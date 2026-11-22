import { describe, expect, test } from "bun:test";

import { LATEST_MIGRATION_ID, LEGACY_USER_VERSION } from "@workspace/db";
import { makeTestDb, seedLegacy } from "@workspace/db/testing";
import { Effect, Option, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { ThreadsRepo } from "./threads";

const TOPIC = { chatId: -100, threadId: 7 } as const;
const OTHER_TOPIC = { chatId: -100, threadId: 9 } as const;

const SchemaState = Schema.Struct({
  latest: Schema.Int,
  userVersion: Schema.Int,
});

/** Highest tracked migration id and `user_version`. */
const schemaState = Effect.gen(function* schemaState() {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: SchemaState,
    execute: () =>
      sql`SELECT max(migration_id) AS latest,
            (SELECT user_version FROM pragma_user_version) AS userVersion
          FROM effect_sql_migrations`,
  })();
});

const tableNames = Effect.gen(function* tableNames() {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    name: string;
  }>`SELECT name FROM sqlite_master WHERE type = 'table'`;
  return rows.map((row) => row.name);
});

/** Run `body` against the threads repo on one open of the file. */
const withThreads = <A, E, R>(
  body: (repo: ThreadsRepo["Service"]) => Effect.Effect<A, E, R>
) => ThreadsRepo.use(body).pipe(Effect.provide(ThreadsRepo.layer));

const PIN = { ...TOPIC, projectPath: "/p/one", provider: "codex" } as const;

describe("migration 002", () => {
  test("creates the threads table and lands on the latest version", async () => {
    const db = makeTestDb();
    try {
      const { names, state } = await db.run(
        Effect.all({ names: tableNames, state: schemaState })
      );
      expect(names).toContain("threads");
      expect(state).toEqual({
        latest: LATEST_MIGRATION_ID,
        userVersion: LEGACY_USER_VERSION,
      });
      expect(LEGACY_USER_VERSION).toBeGreaterThanOrEqual(2);
    } finally {
      db.cleanup();
    }
  });

  test("a db still on version 1 upgrades in place, keeping its rows", async () => {
    const db = makeTestDb();
    try {
      seedLegacy(db.file, 1, [
        "INSERT INTO settings (key, value, updated_at) VALUES ('verbosity', 'full', 1)",
      ]);

      const { state, topic, verbosity } = await db.run(
        withThreads((repo) =>
          Effect.gen(function* upgraded() {
            const sql = yield* SqlClient.SqlClient;
            const rows = yield* sql<{
              value: string;
            }>`SELECT value FROM settings WHERE key = 'verbosity'`;
            return {
              state: yield* schemaState,
              topic: yield* repo.get(TOPIC),
              verbosity: rows[0]?.value,
            };
          })
        )
      );
      expect(state).toEqual({
        latest: LATEST_MIGRATION_ID,
        userVersion: LEGACY_USER_VERSION,
      });
      expect(topic).toEqual(Option.none());
      expect(verbosity).toBe("full");
    } finally {
      db.cleanup();
    }
  });
});

