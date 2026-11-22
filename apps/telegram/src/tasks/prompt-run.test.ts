import { describe, expect, test } from "bun:test";

import type { AgentEvent } from "@workspace/agent/types";
import { Effect, Stream } from "effect";

import { collectFinalText } from "../runs/headless-run";
import { scheduledRunKey } from "./prompt-run";

/** Replay a fixed event list as the stream a run hands back. */
const stream = (events: readonly AgentEvent[]) => Stream.fromIterable(events);

const collect = async (events: Stream.Stream<AgentEvent>) =>
  await Effect.runPromise(collectFinalText(events));

const result = (text: string): AgentEvent => ({
  durationMs: 10,
  kind: "result",
  sessionId: "s1",
  text,
});

describe("scheduledRunKey", () => {
  test("a scheduled run never shares a slot with a conversation", () => {
    const key = scheduledRunKey({ chatId: -100, ownerId: 7, taskId: 3 });
    expect(key).toEqual({ chatId: -100, threadId: -3, userId: 7 });
    // Forum topic ids are positive, so no chat can collide with this slot.
    expect(key.threadId).toBeLessThan(0);
  });

  test("two tasks get slots of their own", () => {
    const a = scheduledRunKey({ chatId: 1, ownerId: 7, taskId: 1 });
    const b = scheduledRunKey({ chatId: 1, ownerId: 7, taskId: 2 });
    expect(a.threadId).not.toBe(b.threadId);
  });
});

describe("collectFinalText", () => {
  test("the final result text is what gets delivered", async () => {
    const events = stream([
      { kind: "text_message", text: "partial" },
      result("the answer"),
    ]);
    expect(await collect(events)).toBe("the answer");
  });

  test("an error with no result throws so the task is marked failed", async () => {
    const events = stream([{ kind: "error", message: "provider crashed" }]);
    const failure = await Effect.runPromise(
      Effect.flip(collectFinalText(events))
    );
    expect(failure.message).toBe("provider crashed");
  });

  test("an error after a result keeps the result", async () => {
    const events = stream([
      result("partial answer"),
      { kind: "error", message: "stream broke" },
    ]);
    expect(await collect(events)).toBe("partial answer");
  });

  test("a stream with nothing in it comes back empty", async () => {
    expect(await collect(stream([]))).toBe("");
  });
});
