import type { Codex, RunResult, ThreadOptions } from "@openai/codex-sdk";

import { assertPosture } from "./access-narrow";
import { registerTurn } from "./agent-turns";
import { readLastTurnInputTokens } from "./codex-history";
import { inView, openCodexSandbox } from "./codex-sandbox";
import { newCodex } from "./codex-sdk";
import {
  buildCodexPrompt,
  CODEX_CAPABILITIES,
  COMPACT_SEED_OPENER,
  codexOptions,
  isSet,
  threadOptions,
} from "./codex-thread";
import { runKeyOf } from "./run-registry";
import type { AgentEvent, CompactEvent, RunContext, RunOptions } from "./types";

/** What the resumed session is asked to write before it is left behind. */
const SUMMARY_PROMPT = [
  "Write a handoff summary of this conversation for a fresh agent that has no",
  "history of it. Do not use any tools and do not change any files — reply with",
  "the summary only, no preamble. Cover, in order: what the user is trying to",
  "achieve; what has been done and the current state; the files, paths, commands",
  "and identifiers that matter, with exact names; the decisions made and why,",
  "including options rejected; the immediate next step. Prose, a few hundred",
  "words at most, specific over general — this text is the only context the next",
  "agent will have.",
].join(" ");

/** First input of the new session: context in, no work started. */
const seedInput = (summary: string) =>
  [
    COMPACT_SEED_OPENER,
    "",
    summary,
    "",
    "Acknowledge in one short line and wait for the user's next message. Do not start any work yet.",
  ].join("\n");

/**
 * The slice of the SDK compaction drives. Structural, so a test can hand it a
 * fake thread instead of spawning Codex.
 */
interface CompactThread {
  readonly id: string | null;
  run: (input: string, options: { signal: AbortSignal }) => Promise<RunResult>;
}

interface CompactClient {
  resumeThread: (id: string, options: ThreadOptions) => CompactThread;
  startThread: (options: ThreadOptions) => CompactThread;
}

/**
 * Context size of a session that has run exactly one turn: the input tokens of
 * that turn. `cached_input_tokens` is a subset of `input_tokens`, so the two are
 * never added. Valid only for a fresh thread — over several turns `usage`
 * accumulates and stops describing a context.
 */
const firstTurnContextTokens = (usage: RunResult["usage"]) =>
  usage === null ? undefined : usage.input_tokens;

const failed = (reason: string): CompactEvent => ({
  kind: "compact_failed",
  reason,
});

/** Run one turn, turning any rejection into words for the user. */
const takeTurn = async (
  turn: () => Promise<RunResult>,
  signal: AbortSignal
) => {
  try {
    return { ok: true as const, turn: await turn() };
  } catch (error) {
    return {
      ok: false as const,
      reason: signal.aborted
        ? "Stopped."
        : (error instanceof Error ? error.message : String(error)) ||
          "Compaction failed.",
    };
  }
};

/**
 * Summarize a session and seed a new one with the summary, succeeding with the
 * single terminal event. Nothing is written anywhere until both turns are done,
 * so every failure leaves the caller on the session it started from.
 */
export const compactWith = async (
  client: CompactClient,
  opts: RunOptions,
  signal: AbortSignal,
  contextTokensOf: (
    sessionId: string
  ) => number | undefined = readLastTurnInputTokens
): Promise<CompactEvent> => {
  const { sessionId } = opts;
  if (!isSet(sessionId)) {
    return failed("No session to compact.");
  }

  const summarized = await takeTurn(
    async () =>
      await client
        .resumeThread(sessionId, threadOptions(opts))
        .run(SUMMARY_PROMPT, { signal }),
    signal
  );
  if (!summarized.ok) {
    return failed(summarized.reason);
  }
  const summary = summarized.turn.finalResponse.trim();
  if (summary.length === 0) {
    return failed("The session produced no summary.");
  }
  // A /stop landing here must not leave a session nobody asked for.
  if (signal.aborted) {
    return failed("Stopped.");
  }
  // Read once the summarize turn has been written to the rollout: that turn
  // replayed the whole conversation, so its input size is the old context.
  const preTokens = contextTokensOf(sessionId);

  const fresh = client.startThread(threadOptions(opts));
  const seeded = await takeTurn(
    async () =>
      await fresh.run(
        buildCodexPrompt({
          ...opts,
          prompt: seedInput(summary),
          sessionId: undefined,
        }),
        { signal }
      ),
    signal
  );
  if (!seeded.ok) {
    return failed(seeded.reason);
  }
  // Codex populates the id once a turn has started; it is only null on a thread
  // that never ran, which the seed turn rules out.
  const fresherId = fresh.id;
  if (fresherId === null || fresherId.length === 0) {
    return failed("Codex reported no session id for the new session.");
  }

  const { usage } = seeded.turn;
  return {
    // As the run's `context` events count it: the request's input and output.
    contextTokens:
      usage === null ? undefined : usage.input_tokens + usage.output_tokens,
    kind: "compact_done",
    postTokens: firstTurnContextTokens(usage),
    preTokens,
    sessionId: fresherId,
  };
};

/**
 * Both turns of a compaction, summary and seed, as one registered entry: they
 * run back to back in the same slot and are stopped together.
 */
const registeredCompact = async (
  codex: Codex,
  opts: RunOptions,
  signal: AbortSignal
) => {
  const turn = registerTurn({
    kind: "compact",
    label: "handoff",
    provider: "codex",
    runKey: runKeyOf(opts),
  });
  let outcome: CompactEvent;
  try {
    outcome = await compactWith(codex, opts, signal);
  } catch (error) {
    turn.end("failed");
    throw error;
  }
  if (outcome.kind === "compact_done") {
    turn.end("done");
  } else {
    turn.end(signal.aborted ? "aborted" : "failed");
  }
  return outcome;
};

/**
 * Compact a Codex session. The SDK exposes no compaction call, so the session is
 * asked for a handoff summary and a new session is started from it: the
 * conversation continues, under a new session id.
 *
 * @yields {AgentEvent} exactly one terminal compact event.
 */
export const compact = async function* compact(
  opts: RunOptions,
  ctx: RunContext,
  signal: AbortSignal
): AsyncGenerator<AgentEvent, void, unknown> {
  assertPosture(CODEX_CAPABILITIES, opts.access);
  const groupMemory = { chatId: opts.chatId, userId: opts.userId };
  const sandbox = await openCodexSandbox({
    access: opts.access,
    groupMemory,
    workingDirectory: opts.projectDir,
  });
  let outcome: CompactEvent;
  try {
    const codex = await newCodex(
      codexOptions({
        access: opts.access,
        granted: opts.grantedAccess,
        groupMemory,
        mcpServers: ctx.mcpServers,
        owner: ctx.ownerSettings,
        sandbox,
      })
    );
    outcome = await registeredCompact(codex, inView(opts, sandbox), signal);
  } finally {
    sandbox?.close();
  }
  yield outcome;
};
