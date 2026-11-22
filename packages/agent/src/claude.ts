import type {
  Options,
  Query,
  SDKMessage,
  SDKResultMessage,
  StopHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { Effect, Option, Schema } from "effect";

import { assertPosture } from "./access-narrow";
import { trackStream, trackTurn } from "./agent-turns";
import {
  CLAUDE_COMMAND,
  CLAUDE_HOME_BIN_DIRS,
  claudeAvailability,
} from "./claude-account";
import { claudeAgents } from "./claude-agents";
import { backgroundWait } from "./claude-background";
import type { Settle } from "./claude-background";
import {
  exactContext,
  mapClaudeMessage,
  mapCompactMessage,
} from "./claude-events";
import type { ClaudeCompactState, ClaudeRunState } from "./claude-events";
import { claudeLog } from "./claude-log";
import { openClaudeMcp } from "./claude-mcp-proxy";
import type { ClaudeMcp } from "./claude-mcp-proxy";
import {
  claudeDefaultModel,
  claudeEffort,
  claudeLightPick,
  claudeMapEffort,
  claudeModels,
  claudeResolveStored,
  claudeTierModels,
  refreshClaudeModels,
} from "./claude-models";
import {
  CLAUDE_CAPABILITIES,
  claudeInert,
  claudePrompt,
  claudeRunOptions,
  claudeWaits,
} from "./claude-options";
import { openClaudeSandbox } from "./claude-sandbox";
import type { ClaudeSandbox } from "./claude-sandbox";
import {
  claudeIsolation,
  inertPrompt,
  loadClaudeSdk,
  steerablePrompt,
} from "./claude-sdk";
import { claudeUsage } from "./claude-usage";
import { AgentInterrupted, ProviderCrashed } from "./errors";
import type { FollowUps } from "./follow-ups";
import type { GroupMemoryChat } from "./group-memory-server";
import { runEnv } from "./run-env";
import { runKeyOf } from "./run-registry";
import { claudeStateRoots } from "./state-roots";
import { HELPER_INSTRUCTIONS, LIGHT_ACCESS, ROUTED_EFFORTS } from "./types";
import type {
  AgentEvent,
  AgentProvider,
  CompactEvent,
  OneTurn,
  RunContext,
  RunOptions,
} from "./types";

/** The CLI's own command that summarizes a session and keeps it. */
const COMPACT_COMMAND = "/compact";

/** An abort controller that follows `signal`. */
const followSignal = (signal: AbortSignal | undefined) => {
  const controller = new AbortController();
  if (signal?.aborted === true) {
    controller.abort();
  } else {
    signal?.addEventListener(
      "abort",
      () => {
        controller.abort();
      },
      { once: true }
    );
  }
  return controller;
};

/**
 * The frames of one CLI session inside the run's view: its MCP servers live
 * exactly as long as the CLI. `prompt` replaces the run's own prompt; it goes
 * to the CLI as written, so a leading `/` runs a command. With `followUps`
 * the prompt stays open for them, and the CLI runs until they close.
 *
 * @yields {SDKMessage} the CLI's frames, unchanged.
 */
const claudeFrames = async function* claudeFrames(input: {
  ctx: RunContext;
  /** The id the run's own prompt goes in under, with `followUps`. */
  firstId?: ReturnType<typeof crypto.randomUUID>;
  followUps?: FollowUps;
  groupMemory: GroupMemoryChat;
  /** Hands over the CLI session, to ask it things while it runs. */
  onQuery?: (session: Query) => void;
  onStop?: (stop: StopHookInput) => void;
  opts: RunOptions;
  prompt?: string;
  sandbox: ClaudeSandbox | undefined;
  signal: AbortSignal;
}): AsyncGenerator<SDKMessage> {
  const { ctx, groupMemory, opts, sandbox, signal } = input;
  let mcp: ClaudeMcp | undefined;
  try {
    const { query } = await loadClaudeSdk();
    mcp = await openClaudeMcp({
      access: opts.access,
      ctx,
      groupMemory,
      sandbox,
    });
    const { prompt, system } = claudePrompt(opts, ctx);
    const options = claudeRunOptions({
      abortController: followSignal(signal),
      mcpServers: mcp.servers,
      onStop: input.onStop,
      opts,
      owner: ctx.ownerSettings,
      sandbox,
      system,
    });
    const first = input.prompt ?? prompt;
    const session = query({
      options,
      // A run's own prompt always streams (`followUps`), and only it carries
      // images; a `/compact` goes in as a plain string.
      prompt:
        input.followUps === undefined
          ? first
          : steerablePrompt({
              first,
              firstId: input.firstId ?? crypto.randomUUID(),
              followUps: input.followUps,
              images: opts.images,
              inert: claudeInert(opts),
            }),
    });
    input.onQuery?.(session);
    yield* session;
  } finally {
    await mcp?.close();
  }
};

/**
 * What the CLI reports of a command, a user message under the id it was sent
 * with: a `command_lifecycle` frame (not in the SDK's types), and whether it
 * took the message into its work (started or completed it).
 */
const decodeLifecycle = Schema.decodeUnknownOption(
  Schema.Struct({
    command_uuid: Schema.String,
    state: Schema.String,
    type: Schema.Literal("command_lifecycle"),
  })
);

const commandOf = (frame: SDKMessage) =>
  Option.getOrUndefined(
    Option.map(decodeLifecycle(frame), (lifecycle) => ({
      id: lifecycle.command_uuid,
      // `queued` has not run yet; `cancelled`, `discarded` and `refused`
      // never will.
      started: lifecycle.state === "started" || lifecycle.state === "completed",
    }))
  );

/**
 * The commands a run's CLI reports: which follow-ups it took, and whether
 * its own prompt (sent under `firstId`) started. A resumed session may first
 * run the CLI's own turn, its notice of background work the old process left
 * behind, with no model call; that result is not the run's to settle on.
 */
const commandWatch = (firstId: string, followUps: FollowUps | undefined) => {
  let reports = false;
  let firstStarted = false;
  return {
    frame: (message: SDKMessage) => {
      const command = commandOf(message);
      reports ||= command !== undefined;
      if (command?.started === true) {
        firstStarted ||= command.id === firstId;
        followUps?.took(command.id);
      }
    },
    /**
     * Whether a result may be the run's own: its prompt started, or the
     * result is an error, which ends the run even when the CLI cancelled
     * the prompt before it started.
     */
    ownsResult: (result: SDKResultMessage) =>
      firstStarted || !reports || result.is_error,
    /** Whether the CLI says which messages it took at all. */
    reports: () => reports,
  };
};

/**
 * The run's turns, their frames as events. Follow-ups are taken until a
 * result with none still queued behind it: the input then closes, the CLI
 * ends after that result, and a later message waits for the next run. One
 * that reached the CLI just before still runs here as one more turn. A
 * follow-up counts as taken once the CLI says it started on it; a CLI that
 * never says so has taken every follow-up it was sent by a successful result.
 *
 * A run that waits for background work (`claudeWaits`) parks at that result
 * instead while work it started is pending: the input stays open, the CLI
 * runs the work's report as a new turn, and a message the user sends goes
 * straight in. It closes at a result with nothing pending, or at a cap.
 *
 * @yields {AgentEvent} the normalized events of the run.
 */
const claudeTurn = async function* claudeTurn(
  input: Omit<
    Parameters<typeof claudeFrames>[0],
    "firstId" | "onQuery" | "onStop"
  >
): AsyncGenerator<AgentEvent> {
  const { followUps } = input;
  const state: ClaudeRunState = {
    agents: claudeAgents(),
    initialized: false,
    lastText: "",
    sessionId: input.opts.sessionId ?? "",
  };
  const background =
    followUps !== undefined && claudeWaits(input.opts)
      ? backgroundWait(followUps, input.ctx.waitSlot)
      : undefined;
  const firstId = crypto.randomUUID();
  const commands = commandWatch(firstId, followUps);
  let session: Query | undefined;
  let refused = false;
  /**
   * What a settled result says about waiting: parked, or cut by the
   * restart with the same report, or refused a waiting slot. The refusal is
   * said at once: the CLI may still report its work while it winds down.
   */
  const afterSettle = (settled: Settle | undefined): AgentEvent | undefined => {
    if (
      (settled === "parked" || settled === "cut") &&
      background !== undefined
    ) {
      return {
        kind: "background",
        pending: background.pending(),
        sessionId: state.sessionId,
        state: "waiting",
      };
    }
    if (refused || background?.ended() !== "full") {
      return undefined;
    }
    refused = true;
    return { kind: "background", state: "full" };
  };
  /** At a result with nothing queued: park the run, or close its input. */
  const settle = (result: SDKResultMessage) => {
    if (
      !commands.reports() &&
      result.subtype === "success" &&
      !result.is_error
    ) {
      followUps?.tookYielded();
    }
    const settled = background?.park() ?? "closed";
    if (settled !== "parked") {
      followUps?.close();
    }
    return settled;
  };
  /**
   * At a result with nothing queued: the CLI's own context figure, asked
   * before the input closes (the CLI ends once it does), then `settle`. A
   * turn still queued behind the result would be read mid-way.
   */
  const atResult = async (message: SDKMessage) => {
    if (
      message.type !== "result" ||
      (message.queued_turn_count ?? 0) > 0 ||
      !commands.ownsResult(message)
    ) {
      return { exact: undefined, settled: undefined };
    }
    // Only a run that keeps its session has its figure recorded.
    const exact =
      input.opts.access.persistSession &&
      message.subtype === "success" &&
      !message.is_error
        ? await exactContext(session, message)
        : undefined;
    return { exact, settled: settle(message) };
  };
  try {
    for await (const message of claudeFrames({
      ...input,
      firstId,
      onQuery: (opened) => {
        session = opened;
      },
      onStop: background?.onStop,
    })) {
      commands.frame(message);
      if (message.type === "system" && message.subtype === "init") {
        // A turn with no text of its own must not answer with the last one.
        state.lastText = "";
      }
      if (background?.frame(message) === true) {
        yield { kind: "background", state: "working" };
      }
      const { exact, settled } = await atResult(message);
      if (exact !== undefined) {
        yield exact;
      }
      yield* mapClaudeMessage(message, state);
      const after = afterSettle(settled);
      if (after !== undefined) {
        yield after;
      }
      // Work still pending as the bot shuts down: the restart cuts this run
      // like a parked one, so the bot resumes it after boot.
      if (settled === "cut") {
        throw new AgentInterrupted({ reason: "restart" });
      }
    }
    if (background?.ended() === "expired") {
      yield { kind: "background", state: "expired" };
    }
  } finally {
    background?.dispose();
    followUps?.close();
  }
};

/**
 * One run on Claude Code: the first turn, plus any follow-up the user sends
 * while it works, so the CLI ends at its last result and nothing it started
 * outlives the run slot. Background work it started (a workflow, a Monitor,
 * a background command) keeps the CLI up past that result, and its report
 * comes in as one more turn of this run; a run that waits for it also keeps
 * its input open for a wake-up and for the user (`claudeTurn`). The turn is
 * registered before the CLI spawns. The run's view lives exactly as long as
 * the turn.
 *
 * @yields {AgentEvent} the normalized events of the run.
 */
const run = async function* run(
  opts: RunOptions,
  ctx: RunContext,
  signal: AbortSignal
): AsyncGenerator<AgentEvent> {
  assertPosture(CLAUDE_CAPABILITIES, opts.access);
  const groupMemory = { chatId: opts.chatId, userId: opts.userId };
  const sandbox = await openClaudeSandbox({
    access: opts.access,
    groupMemory,
    workingDirectory: opts.projectDir,
  });
  try {
    yield* trackStream(
      {
        kind: "run",
        label: opts.access.modelClass,
        provider: "claude",
        runKey: runKeyOf(opts),
      },
      signal,
      () =>
        claudeTurn({
          ctx,
          followUps: ctx.followUps,
          groupMemory,
          opts,
          sandbox,
          signal,
        })
    );
  } finally {
    sandbox?.close();
  }
};

/**
 * `opts` without a stored session whose transcript is gone. Claude deletes
 * old transcripts at startup, and resuming a missing one fails every turn
 * until `/new`; a fresh session starts instead. The search covers every
 * project directory, so a moved working directory never drops a live one.
 */
const withLiveSession = async (opts: RunOptions) => {
  const { sessionId } = opts;
  if (sessionId === undefined || sessionId.length === 0) {
    return opts;
  }
  const { getSessionInfo } = await loadClaudeSdk();
  if ((await getSessionInfo(sessionId)) !== undefined) {
    return opts;
  }
  claudeLog(
    Effect.logWarning("claude session transcript gone, starting fresh")
  );
  return { ...opts, sessionId: undefined };
};

/**
 * A run on the stored session when it still exists, else a fresh one.
 *
 * @yields {AgentEvent} the normalized events of the run.
 */
const runLive = async function* runLive(
  opts: RunOptions,
  ctx: RunContext,
  signal: AbortSignal
): AsyncGenerator<AgentEvent> {
  yield* run(await withLiveSession(opts), ctx, signal);
};

/**
 * Compact a Claude session in place: the CLI's own `/compact` on the resumed
 * session, with the run's tools and system prompt so the summary sees the
 * conversation as the run did. The session id stays the same.
 *
 * @yields {AgentEvent} exactly one terminal compact event.
 */
const compact = async function* compact(
  requested: RunOptions,
  ctx: RunContext,
  signal: AbortSignal
): AsyncGenerator<AgentEvent> {
  assertPosture(CLAUDE_CAPABILITIES, requested.access);
  const opts = await withLiveSession(requested);
  if (opts.sessionId === undefined || opts.sessionId.length === 0) {
    yield { kind: "compact_failed", reason: "No session to compact." };
    return;
  }
  const groupMemory = { chatId: opts.chatId, userId: opts.userId };
  const sandbox = await openClaudeSandbox({
    access: opts.access,
    groupMemory,
    workingDirectory: opts.projectDir,
  });
  try {
    const frames = trackStream(
      {
        kind: "compact",
        label: "in place",
        provider: "claude",
        runKey: runKeyOf(opts),
      },
      signal,
      () =>
        claudeFrames({
          ctx,
          groupMemory,
          opts,
          prompt: COMPACT_COMMAND,
          sandbox,
          signal,
        })
    );
    // Read to the end, so the turn is recorded as done rather than abandoned.
    const state: ClaudeCompactState = { initialized: false };
    let outcome: CompactEvent | undefined;
    for await (const message of frames) {
      outcome = mapCompactMessage(message, state) ?? outcome;
    }
    if (outcome !== undefined) {
      yield outcome;
    }
  } finally {
    sandbox?.close();
  }
};

/** The access a helper turn runs under: no local tools, no web, no session. */
const HELPER_ACCESS = {
  ...LIGHT_ACCESS,
  sandbox: "none",
  webSearch: false,
} as const;

/**
 * Claude's `oneTurn`: the light model unless the request names one, no
 * tools, no session, in the view when the host has one. Each call spawns the
 * CLI. The judge runs only after a name hit and only when TypeSafe is missing
 * or failed, and the 2-slot side-turn pool and its 30 s timeout cap it.
 */
const claudeOneTurn: OneTurn = async (request) =>
  await trackTurn(
    { kind: request.kind, label: request.label, provider: "claude" },
    async () => {
      const sandbox = await openClaudeSandbox({
        access: HELPER_ACCESS,
        workingDirectory: request.workingDirectory,
      });
      try {
        const { query } = await loadClaudeSdk();
        const model = request.model ?? claudeLightPick().model;
        const options: Options = {
          ...claudeIsolation(),
          abortController: followSignal(request.signal),
          cwd: request.workingDirectory,
          env: runEnv({
            access: HELPER_ACCESS,
            granted: HELPER_ACCESS,
            provider: "claude",
          }),
          maxTurns: 1,
          model,
          permissionMode: "dontAsk",
          persistSession: false,
          systemPrompt: HELPER_INSTRUCTIONS,
          thinking: { type: "disabled" },
          tools: [],
        };
        const effort = claudeEffort(model, request.effort ?? "low");
        if (effort !== undefined) {
          options.effort = effort;
        }
        if (sandbox !== undefined) {
          options.spawnClaudeCodeProcess = sandbox.spawn;
        }
        for await (const message of query({
          options,
          prompt: inertPrompt(request.prompt),
        })) {
          if (message.type === "result") {
            if (message.subtype !== "success" || message.is_error) {
              throw new ProviderCrashed({
                message: `Claude helper turn failed (${message.subtype})`,
              });
            }
            return message.result;
          }
        }
        throw new ProviderCrashed({
          message: "Claude helper turn ended without a result",
        });
      } finally {
        sandbox?.close();
      }
    },
    request.signal
  );

/** Claude provider definition (Claude Agent SDK) */
export const claudeProvider: AgentProvider = {
  availability: claudeAvailability,
  capabilities: CLAUDE_CAPABILITIES,
  command: CLAUDE_COMMAND,
  compact,
  defaultEffort: "medium",
  defaultModel: claudeDefaultModel,
  displayName: "Claude",
  // The router's scale; each run clamps it to what its model offers.
  effortLevels: ROUTED_EFFORTS.map((id) => ({ id, label: id })),
  homeBinDirs: CLAUDE_HOME_BIN_DIRS,
  id: "claude",
  lightPick: claudeLightPick,
  mapEffort: claudeMapEffort,
  models: claudeModels,
  oneTurn: claudeOneTurn,
  oneTurnUses: ["format", "judge", "title"],
  // No `pastSessions`: the SDK's `listSessions` reads every session in the
  // config dir, the owner's own Claude Code sessions included, and nothing in
  // its answer tells the bot's runs apart.
  refreshModels: refreshClaudeModels,
  resolveStored: claudeResolveStored,
  run: runLive,
  stateRoots: claudeStateRoots(),
  tierModels: claudeTierModels,
  usage: claudeUsage,
};
