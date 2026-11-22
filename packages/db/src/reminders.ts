import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { persistence } from "./errors";
import { Millis, OptionalFromNull, RowId } from "./schema";

/** One shared reminder. A row remains active after notification until completed. */
export const ReminderEntrySchema = Schema.Struct({
  acknowledgedAt: OptionalFromNull(Millis),
  chatId: OptionalFromNull(Schema.Int),
  claimUntil: OptionalFromNull(Millis),
  createdAt: Millis,
  dueAt: OptionalFromNull(Millis),
  id: RowId,
  messageId: OptionalFromNull(Schema.Int),
  notifiedAt: OptionalFromNull(Millis),
  text: Schema.String,
  threadId: OptionalFromNull(Schema.Int),
  timezone: Schema.String,
});

export type ReminderEntry = typeof ReminderEntrySchema.Type;

export interface ReminderDraft {
  dueAt?: number;
  text: string;
  timezone: string;
}

/** `null` clears a due date; an absent field stays unchanged. */
export interface ReminderPatch {
  dueAt?: number | null;
  text?: string;
  timezone?: string;
}

export interface ReminderListFilter {
  dueFrom?: number;
  dueTo?: number;
  limit?: number;
  offset?: number;
}

const COLUMNS =
  "id, text, due_at, timezone, created_at, notified_at, acknowledged_at, claim_until, chat_id, thread_id, message_id";

/**
 * The `reminders` row as it is stored: the entry's fields under their column
 * names. Every SELECT and RETURNING lists `COLUMNS`, so a row decodes through
 * this schema and a NULL column reads as an absent field.
 */
const StoredReminder = ReminderEntrySchema.pipe(
  Schema.encodeKeys({
    acknowledgedAt: "acknowledged_at",
    chatId: "chat_id",
    claimUntil: "claim_until",
    createdAt: "created_at",
    dueAt: "due_at",
    messageId: "message_id",
    notifiedAt: "notified_at",
    threadId: "thread_id",
  })
);

const Claimed = Schema.Struct({ id: RowId });
const Total = Schema.Struct({ total: Schema.Int });

const ListQuery = Schema.Struct({
  dueFrom: Schema.optional(Millis),
  dueTo: Schema.optional(Millis),
  limit: Schema.Int,
  offset: Schema.Int,
});
const CountQuery = Schema.Struct({
  dueFrom: Schema.optional(Millis),
  dueTo: Schema.optional(Millis),
});
const Insert = Schema.Struct({
  createdAt: Millis,
  dueAt: Schema.NullOr(Millis),
  text: Schema.String,
  timezone: Schema.String,
});
const Patch = Schema.Struct({
  dueAt: Schema.optional(Schema.NullOr(Millis)),
  id: RowId,
  text: Schema.optional(Schema.String),
  timezone: Schema.optional(Schema.String),
});
const DueQuery = Schema.Struct({
  limit: Schema.Int,
  now: Millis,
  repeatBefore: Millis,
});
const Lease = Schema.Struct({
  id: RowId,
  leaseUntil: Millis,
  now: Millis,
  repeatBefore: Millis,
});
const Acknowledgement = Schema.Struct({ at: Millis, id: RowId });
const Destination = Schema.Struct({
  chatId: Schema.Int,
  id: RowId,
  messageId: Schema.NullOr(Schema.Int),
  threadId: Schema.NullOr(Schema.Int),
});
const Notification = Schema.Struct({
  at: Millis,
  id: RowId,
  messageId: Schema.Int,
});
const ThreadRoute = Schema.Struct({ chatId: Schema.Int, threadId: Schema.Int });
const MessageRoute = Schema.Struct({
  chatId: Schema.Int,
  messageId: Schema.Int,
});

