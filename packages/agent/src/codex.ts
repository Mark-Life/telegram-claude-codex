import { statSync } from "node:fs";
import path from "node:path";

import { Schema } from "effect";

import { assertPosture } from "./access-narrow";
import { trackStream } from "./agent-turns";
import { codexSkillRoots } from "./bot-skills";
import {
  CODEX_COMMAND,
  CODEX_HOME_BIN_DIRS,
  codexAvailability,
  codexDeviceLogin,
} from "./codex-account";
import { turnReader } from "./codex-app-events";
import type { TurnIds } from "./codex-app-events";
import { AnyResult, openAppServer } from "./codex-app-server";
import type { AppServer } from "./codex-app-server";
import { compact } from "./codex-compact";
import { pastSessions, readRolloutTokenTotal } from "./codex-history";
import { appServerLaunch } from "./codex-launch";
import type { CodexLaunch } from "./codex-launch";
import {
  codexModels,
  codexDefaultModel,
  codexLightPick,
  codexResolveStored,
  EFFORT_LEVELS,
  codexTierModels,
} from "./codex-models";
import { inView, openCodexSandbox } from "./codex-sandbox";
import {
  buildCodexPrompt,
  CODEX_CAPABILITIES,
  CODEX_PLAN_FILE,
  codexOptions,
  isSet,
  threadOptions,
} from "./codex-thread";
import { codexOneTurn } from "./codex-turns";
import { codexUsage } from "./codex-usage";
import { ProviderCrashed } from "./errors";
import { runKeyOf } from "./run-registry";
import { codexStateRoots } from "./state-roots";
import type {
  AgentEvent,
  AgentProvider,
  RunContext,
  RunImage,
  RunOptions,
} from "./types";
import { untilAborted } from "./until-aborted";

/** True when PLAN.md exists and was (re)written during this run. */
const planWrittenSince = (planPath: string, since: number) => {
  try {
    return statSync(planPath).mtimeMs >= since;
  } catch {
    return false;
  }
};

/**
 * A surrogate standing alone. With the `u` flag a proper pair is one code
 * point, so only half of an emoji (a prompt clipped mid-character) matches.
 */
const LONE_SURROGATE = /[\uD800-\uDFFF]/gu;

/**
 * A user message as the app server takes it. A lone surrogate would go out
 * as an escape the server cannot parse, and it drops such a line without
 * answering, so it becomes U+FFFD first, as it did on `codex exec`'s stdin.
 */
const textInput = (text: string, images: readonly RunImage[] = []) => [
  {
    text: text.replaceAll(LONE_SURROGATE, "\uFFFD"),
    text_elements: [],
    type: "text",
  },
  // A data URL, so the server inside the view reads no path for it.
  ...images.map((image) => ({
    type: "image",
    url: `data:${image.mimeType};base64,${image.data}`,
  })),
];

/** `thread/start` answers with the thread. */
const ThreadAnswer = Schema.Struct({
  thread: Schema.Struct({ id: Schema.String }),
});
/** `turn/start` answers with the turn. */
const TurnAnswer = Schema.Struct({
  turn: Schema.Struct({ id: Schema.String }),
});

/**
 * Deltas a run never reads: it shows items once they complete, as it did
 * on `codex exec`. Opting out keeps a chatty command's output off the pipe.
 */
const STREAMED_NOTIFICATIONS = [
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/plan/delta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "turn/diff/updated",
];

/** How long a stopped turn may take to wind down before its server is killed. */
const INTERRUPT_GRACE_MS = 1000;

/**
 * Hand each message the user sends while the turn runs to it, under the
 * follow-up's own id. The server folds it in at the next tool call, or
 * samples once more when the model had already answered. The item it
 * records for the message carries the id back, and the message counts as
 * taken once the model starts on something after it. A steer the server
 * refuses (the turn just ended) leaves it and every later one unread, and
 * the caller queues them: the caller requeues the newest unread ones, so
 * the ones not taken must be the last.
 */
const steerFollowUps = async (input: {
  followUps: RunContext["followUps"];
  server: AppServer;
  threadId: string;
  turnId: string;
}) => {
  for await (const followUp of input.followUps.listen()) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one message at a time, in the order sent
      await input.server.request(
        "turn/steer",
        {
          clientUserMessageId: followUp.id,
          expectedTurnId: input.turnId,
          input: textInput(followUp.text),
          threadId: input.threadId,
        },
        AnyResult
      );
    } catch {
      // Not taken, nor anything after it: the run reports them unread.
      input.followUps.close();
      return;
    }
  }
};

/**
 * `config/read` answers with the effective config, `--config` overrides
 * included; only its provider and reasoning summary are read.
 */
