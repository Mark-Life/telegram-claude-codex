import path from "node:path";

import { Effect, Option, Schema } from "effect";

import { assertPosture } from "./access-narrow";
import { trackStream } from "./agent-turns";
import { piSkillFiles } from "./bot-skills";
import { ProviderCrashed } from "./errors";
import type { FollowUps } from "./follow-ups";
import {
  piAgentDir,
  piAvailability,
  piBin,
  piCheckEnv,
  piDefaultModel,
  PI_COMMAND,
  PI_FIXED_ENV,
  PI_HOME_BIN_DIRS,
  splitPiModel,
} from "./pi-account";
import {
  Compacted,
  compactDoneOf,
  contextOfStats,
  mapPiRecord,
  newPiRunState,
  SessionStats,
} from "./pi-events";
import { piLog } from "./pi-log";
import { openPiMcp } from "./pi-mcp";
import type { PiMcp } from "./pi-mcp";
import {
  findPiModel,
  PI_LEFT_OUT,
  piLightModel,
  piModelList,
  refreshPiModels,
} from "./pi-models";
import { piOneTurn } from "./pi-one-turn";
import { decodeResponse, openPiRpc, piArgs } from "./pi-rpc";
import type { PiRecord, PiRpc } from "./pi-rpc";
import { openPiSandbox, piModelReach, piRefusalOf } from "./pi-sandbox";
import { runEnv } from "./run-env";
import { buildRunPrompt } from "./run-prompt";
import { runKeyOf } from "./run-registry";
import { credentialViewPostures } from "./sandbox/host";
import { piStateRoots } from "./state-roots";
import { AUTO_MODEL, DEFAULT_MODEL, ROUTED_EFFORTS } from "./types";
import type {
  AgentEvent,
  AgentProvider,
  ProviderCapabilities,
  ProviderWiring,
  RunContext,
  RunImage,
  RunOptions,
} from "./types";
import { untilAborted } from "./until-aborted";

/**
 * What the pi provider supports. Executor and the owner's account reach a
 * run outside the view through the bot's loopback proxy (`pi-mcp.ts`), the
 * chat's memory a group run inside it through the relay. No routing.
 */
const PI_CAPABILITIES = {
  autoModel: false,
  compaction: true,
  cost: false,
  externalTools: true,
  groupMemory: true,
  planMode: false,
  get postures() {
    // The view holds pi's key files, as Claude's holds its credentials.
    return credentialViewPostures();
  },
  sessionsInView: false,
  telegramAccount: true,
  thinking: true,
} satisfies ProviderCapabilities & ProviderWiring;

/** pi's thinking levels; it clamps one to what the model offers. */
const THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const STATS_TIMEOUT_MS = 2000;
/** A summary is a model call of its own; it may take a while. */
const COMPACT_TIMEOUT_MS = 600_000;
/** How long a stopped run may take to wind down before pi is shut. */
const ABORT_GRACE_MS = 1500;

/** The run's model as pi takes it: its pick, else pi's default. */
const modelOf = (opts: Pick<RunOptions, "model">) => {
  const picked =
    opts.model === undefined ||
    opts.model === DEFAULT_MODEL ||
    opts.model === AUTO_MODEL
      ? undefined
      : opts.model;
  const model = splitPiModel(picked ?? piDefaultModel() ?? "");
  if (model === undefined) {
    throw new ProviderCrashed({
      message:
        "pi has no model: set PI_DEFAULT_MODEL or a default in pi's settings.json",
    });
  }
  return model;
};

/** The session a run keeps: its stored one, else a new id. None when throwaway. */
const sessionOf = (opts: RunOptions): string | undefined => {
  if (!opts.access.persistSession) {
    return undefined;
  }
  return opts.sessionId !== undefined && opts.sessionId.length > 0
    ? opts.sessionId
    : crypto.randomUUID();
};

/**
 * Start one pi child for `opts`, in its view when the posture has one. A
 * run (`mcp` set) gets its MCP servers; a compaction gets none.
 */
