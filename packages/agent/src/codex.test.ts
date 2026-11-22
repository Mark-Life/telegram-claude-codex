import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import type { RunResult } from "@openai/codex-sdk";

import { BOT_SKILLS, botSkillFile } from "./bot-skills";
import { compactWith } from "./codex-compact";
import { OWNER_ACCESS } from "./types";
import type { RunOptions } from "./types";

describe("bot skills", () => {
  // Each provider is handed these paths, a link among them, so a wrong one
  // fails only when the agent runs. Nothing else catches it.
  test("point at files that exist", () => {
    for (const skill of BOT_SKILLS) {
      expect(existsSync(botSkillFile(skill))).toBe(true);
    }
  });
});

const turnOf = (
  finalResponse: string,
  usage: RunResult["usage"] = null
): RunResult => ({ finalResponse, items: [], usage });

/** `cached_input_tokens` is a subset of `input_tokens`, as the SDK reports it. */
const usageOf = (input: number, cached: number): RunResult["usage"] => ({
  cache_write_input_tokens: 0,
  cached_input_tokens: cached,
  input_tokens: input,
  output_tokens: 7,
  reasoning_output_tokens: 11,
});

/** Replay a scripted turn: an Error rejects it, a turn resolves it. */
const replay = async (scripted: RunResult | Error) => {
  await Bun.sleep(0);
  if (scripted instanceof Error) {
    throw scripted;
  }
  return scripted;
};

/** What the compaction asked of the client, in order. */
interface Calls {
  resumed: string[];
  seeds: string[];
  starts: number;
}

/** A Codex stand-in: records what it was asked, replies from the script. */
const makeClient = (script: {
  newId?: string | null;
  onSummary?: () => void;
  seed?: RunResult | Error;
  summary: RunResult | Error;
}) => {
  const calls: Calls = { resumed: [], seeds: [], starts: 0 };
  const client = {
    resumeThread: (id: string) => {
      calls.resumed.push(id);
      return {
        id,
        run: async () => {
          script.onSummary?.();
          return await replay(script.summary);
        },
      };
    },
    startThread: () => {
      calls.starts += 1;
      return {
        id: script.newId === undefined ? "session-2" : script.newId,
        run: async (input: string) => {
          calls.seeds.push(input);
          return await replay(script.seed ?? turnOf("Ready."));
        },
      };
    },
  };
  return { calls, client };
};

const OPTS: RunOptions = {
  access: OWNER_ACCESS,
  chatId: 42,
  persona: { callName: "Assistant", gender: "male", ownerName: undefined },
  projectDir: "/tmp",
  prompt: "",
  sessionId: "session-1",
  userId: 42,
};

/**
 * Run a compaction with the old session's context size supplied, so the test
 * never reaches for a rollout file on disk.
 */
const runCompaction = async (
  client: Parameters<typeof compactWith>[0],
  options: {
    opts?: RunOptions;
    preTokens?: number;
    signal?: AbortSignal;
  } = {}
) =>
  await compactWith(
    client,
    options.opts ?? OPTS,
    options.signal ?? new AbortController().signal,
    () => options.preTokens
  );

describe("codex compaction", () => {
  test("summarizes the old session and seeds a new one", async () => {
    const { calls, client } = makeClient({
      seed: turnOf("Ready.", usageOf(900, 100)),
      summary: turnOf("  We are porting /compact.  ", usageOf(20_000, 3871)),
    });

    const outcome = await runCompaction(client, { preTokens: 20_000 });

    expect(outcome).toEqual({
      contextTokens: 907,
      kind: "compact_done",
      postTokens: 900,
      preTokens: 20_000,
      sessionId: "session-2",
    });
    expect(calls.resumed).toEqual(["session-1"]);
    // The seed carries the summary and the first-turn instructions a fresh
    // session would otherwise never see.
    expect(calls.seeds[0]).toContain("We are porting /compact.");
    expect(calls.seeds[0]).toContain("bot-send-file");
  });

  test("omits token counts when the SDK reports no usage", async () => {
    const { client } = makeClient({ summary: turnOf("Summary.") });

    const outcome = await runCompaction(client);

    expect(outcome).toEqual({
      kind: "compact_done",
      postTokens: undefined,
      preTokens: undefined,
      sessionId: "session-2",
    });
  });

  test("declines when there is no session to compact", async () => {
    const { calls, client } = makeClient({ summary: turnOf("Summary.") });

    const outcome = await runCompaction(client, {
      opts: { ...OPTS, sessionId: undefined },
    });

    expect(outcome).toEqual({
      kind: "compact_failed",
      reason: "No session to compact.",
    });
    expect(calls.resumed).toEqual([]);
  });

  test("an empty summary starts no session", async () => {
    const { calls, client } = makeClient({ summary: turnOf("   ") });

    const outcome = await runCompaction(client);

    expect(outcome).toEqual({
      kind: "compact_failed",
      reason: "The session produced no summary.",
    });
    expect(calls.starts).toBe(0);
  });

  test("a stop between the passes starts no session", async () => {
    const ac = new AbortController();
    const { calls, client } = makeClient({
      onSummary: () => {
        ac.abort();
      },
      summary: turnOf("Summary."),
    });

    const outcome = await runCompaction(client, { signal: ac.signal });

    expect(outcome).toEqual({ kind: "compact_failed", reason: "Stopped." });
    expect(calls.starts).toBe(0);
  });

  test("a failed summarize turn reports the SDK's message", async () => {
    const { calls, client } = makeClient({
      summary: new Error("session file vanished"),
    });

    const outcome = await runCompaction(client);

    expect(outcome).toEqual({
      kind: "compact_failed",
      reason: "session file vanished",
    });
    expect(calls.starts).toBe(0);
  });

  test("an aborted turn reports the stop, not the SDK's message", async () => {
    const ac = new AbortController();
    const { client } = makeClient({
      onSummary: () => {
        ac.abort();
      },
      summary: new Error("The operation was aborted"),
    });

    const outcome = await runCompaction(client, { signal: ac.signal });

    expect(outcome).toEqual({ kind: "compact_failed", reason: "Stopped." });
  });

  test("a new session without an id is not handed back", async () => {
    const { client } = makeClient({ newId: null, summary: turnOf("Summary.") });

    const outcome = await runCompaction(client);

    expect(outcome).toEqual({
      kind: "compact_failed",
      reason: "Codex reported no session id for the new session.",
    });
  });
});
