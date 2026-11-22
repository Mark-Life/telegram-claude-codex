import { describe, expect, test } from "bun:test";

import { Effect, Option } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  isValidSchedule,
  isValidTimeZone,
  nextRunAt,
  validateSchedule,
} from "./cron";
import { TasksRepo } from "./tasks";
import type { TaskDraft } from "./tasks";
import { makeTestDb } from "./testing";

const DRAFT: TaskDraft = {
  cron: "0 9 * * *",
  payload: "Summarize my inbox",
  title: "Morning digest",
  type: "prompt",
  tz: "Europe/Berlin",
};

/** Run one effect against a fresh `TasksRepo` over the test file. */
const withRepo = async <A, E>(
  db: ReturnType<typeof makeTestDb>,
  body: (repo: TasksRepo["Service"]) => Effect.Effect<A, E, SqlClient.SqlClient>
) => await db.run(TasksRepo.use(body).pipe(Effect.provide(TasksRepo.layer)));

describe("TasksRepo", () => {
  test("a created task comes back enabled, prettified and never run", async () => {
    const db = makeTestDb();
    try {
      const created = await withRepo(db, (repo) => repo.create(DRAFT));
      expect(created).toMatchObject({
        cron: "0 9 * * *",
        enabled: true,
        payload: "Summarize my inbox",
        raw: false,
        title: "Morning digest",
        type: "prompt",
        tz: "Europe/Berlin",
      });
      expect(created.lastRunAt).toBeUndefined();
      expect(created.lastStatus).toBeUndefined();
      expect(created.project).toBeUndefined();
    } finally {
      db.cleanup();
    }
  });

  test("draft flags override the defaults", async () => {
    const db = makeTestDb();
    try {
      const created = await withRepo(db, (repo) =>
        repo.create({
          ...DRAFT,
          enabled: false,
          project: "/tmp/project",
          raw: true,
          type: "script",
        })
      );
      expect(created).toMatchObject({
        enabled: false,
        project: "/tmp/project",
        raw: true,
        type: "script",
      });
    } finally {
      db.cleanup();
    }
  });

  test("list returns every task, oldest first", async () => {
    const db = makeTestDb();
    try {
      const titles = await withRepo(db, (repo) =>
        Effect.gen(function* listTitles() {
          yield* repo.create(DRAFT);
          yield* repo.create({ ...DRAFT, title: "Second" });
          const tasks = yield* repo.list();
          return tasks.map((task) => task.title);
        })
      );
      expect(titles).toEqual(["Morning digest", "Second"]);
    } finally {
      db.cleanup();
    }
  });

  test("a task survives closing and reopening the db", async () => {
    const db = makeTestDb();
    try {
      const { id } = await withRepo(db, (repo) => repo.create(DRAFT));
      const found = await withRepo(db, (repo) => repo.get(id));
      expect(Option.getOrThrow(found).title).toBe("Morning digest");
    } finally {
      db.cleanup();
    }
  });

  test("update changes only the fields it carries", async () => {
    const db = makeTestDb();
    try {
      const updated = await withRepo(db, (repo) =>
        Effect.gen(function* edit() {
          const { id } = yield* repo.create(DRAFT);
          return yield* repo.update(id, { enabled: false });
        })
      );
      expect(Option.getOrThrow(updated)).toMatchObject({
        cron: "0 9 * * *",
        enabled: false,
        title: "Morning digest",
      });
    } finally {
      db.cleanup();
    }
  });

  test("an empty patch is a no-op that still returns the task", async () => {
    const db = makeTestDb();
    try {
      const { stored, updated } = await withRepo(db, (repo) =>
        Effect.gen(function* edit() {
          const { id } = yield* repo.create(DRAFT);
          const afterPatch = yield* repo.update(id, {});
          const current = yield* repo.get(id);
          return { stored: current, updated: afterPatch };
        })
      );
      expect(Option.isSome(updated)).toBe(true);
      expect(updated).toEqual(stored);
    } finally {
      db.cleanup();
    }
  });

  test("recordRun stores the outcome of the last fire", async () => {
    const db = makeTestDb();
    try {
      const updated = await withRepo(db, (repo) =>
        Effect.gen(function* fire() {
          const { id } = yield* repo.create(DRAFT);
          return yield* repo.recordRun({
            finishedAt: 1_700_000_000,
            startedAt: 1_699_999_000,
            status: "error",
            taskId: id,
          });
        })
      );
      expect(Option.getOrThrow(updated)).toMatchObject({
        lastRunAt: 1_700_000_000,
        lastStatus: "error",
      });
    } finally {
      db.cleanup();
    }
  });

  test("drop forgets the task and reports whether there was one", async () => {
    const db = makeTestDb();
    try {
      const outcome = await withRepo(db, (repo) =>
        Effect.gen(function* forget() {
          const { id } = yield* repo.create(DRAFT);
          const first = yield* repo.drop(id);
          const after = yield* repo.get(id);
          const second = yield* repo.drop(id);
          return { after, first, second };
        })
      );
      expect(outcome).toEqual({
        after: Option.none(),
        first: true,
        second: false,
      });
    } finally {
      db.cleanup();
    }
  });

  test("a row of an unknown type reads as absent", async () => {
    const db = makeTestDb();
    try {
      const reads = await withRepo(db, (repo) =>
        Effect.gen(function* alien() {
          const sql = yield* SqlClient.SqlClient;
          const { id } = yield* repo.create(DRAFT);
          yield* sql`UPDATE tasks SET type = 'telepathy' WHERE id = ${id}`;
          const one = yield* repo.get(id);
          const all = yield* repo.list();
          return { all, one };
        })
      );
      expect(reads).toEqual({ all: [], one: Option.none() });
    } finally {
      db.cleanup();
    }
  });

  test("an unknown stored status reads as never run", async () => {
    const db = makeTestDb();
    try {
      const found = await withRepo(db, (repo) =>
        Effect.gen(function* alien() {
          const sql = yield* SqlClient.SqlClient;
          const { id } = yield* repo.create(DRAFT);
          yield* sql`UPDATE tasks SET last_status = 'whatever' WHERE id = ${id}`;
          return yield* repo.get(id);
        })
      );
      expect(Option.getOrThrow(found).lastStatus).toBeUndefined();
    } finally {
      db.cleanup();
    }
  });
});

