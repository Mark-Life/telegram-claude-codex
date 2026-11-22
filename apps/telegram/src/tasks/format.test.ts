import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { TaskEntry } from "@workspace/db";

import { DEFAULT_LANGUAGE, switchLanguage } from "../i18n";
import { describeNextRun, describeTask, parseTaskDraft } from "./format";
import type { TaskParseResult } from "./format";

/** These cases check the Russian source copy. */
beforeAll(() => {
  switchLanguage("ru");
});
afterAll(() => {
  switchLanguage(DEFAULT_LANGUAGE);
});

/** What a refused form complained about; undefined when it parsed. */
const problemOf = (parsed: TaskParseResult) =>
  parsed.ok ? undefined : parsed.problem;

const FORM = [
  "",
  "title: Morning digest",
  "cron: 0 9 * * *",
  "tz: Europe/Berlin",
  "type: prompt",
  "---",
  "Summarize my inbox.",
].join("\n");

const task = (overrides: Partial<TaskEntry> = {}): TaskEntry => ({
  createdAt: 0,
  cron: "0 9 * * *",
  enabled: true,
  id: 3,
  payload: "p",
  raw: false,
  title: "Morning digest",
  type: "prompt",
  tz: "Europe/Berlin",
  ...overrides,
});

describe("parseTaskDraft", () => {
  test("reads the header fields and the payload below the separator", () => {
    const parsed = parseTaskDraft(FORM);
    expect(parsed).toEqual({
      draft: {
        cron: "0 9 * * *",
        enabled: undefined,
        payload: "Summarize my inbox.",
        project: undefined,
        raw: undefined,
        title: "Morning digest",
        type: "prompt",
        tz: "Europe/Berlin",
      },
      ok: true,
      silent: false,
    });
  });

  test("optional flags are read when present", () => {
    const parsed = parseTaskDraft(
      [
        "title: Fetch",
        "cron: 0 * * * *",
        "tz: UTC",
        "type: script",
        "raw: true",
        "enabled: false",
        "project: /tmp/x",
        "---",
        "tools.gmail.me.work.list()",
      ].join("\n")
    );
    expect(parsed).toMatchObject({
      draft: { enabled: false, project: "/tmp/x", raw: true, type: "script" },
      ok: true,
    });
  });

  test("a payload keeps its own blank lines and indentation", () => {
    const parsed = parseTaskDraft(
      [
        "title: T",
        "cron: 0 9 * * *",
        "tz: UTC",
        "type: script",
        "---",
        "const a = 1;",
        "",
        "  return a;",
      ].join("\n")
    );
    expect(parsed.ok && parsed.draft.payload).toBe(
      "const a = 1;\n\n  return a;"
    );
  });

  test("missing header fields are named", () => {
    const parsed = parseTaskDraft("cron: 0 9 * * *\n---\nrun");
    expect(parsed).toMatchObject({ ok: false });
    expect(problemOf(parsed)).toContain("title");
  });

  test("an unknown type is refused", () => {
    const parsed = parseTaskDraft(
      "title: T\ncron: 0 9 * * *\ntz: UTC\ntype: telepathy\n---\nrun"
    );
    expect(problemOf(parsed)).toContain("prompt");
  });

  test("a form with no payload is refused", () => {
    const parsed = parseTaskDraft(
      "title: T\ncron: 0 9 * * *\ntz: UTC\ntype: prompt"
    );
    expect(problemOf(parsed)).toContain("---");
  });

  test("an unrunnable schedule is refused with the reason", () => {
    const parsed = parseTaskDraft(
      "title: T\ncron: 0 9 * * *\ntz: Mars/Olympus\ntype: prompt\n---\nrun"
    );
    expect(problemOf(parsed)).toContain("Mars/Olympus");
  });
});

describe("describeTask", () => {
  test("an enabled task shows its next run", () => {
    const text = describeTask(task(), new Date("2026-03-01T00:00:00Z"));
    expect(text).toContain("#3 Morning digest");
    expect(text).toContain("0 9 * * *");
    expect(text).toContain("дальше ");
    expect(text).toContain("ещё не запускалось");
  });

  test("a paused task says so instead", () => {
    expect(describeTask(task({ enabled: false }))).toContain("на паузе");
  });

  test("a task that ran reports its last outcome", () => {
    const text = describeTask(
      task({ lastRunAt: Date.parse("2026-03-01T09:00:00Z"), lastStatus: "ok" })
    );
    expect(text).toContain("прошлый раз успешно");
  });

  test("the next run is rendered in the task's own timezone", () => {
    const from = new Date("2026-03-01T00:00:00Z");
    expect(describeNextRun(task({ tz: "UTC" }), from)).toContain("09:00");
    expect(describeNextRun(task({ tz: "Europe/Berlin" }), from)).toContain(
      "09:00"
    );
  });

  test("html in a title cannot break the message", () => {
    expect(describeTask(task({ title: "<b>x</b>" }))).toContain("&lt;b&gt;");
  });
});