const startPi = async (input: {
  mcp?: Pick<RunContext, "mcpServers" | "telegramAccount">;
  model: { id: string; provider: string };
  opts: RunOptions;
  session: string | undefined;
  system?: string;
}) => {
  const { opts } = input;
  const bin = piBin();
  if (bin === undefined) {
    throw new ProviderCrashed({ message: "pi CLI not found" });
  }
  const groupMemory =
    input.mcp === undefined
      ? undefined
      : { chatId: opts.chatId, userId: opts.userId };
  const sandbox = await openPiSandbox({
    access: opts.access,
    bin,
    groupMemory,
    model: input.model,
    workingDirectory: opts.projectDir,
  });
  let mcp: PiMcp | undefined;
  try {
    mcp =
      input.mcp === undefined
        ? undefined
        : await openPiMcp({
            access: opts.access,
            ctx: input.mcp,
            groupMemory,
            sandbox,
          });
    const { args, env } = piArgs({
      effort:
        opts.effort !== undefined && THINKING_LEVELS.has(opts.effort)
          ? opts.effort
          : undefined,
      mcp: mcp?.tools,
      model: input.model,
      sandbox: opts.access.sandbox,
      session: input.session,
      skills: piSkillFiles(opts.access),
      system: input.system,
    });
    const base = {
      ...runEnv({
        access: opts.access,
        granted: opts.grantedAccess ?? opts.access,
        provider: "pi",
        stamp: opts.taskAuthor,
      }),
      ...PI_FIXED_ENV,
      ...env,
      ...sandbox?.env,
    };
    const rpc = openPiRpc({
      argv: sandbox === undefined ? [bin, ...args] : sandbox.argv(args),
      cwd: opts.projectDir,
      env: { ...base, ...mcp?.env(base) },
      secret: mcp?.token,
    });
    const opened = mcp;
    return {
      close: async () => {
        await rpc.close();
        await opened?.close();
        sandbox?.close();
      },
      rpc,
    };
  } catch (error) {
    await mcp?.close();
    sandbox?.close();
    throw error;
  }
};

const decodeDisposition = Schema.decodeUnknownOption(
  Schema.Struct({ disposition: Schema.String })
);

/** A command whose failure changes nothing: the child is going anyway. */
const quietly = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch {
    // Timed out, or the child is gone.
  }
};

/** The session's context figure; none when pi does not answer in time. */
const readContext = async (
  rpc: PiRpc,
  at: { model: string; sessionId: string }
): Promise<AgentEvent | undefined> => {
  try {
    const stats = await rpc.request(
      { type: "get_session_stats" },
      SessionStats,
      STATS_TIMEOUT_MS
    );
    return contextOfStats({ ...at, stats });
  } catch {
    return undefined;
  }
};

/** The id the run's own prompt goes in under. */
const FIRST_PROMPT = "bot-prompt";

/**
 * The run's records as events, until pi settles with nothing left to do.
 * Follow-ups go in as `prompt` with `streamingBehavior: "steer"`: pi folds
 * one into the running turn before its next model call, or, when the run
 * settled just before, starts a run of its own for it, which this run then
 * waits for too. A follow-up counts as taken when pi records it as a user
 * message; one pi refused leaves it and every later one unread. pi retries
 * a failed request itself, so an error is final only at `agent_settled`.
 *
 * @yields {AgentEvent} the normalized events of the run.
 */