describe("schedule validation", () => {
  test("a daily expression in a real zone is valid", () => {
    expect(isValidSchedule({ cron: "0 9 * * *", tz: "Europe/Berlin" })).toBe(
      true
    );
    expect(validateSchedule({ cron: "0 9 * * *", tz: "UTC" })).toBeUndefined();
  });

  test("junk cron is refused with the expression named", () => {
    const problem = validateSchedule({ cron: "every morning", tz: "UTC" });
    expect(problem).toContain("every morning");
  });

  test("an unknown timezone is refused before the cron is parsed", () => {
    const problem = validateSchedule({ cron: "0 9 * * *", tz: "Mars/Olympus" });
    expect(problem).toContain("Mars/Olympus");
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("America/New_York")).toBe(true);
  });

  test("a date that never occurs is refused", () => {
    expect(isValidSchedule({ cron: "0 0 30 2 *", tz: "UTC" })).toBe(false);
  });

  test("nextRunAt reads the expression in its own timezone", () => {
    const from = new Date("2026-03-01T00:00:00Z");
    const berlin = nextRunAt({ cron: "0 9 * * *", tz: "Europe/Berlin" }, from);
    const utc = nextRunAt({ cron: "0 9 * * *", tz: "UTC" }, from);
    expect(berlin?.toISOString()).toBe("2026-03-01T08:00:00.000Z");
    expect(utc?.toISOString()).toBe("2026-03-01T09:00:00.000Z");
  });
});
