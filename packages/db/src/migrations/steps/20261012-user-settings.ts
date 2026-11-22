import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { Migration } from "../runner";

/**
 * One person's own settings, beside the bot-wide `settings`: what their new
 * conversations start on. Keyed by Telegram user id, since the owner is never
 * a `users` row. A new table; an older build never reads it, and a person
 * with no row keeps the old behaviour.
 */
export const userSettings: Migration = {
  name: "20261012-user-settings",
  run: Effect.gen(function* userSettingsMigration() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE IF NOT EXISTS user_settings (
      user_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, key)
    )`;
  }),
};