const make = Effect.gen(function* makeRemindersRepo() {
  const sql = yield* SqlClient.SqlClient;
  const columns = sql.literal(COLUMNS);

  /** The bounded due-date clause shared by `list` and `count`. */
  const dueWindow = (filter: { dueFrom?: number; dueTo?: number }) =>
    sql.and([
      ...(filter.dueFrom === undefined
        ? []
        : [sql`due_at >= ${filter.dueFrom}`]),
      ...(filter.dueTo === undefined ? [] : [sql`due_at < ${filter.dueTo}`]),
    ]);

  const selectOne = SqlSchema.findOneOption({
    Request: RowId,
    Result: StoredReminder,
    execute: (id) => sql`SELECT ${columns} FROM reminders WHERE id = ${id}`,
  });
  const selectPage = SqlSchema.findAll({
    Request: ListQuery,
    Result: StoredReminder,
    execute: (query) =>
      sql`SELECT ${columns} FROM reminders
          WHERE ${dueWindow(query)}
          ORDER BY due_at IS NULL ASC, due_at ASC, id ASC
          LIMIT ${query.limit} OFFSET ${query.offset}`,
  });
  const selectTotal = SqlSchema.findOne({
    Request: CountQuery,
    Result: Total,
    execute: (query) =>
      sql`SELECT COUNT(*) AS total FROM reminders WHERE ${dueWindow(query)}`,
  });
  const insert = SqlSchema.findOne({
    Request: Insert,
    Result: StoredReminder,
    execute: (row) =>
      sql`INSERT INTO reminders (text, due_at, timezone, created_at)
          VALUES (${row.text}, ${row.dueAt}, ${row.timezone}, ${row.createdAt})
          RETURNING ${columns}`,
  });
  const patch = SqlSchema.findOneOption({
    Request: Patch,
    Result: StoredReminder,
    execute: (row) => {
      const sets: Record<string, number | string | null> = {};
      if (row.text !== undefined) {
        sets.text = row.text;
      }
      if (row.timezone !== undefined) {
        sets.timezone = row.timezone;
      }
      if (row.dueAt !== undefined) {
        // A new due date starts the reminder over: not notified, not
        // acknowledged, not claimed.
        sets.due_at = row.dueAt;
        sets.notified_at = null;
        sets.acknowledged_at = null;
        sets.claim_until = null;
      }
      return sql`UPDATE reminders SET ${sql.update(sets)}
                 WHERE id = ${row.id}
                 RETURNING ${columns}`;
    },
  });
  const remove = SqlSchema.findOneOption({
    Request: RowId,
    Result: Claimed,
    execute: (id) => sql`DELETE FROM reminders WHERE id = ${id} RETURNING id`,
  });
  const selectDue = SqlSchema.findAll({
    Request: DueQuery,
    Result: StoredReminder,
    execute: (query) =>
      sql`SELECT ${columns} FROM reminders
          WHERE due_at IS NOT NULL
            AND due_at <= ${query.now}
            AND acknowledged_at IS NULL
            AND (notified_at IS NULL OR notified_at <= ${query.repeatBefore})
            AND (claim_until IS NULL OR claim_until <= ${query.now})
          ORDER BY due_at ASC, id ASC
          LIMIT ${query.limit}`,
  });
  // The guards repeat the SELECT's so a row another tick leased between the
  // two statements is skipped, not re-leased.
  const lease = SqlSchema.findOneOption({
    Request: Lease,
    Result: Claimed,
    execute: (row) =>
      sql`UPDATE reminders SET claim_until = ${row.leaseUntil}
          WHERE id = ${row.id}
            AND acknowledged_at IS NULL
            AND (notified_at IS NULL OR notified_at <= ${row.repeatBefore})
            AND (claim_until IS NULL OR claim_until <= ${row.now})
          RETURNING id`,
  });
  const unlease = SqlSchema.void({
    Request: RowId,
    execute: (id) =>
      sql`UPDATE reminders SET claim_until = NULL WHERE id = ${id}`,
  });
  const complete = SqlSchema.findOneOption({
    Request: Acknowledgement,
    Result: StoredReminder,
    execute: (row) =>
      sql`UPDATE reminders
          SET acknowledged_at = ${row.at}, claim_until = NULL
          WHERE id = ${row.id}
          RETURNING ${columns}`,
  });
  const route = SqlSchema.findOneOption({
    Request: Destination,
    Result: StoredReminder,
    execute: (row) =>
      sql`UPDATE reminders
          SET chat_id = ${row.chatId}, thread_id = ${row.threadId}, message_id = ${row.messageId}
          WHERE id = ${row.id}
          RETURNING ${columns}`,
  });
  const notify = SqlSchema.findOneOption({
    Request: Notification,
    Result: StoredReminder,
    execute: (row) =>
      sql`UPDATE reminders
          SET notified_at = ${row.at},
              acknowledged_at = NULL,
              claim_until = NULL,
              message_id = ${row.messageId}
          WHERE id = ${row.id}
          RETURNING ${columns}`,
  });
  const selectByThread = SqlSchema.findOneOption({
    Request: ThreadRoute,
    Result: StoredReminder,
    execute: (key) =>
      sql`SELECT ${columns} FROM reminders
          WHERE chat_id = ${key.chatId} AND thread_id = ${key.threadId}
          ORDER BY id DESC LIMIT 1`,
  });
  const selectByMessage = SqlSchema.findOneOption({
    Request: MessageRoute,
    Result: StoredReminder,
    execute: (key) =>
      sql`SELECT ${columns} FROM reminders
          WHERE chat_id = ${key.chatId} AND message_id = ${key.messageId}
          ORDER BY id DESC LIMIT 1`,
  });

  /** The reminder, none when the id is unknown. */
  const get = Effect.fn("RemindersRepo.get")(function* get(id: number) {
    return yield* selectOne(id);
  }, persistence("RemindersRepo.get"));

  /** Reminders in due order, undated last; `limit` absent means every row. */
  const list = Effect.fn("RemindersRepo.list")(function* list(
    filter: ReminderListFilter = {}
  ) {
    return yield* selectPage({
      dueFrom: filter.dueFrom,
      dueTo: filter.dueTo,
      limit: filter.limit ?? -1,
      offset: filter.offset ?? 0,
    });
  }, persistence("RemindersRepo.list"));

  /** How many reminders `list` would see under the same due-date window. */
  const count = Effect.fn("RemindersRepo.count")(function* count(
    filter: ReminderListFilter = {}
  ) {
    const row = yield* selectTotal({
      dueFrom: filter.dueFrom,
      dueTo: filter.dueTo,
    }).pipe(Effect.catchTag("NoSuchElementError", Effect.die));
    return row.total;
  }, persistence("RemindersRepo.count"));

  /** Store a new reminder; `createdAt` is the clock's now. */
  const create = Effect.fn("RemindersRepo.create")(function* create(
    draft: ReminderDraft
  ) {
    const createdAt = yield* Clock.currentTimeMillis;
    return yield* insert({
      createdAt,
      dueAt: draft.dueAt ?? null,
      text: draft.text,
      timezone: draft.timezone,
    }).pipe(
      // An INSERT … RETURNING that returns nothing is not a data condition.
      Effect.catchTag("NoSuchElementError", Effect.die)
    );
  }, persistence("RemindersRepo.create"));

  /**
   * Change text, timezone or due date; a `null` due date clears it. An empty
   * patch changes nothing and reads the row back. None when the id is unknown.
   */
  const update = Effect.fn("RemindersRepo.update")(function* update(
    id: number,
    changes: ReminderPatch
  ) {
    if (
      changes.dueAt === undefined &&
      changes.text === undefined &&
      changes.timezone === undefined
    ) {
      return yield* selectOne(id);
    }
    return yield* patch({
      dueAt: changes.dueAt,
      id,
      text: changes.text,
      timezone: changes.timezone,
    });
  }, persistence("RemindersRepo.update"));

  /** Delete the reminder; false when the id was unknown. */
  const drop = Effect.fn("RemindersRepo.drop")(function* drop(id: number) {
    const deleted = yield* remove(id);
    return Option.isSome(deleted);
  }, persistence("RemindersRepo.drop"));

  /**
   * Atomically lease due, undelivered rows so overlapping ticks cannot resend.
   * Claimed rows come back in due order carrying the new `claimUntil`. One
   * guarded UPDATE per row, not a single `UPDATE … RETURNING`: SQLite does not
   * order that statement's rows.
   */
  const claimDue = Effect.fn("RemindersRepo.claimDue")(
    function* claimDue(input: {
      readonly leaseUntil: number;
      readonly limit: number;
      readonly now: number;
      readonly repeatBefore: number;
    }) {
      return yield* sql.withTransaction(
        Effect.gen(function* claim() {
          const due = yield* selectDue({
            limit: input.limit,
            now: input.now,
            repeatBefore: input.repeatBefore,
          });
          const claimed: ReminderEntry[] = [];
          for (const reminder of due) {
            const won = yield* lease({
              id: reminder.id,
              leaseUntil: input.leaseUntil,
              now: input.now,
              repeatBefore: input.repeatBefore,
            });
            if (Option.isSome(won)) {
              claimed.push({ ...reminder, claimUntil: input.leaseUntil });
            }
          }
          return claimed;
        })
      );
    },
    persistence("RemindersRepo.claimDue")
  );

  /** Give a leased reminder back so the next tick may deliver it. */
  const releaseClaim = Effect.fn("RemindersRepo.releaseClaim")(
    function* releaseClaim(id: number) {
      yield* unlease(id);
    },
    persistence("RemindersRepo.releaseClaim")
  );

  /** Mark the reminder done at `at` and drop its lease. None when unknown. */
  const acknowledge = Effect.fn("RemindersRepo.acknowledge")(
    function* acknowledge(input: { readonly at: number; readonly id: number }) {
      return yield* complete(input);
    },
    persistence("RemindersRepo.acknowledge")
  );

  /** Record where the reminder is (or will be) delivered. None when unknown. */
  const setDestination = Effect.fn("RemindersRepo.setDestination")(
    function* setDestination(input: {
      readonly chatId: number;
      readonly id: number;
      readonly messageId?: number;
      readonly threadId?: number;
    }) {
      return yield* route({
        chatId: input.chatId,
        id: input.id,
        messageId: input.messageId ?? null,
        threadId: input.threadId ?? null,
      });
    },
    persistence("RemindersRepo.setDestination")
  );

  /**
   * Record a delivery: notified at `at` through `messageId`, awaiting a fresh
   * acknowledgement, lease released. None when unknown.
   */
  const markNotified = Effect.fn("RemindersRepo.markNotified")(
    function* markNotified(input: {
      readonly at: number;
      readonly id: number;
      readonly messageId: number;
    }) {
      return yield* notify(input);
    },
    persistence("RemindersRepo.markNotified")
  );

  /** The newest reminder delivered into a forum topic. */
  const findByThread = Effect.fn("RemindersRepo.findByThread")(
    function* findByThread(input: {
      readonly chatId: number;
      readonly threadId: number;
    }) {
      return yield* selectByThread(input);
    },
    persistence("RemindersRepo.findByThread")
  );

  /** The newest reminder delivered as a given message. */
  const findByMessage = Effect.fn("RemindersRepo.findByMessage")(
    function* findByMessage(input: {
      readonly chatId: number;
      readonly messageId: number;
    }) {
      return yield* selectByMessage(input);
    },
    persistence("RemindersRepo.findByMessage")
  );

  return {
    acknowledge,
    claimDue,
    count,
    create,
    drop,
    findByMessage,
    findByThread,
    get,
    list,
    markNotified,
    releaseClaim,
    setDestination,
    update,
  } as const;
});

/**
 * The shared owner/executor reminder registry (`reminders`).
 *
 * Transactions live only inside repositories. Never run the bridge, Telegram
 * or an agent inside `withTransaction`: the transaction holds the client's only
 * permit, so it would stall every other query in the process.
 */
export class RemindersRepo extends Context.Service<
  RemindersRepo,
  Effect.Success<typeof make>
>()("@workspace/db/RemindersRepo") {
  static readonly layer = Layer.effect(RemindersRepo, make);
}
