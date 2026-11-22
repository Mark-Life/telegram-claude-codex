import { Clock, Context, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { persistence } from "./errors";
import { Millis } from "./schema";

/**
 * Every key one person's settings may hold.
 * - `default_provider`: the provider their new conversations start on, or
 *   `auto` for the detected one.
 * - `default_model`, `default_effort`: what a new conversation runs on, in
 *   the router's terms (a tier, a level), so they hold on any provider.
 * - `default_pi_model`: a pi model by name (`provider/id`), which a new
 *   conversation on pi starts on instead; `default` is none.
 */
const USER_SETTING_KEYS = [
  "default_effort",
  "default_model",
  "default_pi_model",
  "default_provider",
] as const;

export type UserSettingKey = (typeof USER_SETTING_KEYS)[number];

const UserSettingKeySchema = Schema.Literals(USER_SETTING_KEYS);

const isUserSettingKey = Schema.is(UserSettingKeySchema);

const UserSettingRow = Schema.Struct({
  key: Schema.String,
  value: Schema.String,
});
const UserSettingWrite = Schema.Struct({
  key: UserSettingKeySchema,
  updatedAt: Millis,
  userId: Schema.Int,
  value: Schema.String,
});

const make = Effect.gen(function* makeUserSettingsRepo() {
  const sql = yield* SqlClient.SqlClient;

  const selectAll = SqlSchema.findAll({
    Request: Schema.Int,
    Result: UserSettingRow,
    execute: (userId) =>
      sql`SELECT key, value FROM user_settings WHERE user_id = ${userId}`,
  });
  const upsert = SqlSchema.void({
    Request: UserSettingWrite,
    execute: (row) =>
      sql`INSERT INTO user_settings (user_id, key, value, updated_at)
          VALUES (${row.userId}, ${row.key}, ${row.value}, ${row.updatedAt})
          ON CONFLICT(user_id, key) DO UPDATE SET
            value = excluded.value, updated_at = excluded.updated_at`,
  });

  /**
   * Everything one person has set, by key; empty for someone who set nothing.
   * A key this build does not know (a newer build's) is left out.
   */
  const all = Effect.fn("UserSettingsRepo.all")(function* all(userId: number) {
    const rows = yield* selectAll(userId);
    const known = rows.flatMap(({ key, value }) =>
      isUserSettingKey(key) ? [[key, value] as const] : []
    );
    return new Map<UserSettingKey, string>(known);
  }, persistence("UserSettingsRepo.all"));

  /** Write (or overwrite) one of a person's settings. */
  const set = Effect.fn("UserSettingsRepo.set")(function* set(entry: {
    readonly key: UserSettingKey;
    readonly userId: number;
    readonly value: string;
  }) {
    const updatedAt = yield* Clock.currentTimeMillis;
    yield* upsert({ ...entry, updatedAt });
  }, persistence("UserSettingsRepo.set"));

  /** Several of a person's settings in one transaction. */
  const apply = Effect.fn("UserSettingsRepo.apply")(function* apply(input: {
    readonly changes: readonly {
      readonly key: UserSettingKey;
      readonly value: string;
    }[];
    readonly userId: number;
  }) {
    if (input.changes.length === 0) {
      return;
    }
    const updatedAt = yield* Clock.currentTimeMillis;
    yield* sql.withTransaction(
      Effect.forEach(
        input.changes,
        (change) => upsert({ ...change, updatedAt, userId: input.userId }),
        { discard: true }
      )
    );
  }, persistence("UserSettingsRepo.apply"));

  return { all, apply, set } as const;
});

/**
 * One person's own settings (`user_settings`), values stored as text, keyed
 * by Telegram user id: the owner has rows here though never a `users` row.
 */
export class UserSettingsRepo extends Context.Service<
  UserSettingsRepo,
  Effect.Success<typeof make>
>()("@workspace/db/UserSettingsRepo") {
  static readonly layer = Layer.effect(UserSettingsRepo, make);
}
