import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { Migration } from "../runner";

/**
 * How full each provider session's context window is, for `/context`. A new
 * table; an older build never reads it, and with no row `/context` says the
 * figure comes with the next answer.
 */
export const sessionContext: Migration = {
  name: "20261014-session-context",
  run: Effect.gen(function* sessionContextMigration() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE IF NOT EXISTS session_context (
      provider TEXT NOT NULL,
      session_id TEXT NOT NULL,
      used_tokens INTEGER NOT NULL,
      window_tokens INTEGER,
      model_window_tokens INTEGER,
      compact_at INTEGER,
      baseline_tokens INTEGER,
      model TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider, session_id)
    )`;
  }),
};