const piTurn = async function* piTurn(input: {
  followUps: FollowUps;
  images: readonly RunImage[] | undefined;
  model: string;
  prompt: string;
  rpc: PiRpc;
  sessionId: string;
  signal: AbortSignal;
  stats: boolean;
}): AsyncGenerator<AgentEvent> {
  const { followUps, rpc, sessionId, signal } = input;
  const state = newPiRunState();
  const start = Date.now();
  /** Prompts sent and not answered yet: the follow-up's id, or the first. */
  const unanswered = new Map<string, string | undefined>();
  /** Follow-ups sent and not yet seen as user messages, oldest first. */
  const sent: string[] = [];
  let runsOpen = 0;
  let pump: Promise<void> | undefined;
  let settled = false;
  const steer = async () => {
    for await (const followUp of followUps.listen()) {
      const id = `bot-steer-${followUp.id}`;
      unanswered.set(id, followUp.id);
      sent.push(followUp.id);
      rpc.send({
        id,
        message: followUp.text,
        streamingBehavior: "steer",
        type: "prompt",
      });
    }
  };
  /** A prompt's answer; true when it was ours. */
  const answered = (record: PiRecord) => {
    const response = Option.getOrUndefined(decodeResponse(record.raw));
    if (response?.id === undefined || !unanswered.has(response.id)) {
      return false;
    }
    const followUp = unanswered.get(response.id);
    unanswered.delete(response.id);
    if (!response.success) {
      if (followUp === undefined) {
        throw new ProviderCrashed({
          message: `pi refused the prompt: ${String(response.error)}`,
        });
      }
      // Not taken, nor anything after it: the run reports them unread.
      followUps.close();
      return true;
    }
    const disposition = Option.getOrUndefined(
      decodeDisposition(response.data)
    )?.disposition;
    if (disposition === "started") {
      runsOpen += 1;
      // A stop that came while pi was starting this run found no run to
      // abort; now there is one.
      if (signal.aborted) {
        rpc.send({ type: "abort" });
      }
    } else if (followUp === undefined) {
      throw new ProviderCrashed({
        message: `pi did not start the run (${String(disposition)})`,
      });
    }
    // Follow-ups wait until pi works on the prompt, so none starts a run of
    // its own beside it.
    pump ??= steer();
    return true;
  };
  /**
   * Whether the run is over: no run open and no prompt unanswered once
   * nothing more may join it and what was offered went in.
   */
  const over = async () => {
    if (runsOpen > 0 || unanswered.size > 0) {
      return false;
    }
    // Nothing offered from here on joins this run; what was already
    // offered still goes in, and is waited for.
    followUps.close();
    await pump;
    return unanswered.size === 0;
  };
  yield { kind: "session_init", sessionId };
  // Stopped before pi was asked anything: ask it nothing.
  signal.throwIfAborted();
  unanswered.set(FIRST_PROMPT, undefined);
  rpc.send({
    id: FIRST_PROMPT,
    // pi resizes each to what the model takes, or drops it with a note.
    images: (input.images ?? []).map((image) => ({
      data: image.data,
      mimeType: image.mimeType,
      type: "image",
    })),
    message: input.prompt,
    type: "prompt",
  });
  for await (const record of rpc.records()) {
    if (answered(record)) {
      // A follow-up answered after the run settled, refused or queued,
      // starts nothing pi would settle again.
      // oxlint-disable-next-line no-await-in-loop -- the pump ends once the inbox drained
      if (await over()) {
        settled = true;
        break;
      }
      continue;
    }
    const users = state.userMessages;
    yield* mapPiRecord(record, state);
    // The first user message is the run's own prompt; every later one is
    // the next follow-up sent.
    if (state.userMessages > users && users > 0) {
      const id = sent.shift();
      if (id !== undefined) {
        followUps.took(id);
      }
    }
    if (record.type !== "agent_settled") {
      continue;
    }
    runsOpen = Math.max(0, runsOpen - 1);
    if (signal.aborted) {
      break;
    }
    if (state.error !== undefined) {
      throw new ProviderCrashed({ message: state.error });
    }
    // oxlint-disable-next-line no-await-in-loop -- the pump ends once the inbox drained
    if (await over()) {
      settled = true;
      break;
    }
  }
  signal.throwIfAborted();
  if (!settled) {
    throw new ProviderCrashed({
      message: `pi exited mid-run${rpc.stderrTail().length > 0 ? `: ${rpc.stderrTail()}` : ""}`,
    });
  }
  if (input.stats) {
    const context = await readContext(rpc, {
      model: input.model,
      sessionId,
    });
    if (context !== undefined) {
      yield context;
    }
  }
  yield {
    durationMs: Date.now() - start,
    kind: "result",
    sessionId,
    text: state.lastText,
    totalTokens: state.totalTokens,
    turns: state.turns,
  };
};

/** What pi expands to a loaded skill, when a message starts with it. */
const SKILL_COMMAND = "/skill:";

/** The prompt's non-empty parts, one paragraph each. */
const blocks = (parts: readonly string[]) =>
  parts.filter((part) => part.length > 0).join("\n\n");

