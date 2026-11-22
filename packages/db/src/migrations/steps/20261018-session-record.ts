import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { Migration } from "../runner";

/**
 * `session_history` becomes the record of every resumable session, and what
 * belongs beside a session gets its own table:
 *
 * - `topics`: the name of a Telegram topic, kept per topic because one topic
 *   hosts many sessions (`/new`, a provider switch, a compaction).
 * - `task_runs`: one row per task fire, a run log for `/history`'s Tasks view.
 *   A fire keeps no session to resume, so it never lands in history.
 * - `session_history.effort`, and `previous_session_id` with
 *   `previous_reason`: the session a new one continues (a Codex `/compact`
 *   starts a fresh session), so `/history` lists the conversation once.
 *
 * The same transaction backfills what is already known: the pi model from
 * `session_context`, the effort from `threads`, the sessions only `threads`
 * points at (with a blank title), and the last fire of each task. Topic names
 * cannot be backfilled: the Bot API cannot read one back.
 *
 * New tables and nullable columns only, no enforced keys: an older build
 * after a rollback never reads them, and its upserts still fit the row.
 */
export const sessionRecord: Migration = {
  name: "20261018-session-record",
  run: Effect.gen(function* sessionRecordMigration() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE IF NOT EXISTS topics (
      chat_id INTEGER NOT NULL,
      thread_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      title_source TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (chat_id, thread_id)
    )`;
    yield* sql`CREATE TABLE IF NOT EXISTS task_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      effort TEXT,
      session_id TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL
    )`;
    yield* sql`CREATE INDEX IF NOT EXISTS task_runs_task
      ON task_runs (task_id, finished_at)`;
    yield* sql`CREATE INDEX IF NOT EXISTS task_runs_recent
      ON task_runs (finished_at)`;
    yield* sql`ALTER TABLE session_history ADD COLUMN effort TEXT`;
    yield* sql`ALTER TABLE session_history ADD COLUMN previous_session_id TEXT`;
    yield* sql`ALTER TABLE session_history ADD COLUMN previous_reason TEXT`;
    yield* sql`CREATE INDEX IF NOT EXISTS session_history_previous
      ON session_history (provider, previous_session_id)`;

    // "default" and "auto" are the router's sentinels, not a model: they read
    // as none. pi reports its model only with a context figure.
    yield* sql`UPDATE session_history SET model = NULL
      WHERE model IN ('default', 'auto')`;
    yield* sql`UPDATE session_history
      SET model = (
        SELECT c.model FROM session_context c
        WHERE c.provider = session_history.provider
          AND c.session_id = session_history.session_id
      )
      WHERE model IS NULL
        AND EXISTS (
          SELECT 1 FROM session_context c
          WHERE c.provider = session_history.provider
            AND c.session_id = session_history.session_id
            AND c.model IS NOT NULL
            AND c.model NOT IN ('default', 'auto')
        )`;
    yield* sql`UPDATE session_history
      SET effort = (
        SELECT t.effort FROM threads t
        WHERE t.provider = session_history.provider
          AND t.session_id = session_history.session_id
          AND t.effort IS NOT NULL
        ORDER BY t.updated_at DESC LIMIT 1
      )
      WHERE effort IS NULL
        AND EXISTS (
          SELECT 1 FROM threads t
          WHERE t.provider = session_history.provider
            AND t.session_id = session_history.session_id
            AND t.effort IS NOT NULL
        )`;
    // A topic's current session from before history was recorded. The user
    // is unknown; the title stays blank, and `/history` shows the topic's
    // name once it has one.
    yield* sql`INSERT OR IGNORE INTO session_history
      (provider, session_id, project_path, chat_id, thread_id, title, model,
       effort, started_at, last_active_at)
      SELECT provider, session_id, project_path, chat_id, thread_id, '',
        NULLIF(NULLIF(model, 'default'), 'auto'), effort, updated_at,
        updated_at
      FROM threads
      WHERE session_id IS NOT NULL AND session_id != ''`;
    yield* sql`INSERT INTO task_runs (task_id, status, started_at, finished_at)
      SELECT id, last_status, last_run_at, last_run_at FROM tasks
      WHERE last_run_at IS NOT NULL AND last_status IS NOT NULL`;
  }),
};
