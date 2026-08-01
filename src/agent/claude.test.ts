import { expect, test } from "bun:test";
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