/**
 * The prompt of one run and the system text, which pi gets on every start
 * (`--append-system-prompt`), so a resumed session keeps it. The text goes
 * in as data: with no templates or extension commands loaded, a leading `/`
 * is just text, except `/skill:<name>` of a bot skill an operator run has,
 * which pi expands only at the very start of a message, taking the name up
 * to the first space. So such a request goes first, a space right after
 * the name, and the rest of it and the bot's blocks after that, which pi
 * passes on as the skill's arguments.
 */
const piPrompt = (
  opts: RunOptions,
  ctx: Pick<RunContext, "telegramAccount">
) => {
  const skill = opts.prompt.startsWith(SKILL_COMMAND);
  const { request, routing, system } = buildRunPrompt(
    skill ? { ...opts, prompt: "" } : opts,
    ctx,
    { userRules: path.join(piAgentDir(), "AGENTS.md") }
  );
  if (!skill) {
    return { prompt: blocks([routing, request]), system: system.join("\n\n") };
  }
  // pi takes the skill name up to the first space, so one follows it.
  const { name = "", rest = "" } =
    /^(?<name>\S*)\s*(?<rest>.*)$/su.exec(opts.prompt)?.groups ?? {};
  return {
    prompt: `${name} ${blocks([rest, routing, request])}`,
    system: system.join("\n\n"),
  };
};

/**
 * One run on pi: a `pi --mode rpc` child of its own, inside the run's view
 * unless it has full access, for exactly the life of the run. A stop asks
 * pi to abort, which ends the commands it runs, then shuts it.
 *
 * @yields {AgentEvent} the normalized events of the run.
 */
const run = async function* run(
  opts: RunOptions,
  ctx: RunContext,
  signal: AbortSignal
): AsyncGenerator<AgentEvent> {
  assertPosture(PI_CAPABILITIES, opts.access);
  const model = modelOf(opts);
  const session = sessionOf(opts);
  const { prompt, system } = piPrompt(opts, ctx);
  yield* trackStream(
    {
      kind: "run",
      label: opts.access.modelClass,
      provider: "pi",
      runKey: runKeyOf(opts),
    },
    signal,
    async function* turn() {
      const child = await startPi({
        mcp: ctx,
        model,
        opts,
        session,
        system,
      });
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        child.rpc.send({ type: "abort" });
        killTimer = setTimeout(() => {
          void child.close();
        }, ABORT_GRACE_MS);
      };
      signal.addEventListener("abort", stop, { once: true });
      let finished = false;
      try {
        yield* piTurn({
          followUps: ctx.followUps,
          images: opts.images,
          model: `${model.provider}/${model.id}`,
          prompt,
          rpc: child.rpc,
          sessionId: session ?? crypto.randomUUID(),
          signal,
          stats: session !== undefined,
        });
        finished = true;
      } finally {
        signal.removeEventListener("abort", stop);
        clearTimeout(killTimer);
        ctx.followUps.close();
        // Abandoned mid-run: end the run first, so its commands go with it.
        if (!finished) {
          await quietly(
            child.rpc.request({ type: "abort" }, Schema.Unknown, ABORT_GRACE_MS)
          );
        }
        await child.close();
      }
    }
  );
};

/**
 * Compact a pi session in place with pi's own `compact` command; the
 * session id stays the same.
 *
 * @yields {AgentEvent} exactly one terminal compact event.
 */
const compact = async function* compact(
  opts: RunOptions,
  _ctx: RunContext,
  signal: AbortSignal
): AsyncGenerator<AgentEvent> {
  assertPosture(PI_CAPABILITIES, opts.access);
  const { sessionId } = opts;
  if (sessionId === undefined || sessionId.length === 0) {
    yield { kind: "compact_failed", reason: "No session to compact." };
    return;
  }
  const model = modelOf(opts);
  yield* trackStream(
    {
      kind: "compact",
      label: "in place",
      provider: "pi",
      runKey: runKeyOf(opts),
    },
    signal,
    async function* compacting() {
      const child = await startPi({ model, opts, session: sessionId });
      try {
        const data = await untilAborted(
          signal,
          child.rpc.request({ type: "compact" }, Compacted, COMPACT_TIMEOUT_MS)
        );
        yield compactDoneOf(data, sessionId);
      } catch (error) {
        signal.throwIfAborted();
        const reason = error instanceof Error ? error.message : String(error);
        piLog(Effect.logWarning("pi compaction failed", { reason }));
        yield { kind: "compact_failed", reason };
      } finally {
        await child.close();
      }
    }
  );
};

