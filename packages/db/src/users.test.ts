import { describe, expect, test } from "bun:test";

import { Effect, Option, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { GroupsRepo, isStale, PRESENCE_TTL_MS } from "./groups";
import { LATEST_MIGRATION_ID } from "./migrations/index";
import { LEGACY_USER_VERSION } from "./migrations/legacy";
import { makeTestDb, seedLegacy } from "./testing";
import { UsersRepo } from "./users";

const OWNER_ID = 111;
const MEMBER_ID = 222;

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

describe("migration 003", () => {
  test("adds the access tables and lands on the latest version", async () => {
    const db = makeTestDb();
    try {
      const { names, state } = await db.run(
        Effect.all({ names: tableNames, state: schemaState })
      );

      expect(names).toContain("users");
      expect(names).toContain("groups");
      expect(names).toContain("run_quota");
      expect(state).toEqual({
        latest: LATEST_MIGRATION_ID,
        userVersion: LEGACY_USER_VERSION,
      });
      expect(LEGACY_USER_VERSION).toBeGreaterThanOrEqual(3);
    } finally {
      db.cleanup();
    }
  });

  test("a db still on version 2 upgrades in place", async () => {
    const db = makeTestDb();
    try {
      seedLegacy(db.file, 2);

      const { state, users } = await db.run(
        Effect.gen(function* upgraded() {
          const repo = yield* UsersRepo;
          return {
            state: yield* schemaState,
            users: yield* repo.list(),
          };
        }).pipe(Effect.provide(UsersRepo.layer))
      );
      expect(state).toEqual({
        latest: LATEST_MIGRATION_ID,
        userVersion: LEGACY_USER_VERSION,
      });
      expect(users).toEqual([]);
    } finally {
      db.cleanup();
    }
  });
});

describe("user ops", () => {
  test("a granted tier reads back with who granted it", async () => {
    const db = makeTestDb();
    try {
      const entry = await db.run(
        Effect.gen(function* granted() {
          const users = yield* UsersRepo;
          yield* users.grant({
            addedBy: OWNER_ID,
            tier: "member",
            userId: MEMBER_ID,
            username: "kate",
          });
          return Option.getOrUndefined(yield* users.get(MEMBER_ID));
        }).pipe(Effect.provide(UsersRepo.layer))
      );
      expect(entry?.tier).toBe("member");
      expect(entry?.username).toBe("kate");
      expect(entry?.addedBy).toBe(OWNER_ID);
    } finally {
      db.cleanup();
    }
  });

  test("an unknown user has no row at all", async () => {
    const db = makeTestDb();
    try {
      const entry = await db.run(
        UsersRepo.use((users) => users.get(MEMBER_ID)).pipe(
          Effect.provide(UsersRepo.layer)
        )
      );
      expect(entry).toEqual(Option.none());
    } finally {
      db.cleanup();
    }
  });

  test("a re-grant changes the tier and keeps the known username", async () => {
    const db = makeTestDb();
    try {
      const { entry, all } = await db.run(
        Effect.gen(function* regranted() {
          const users = yield* UsersRepo;
          yield* users.grant({
            addedBy: OWNER_ID,
            tier: "member",
            userId: MEMBER_ID,
            username: "kate",
          });
          yield* users.grant({
            addedBy: OWNER_ID,
            tier: "executor",
            userId: MEMBER_ID,
          });
          return {
            all: yield* users.list(),
            entry: Option.getOrUndefined(yield* users.get(MEMBER_ID)),
          };
        }).pipe(Effect.provide(UsersRepo.layer))
      );
      expect(entry?.tier).toBe("executor");
      expect(entry?.username).toBe("kate");
      expect(all).toHaveLength(1);
    } finally {
      db.cleanup();
    }
  });

  test("revoke drops the row, and says whether there was one", async () => {
    const db = makeTestDb();
    try {
      const { after, first, second } = await db.run(
        Effect.gen(function* revoked() {
          const users = yield* UsersRepo;
          yield* users.grant({
            addedBy: OWNER_ID,
            tier: "member",
            userId: MEMBER_ID,
          });
          const firstRevoke = yield* users.revoke(MEMBER_ID);
          const secondRevoke = yield* users.revoke(MEMBER_ID);
          return {
            after: yield* users.get(MEMBER_ID),
            first: firstRevoke,
            second: secondRevoke,
          };
        }).pipe(Effect.provide(UsersRepo.layer))
      );
      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(after).toEqual(Option.none());
    } finally {
      db.cleanup();
    }
  });

  test("a tier this build does not know fails as Decode on get, and list skips it", async () => {
    const db = makeTestDb();
    try {
      const { failure, all } = await db.run(
        Effect.gen(function* alienTier() {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO users (user_id, tier, username, added_by, added_at)
                     VALUES (${MEMBER_ID}, 'root', NULL, ${OWNER_ID}, 1)`;
          const users = yield* UsersRepo;
          return {
            all: yield* users.list(),
            failure: yield* Effect.flip(users.get(MEMBER_ID)),
          };
        }).pipe(Effect.provide(UsersRepo.layer))
      );
      expect(failure._tag).toBe("PersistenceError");
      expect(failure.reason).toBe("Decode");
      expect(failure.operation).toBe("UsersRepo.get");
      expect(all).toEqual([]);
    } finally {
      db.cleanup();
    }
  });

  test("grants survive a close and reopen", async () => {
    const db = makeTestDb();
    try {
      await db.run(
        UsersRepo.use((users) =>
          users.grant({
            addedBy: OWNER_ID,
            tier: "executor",
            userId: MEMBER_ID,
          })
        ).pipe(Effect.provide(UsersRepo.layer))
      );

      const entry = await db.run(
        UsersRepo.use((users) => users.get(MEMBER_ID)).pipe(
          Effect.provide(UsersRepo.layer)
        )
      );
      expect(Option.getOrUndefined(entry)?.tier).toBe("executor");
    } finally {
      db.cleanup();
    }
  });

  test("a user can be found by the username stored with the grant", async () => {
    const db = makeTestDb();
    try {
      const found = await db.run(
        Effect.gen(function* byName() {
          const users = yield* UsersRepo;
          yield* users.grant({
            addedBy: OWNER_ID,
            tier: "member",
            userId: MEMBER_ID,
            username: "Kate",
          });
          return yield* users.findByUsername("@kate");
        }).pipe(Effect.provide(UsersRepo.layer))
      );
      expect(Option.getOrUndefined(found)?.userId).toBe(MEMBER_ID);
    } finally {
      db.cleanup();
    }
  });
});

describe("group presence cache", () => {
  test("remembers a check and reads it back", async () => {
    const db = makeTestDb();
    try {
      const entry = await db.run(
        Effect.gen(function* remembered() {
          const groups = yield* GroupsRepo;
          yield* groups.remember({ chatId: -100, ownerPresent: true });
          return Option.getOrUndefined(yield* groups.get(-100));
        }).pipe(Effect.provide(GroupsRepo.layer))
      );

      expect(entry?.ownerPresent).toBe(true);
      expect(
        isStale(
          entry ?? { chatId: -100, checkedAt: 0, ownerPresent: true },
          Date.now()
        )
      ).toBe(false);
    } finally {
      db.cleanup();
    }
  });

  test("an old check is stale, and forget removes it", async () => {
    const db = makeTestDb();
    try {
      const { after, entry } = await db.run(
        Effect.gen(function* forgotten() {
          const groups = yield* GroupsRepo;
          yield* groups.remember({ chatId: -100, ownerPresent: false });
          const remembered = Option.getOrUndefined(yield* groups.get(-100));
          yield* groups.forget(-100);
          return { after: yield* groups.get(-100), entry: remembered };
        }).pipe(Effect.provide(GroupsRepo.layer))
      );

      expect(
        isStale(
          entry ?? { chatId: -100, checkedAt: 0, ownerPresent: false },
          Date.now() + PRESENCE_TTL_MS
        )
      ).toBe(true);
      expect(after).toEqual(Option.none());
    } finally {
      db.cleanup();
    }
  });
});
