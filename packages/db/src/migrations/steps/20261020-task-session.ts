import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { Migration } from "../runner";

/**
 * Which conversation a task's fires keep, and what a gated script carries
 * from one fire to the next. Every column is nullable, and NULL is the old
 * behaviour: `session_mode` NULL is a fresh session per fire, `own` keeps one
 * session of the task's own (`session_id`, on `session_provider`), `route`
 * runs in the conversation of the task's chat and topic. `session_reset` is a
 * pending request to start a route task's conversation over, applied by the
 * bot. `script_state` is the JSON a gated script returned as its `state`. An
 * older build after a rollback ignores these columns, so every task fires
 * fresh.
 */
export const taskSession: Migration = {
  name: "20261020-task-session",
  run: Effect.gen(function* taskSessionMigration() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE tasks ADD COLUMN session_mode TEXT`;
    yield* sql`ALTER TABLE tasks ADD COLUMN session_id TEXT`;
    yield* sql`ALTER TABLE tasks ADD COLUMN session_provider TEXT`;
    yield* sql`ALTER TABLE tasks ADD COLUMN session_reset INTEGER`;
    yield* sql`ALTER TABLE tasks ADD COLUMN script_state TEXT`;
  }),
};
