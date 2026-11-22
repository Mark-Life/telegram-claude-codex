import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { persistence } from "./errors";
import { Millis, OptionalFromNull } from "./schema";

/**
 * Tiers that can be stored. `owner` never appears here — it comes from
 * `ALLOWED_USER_ID` and cannot be granted or revoked through the db — and
 * `guest` is the absence of a row, so a revoke is a delete.
 */
export const STORED_TIERS = ["executor", "member"] as const;

export type StoredTier = (typeof STORED_TIERS)[number];

const StoredTierSchema = Schema.Literals(STORED_TIERS);

/**
 * What a user is allowed to be. `owner` comes from `ALLOWED_USER_ID` and is
 * never stored, so it cannot be granted or taken away through the db; `guest`
 * is the absence of a row — everyone starts there.
 */
export const TIERS = ["owner", "executor", "member", "guest"] as const;

export type Tier = (typeof TIERS)[number];

/**
 * The tier of one user: the env owner first, then the db, then guest. The one
 * rule every door shares: the chat middleware, the HTTP API and the CLIs.
 */
export const resolveTier = (input: {
  ownerId: number;
  stored: StoredTier | undefined;
  userId: number;
}): Tier =>
  input.userId === input.ownerId ? "owner" : (input.stored ?? "guest");

/** One managed user, as the store hands it back. */
export const UserEntrySchema = Schema.Struct({
  addedAt: Millis,
  /** User id of whoever granted the tier (the owner, or the owner's agent). */
  addedBy: Schema.Int,
  tier: StoredTierSchema,
  userId: Schema.Int,
  username: OptionalFromNull(Schema.String),
});

export type UserEntry = typeof UserEntrySchema.Type;

/** What a grant needs: who, which tier, and who granted it. */
export type UserGrant = Pick<UserEntry, "addedBy" | "tier" | "userId"> &
  Partial<Pick<UserEntry, "username">>;

/** The `users` row: the entry under its column names, `username` nullable. */
const UserRow = UserEntrySchema.pipe(
  Schema.encodeKeys({
    addedAt: "added_at",
    addedBy: "added_by",
    userId: "user_id",
  })
);

/** A grant as bound to the upsert: every column, a missing username as NULL. */
const UserWrite = Schema.Struct({
  addedAt: Millis,
  addedBy: Schema.Int,
  tier: StoredTierSchema,
  userId: Schema.Int,
  username: Schema.NullOr(Schema.String),
});

const DeletedUser = Schema.Struct({ user_id: Schema.Int });

/** Narrow a stored tier string; an unknown value reads as no row at all. */
export const isStoredTier = (value: string): value is StoredTier =>
  STORED_TIERS.some((tier) => tier === value);

const make = Effect.gen(function* makeUsersRepo() {
  const sql = yield* SqlClient.SqlClient;

  const selectOne = SqlSchema.findOneOption({
    Request: Schema.Int,
    Result: UserRow,
    execute: (userId) =>
      sql`SELECT user_id, tier, username, added_by, added_at FROM users
          WHERE user_id = ${userId}`,
  });
  // A row whose tier this build does not know is skipped here, so one alien
  // row cannot blind the access watcher, `/users` or the users CLI. `get` and
  // `findByUsername` stay strict and fail it as a Decode.
  const selectAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: UserRow,
    execute: () =>
      sql`SELECT user_id, tier, username, added_by, added_at FROM users
          WHERE tier IN ${sql.in(STORED_TIERS)}
          ORDER BY added_at ASC`,
  });
  // A re-grant keeps the original username when the caller has no fresh one.
  const upsert = SqlSchema.findOne({
    Request: UserWrite,
    Result: UserRow,
    execute: (row) =>
      sql`INSERT INTO users (user_id, tier, username, added_by, added_at)
          VALUES (${row.userId}, ${row.tier}, ${row.username}, ${row.addedBy}, ${row.addedAt})
          ON CONFLICT(user_id) DO UPDATE SET
            tier = excluded.tier,
            username = COALESCE(excluded.username, users.username),
            added_by = excluded.added_by,
            added_at = excluded.added_at
          RETURNING user_id, tier, username, added_by, added_at`,
  });
  const remove = SqlSchema.findAll({
    Request: Schema.Int,
    Result: DeletedUser,
    execute: (userId) =>
      sql`DELETE FROM users WHERE user_id = ${userId} RETURNING user_id`,
  });
  const selectByName = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: UserRow,
    execute: (username) =>
      sql`SELECT user_id, tier, username, added_by, added_at FROM users
          WHERE username = ${username} COLLATE NOCASE`,
  });

  /** The user's row, none when they are not managed (a guest). */
  const get = Effect.fn("UsersRepo.get")(function* get(userId: number) {
    return yield* selectOne(userId);
  }, persistence("UsersRepo.get"));

  /** Every managed user, oldest grant first. */
  const list = Effect.fn("UsersRepo.list")(function* list() {
    return yield* selectAll();
  }, persistence("UsersRepo.list"));

  /** Grant (or re-grant) a tier; returns the row as it now stands. */
  const grant = Effect.fn("UsersRepo.grant")(function* grant(entry: UserGrant) {
    const addedAt = yield* Clock.currentTimeMillis;
    return yield* upsert({
      addedAt,
      addedBy: entry.addedBy,
      tier: entry.tier,
      userId: entry.userId,
      username: entry.username ?? null,
    }).pipe(
      // An INSERT … RETURNING always hands back its row; no row is a defect.
      Effect.catchTag("NoSuchElementError", (cause) => Effect.die(cause))
    );
  }, persistence("UsersRepo.grant"));

  /** Drop a user back to guest; false when they were not managed. */
  const revoke = Effect.fn("UsersRepo.revoke")(function* revoke(
    userId: number
  ) {
    const deleted = yield* remove(userId);
    return deleted.length > 0;
  }, persistence("UsersRepo.revoke"));

  /** Look a managed user up by the @username stored with their grant. */
  const findByUsername = Effect.fn("UsersRepo.findByUsername")(
    function* findByUsername(username: string) {
      return yield* selectByName(username.replace(/^@/u, ""));
    },
    persistence("UsersRepo.findByUsername")
  );

  /**
   * The user's tier right now, through `resolveTier`. A row whose tier this
   * build does not know reads as a guest, as the chat reads it.
   */
  const tierOf = Effect.fn("UsersRepo.tierOf")(function* tierOf(input: {
    ownerId: number;
    userId: number;
  }) {
    if (input.userId === input.ownerId) {
      return resolveTier({ ...input, stored: undefined });
    }
    const row = yield* selectOne(input.userId).pipe(
      Effect.catchTag("SchemaError", () => Effect.succeed(Option.none()))
    );
    return resolveTier({
      ...input,
      stored: Option.getOrUndefined(Option.map(row, (entry) => entry.tier)),
    });
  }, persistence("UsersRepo.tierOf"));

  return { findByUsername, get, grant, list, revoke, tierOf } as const;
});

/**
 * Managed users (`users`). The table is tiny and read on every update, so
 * nothing is cached: the db is the single source of truth shared by the bot
 * and the users CLI.
 *
 * Transactions live only inside repositories. Never run the bridge, Telegram
 * or an agent inside `withTransaction`: the transaction holds the client's only
 * permit, so it would stall every other query in the process.
 */
export class UsersRepo extends Context.Service<
  UsersRepo,
  Effect.Success<typeof make>
>()("@workspace/db/UsersRepo") {
  static readonly layer = Layer.effect(UsersRepo, make);
}