const ConfigAnswer = Schema.Struct({
  config: Schema.Struct({
    model_provider: Schema.optional(Schema.NullOr(Schema.String)),
    model_reasoning_summary: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});

/** Codex's own provider when the config names none. */
const DEFAULT_MODEL_PROVIDER = "openai";

/**
 * `thread/resume` answers with the thread: how it keeps its history and,
 * for a legacy one, the rollout it lives in.
 */
const ResumeAnswer = Schema.Struct({
  thread: Schema.Struct({
    historyMode: Schema.optional(Schema.String),
    id: Schema.String,
    path: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});

/** An opened thread, and its token total when the server will not replay it. */
interface OpenedThread {
  readonly threadId: string;
  readonly threadTotal: number | undefined;
}

/**
 * Resume a thread as `codex exec` does. Without a model or provider of its
 * own, `thread/resume` brings back the model, provider and effort the thread
 * last ran with, over this run's flags, so a changed `/effort` would not
 * apply; `codex exec` always names the provider, which turns that off. The
 * run names the one the effective config resolves to. Since Codex 0.164 it
 * also brings back the thread's reasoning summary unless the request's own
 * `config` names one, so the owner's summary setting (`/settings`) is sent
 * again with it; unset, the thread keeps its own. Only the new turn is
 * read back; the old ones stay on disk. Without them the server replays the
 * thread's token total, which the run's count starts from (`tokenMeter` in
 * `codex-app-events.ts`), only for a paginated thread. For a legacy one,
 * written by an older Codex, the total is read off the tail of its rollout
 * instead: resuming it with its turns would send its whole history back as
 * one line, every tool result in full.
 */
const resumeThread = async (
  server: AppServer,
  launch: CodexLaunch,
  threadId: string
): Promise<OpenedThread> => {
  const effective = await server.request(
    "config/read",
    { cwd: launch.thread.cwd },
    ConfigAnswer
  );
  const params = {
    ...launch.thread,
    excludeTurns: true,
    modelProvider: effective.config.model_provider ?? DEFAULT_MODEL_PROVIDER,
    threadId,
  };
  const summary = effective.config.model_reasoning_summary ?? undefined;
  const resumed = await server.request(
    "thread/resume",
    isSet(summary)
      ? { ...params, config: { model_reasoning_summary: summary } }
      : params,
    ResumeAnswer
  );
  const { historyMode, id } = resumed.thread;
  const rollout = resumed.thread.path ?? undefined;
  return {
    threadId: id,
    threadTotal:
      historyMode !== "paginated" && isSet(rollout)
        ? await readRolloutTokenTotal(rollout)
        : undefined,
  };
};

/** Start a new thread; it has no token total yet. */
const startThread = async (
  server: AppServer,
  launch: CodexLaunch
): Promise<OpenedThread> => {
  const started = await server.request(
    "thread/start",
    { ...launch.thread },
    ThreadAnswer
  );
  return { threadId: started.thread.id, threadTotal: undefined };
};

/**
 * Stream one turn on its own `codex app-server`: start or resume the
 * thread, start the turn, steer follow-ups into it, and read its
 * notifications as AgentEvents, the way `codex exec` read them. A stop
 * asks the server to interrupt the turn, which also ends the commands it
 * runs, and kills it after a grace.
 *
 * @yields {AgentEvent} the normalized events of the turn.
 */
const streamTurn = async function* streamTurn(input: {
  followUps: RunContext["followUps"];
  images: readonly RunImage[] | undefined;
  launch: CodexLaunch;
  prompt: string;
  resume: string | undefined;
  signal: AbortSignal;
  start: number;
}): AsyncGenerator<AgentEvent> {
  const { followUps, launch, signal } = input;
  const server = openAppServer(launch.launch);
  let turn: TurnIds | undefined;
  let done = false;
  let failure: string | undefined;
  let interrupting: Promise<void> | undefined;
  const requestInterrupt = async (running: TurnIds) => {
    try {
      await server.request("turn/interrupt", { ...running }, AnyResult);
    } catch {
      // The turn already ended, or the server is gone: nothing left to stop.
    }
  };
  /**
   * Ask the server to stop the turn, once. The answer comes when the turn
   * has wound down and its commands are gone.
   */
  const interrupt = async () => {
    if (turn !== undefined && !done) {
      interrupting ??= requestInterrupt(turn);
    }
    await interrupting;
  };
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  // A server that does not wind the turn down in time is killed, which
  // ends the notifications the run waits on.
  const stop = () => {
    void interrupt();
    killTimer = setTimeout(() => {
      void server.close();
    }, INTERRUPT_GRACE_MS);
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    await untilAborted(
      signal,
      server.request(
        "initialize",
        {
          capabilities: {
            experimentalApi: false,
            optOutNotificationMethods: STREAMED_NOTIFICATIONS,
          },
          clientInfo: { name: "owner-telegram-bot", title: null, version: "1" },
        },
        AnyResult
      )
    );
    server.notify("initialized");
    if (launch.skillRoots.length > 0) {
      // A root no flag can add: the server's own, for this run alone.
      await untilAborted(
        signal,
        server.request(
          "skills/extraRoots/set",
          { extraRoots: launch.skillRoots },
          AnyResult
        )
      );
    }
    const opened = await untilAborted(
      signal,
      isSet(input.resume)
        ? resumeThread(server, launch, input.resume)
        : startThread(server, launch)
    );
    const { threadId } = opened;
    yield { kind: "session_init", sessionId: threadId };
    const started = await untilAborted(
      signal,
      server.request(
        "turn/start",
        { input: textInput(input.prompt, input.images), threadId },
        TurnAnswer
      )
    );
    turn = { threadId, turnId: started.turn.id };
    // A steer still unanswered when the turn ends is not waited for: the
    // server's close rejects it, and the message counts as unread.
    void steerFollowUps({ followUps, server, ...turn });
    const read = turnReader(turn, input.start, opened.threadTotal);
    for await (const notification of server.notifications()) {
      const step = read(notification);
      for (const id of step.taken ?? []) {
        followUps.took(id);
      }
      if (step.done) {
        // Nothing offered from here on can join this turn.
        followUps.close();
        done = true;
        failure = step.failed;
      }
      yield* step.events;
      if (done) {
        break;
      }
    }
    signal.throwIfAborted();
    if (failure !== undefined) {
      throw new ProviderCrashed({ message: failure });
    }
    if (!done) {
      throw new ProviderCrashed({
        message: `Codex app-server exited mid-turn${server.stderrTail().length > 0 ? `: ${server.stderrTail()}` : ""}`,
      });
    }
  } finally {
    signal.removeEventListener("abort", stop);
    clearTimeout(killTimer);
    followUps.close();
    // Abandoned mid-turn (a stop the run never got to read): end the turn
    // first, so its commands go with it rather than with the server.
    if (turn !== undefined && !done) {
      await Promise.race([interrupt(), Bun.sleep(INTERRUPT_GRACE_MS)]);
    }
    await server.close();
  }
};

/**
 * Drive one Codex run on `codex app-server`, normalizing its notifications
 * into AgentEvents. Starts or resumes a thread by sessionId, streams the
 * turn with the caller's abort signal (so /stop tears it down), steers the
 * user's follow-ups into it, and — as a safety net for a PLAN.md written via
 * shell redirection (which surfaces as a `commandExecution` item, not a
 * `fileChange`) — stats the plan file after the turn. A run in the bwrap view
 * gets it, and its group memory relay, for exactly the life of the turn.
 *
 * @yields {AgentEvent} the normalized events of the whole run.
 */
const run = async function* run(
  opts: RunOptions,
  ctx: RunContext,
  signal: AbortSignal
): AsyncGenerator<AgentEvent> {
  assertPosture(CODEX_CAPABILITIES, opts.access);
  const groupMemory = { chatId: opts.chatId, userId: opts.userId };
  const sandbox = await openCodexSandbox({
    access: opts.access,
    groupMemory,
    workingDirectory: opts.projectDir,
  });
  const start = Date.now();
  let planEmitted = false;
  try {
    const viewOpts = inView(opts, sandbox);
    const launch = appServerLaunch(
      codexOptions({
        access: opts.access,
        granted: opts.grantedAccess,
        groupMemory,
        mcpServers: ctx.mcpServers,
        owner: ctx.ownerSettings,
        sandbox,
        stamp: opts.taskAuthor,
        telegramAccount: ctx.telegramAccount,
      }),
      threadOptions(viewOpts),
      codexSkillRoots(opts.access)
    );
    const prompt = buildCodexPrompt(viewOpts, ctx);
    const events = trackStream(
      {
        kind: "run",
        label: opts.access.modelClass,
        provider: "codex",
        runKey: runKeyOf(opts),
      },
      signal,
      () =>
        streamTurn({
          followUps: ctx.followUps,
          images: opts.images,
          launch,
          prompt,
          resume: opts.sessionId,
          signal,
          start,
        })
    );
    for await (const event of events) {
      planEmitted ||= event.kind === "plan_ready";
      yield event;
    }
  } finally {
    sandbox?.close();
  }

  if (!planEmitted) {
    const planPath = path.join(opts.projectDir, CODEX_PLAN_FILE);
    if (planWrittenSince(planPath, start)) {
      yield { kind: "plan_ready", planPath };
    }
  }
};

/** Codex provider definition (`codex app-server`; helper turns and compaction run `codex exec` through the SDK) */
export const codexProvider: AgentProvider = {
  availability: codexAvailability,
  capabilities: CODEX_CAPABILITIES,
  command: CODEX_COMMAND,
  // Codex cannot rewrite a session in place, so compaction summarizes the
  // session and seeds a fresh one: the session id changes.
  compact,
  defaultEffort: "medium",
  // Codex's own config default, as a run with no pick has always had.
  defaultModel: codexDefaultModel,
  deviceLogin: codexDeviceLogin,
  displayName: "Codex",
  effortLevels: EFFORT_LEVELS.map((id) => ({ id, label: id })),
  homeBinDirs: CODEX_HOME_BIN_DIRS,
  id: "codex",
  lightPick: codexLightPick,
  // The router's efforts are Codex's own levels.
  mapEffort: (routed) => routed,
  models: codexModels,
  oneTurn: codexOneTurn,
  oneTurnUses: ["format", "judge", "title"],
  pastSessions,
  resolveStored: codexResolveStored,
  run,
  stateRoots: codexStateRoots(),
  tierModels: codexTierModels,
  usage: codexUsage,
};
