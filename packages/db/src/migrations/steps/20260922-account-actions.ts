import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { Migration } from "../runner";

/**
 * Writes a run asked to make on the owner's Telegram account. Under
 * `TELEGRAM_ACCOUNT_WRITES=confirm` each waits here as `pending` until the
 * owner presses a button or 24 h pass; under `direct` it is recorded already
 * decided. `chat_id`/`thread_id`/`message_id` locate the confirmation message,
 * so an expiry can edit it. New table only: an older build never reads it.
 */
export const accountActions: Migration = {
  name: "20260922-account-actions",
  run: Effect.gen(function* accountActionsMigration() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE IF NOT EXISTS account_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      chat_id INTEGER,
      thread_id INTEGER,
      message_id INTEGER,
      created_at INTEGER NOT NULL,
      decided_at INTEGER,
      error TEXT
    )`;
    yield* sql`CREATE INDEX IF NOT EXISTS account_actions_status
      ON account_actions (status, created_at)`;
  }),
};
