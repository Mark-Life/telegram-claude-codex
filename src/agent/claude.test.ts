import { expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  type CompactState,
  compactEventOf,
  observeCompactMessage,
} from "./claude";
import { userTurns } from "./claude-input";
import type { RunOptions } from "./types";

const opts = (prompt: string) =>
  ({ prompt, chatId: 1, projectDir: "/tmp", userId: 1 }) as RunOptions;

test("userTurns yields the initial user turn as a streaming SDKUserMessage", async () => {
  const gen = userTurns(opts("hello"), new Promise<void>(() => undefined));
  const first = await gen.next();
  expect(first.done).toBe(false);
  expect(first.value).toEqual({
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: "hello" },
  });
});

/** Fold a captured `/compact` message stream the way the provider run does. */
const foldMessages = (messages: unknown[]) => {
  const state: CompactState = { failure: "", resultText: "" };
  for (const msg of messages) {
    observeCompactMessage(state, msg as SDKMessage);
  }
  return compactEventOf(state);
};

// The message shapes below are verbatim from a real `/compact` run against
// claude-agent-sdk 0.3.280 (trimmed to the fields the fold reads).
test("compaction that ran reports the boundary's token counts", () => {
  expect(
    foldMessages([
      { type: "system", subtype: "status", status: "compacting" },
      {
        type: "system",
        subtype: "status",
        status: null,
        compact_result: "success",
      },
      {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: {
          trigger: "manual",
          pre_tokens: 23_871,
          post_tokens: 5393,
          duration_ms: 53_576,
        },
      },
      { type: "result", subtype: "success", result: "" },
    ])
  ).toEqual({ kind: "compact_done", preTokens: 23_871, postTokens: 5393 });
});

test("a boundary without post_tokens reports only what was measured", () => {
  expect(
    foldMessages([
      {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "manual", pre_tokens: 900 },
      },
      { type: "result", subtype: "success", result: "" },
    ])
  ).toEqual({ kind: "compact_done", preTokens: 900, postTokens: undefined });
});

test("the CLI declining surfaces its own reason, not a success", () => {
  expect(
    foldMessages([
      { type: "system", subtype: "status", status: "compacting" },
      {
        type: "system",
        subtype: "status",
        status: null,
        compact_result: "failed",
        compact_error: "Not enough messages to compact.",
      },
      {
        type: "result",
        subtype: "success",
        result: "Not enough messages to compact.",
      },
    ])
  ).toEqual({
    kind: "compact_failed",
    reason: "Not enough messages to compact.",
  });
});

test("an error result fails with the run's errors", () => {
  expect(
    foldMessages([
      { type: "result", subtype: "error_during_execution", errors: ["boom"] },
    ])
  ).toEqual({ kind: "compact_failed", reason: "boom" });
});

test("a silent stream still fails with words", () => {
  expect(foldMessages([])).toEqual({
    kind: "compact_failed",
    reason: "Compaction reported no result.",
  });
});

test("userTurns stays open until `closed` resolves, then ends", async () => {
  let close: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  const gen = userTurns(opts("hi"), closed);
  await gen.next(); // consume the initial turn

  let settled = false;
  const pending = gen.next().then((r) => {
    settled = true;
    return r;
  });
  // Give the microtask queue a chance; the stream must still be open.
  await Promise.resolve();
  expect(settled).toBe(false);

  close();
  const done = await pending;
  expect(done.done).toBe(true);
});
