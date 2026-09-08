import { describe, expect, test } from "bun:test";
import { stateKeyOf } from "./user-state";

describe("stateKeyOf", () => {
  test("a topic keys apart from the chat it lives in", () => {
    const main = stateKeyOf({ chatId: -100, threadId: null, userId: 7 });
    const topic = stateKeyOf({ chatId: -100, threadId: 42, userId: 7 });
    expect(main).toBe("7:-100:main");
    expect(topic).toBe("7:-100:42");
  });

  test("two topics of one chat never share a key", () => {
    const first = stateKeyOf({ chatId: -100, threadId: 1, userId: 7 });
    const second = stateKeyOf({ chatId: -100, threadId: 2, userId: 7 });
    expect(first).not.toBe(second);
  });

  test("the same route for two users keys apart", () => {
    const mine = stateKeyOf({ chatId: -100, threadId: 1, userId: 7 });
    const theirs = stateKeyOf({ chatId: -100, threadId: 1, userId: 8 });
    expect(mine).not.toBe(theirs);
  });
});
