import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { Migration } from "../runner";

/**
 * HTTP API keys: one row per key, the secret kept only as its sha256. A key
 * names a Telegram user, never a tier; the tier is read on every request, so
 * a demotion takes the key's powers with it. `user_id` has no foreign key
 * because the owner is never a `users` row. `token_chat_id` and
 * `token_message_id` point at the DM that carried the token until the bot
 * deletes it. A new table; an older build never reads it.
 */
export const apiKeys: Migration = {
  name: "20261021-api-keys",
  run: Effect.gen(function* apiKeysMigration() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      created_by INTEGER NOT NULL,
      created_via TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at INTEGER,
      token_chat_id INTEGER,
      token_message_id INTEGER
    )`;
    yield* sql`CREATE INDEX IF NOT EXISTS api_keys_user ON api_keys (user_id)`;
  }),
};
