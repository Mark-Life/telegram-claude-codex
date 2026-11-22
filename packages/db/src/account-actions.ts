import { Clock, Context, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { persistence } from "./errors";
import { Millis, OptionalFromNull, RowId } from "./schema";
import { TASK_AUTHORS } from "./tasks";

/** What a run may do on the owner's Telegram account besides reading. */
export const ACCOUNT_ACTION_KINDS = [
  "send",
  "forward",
  "edit",
  "delete",
  "media",
  "react",
  "pin",
  "unpin",
  "archive",
  "mute",
  "delete_scheduled",
  "send_scheduled",
  "poll",
  "vote",
  "raw",
] as const;

export type AccountActionKind = (typeof ACCOUNT_ACTION_KINDS)[number];

/** How a file of a `media` write goes out: the Telegram media type it takes. */
export const ACCOUNT_MEDIA_KINDS = [
  "photo",
  "video",
  "document",
  "voice",
  "audio",
] as const;

export type AccountMediaKind = (typeof ACCOUNT_MEDIA_KINDS)[number];

/**
 * Where one write is in its life. `pending` waits for the owner's button;
 * `approved` is claimed and being carried out (pressed, or written at once
 * under `direct`); `done`, `failed`, `rejected` and `expired` are final.
 */
export const ACCOUNT_ACTION_STATUSES = [
  "pending",
  "approved",
  "done",
  "failed",
  "rejected",
  "expired",
] as const;

export type AccountActionStatus = (typeof ACCOUNT_ACTION_STATUSES)[number];

/**
 * A chat as the write names it: the marked id it resolved to when the run
 * asked, so a confirmed write reaches exactly the chat the owner was shown,
 * and the label the confirmation showed.
 */
const PeerRef = Schema.Struct({ id: Schema.Int, label: Schema.String });

/**
 * The user whose run asked for the write, as the run's stamp names them, and
 * their @username when the bot knows it. Absent on a write stored before
 * requesters were kept.
 */
const Requester = Schema.Struct({
  /**
   * The name of the HTTP API key whose run asked, as it was when it asked;
   * absent for a run a chat or a task started.
   */
  apiKey: Schema.optional(Schema.String),
  /** The HTTP API run (`api_runs` row) that asked, with `apiKey`. */
  apiRunId: Schema.optional(Schema.Int),
  author: Schema.Literals(TASK_AUTHORS),
  userId: Schema.Int,
  username: Schema.optional(Schema.String),
});

const requestedBy = Schema.optional(Requester);

/** A forum topic a write goes into, with its title when the write was asked. */
const Topic = Schema.Struct({ id: Schema.Int, title: Schema.String });

/**
 * When a scheduled write goes out: `at` in ms, and `label`, the time as the
 * owner read it in the confirmation, rendered when the write was asked.
 */
const Schedule = Schema.Struct({ at: Schema.Int, label: Schema.String });

/**
 * The text of the message a write acts on, clipped, so the confirmation shows
 * what it is acted on; absent when it has none.
 */
const excerpt = Schema.optional(Schema.String);

/**
 * One file of a `media` write: the copy staged when the write was asked (so
 * what goes out is what the owner was shown), the name it goes out under, its
 * size in bytes and how it goes out.
 */
const MediaItem = Schema.Struct({
  as: Schema.Literals(ACCOUNT_MEDIA_KINDS),
  name: Schema.String,
  path: Schema.String,
  size: Schema.Int,
});

/** The write itself, one variant per kind. */
export const AccountActionPayloadSchema = Schema.Union([
  Schema.Struct({
    /** Clear the owner's draft in that chat once it is sent. */
    clearDraft: Schema.optional(Schema.Boolean),
    kind: Schema.tag("send"),
    peer: PeerRef,
    replyTo: Schema.optional(Schema.Int),
    requestedBy,
    /** Absent goes out at once. */
    schedule: Schema.optional(Schedule),
    /** Sent without a notification sound. */
    silent: Schema.optional(Schema.Boolean),
    text: Schema.String,
    /** Absent goes to the main thread, or the topic `replyTo` is in. */
    topic: Schema.optional(Topic),
  }),
  Schema.Struct({
    from: PeerRef,
    kind: Schema.tag("forward"),
    messageIds: Schema.Array(Schema.Int),
    requestedBy,
    to: PeerRef,
    /**
     * The forum topic in `to`, with its title when the write was asked, for
     * the confirmation; absent forwards into the main thread.
     */
    toTopic: Schema.optional(Topic),
  }),
  Schema.Struct({
    kind: Schema.tag("edit"),
    messageId: Schema.Int,
    peer: PeerRef,
    /** The text before the edit, clipped, for the confirmation. */
    previous: Schema.optional(Schema.String),
    requestedBy,
    text: Schema.String,
  }),
  Schema.Struct({
    /** Ids among `messageIds` someone else sent, named in the confirmation. */
    foreignIds: Schema.optional(Schema.Array(Schema.Int)),
    kind: Schema.tag("delete"),
    messageIds: Schema.Array(Schema.Int),
    peer: PeerRef,
    requestedBy,
    /** Delete for everyone; absent is true, as before it was kept. */
    revoke: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    /** On the first file of an album. */
    caption: Schema.optional(Schema.String),
    /** One file, or an album of up to ten. */
    items: Schema.Array(MediaItem),
    kind: Schema.tag("media"),
    peer: PeerRef,
    replyTo: Schema.optional(Schema.Int),
    requestedBy,
    schedule: Schema.optional(Schedule),
    silent: Schema.optional(Schema.Boolean),
    topic: Schema.optional(Topic),
  }),
  Schema.Struct({
    big: Schema.optional(Schema.Boolean),
    /** An emoji, or `custom:<id>` for a custom one; null removes the reaction. */
    emoji: Schema.NullOr(Schema.String),
    excerpt,
    kind: Schema.tag("react"),
    messageId: Schema.Int,
    peer: PeerRef,
    requestedBy,
  }),
  Schema.Struct({
    /** Pin for both sides of a private chat. */
    bothSides: Schema.optional(Schema.Boolean),
    excerpt,
    kind: Schema.tag("pin"),
    messageId: Schema.Int,
    /** Notify the members; absent pins silently. */
    notify: Schema.optional(Schema.Boolean),
    peer: PeerRef,
    requestedBy,
  }),
  Schema.Struct({
    excerpt,
    kind: Schema.tag("unpin"),
    messageId: Schema.Int,
    peer: PeerRef,
    requestedBy,
  }),
  Schema.Struct({
    /** true moves the chat to the archive, false back out of it. */
    archived: Schema.Boolean,
    kind: Schema.tag("archive"),
    peer: PeerRef,
    requestedBy,
  }),
  Schema.Struct({
    kind: Schema.tag("mute"),
    /** When the time a temporary mute ends reads in the owner's home zone. */
    label: Schema.String,
    /** Unix seconds: 0 unmutes, `2147483647` mutes for good. */
    muteUntil: Schema.Int,
    peer: PeerRef,
    requestedBy,
  }),
  Schema.Struct({
    excerpt,
    kind: Schema.tag("delete_scheduled"),
    messageIds: Schema.Array(Schema.Int),
    peer: PeerRef,
    requestedBy,
  }),
  Schema.Struct({
    excerpt,
    kind: Schema.tag("send_scheduled"),
    messageIds: Schema.Array(Schema.Int),
    peer: PeerRef,
    requestedBy,
  }),
  Schema.Struct({
    answers: Schema.Array(Schema.String),
    kind: Schema.tag("poll"),
    multiple: Schema.optional(Schema.Boolean),
    peer: PeerRef,
    /** Voters are visible to everyone. */
    public: Schema.optional(Schema.Boolean),
    question: Schema.String,
    replyTo: Schema.optional(Schema.Int),
    requestedBy,
    schedule: Schema.optional(Schedule),
    silent: Schema.optional(Schema.Boolean),
    topic: Schema.optional(Topic),
  }),
  Schema.Struct({
    kind: Schema.tag("vote"),
    messageId: Schema.Int,
    /**
     * The chosen answers' bytes, base64, as Telegram votes by them, so a poll
     * whose answers changed refuses the vote instead of moving it.
     */
    optionData: Schema.Array(Schema.String),
    /** The answers' texts, for the confirmation. */
    optionTexts: Schema.Array(Schema.String),
    /** Answer indexes, 0-based; empty retracts the vote. */
    options: Schema.Array(Schema.Int),
    peer: PeerRef,
    question: Schema.String,
    requestedBy,
  }),
  Schema.Struct({
    /**
     * Paths into `params` of the bytes values, so the confirmation shows
     * their size instead of base64; absent when there are none.
     */
    bytes: Schema.optional(Schema.Array(Schema.String)),
    kind: Schema.tag("raw"),
    /** A Telegram API method, as the schema names it: `messages.sendReaction`. */
    method: Schema.String,
    /**
     * Its arguments as checked when the run asked, in the raw tools' JSON
     * convention (camelCase keys, `long` as a decimal string, bytes as
     * base64), each peer kept as its marked id or `"me"`.
     */
    params: Schema.JsonObject,
    /** Every peer in `params`, by its path, with the label the owner read. */
    peers: Schema.Array(Schema.Struct({ path: Schema.String, peer: PeerRef })),
    requestedBy,
    /** The method's own description, its first line. */
    summary: Schema.String,
  }),
]);

export type AccountActionPayload = typeof AccountActionPayloadSchema.Type;

export type AccountRequester = typeof Requester.Type;

/** One write as the store hands it back. */
export const AccountActionEntrySchema = Schema.Struct({
  /** Chat of the confirmation message; absent under `direct`. */
  chatId: OptionalFromNull(Schema.Int),
  createdAt: Millis,
  decidedAt: OptionalFromNull(Millis),
  /** Why a `failed` write failed: the class, never message text. */
  error: OptionalFromNull(Schema.String),
  id: RowId,
  messageId: OptionalFromNull(Schema.Int),
  payload: Schema.fromJsonString(AccountActionPayloadSchema),
  status: Schema.Literals(ACCOUNT_ACTION_STATUSES),
  threadId: OptionalFromNull(Schema.Int),
});

export type AccountActionEntry = typeof AccountActionEntrySchema.Type;

const AccountActionRowSchema = AccountActionEntrySchema.pipe(
  Schema.encodeKeys({
    chatId: "chat_id",
    createdAt: "created_at",
    decidedAt: "decided_at",
    messageId: "message_id",
    threadId: "thread_id",
  })
);

const Insert = Schema.Struct({
  createdAt: Millis,
  kind: Schema.Literals(ACCOUNT_ACTION_KINDS),
  payload: Schema.fromJsonString(AccountActionPayloadSchema),
  status: Schema.Literals(["pending", "approved"]),
});

const Confirmation = Schema.Struct({
  chatId: Schema.Int,
  id: RowId,
  messageId: Schema.Int,
  threadId: Schema.NullOr(Schema.Int),
});

const Transition = Schema.Struct({
  at: Millis,
  from: Schema.Literals(ACCOUNT_ACTION_STATUSES),
  id: RowId,
  status: Schema.Literals(ACCOUNT_ACTION_STATUSES),
});

const Finish = Schema.Struct({
  at: Millis,
  error: Schema.NullOr(Schema.String),
  id: RowId,
  status: Schema.Literals(["done", "failed"]),
});

const Expire = Schema.Struct({ at: Millis, cutoff: Millis });

const make = Effect.gen(function* makeAccountActionsRepo() {
  const sql = yield* SqlClient.SqlClient;

  const columns = sql`id, payload, status, chat_id, thread_id, message_id,
    created_at, decided_at, error`;

  const insert = SqlSchema.findOne({
    Request: Insert,
    Result: AccountActionRowSchema,
    execute: (row) =>
      sql`INSERT INTO account_actions (kind, payload, status, created_at, decided_at)
          VALUES (${row.kind}, ${row.payload}, ${row.status}, ${row.createdAt},
            ${row.status === "approved" ? row.createdAt : null})
          RETURNING ${columns}`,
  });
  const selectOne = SqlSchema.findOneOption({
    Request: RowId,
    Result: AccountActionRowSchema,
    execute: (id) =>
      sql`SELECT ${columns} FROM account_actions WHERE id = ${id}`,
  });
  const confirm = SqlSchema.void({
    Request: Confirmation,
    execute: (row) =>
      sql`UPDATE account_actions
          SET chat_id = ${row.chatId}, thread_id = ${row.threadId},
            message_id = ${row.messageId}
          WHERE id = ${row.id}`,
  });
  // The status guard makes a transition a claim: of two presses, or a press
  // racing the expiry, exactly one gets the row back.
  const transition = SqlSchema.findOneOption({
    Request: Transition,
    Result: AccountActionRowSchema,
    execute: (row) =>
      sql`UPDATE account_actions SET status = ${row.status}, decided_at = ${row.at}
          WHERE id = ${row.id} AND status = ${row.from}
          RETURNING ${columns}`,
  });
  const finish = SqlSchema.findOneOption({
    Request: Finish,
    Result: AccountActionRowSchema,
    execute: (row) =>
      sql`UPDATE account_actions
          SET status = ${row.status}, error = ${row.error}, decided_at = ${row.at}
          WHERE id = ${row.id} AND status = 'approved'
          RETURNING ${columns}`,
  });
  const selectPendingOfRun = SqlSchema.findAll({
    Request: RowId,
    Result: AccountActionRowSchema,
    execute: (runId) =>
      sql`SELECT ${columns} FROM account_actions
          WHERE status = 'pending'
            AND json_extract(payload, '$.requestedBy.apiRunId') = ${runId}
          ORDER BY id ASC`,
  });
  const expire = SqlSchema.findAll({
    Request: Expire,
    Result: AccountActionRowSchema,
    execute: (row) =>
      sql`UPDATE account_actions SET status = 'expired', decided_at = ${row.at}
          WHERE status = 'pending' AND created_at < ${row.cutoff}
          RETURNING ${columns}`,
  });

  /**
   * Store a write. `pending` waits for the owner; `approved` is a write about
   * to be carried out at once (`direct`), recorded so the ledger and the table
   * agree on what was done.
   */
  const create = Effect.fn("AccountActionsRepo.create")(
    function* create(input: {
      readonly payload: AccountActionPayload;
      readonly status: "approved" | "pending";
    }) {
      const createdAt = yield* Clock.currentTimeMillis;
      // RETURNING on an INSERT always yields the row; an empty result is a defect.
      return yield* insert({
        createdAt,
        kind: input.payload.kind,
        payload: input.payload,
        status: input.status,
      }).pipe(Effect.catchTag("NoSuchElementError", Effect.die));
    },
    persistence("AccountActionsRepo.create")
  );

  /** One write, or none when there is no such id. */
  const get = Effect.fn("AccountActionsRepo.get")(function* get(id: number) {
    return yield* selectOne(id);
  }, persistence("AccountActionsRepo.get"));

  /** Remember where the confirmation message for a write was sent. */
  const attachConfirmation = Effect.fn("AccountActionsRepo.attachConfirmation")(
    function* attachConfirmation(input: {
      readonly chatId: number;
      readonly id: number;
      readonly messageId: number;
      readonly threadId: number | null;
    }) {
      yield* confirm(input);
    },
    persistence("AccountActionsRepo.attachConfirmation")
  );

  /**
   * The owner's answer to a pending write. The row as it now stands, or none
   * when it was no longer pending: already answered, or expired.
   */
  const decide = Effect.fn("AccountActionsRepo.decide")(
    function* decide(input: {
      readonly id: number;
      readonly status: "approved" | "rejected";
    }) {
      const at = yield* Clock.currentTimeMillis;
      return yield* transition({
        at,
        from: "pending",
        id: input.id,
        status: input.status,
      });
    },
    persistence("AccountActionsRepo.decide")
  );

  /** How an approved write ended; none when it was not in `approved`. */
  const complete = Effect.fn("AccountActionsRepo.complete")(
    function* complete(input: {
      readonly error?: string;
      readonly id: number;
      readonly status: "done" | "failed";
    }) {
      const at = yield* Clock.currentTimeMillis;
      return yield* finish({
        at,
        error: input.error ?? null,
        id: input.id,
        status: input.status,
      });
    },
    persistence("AccountActionsRepo.complete")
  );

  /** Expire every write pending since before `cutoff`; returns those rows. */
  const expireBefore = Effect.fn("AccountActionsRepo.expireBefore")(
    function* expireBefore(cutoff: number) {
      const at = yield* Clock.currentTimeMillis;
      return yield* expire({ at, cutoff });
    },
    persistence("AccountActionsRepo.expireBefore")
  );

  /**
   * The writes an HTTP API run asked for that still wait for the owner's
   * button, oldest first.
   */
  const pendingOfApiRun = Effect.fn("AccountActionsRepo.pendingOfApiRun")(
    function* pendingOfApiRun(runId: number) {
      return yield* selectPendingOfRun(runId);
    },
    persistence("AccountActionsRepo.pendingOfApiRun")
  );

  return {
    attachConfirmation,
    complete,
    create,
    decide,
    expireBefore,
    get,
    pendingOfApiRun,
  } as const;
});

/**
 * Writes on the owner's Telegram account (`account_actions`). Every write a
 * run asks for is a row, whether it waited for a button or not, so what was
 * sent as the owner is on record beside the ledger line that says it.
 *
 * Transactions live only inside repositories. Never run the bridge, Telegram
 * or an agent inside `withTransaction`: the transaction holds the client's only
 * permit, so it would stall every other query in the process.
 */
export class AccountActionsRepo extends Context.Service<
  AccountActionsRepo,
  Effect.Success<typeof make>
>()("@workspace/db/AccountActionsRepo") {
  static readonly layer = Layer.effect(AccountActionsRepo, make);
}
