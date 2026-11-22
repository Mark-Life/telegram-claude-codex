import { describe, expect, test } from "bun:test";

import { runKeyOf } from "@workspace/agent";
import type { Context } from "grammy";

import { parseChatId } from "../handlers/workspace";
import {
  requireRoute,
  routeKey,
  routeOf,
  threadIdOf,
  threadOpts,
} from "./route";

/**
 * A grammy Context reduced to what routing reads: the chat and `ctx.msg`, the
 * message an update is about (a plain message, or a callback query's message).
 */
const fakeCtx = (over: {
  chatId?: number;
  isTopicMessage?: true;
  threadId?: number;
}) =>
  // SAFETY: routing reads only `ctx.chat` and `ctx.msg`; every other grammy
  // Context member is unreachable from these tests.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- Context carries 200+ members no fake can supply
  ({
    chat: over.chatId === undefined ? undefined : { id: over.chatId },
    msg: {
      is_topic_message: over.isTopicMessage,
      message_thread_id: over.threadId,
    },
  }) as unknown as Context;

describe("threadIdOf", () => {
  test("a topic message routes to its topic", () => {
    expect(
      threadIdOf(fakeCtx({ chatId: -100, isTopicMessage: true, threadId: 7 }))
    ).toBe(7);
  });

  test("messages outside a topic route to null", () => {
    expect(threadIdOf(fakeCtx({ chatId: -100 }))).toBeNull();
    expect(threadIdOf(fakeCtx({ chatId: 42 }))).toBeNull();
  });

  test("a reply thread outside a forum is not a topic", () => {
    // Non-forum supergroups put a message_thread_id on replies too; only
    // is_topic_message means a real topic.
    expect(threadIdOf(fakeCtx({ chatId: -100, threadId: 7 }))).toBeNull();
  });
});

describe("routeOf", () => {
  test("carries the chat and the topic", () => {
    expect(
      routeOf(fakeCtx({ chatId: -100, isTopicMessage: true, threadId: 7 }))
    ).toEqual({ chatId: -100, threadId: 7 });
  });

  test("an update with no chat has no route", () => {
    expect(routeOf(fakeCtx({}))).toBeNull();
    expect(() => requireRoute(fakeCtx({}))).toThrow("No chat context");
  });
});

describe("threadOpts", () => {
  test("adds message_thread_id only inside a topic", () => {
    expect(threadOpts({ chatId: -100, threadId: 7 })).toEqual({
      message_thread_id: 7,
    });
    expect(threadOpts({ chatId: -100, threadId: null })).toEqual({});
  });
});

describe("routeKey", () => {
  test("separates topics of one chat and keeps the General topic distinct", () => {
    const general = routeKey({ chatId: -100, threadId: null });
    const first = routeKey({ chatId: -100, threadId: 7 });
    const second = routeKey({ chatId: -100, threadId: 8 });
    expect(new Set([general, first, second]).size).toBe(3);
  });

  test("the same route always derives the same key", () => {
    expect(routeKey({ chatId: -100, threadId: 7 })).toBe(
      routeKey({ chatId: -100, threadId: 7 })
    );
  });

  test("one topic id in two chats is two routes", () => {
    expect(routeKey({ chatId: -100, threadId: 7 })).not.toBe(
      routeKey({ chatId: -200, threadId: 7 })
    );
  });
});

describe("runKeyOf", () => {
  test("topics of one chat get their own run slot", () => {
    const first = runKeyOf({ chatId: -100, threadId: 7, userId: 1 });
    const second = runKeyOf({ chatId: -100, threadId: 8, userId: 1 });
    expect(first).not.toBe(second);
  });

  test("no topic collapses to the chat's single slot", () => {
    const absent = runKeyOf({ chatId: 42, userId: 1 });
    expect(runKeyOf({ chatId: 42, threadId: null, userId: 1 })).toBe(absent);
    expect(runKeyOf({ chatId: 42, threadId: 7, userId: 1 })).not.toBe(absent);
  });

  test("two users in one topic never share a slot", () => {
    expect(runKeyOf({ chatId: -100, threadId: 7, userId: 1 })).not.toBe(
      runKeyOf({ chatId: -100, threadId: 7, userId: 2 })
    );
  });
});

describe("parseChatId", () => {
  test("falls back when nothing usable is stored", () => {
    expect(parseChatId(undefined, 42)).toBe(42);
    expect(parseChatId("", 42)).toBe(42);
    expect(parseChatId("not-a-chat", 42)).toBe(42);
  });

  test("reads a stored (negative) supergroup id", () => {
    expect(parseChatId("-1001234567890", 42)).toBe(-1_001_234_567_890);
  });
});
