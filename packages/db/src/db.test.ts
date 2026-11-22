import { describe, expect, test } from "bun:test";

import { Effect, Option, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { ComposeRepo } from "./compose";
import { LATEST_MIGRATION_ID, MIGRATION_LISTS } from "./migrations/index";
import { LEGACY_USER_VERSION } from "./migrations/legacy";
import { planMigrations, runMigrations } from "./migrations/runner";
import { adoptLegacyVersion } from "./migrations/transition";
import { SettingsRepo } from "./settings";
import { makeTestDb } from "./testing";

const SchemaState = Schema.Struct({
  latest: Schema.Int,
  tracked: Schema.Int,
  userVersion: Schema.Int,
});

/** Highest tracked migration id, how many are tracked, and `user_version`. */
const schemaState = Effect.gen(function* schemaState() {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: SchemaState,
    execute: () =>
      sql`SELECT max(migration_id) AS latest, count(*) AS tracked,
            (SELECT user_version FROM pragma_user_version) AS userVersion
          FROM effect_sql_migrations`,
  })();
});

/** Run `body` against the compose repo on one open of the file. */
const withCompose = <A, E>(
  body: (repo: ComposeRepo["Service"]) => Effect.Effect<A, E>
) => ComposeRepo.use(body).pipe(Effect.provide(ComposeRepo.layer));

describe("migrations", () => {
  test("a fresh db is migrated to the latest version", async () => {
    const db = makeTestDb();
    try {
      const state = await db.run(schemaState);
      expect(state).toEqual({
        latest: LATEST_MIGRATION_ID,
        tracked: LATEST_MIGRATION_ID,
        userVersion: LEGACY_USER_VERSION,
      });
    } finally {
      db.cleanup();
    }
  });

  test("reopening an up-to-date db is a no-op and keeps data", async () => {
    const db = makeTestDb();
    try {
      await db.run(
        SettingsRepo.use((repo) =>
          repo.set({ key: "call_name", value: "hi" })
        ).pipe(Effect.provide(SettingsRepo.layer))
      );

      const reopened = await db.run(
        Effect.gen(function* reopened() {
          const adopted = yield* adoptLegacyVersion;
          const { ran } = yield* runMigrations(
            yield* planMigrations(MIGRATION_LISTS)
          );
          const state = yield* schemaState;
          const value = yield* SettingsRepo.use((repo) =>
            repo.get("call_name")
          );
          return { adopted, ran, state, value };
        }).pipe(Effect.provide(SettingsRepo.layer))
      );
      expect(reopened).toEqual({
        adopted: 0,
        ran: [],
        state: {
          latest: LATEST_MIGRATION_ID,
          tracked: LATEST_MIGRATION_ID,
          userVersion: LEGACY_USER_VERSION,
        },
        value: Option.some("hi"),
      });
    } finally {
      db.cleanup();
    }
  });

  test("migration 001 creates compose and settings", async () => {
    const db = makeTestDb();
    try {
      const names = await db.run(
        Effect.gen(function* names() {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{
            name: string;
          }>`SELECT name FROM sqlite_master WHERE type = 'table'`;
          return rows.map((row) => row.name);
        })
      );
      expect(names).toContain("compose");
      expect(names).toContain("settings");
    } finally {
      db.cleanup();
    }
  });

  test("WAL is on", async () => {
    const db = makeTestDb();
    try {
      const mode = await db.run(
        Effect.gen(function* mode() {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{
            journal_mode: string;
          }>`PRAGMA journal_mode`;
          return rows[0]?.journal_mode;
        })
      );
      expect(mode).toBe("wal");
    } finally {
      db.cleanup();
    }
  });
});

