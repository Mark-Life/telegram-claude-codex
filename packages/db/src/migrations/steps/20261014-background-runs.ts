import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { Migration } from "../runner";

/**
 * Conversations parked on background work, one per run slot, so a restart
 * can resume them. A new table; an older build never reads it, and with no
 * row nothing is resumed, as before.
 */
export const backgroundRuns: Migration = {
  name: "20261014-background-runs",
  run: Effect.gen(function* backgroundRunsMigration() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE IF NOT EXISTS background_runs (
      run_key TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      chat_id INTEGER NOT NULL,
      thread_id INTEGER,
      surface TEXT NOT NULL,
      provider TEXT NOT NULL,
      session_id TEXT NOT NULL,
      project_path TEXT NOT NULL,
      pending TEXT NOT NULL,
      continuations INTEGER NOT NULL,
      stop_cause TEXT,
      updated_at INTEGER NOT NULL
    )`;
  }),
};
