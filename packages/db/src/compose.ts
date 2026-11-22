import { Clock, Context, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { persistence } from "./errors";
import { Millis, RowId } from "./schema";

export const COMPOSE_TYPES = [
  "text",
  "voice",
  "forwarded",
  "file",
  "photo",
] as const;

export type ComposeType = (typeof COMPOSE_TYPES)[number];

/** One buffered compose entry as handlers see it. */
export const ComposeMessageSchema = Schema.Struct({
  content: Schema.String,
  type: Schema.Literals(COMPOSE_TYPES),
});
export type ComposeMessage = typeof ComposeMessageSchema.Type;

/**
 * Identifies one compose buffer. `threadId` is the forum topic a message came
 * from; absent/null is the plain-chat buffer and is stored as SQL NULL.
 */
export interface ComposeKey {
  threadId?: number | null;
  userId: number;
}

const ComposeKeySchema = Schema.Struct({
  threadId: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  userId: Schema.Int,
});
const ComposeInsert = Schema.Struct({
  ...ComposeKeySchema.fields,
  ...ComposeMessageSchema.fields,
  createdAt: Millis,
});
const CountRow = Schema.Struct({ n: Schema.Int });
const IdRow = Schema.Struct({ id: RowId });

const make = Effect.gen(function* makeComposeRepo() {
  const sql = yield* SqlClient.SqlClient;

  // `thread_id IS ?` matches NULL, which `=` never does; `?? null` keeps an
  // absent topic from reaching the driver as `undefined`.
  const insert = SqlSchema.void({
    Request: ComposeInsert,
    execute: (row) =>
      sql`INSERT INTO compose (user_id, thread_id, seq, type, content, created_at)
          VALUES (
            ${row.userId},
            ${row.threadId ?? null},
            (SELECT COALESCE(MAX(seq), 0) + 1 FROM compose
             WHERE user_id = ${row.userId} AND thread_id IS ${row.threadId ?? null}),
            ${row.type},
            ${row.content},
            ${row.createdAt}
          )`,
  });
  const selectAll = SqlSchema.findAll({
    Request: ComposeKeySchema,
    Result: ComposeMessageSchema,
    execute: (key) =>
      sql`SELECT content, type FROM compose
          WHERE user_id = ${key.userId} AND thread_id IS ${key.threadId ?? null}
          ORDER BY seq`,
  });
  const selectCount = SqlSchema.findOne({
    Request: ComposeKeySchema,
    Result: CountRow,
    execute: (key) =>
      sql`SELECT COUNT(*) AS n FROM compose
          WHERE user_id = ${key.userId} AND thread_id IS ${key.threadId ?? null}`,
  });
  const remove = SqlSchema.findAll({
    Request: ComposeKeySchema,
    Result: IdRow,
    execute: (key) =>
      sql`DELETE FROM compose
          WHERE user_id = ${key.userId} AND thread_id IS ${key.threadId ?? null}
          RETURNING id`,
  });

  /** Append one message to the buffer; `seq` continues from the last entry. */
  const append = Effect.fn("ComposeRepo.append")(function* append(
    entry: ComposeKey & ComposeMessage
  ) {
    const createdAt = yield* Clock.currentTimeMillis;
    yield* insert({ ...entry, createdAt });
  }, persistence("ComposeRepo.append"));

  /** Buffered messages in arrival order (empty when nothing is composing). */
  const list = Effect.fn("ComposeRepo.list")(function* list(key: ComposeKey) {
    return yield* selectAll(key);
  }, persistence("ComposeRepo.list"));

  /** How many messages the buffer holds. */
  const count = Effect.fn("ComposeRepo.count")(function* count(
    key: ComposeKey
  ) {
    const row = yield* selectCount(key).pipe(
      // COUNT(*) always yields one row; none is the driver breaking its word.
      Effect.catchTag("NoSuchElementError", Effect.die)
    );
    return row.n;
  }, persistence("ComposeRepo.count"));

  /** Drop the whole buffer; returns how many messages were discarded. */
  const clear = Effect.fn("ComposeRepo.clear")(function* clear(
    key: ComposeKey
  ) {
    const discarded = yield* remove(key);
    return discarded.length;
  }, persistence("ComposeRepo.clear"));

  return { append, clear, count, list } as const;
});

/**
 * Compose buffers (`compose`). Entries are appended on arrival and removed only
 * by an explicit clear (/send, /cancel, /stop, /new, project switch), so a
 * draft survives restarts and never expires on a timer.
 *
 * Transactions live only inside repositories. Never run the bridge, Telegram
 * or an agent inside `withTransaction`: the transaction holds the client's only
 * permit, so it would stall every other query in the process.
 */
export class ComposeRepo extends Context.Service<
  ComposeRepo,
  Effect.Success<typeof make>
>()("@workspace/db/ComposeRepo") {
  static readonly layer = Layer.effect(ComposeRepo, make);
}
