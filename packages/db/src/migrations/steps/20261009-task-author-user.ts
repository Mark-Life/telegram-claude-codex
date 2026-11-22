import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { Migration } from "../runner";

/**
 * The Telegram user id behind a task's `author`, so a fire can check that the
 * user is still the owner or an executor before it hands the task the owner's
 * Telegram account. A new nullable column; an older build never reads it, and
 * NULL (every task written before it) keeps the old rule: only an `owner`
 * task holds the account.
 */
export const taskAuthorUser: Migration = {
  name: "20261009-task-author-user",
  run: Effect.gen(function* taskAuthorUserMigration() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE tasks ADD COLUMN author_user_id INTEGER`;
  }),
};
