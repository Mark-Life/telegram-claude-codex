import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { Migration } from "../runner";

/**
 * Who last set what a recurring task does: `owner` or `executor`. Only an
 * owner-authored task runs with the owner's Telegram account. A new nullable
 * column; an older build never reads it, and NULL (every task written before
 * it) reads as not the owner's.
 */
export const taskAuthor: Migration = {
  name: "20260922-task-author",
  run: Effect.gen(function* taskAuthorMigration() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE tasks ADD COLUMN author TEXT`;
  }),
};
