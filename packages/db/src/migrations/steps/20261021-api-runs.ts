import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { Migration } from "../runner";

/**
 * HTTP API agent runs: one row per `runs.create`, kept after the run ends so
 * a caller can read its result later. `id` is AUTOINCREMENT, never reused, so
 * the run slot it names stays unique for good. `idempotency_key` is unique
 * per key: a retried request finds the run it already started. `status` is
 * `running` until the run ends; the boot turns a `running` row it finds into
 * `interrupted`. A new table; an older build never reads it.
 */
export const apiRuns: Migration = {
  name: "20261021-api-runs",
  run: Effect.gen(function* apiRunsMigration() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE IF NOT EXISTS api_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      idempotency_key TEXT,
      request_hash TEXT NOT NULL,
      profile TEXT NOT NULL,
      deliver TEXT NOT NULL,
      status TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      result_text TEXT,
      result_truncated INTEGER NOT NULL DEFAULT 0,
      notified_chat_id INTEGER,
      notified_message_id INTEGER,
      cost_usd REAL,
      error TEXT,
      created_at INTEGER NOT NULL,
      finished_at INTEGER
    )`;
    yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS api_runs_idempotency
      ON api_runs (key_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL`;
    yield* sql`CREATE INDEX IF NOT EXISTS api_runs_user
      ON api_runs (user_id, created_at)`;
    yield* sql`CREATE INDEX IF NOT EXISTS api_runs_status
      ON api_runs (status)`;
  }),
};