/**
 * pi's `Choice` list: only "no pick". Its ids outgrow a button's 64 bytes,
 * so the chat offers its models by index into `piModelList` instead.
 */
const piModels = () => [{ id: AUTO_MODEL, label: "auto" }];

/**
 * The router's levels `model` takes: the ones its thinking map leaves on,
 * none for a model with no thinking setting, all of them for a model the
 * list does not know.
 */
const piEffortLevels = (model: string | undefined) => {
  const known = findPiModel(piModelList(), model ?? piDefaultModel());
  return (known?.levels ?? ROUTED_EFFORTS).map((id) => ({ id, label: id }));
};

/** Default models already warned about, so the warning shows once each. */
const warnedDefault = new Set<string>();

/**
 * `piAvailability`, except when pi's default model may not run (its reach
 * is in `PI_LEFT_OUT`, or pi does not list it though its key works):
 * then a run on the default is refused at its start, and pi stays ready
 * while its list has another model, for a pick. With none, pi is not ready.
 * The list already leaves out what may not run; a model whose endpoint
 * does not resolve stays on it and counts. An `unresolved` default changes
 * nothing here: DNS may only be down. A default pi does not list for
 * want of a credential (`pi auth check` fails) reads as `piAvailability`
 * says, `logged_out`. Warns once per such default.
 */
const availability: AgentProvider["availability"] = async (bin, signal) => {
  const found = await piAvailability(bin, signal);
  const key = piDefaultModel() ?? "";
  const model = splitPiModel(key);
  if (found === "missing" || model === undefined) {
    return found;
  }
  const reach = await piModelReach({ bin, env: piCheckEnv(), model });
  const refused =
    PI_LEFT_OUT.has(reach.kind) ||
    (reach.kind === "unlisted" && found === "ready");
  if (!refused) {
    return found;
  }
  if (piModelList().checkedAt === 0) {
    await refreshPiModels({ maxAgeMs: 0 });
  }
  const usable = piModelList().models.length;
  if (!warnedDefault.has(key)) {
    warnedDefault.add(key);
    piLog(
      Effect.logWarning(
        usable > 0
          ? "pi's default model may not run; runs on it are refused, other pi models still run"
          : "pi is not ready: its default model may not run, and no other pi model can",
        { model: key, reason: piRefusalOf(key, reach), usable }
      )
    );
  }
  return usable > 0 ? "ready" : "logged_out";
};

/** pi provider definition (`pi --mode rpc`, one child per run) */
export const piProvider: AgentProvider = {
  availability,
  capabilities: PI_CAPABILITIES,
  command: PI_COMMAND,
  compact,
  defaultEffort: "medium",
  // None, so a conversation stores `DEFAULT_MODEL` and `modelOf` reads
  // `PI_DEFAULT_MODEL` or pi's settings at each run.
  defaultModel: (): string | undefined => undefined,
  displayName: "pi",
  // The router's scale is a subset of pi's thinking levels.
  effortLevels: ROUTED_EFFORTS.map((id) => ({ id, label: id })),
  effortLevelsFor: piEffortLevels,
  homeBinDirs: PI_HOME_BIN_DIRS,
  id: "pi",
  lightPick: () => ({ effort: "low", model: piLightModel() }),
  mapEffort: (routed) => routed,
  models: piModels,
  oneTurn: piOneTurn,
  oneTurnUses: ["format", "judge", "title"],
  refreshModels: refreshPiModels,
  // A stored `provider/id` is kept; pi says at run time when it is gone.
  resolveStored: (model) =>
    splitPiModel(model) === undefined ? undefined : model,
  run,
  stateRoots: piStateRoots(),
  tierModels: () => ({}),
};
