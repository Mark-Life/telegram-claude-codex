import { describe, expect, test } from "bun:test";
import type { Context } from "grammy";
import {
  requireRoute,
  routeKey,
  routeOf,
  threadIdOf,
  threadOpts,
} from "./route";

/** Minimal grammy context stand-in: only `chat` and `msg` are read. */
const ctxOf = (chat: unknown, msg?: unknown) => ({ chat, msg }) as Context;

const topic = ctxOf(
  { id: -100 },
  { message_thread_id: 42, is_topic_message: true }
);
const replyThread = ctxOf({ id: -100 }, { message_thread_id: 42 });
const privateChat = ctxOf({ id: 7 }, { message_thread_id: undefined });
const noChat = ctxOf(undefined, {
  message_thread_id: 42,
  is_topic_message: true,
});

describe("threadIdOf", () => {
  const cases: [string, Context, number | null][] = [
    ["forum topic", topic, 42],
    ["reply thread in a non-forum supergroup", replyThread, null],
    ["private chat", privateChat, null],
    ["no message", ctxOf({ id: 7 }), null],
  ];
  for (const [name, ctx, expected] of cases) {
    test(name, () => expect(threadIdOf(ctx)).toBe(expected));
  }
});

describe("routeOf", () => {
  test("keeps the topic id", () =>
    expect(routeOf(topic)).toEqual({ chatId: -100, threadId: 42 }));
  test("drops a reply thread id", () =>
    expect(routeOf(replyThread)).toEqual({ chatId: -100, threadId: null }));
  test("null without a chat", () => expect(routeOf(noChat)).toBeNull());
});

describe("requireRoute", () => {
  test("throws without a chat", () =>
    expect(() => requireRoute(noChat)).toThrow());
  test("returns the route otherwise", () =>
    expect(requireRoute(privateChat)).toEqual({ chatId: 7, threadId: null }));
});

describe("threadOpts / routeKey", () => {
  test("topic route", () => {
    const route = { chatId: -100, threadId: 42 };
    expect(threadOpts(route)).toEqual({ message_thread_id: 42 });
    expect(routeKey(route)).toBe("-100:42");
  });
  test("main route", () => {
    const route = { chatId: 7, threadId: null };
    expect(threadOpts(route)).toEqual({});
    expect(routeKey(route)).toBe("7:main");
  });
});
