import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { ExecutionOutcome } from "@workspace/agent";
import type { TaskEntry } from "@workspace/db";

import { DEFAULT_LANGUAGE, switchLanguage } from "../i18n";
import { fireTask } from "./runner";
import type { RunnerDeps } from "./runner";

/** These cases check the Russian source copy. */
beforeAll(() => {
  switchLanguage("ru");
});
afterAll(() => {
  switchLanguage(DEFAULT_LANGUAGE);
});

const task = (overrides: Partial<TaskEntry> = {}): TaskEntry => ({
  createdAt: 0,
  cron: "0 9 * * *",
  enabled: true,
  id: 1,
  payload: "tools.gmail.me.work.list()",
  raw: false,
  title: "Inbox",
  type: "script",
  tz: "UTC",
  ...overrides,
});

/** Deps that fail loudly if a path calls something it should not. */
const deps = (overrides: Partial<RunnerDeps> = {}): RunnerDeps => ({
  execute: async () => await Promise.reject(new Error("execute not expected")),
  prettify: async () =>
    await Promise.reject(new Error("prettify not expected")),
  runPrompt: async () =>
    await Promise.reject(new Error("runPrompt not expected")),
  runRoute: async () =>
    await Promise.reject(new Error("runRoute not expected")),
  ...overrides,
});

/** A formatting pass that answers `answer`, or cannot answer at all. */
const formatterAnswering =
  (answer?: string): RunnerDeps["prettify"] =>
  async () =>
    await Promise.resolve(answer);

const ok = (
  overrides: Partial<Extract<ExecutionOutcome, { kind: "ok" }>> = {}
): ExecutionOutcome => ({ kind: "ok", text: "3 unread", ...overrides });

describe("fireTask: prompt tasks", () => {
  test("the agent's answer is delivered under the task title", async () => {
    const outcome = await fireTask(
      task({ type: "prompt" }),
      deps({
        runPrompt: async () => await Promise.resolve("Two things happened."),
      })
    );
    expect(outcome.status).toBe("ok");
    expect(outcome.text).toBe("Inbox\n\nTwo things happened.");
  });

  test("a failed run quotes its error, not retried", async () => {
    const outcome = await fireTask(
      task({ type: "prompt" }),
      deps({
        runPrompt: async () => await Promise.reject(new Error("codex crashed")),
      })
    );
    expect(outcome.status).toBe("error");
    expect(outcome.text).toContain("Не получилось");
    expect(outcome.text).toContain("«codex crashed»");
  });

  test("an empty answer counts as a failure", async () => {
    const outcome = await fireTask(
      task({ type: "prompt" }),
      deps({ runPrompt: async () => await Promise.resolve("   ") })
    );
    expect(outcome.status).toBe("error");
  });
});

describe("fireTask: script tasks", () => {
  test("output goes through the formatting pass by default", async () => {
    const seen: { result: string; title: string }[] = [];
    const outcome = await fireTask(
      task(),
      deps({
        execute: async () => await Promise.resolve(ok()),
        prettify: async (args) => {
          seen.push(args);
          return await Promise.resolve("You have 3 unread messages.");
        },
      })
    );
    expect(outcome).toEqual({
      status: "ok",
      text: "Inbox\n\nYou have 3 unread messages.",
    });
    expect(seen).toEqual([{ result: "3 unread", title: "Inbox" }]);
  });

  test("a formatting pass that cannot answer falls back to the raw output", async () => {
    const outcome = await fireTask(
      task(),
      deps({
        execute: async () => await Promise.resolve(ok()),
        prettify: formatterAnswering(),
      })
    );
    expect(outcome.text).toBe("Inbox\n\n3 unread");
  });

  test("a raw task never calls the formatting pass", async () => {
    const outcome = await fireTask(
      task({ raw: true }),
      deps({ execute: async () => await Promise.resolve(ok()) })
    );
    expect(outcome).toEqual({ status: "ok", text: "Inbox\n\n3 unread" });
  });

  test("structured output is sent when there is no text", async () => {
    const outcome = await fireTask(
      task({ raw: true }),
      deps({
        execute: async () =>
          await Promise.resolve(ok({ structured: { unread: 3 }, text: "" })),
      })
    );
    expect(outcome.text).toContain('"unread": 3');
  });

  test("an execution with nothing at all still says so", async () => {
    const outcome = await fireTask(
      task({ raw: true }),
      deps({ execute: async () => await Promise.resolve(ok({ text: "" })) })
    );
    expect(outcome.text).toBe("Inbox\n\n(пусто)");
  });

  test("a failed execution quotes its error", async () => {
    const outcome = await fireTask(
      task(),
      deps({
        execute: async () =>
          await Promise.resolve({ kind: "failed", message: "token expired" }),
      })
    );
    expect(outcome.status).toBe("error");
    expect(outcome.text).toContain("Не получилось");
    expect(outcome.text).toContain("«token expired»");
  });

  test("a paused execution warns with the id needed to resume it", async () => {
    const outcome = await fireTask(
      task(),
      deps({
        execute: async () =>
          await Promise.resolve({
            executionId: "exec_42",
            kind: "paused",
            resume: "rest",
            text: "",
          }),
      })
    );
    expect(outcome.status).toBe("paused");
    expect(outcome.text).toContain("exec_42");
  });
});
