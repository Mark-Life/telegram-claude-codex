import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { Migration } from "../runner";

/**
 * Every provider session a remembered conversation ran on, for `/history`:
 * the directory it worked in, who started it and where, the first thing the
 * user asked (`title`) and when it was last used. Keyed by provider and
 * session id, so the same id can never mix two providers. `user_id` and
 * `chat_id` are NULL on a row imported from a provider's own files. New table
 * only: an older build never reads it.
 */
export const sessionHistory: Migration = {
  name: "20261009-session-history",
  run: Effect.gen(function* sessionHistoryMigration() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE IF NOT EXISTS session_history (
      provider TEXT NOT NULL,
      session_id TEXT NOT NULL,
      project_path TEXT NOT NULL,
      user_id INTEGER,
      chat_id INTEGER,
      thread_id INTEGER,
      title TEXT NOT NULL,
      model TEXT,
      started_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL,
      PRIMARY KEY (provider, session_id)
    )`;
    yield* sql`CREATE INDEX IF NOT EXISTS session_history_recent
      ON session_history (last_active_at)`;
  }),
};
