import { describe, expect, test } from "bun:test";

import { createRepeatGuard, REPEAT_WINDOW_MS } from "./repeat-guard";

const CHAT = 1001;
const OTHER_CHAT = 42;
const VOICE =
  "добавь в заметки список покупок молоко хлеб яйца и напомни вечером";

/** A guard on a clock the test moves by hand. */
const guardAt = () => {
  let time = 0;
  const guard = createRepeatGuard({ now: () => time });
  return {
    guard,
    wait: (ms: number) => {
      time += ms;
    },
  };
};

describe("repeat guard", () => {
  test("the same words from one chat seconds apart are a repeat", () => {
    const { guard, wait } = guardAt();
    expect(guard.isRepeat({ chatId: CHAT, text: VOICE })).toBe(false);
    wait(8000);
    expect(guard.isRepeat({ chatId: CHAT, text: ` ${VOICE}\n` })).toBe(true);
  });

  test("the same words after the window are new", () => {
    const { guard, wait } = guardAt();
    guard.isRepeat({ chatId: CHAT, text: VOICE });
    wait(REPEAT_WINDOW_MS);
    expect(guard.isRepeat({ chatId: CHAT, text: VOICE })).toBe(false);
  });

  test("a repeat does not extend the window", () => {
    const { guard, wait } = guardAt();
    guard.isRepeat({ chatId: CHAT, text: VOICE });
    wait(REPEAT_WINDOW_MS - 1);
    expect(guard.isRepeat({ chatId: CHAT, text: VOICE })).toBe(true);
    wait(1);
    expect(guard.isRepeat({ chatId: CHAT, text: VOICE })).toBe(false);
  });

  test("other words and other chats are not repeats", () => {
    const { guard } = guardAt();
    guard.isRepeat({ chatId: CHAT, text: VOICE });
    expect(guard.isRepeat({ chatId: OTHER_CHAT, text: VOICE })).toBe(false);
    expect(guard.isRepeat({ chatId: CHAT, text: `${VOICE}, срочно` })).toBe(
      false
    );
  });

  test("short replies are never repeats", () => {
    const { guard } = guardAt();
    expect(guard.isRepeat({ chatId: CHAT, text: "да, продолжай" })).toBe(false);
    expect(guard.isRepeat({ chatId: CHAT, text: "да, продолжай" })).toBe(false);
  });
});