describe("ThreadsRepo", () => {
  test("pin creates the row; get reads project and provider back", async () => {
    const db = makeTestDb();
    try {
      const entry = await db.run(
        withThreads((repo) =>
          Effect.gen(function* pinned() {
            yield* repo.pin(PIN);
            return Option.getOrUndefined(yield* repo.get(TOPIC));
          })
        )
      );
      expect(entry?.projectPath).toBe("/p/one");
      expect(entry?.provider).toBe("codex");
      expect(entry?.sessionId).toBeUndefined();
    } finally {
      db.cleanup();
    }
  });

  test("an unused topic has no row", async () => {
    const db = makeTestDb();
    try {
      const entry = await db.run(withThreads((repo) => repo.get(TOPIC)));
      expect(entry).toEqual(Option.none());
    } finally {
      db.cleanup();
    }
  });

  test("re-pinning the same project keeps the session", async () => {
    const db = makeTestDb();
    try {
      const pinned = await db.run(
        withThreads((repo) =>
          Effect.gen(function* repinned() {
            yield* repo.pin(PIN);
            yield* repo.setSession({
              ...TOPIC,
              provider: "codex",
              sessionId: "s-1",
            });
            return yield* repo.pin(PIN);
          })
        )
      );
      expect(pinned.sessionId).toBe("s-1");
    } finally {
      db.cleanup();
    }
  });

  test("switching the project drops the session that belonged to it", async () => {
    const db = makeTestDb();
    try {
      const pinned = await db.run(
        withThreads((repo) =>
          Effect.gen(function* switched() {
            yield* repo.pin(PIN);
            yield* repo.setSession({
              ...TOPIC,
              provider: "codex",
              sessionId: "s-1",
            });
            return yield* repo.pin({ ...PIN, projectPath: "/p/two" });
          })
        )
      );
      expect(pinned.projectPath).toBe("/p/two");
      expect(pinned.sessionId).toBeUndefined();
    } finally {
      db.cleanup();
    }
  });

  test("setSession reports whether the topic had a row", async () => {
    const db = makeTestDb();
    try {
      const { after, before, stored } = await db.run(
        withThreads((repo) =>
          Effect.gen(function* sessions() {
            const unpinned = yield* repo.setSession({
              ...TOPIC,
              provider: "codex",
              sessionId: "s-1",
            });
            yield* repo.pin(PIN);
            const pinned = yield* repo.setSession({
              ...TOPIC,
              provider: "codex",
              sessionId: "s-1",
            });
            return {
              after: pinned,
              before: unpinned,
              stored: Option.getOrUndefined(yield* repo.get(TOPIC)),
            };
          })
        )
      );
      expect(before).toBe(false);
      expect(after).toBe(true);
      expect(stored?.sessionId).toBe("s-1");
    } finally {
      db.cleanup();
    }
  });

  test("clearSession forgets the session but keeps the project pin", async () => {
    const db = makeTestDb();
    try {
      const entry = await db.run(
        withThreads((repo) =>
          Effect.gen(function* cleared() {
            yield* repo.pin(PIN);
            yield* repo.setSession({
              ...TOPIC,
              provider: "codex",
              sessionId: "s-1",
            });
            yield* repo.clearSession(TOPIC);
            return Option.getOrUndefined(yield* repo.get(TOPIC));
          })
        )
      );
      expect(entry?.sessionId).toBeUndefined();
      expect(entry?.projectPath).toBe("/p/one");
    } finally {
      db.cleanup();
    }
  });

  test("topics of one chat never share a session", async () => {
    const db = makeTestDb();
    try {
      const { afterClear, one, other } = await db.run(
        withThreads((repo) =>
          Effect.gen(function* twoTopics() {
            yield* repo.pin(PIN);
            yield* repo.setSession({
              ...TOPIC,
              provider: "codex",
              sessionId: "s-1",
            });
            yield* repo.pin({ ...PIN, ...OTHER_TOPIC });
            yield* repo.setSession({
              ...OTHER_TOPIC,
              provider: "codex",
              sessionId: "s-2",
            });
            const first = Option.getOrUndefined(yield* repo.get(TOPIC));
            const second = Option.getOrUndefined(yield* repo.get(OTHER_TOPIC));
            yield* repo.clearSession(TOPIC);
            return {
              afterClear: Option.getOrUndefined(yield* repo.get(OTHER_TOPIC)),
              one: first,
              other: second,
            };
          })
        )
      );
      expect(one?.sessionId).toBe("s-1");
      expect(other?.sessionId).toBe("s-2");
      expect(afterClear?.sessionId).toBe("s-2");
    } finally {
      db.cleanup();
    }
  });

  test("a topic survives closing and reopening the db", async () => {
    const db = makeTestDb();
    try {
      // `adopt` is the pin-then-setSession pair the old test wrote by hand.
      await db.run(
        withThreads((repo) => repo.adopt({ ...PIN, sessionId: "s-1" }))
      );

      const entry = await db.run(withThreads((repo) => repo.get(TOPIC)));
      expect(Option.getOrUndefined(entry)?.sessionId).toBe("s-1");
    } finally {
      db.cleanup();
    }
  });

  test("list returns a chat's topics, most recently used first", async () => {
    const db = makeTestDb();
    try {
      const { mine, theirs } = await db.run(
        withThreads((repo) =>
          Effect.gen(function* listed() {
            const sql = yield* SqlClient.SqlClient;
            yield* repo.pin(PIN);
            yield* sql`UPDATE threads SET updated_at = 1 WHERE thread_id = 7`;
            yield* repo.pin({ ...PIN, ...OTHER_TOPIC, projectPath: "/p/two" });
            yield* sql`UPDATE threads SET updated_at = 2 WHERE thread_id = 9`;
            yield* repo.pin({
              chatId: -200,
              projectPath: "/p/three",
              provider: "codex",
              threadId: 7,
            });
            return {
              mine: yield* repo.list(-100),
              theirs: yield* repo.list(-200),
            };
          })
        )
      );
      expect(mine.map((entry) => entry.threadId)).toEqual([9, 7]);
      expect(theirs.map((entry) => entry.projectPath)).toEqual(["/p/three"]);
    } finally {
      db.cleanup();
    }
  });

  test("a row whose provider left the build reads as absent", async () => {
    const db = makeTestDb();
    try {
      const { all, one } = await db.run(
        withThreads((repo) =>
          Effect.gen(function* retired() {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`INSERT INTO threads (chat_id, thread_id, project_path, provider, session_id, updated_at)
                       VALUES (-100, 7, '/p/one', 'retired-agent', 's-1', 1)`;
            return { all: yield* repo.list(-100), one: yield* repo.get(TOPIC) };
          })
        )
      );
      expect(one).toEqual(Option.none());
      expect(all).toEqual([]);
    } finally {
      db.cleanup();
    }
  });

  test("drop removes the topic entirely", async () => {
    const db = makeTestDb();
    try {
      const entry = await db.run(
        withThreads((repo) =>
          Effect.gen(function* dropped() {
            yield* repo.pin(PIN);
            yield* repo.drop(TOPIC);
            return yield* repo.get(TOPIC);
          })
        )
      );
      expect(entry).toEqual(Option.none());
    } finally {
      db.cleanup();
    }
  });
});
