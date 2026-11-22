import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { Migration } from "../runner";

/**
 * What a prompt task runs on, chosen per task, and the pick routed for it.
 * `provider`, `model_tier` and `effort_level` are a task's own choice in the
 * router's terms; NULL follows the writer's `/settings` defaults.
 * `pick_model` and `pick_effort` are the halves the router decided, in
 * `pick_provider`'s terms. New nullable columns: the old `model` and
 * `effort`, Codex's pick, are left as they were, so an older build after a
 * rollback still reads a pick Codex can run.
 */
export const taskProvider: Migration = {
  name: "20261015-task-provider",
  run: Effect.gen(function* taskProviderMigration() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE tasks ADD COLUMN provider TEXT`;
    yield* sql`ALTER TABLE tasks ADD COLUMN model_tier TEXT`;
    yield* sql`ALTER TABLE tasks ADD COLUMN effort_level TEXT`;
    yield* sql`ALTER TABLE tasks ADD COLUMN pick_provider TEXT`;
    yield* sql`ALTER TABLE tasks ADD COLUMN pick_model TEXT`;
    yield* sql`ALTER TABLE tasks ADD COLUMN pick_effort TEXT`;
  }),
};