describe("ComposeRepo", () => {
  test("messages come back in arrival order with their type", async () => {
    const db = makeTestDb();
    try {
      const buffer = await db.run(
        withCompose((repo) =>
          Effect.gen(function* appendThree() {
            yield* repo.append({ content: "one", type: "text", userId: 7 });
            yield* repo.append({ content: "two", type: "voice", userId: 7 });
            yield* repo.append({ content: "three", type: "photo", userId: 7 });
            return {
              count: yield* repo.count({ userId: 7 }),
              list: yield* repo.list({ userId: 7 }),
            };
          })
        )
      );
      expect(buffer).toEqual({
        count: 3,
        list: [
          { content: "one", type: "text" },
          { content: "two", type: "voice" },
          { content: "three", type: "photo" },
        ],
      });
    } finally {
      db.cleanup();
    }
  });

  test("a buffer survives closing and reopening the db", async () => {
    const db = makeTestDb();
    try {
      await db.run(
        withCompose((repo) =>
          repo.append({ content: "draft", type: "text", userId: 7 })
        )
      );

      const list = await db.run(
        withCompose((repo) => repo.list({ userId: 7 }))
      );
      expect(list).toEqual([{ content: "draft", type: "text" }]);
    } finally {
      db.cleanup();
    }
  });

  test("buffers are scoped per user and per thread", async () => {
    const db = makeTestDb();
    try {
      const buffers = await db.run(
        withCompose((repo) =>
          Effect.gen(function* appendScoped() {
            yield* repo.append({ content: "a", type: "text", userId: 1 });
            yield* repo.append({ content: "b", type: "text", userId: 2 });
            yield* repo.append({
              content: "c",
              threadId: 55,
              type: "text",
              userId: 1,
            });
            return {
              one: yield* repo.list({ userId: 1 }),
              oneInTopic: yield* repo.list({ threadId: 55, userId: 1 }),
              two: yield* repo.list({ userId: 2 }),
            };
          })
        )
      );
      expect(buffers).toEqual({
        one: [{ content: "a", type: "text" }],
        oneInTopic: [{ content: "c", type: "text" }],
        two: [{ content: "b", type: "text" }],
      });
    } finally {
      db.cleanup();
    }
  });

  test("clear drops only the targeted buffer and reports the count", async () => {
    const db = makeTestDb();
    try {
      const after = await db.run(
        withCompose((repo) =>
          Effect.gen(function* appendThenClear() {
            yield* repo.append({ content: "a", type: "text", userId: 1 });
            yield* repo.append({ content: "b", type: "text", userId: 1 });
            yield* repo.append({
              content: "c",
              threadId: 9,
              type: "text",
              userId: 1,
            });
            const discarded = yield* repo.clear({ userId: 1 });
            return {
              discarded,
              plain: yield* repo.list({ userId: 1 }),
              topic: yield* repo.list({ threadId: 9, userId: 1 }),
            };
          })
        )
      );
      expect(after).toEqual({
        discarded: 2,
        plain: [],
        topic: [{ content: "c", type: "text" }],
      });
    } finally {
      db.cleanup();
    }
  });

  test("a cleared buffer restarts numbering and stays ordered", async () => {
    const db = makeTestDb();
    try {
      const contents = await db.run(
        withCompose((repo) =>
          Effect.gen(function* clearThenAppend() {
            yield* repo.append({ content: "old", type: "text", userId: 3 });
            yield* repo.clear({ userId: 3 });
            yield* repo.append({ content: "new-1", type: "text", userId: 3 });
            yield* repo.append({ content: "new-2", type: "text", userId: 3 });
            const list = yield* repo.list({ userId: 3 });
            return list.map((message) => message.content);
          })
        )
      );
      expect(contents).toEqual(["new-1", "new-2"]);
    } finally {
      db.cleanup();
    }
  });

  test("an empty buffer lists nothing and clears to zero", async () => {
    const db = makeTestDb();
    try {
      const empty = await db.run(
        withCompose((repo) =>
          Effect.all({
            discarded: repo.clear({ userId: 42 }),
            list: repo.list({ userId: 42 }),
          })
        )
      );
      expect(empty).toEqual({ discarded: 0, list: [] });
    } finally {
      db.cleanup();
    }
  });
});

describe("settings ops", () => {
  test("set then get round-trips and survives reopen", async () => {
    const db = makeTestDb();
    try {
      await db.run(
        SettingsRepo.use((repo) =>
          repo.set({ key: "call_name", value: "boss" })
        ).pipe(Effect.provide(SettingsRepo.layer))
      );

      const value = await db.run(
        SettingsRepo.use((repo) => repo.get("call_name")).pipe(
          Effect.provide(SettingsRepo.layer)
        )
      );
      expect(value).toEqual(Option.some("boss"));
    } finally {
      db.cleanup();
    }
  });

  test("set overwrites, unset forgets, unknown keys are undefined", async () => {
    const db = makeTestDb();
    try {
      const reads = await db.run(
        Effect.gen(function* reads() {
          const repo = yield* SettingsRepo;
          yield* repo.set({ key: "verbosity", value: "low" });
          yield* repo.set({ key: "verbosity", value: "high" });
          const overwritten = yield* repo.get("verbosity");
          const unknown = yield* repo.get("call_name");
          yield* repo.unset("verbosity");
          const forgotten = yield* repo.get("verbosity");
          return { forgotten, overwritten, unknown };
        }).pipe(Effect.provide(SettingsRepo.layer))
      );
      expect(reads).toEqual({
        forgotten: Option.none(),
        overwritten: Option.some("high"),
        unknown: Option.none(),
      });
    } finally {
      db.cleanup();
    }
  });
});
