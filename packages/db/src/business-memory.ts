import { Clock, Context, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { persistence } from "./errors";
import { Millis, OptionalFromNull, RowId } from "./schema";

/** Who wrote a Business message: the bot, the account owner, or the peer. */
const BusinessSenderRoleSchema = Schema.Literals([
  "assistant",
  "owner",
  "peer",
]);
export type BusinessSenderRole = typeof BusinessSenderRoleSchema.Type;

/** Where a voice message's transcript stands; `none` means no voice at all. */
const TranscriptStatusSchema = Schema.Literals([
  "failed",
  "none",
  "pending",
  "ready",
]);
export type TranscriptStatus = typeof TranscriptStatusSchema.Type;

/** One Business conversation the bot has seen, keyed by connection and chat. */
export const BusinessChatSchema = Schema.Struct({
  businessConnectionId: Schema.String,
  chatId: Schema.Int,
  peerId: OptionalFromNull(Schema.Int),
  title: Schema.String,
  username: OptionalFromNull(Schema.String),
});
export type BusinessChat = typeof BusinessChatSchema.Type;

/**
 * One archived Business message. `kind` is an open set: the bot writes whatever
 * Telegram sends, so it stays a string rather than a literal list.
 */
export const BusinessMemoryMessageSchema = Schema.Struct({
  businessConnectionId: Schema.String,
  chatId: Schema.Int,
  editedAt: OptionalFromNull(Millis),
  ingestedAt: Millis,
  kind: Schema.String,
  mediaFileId: OptionalFromNull(Schema.String),
  messageId: Schema.Int,
  replyToMessageId: OptionalFromNull(Schema.Int),
  senderId: OptionalFromNull(Schema.Int),
  senderName: Schema.String,
  senderRole: BusinessSenderRoleSchema,
  senderUsername: OptionalFromNull(Schema.String),
  sentAt: Millis,
  text: Schema.String,
  transcript: OptionalFromNull(Schema.String),
  transcriptStatus: TranscriptStatusSchema,
  // bun:sqlite reads a BLOB back as a Uint8Array and binds one as-is.
  voiceData: OptionalFromNull(Schema.Uint8Array),
  voiceFileId: OptionalFromNull(Schema.String),
});
export type BusinessMemoryMessage = typeof BusinessMemoryMessageSchema.Type;

const MESSAGE_COLUMNS = `business_connection_id, chat_id, message_id,
  sender_role, sender_id, sender_name, sender_username, text, message_kind,
  reply_to_message_id, sent_at, edited_at, ingested_at, media_file_id, voice_file_id,
  voice_data, transcript, transcript_status`;

/** The `business_messages` row as stored, decoded straight into the record. */
const StoredMessage = BusinessMemoryMessageSchema.pipe(
  Schema.encodeKeys({
    businessConnectionId: "business_connection_id",
    chatId: "chat_id",
    editedAt: "edited_at",
    ingestedAt: "ingested_at",
    kind: "message_kind",
    mediaFileId: "media_file_id",
    messageId: "message_id",
    replyToMessageId: "reply_to_message_id",
    senderId: "sender_id",
    senderName: "sender_name",
    senderRole: "sender_role",
    senderUsername: "sender_username",
    sentAt: "sent_at",
    transcript: "transcript",
    transcriptStatus: "transcript_status",
    voiceData: "voice_data",
    voiceFileId: "voice_file_id",
  })
);

/** What identifies one message: the connection, the chat and Telegram's id. */
const MessageKey = Schema.Struct({
  businessConnectionId: Schema.String,
  chatId: Schema.Int,
  messageId: Schema.Int,
});
export type BusinessMessageKey = typeof MessageKey.Type;

const ChatSeen = Schema.Struct({
  ...BusinessChatSchema.fields,
  seenAt: Millis,
});
const RecentQuery = Schema.Struct({
  businessConnectionId: Schema.String,
  chatId: Schema.Int,
  from: Millis,
  limit: Schema.Int,
});
const TranscriptWrite = Schema.Struct({
  ...MessageKey.fields,
  status: TranscriptStatusSchema,
  transcript: OptionalFromNull(Schema.String),
});
const DeletedId = Schema.Struct({ id: RowId });

const make = Effect.gen(function* makeBusinessMemoryRepo() {
  const sql = yield* SqlClient.SqlClient;
  const messageColumns = sql.literal(MESSAGE_COLUMNS);

  const upsertChat = SqlSchema.void({
    Request: ChatSeen,
    execute: (chat) =>
      sql`INSERT INTO business_chats
            (business_connection_id, chat_id, peer_id, title, username,
             first_seen_at, last_seen_at)
          VALUES (${chat.businessConnectionId}, ${chat.chatId},
                  ${chat.peerId ?? null}, ${chat.title}, ${chat.username ?? null},
                  ${chat.seenAt}, ${chat.seenAt})
          ON CONFLICT(business_connection_id, chat_id) DO UPDATE SET
            peer_id = excluded.peer_id,
            title = excluded.title,
            username = excluded.username,
            last_seen_at = excluded.last_seen_at`,
  });
  // A re-record keeps the voice, its bytes and the transcript already stored
  // when the new copy has none, and a `none` status never overwrites a real one.
  const upsertMessage = SqlSchema.void({
    Request: BusinessMemoryMessageSchema,
    execute: (m) =>
      sql`INSERT INTO business_messages
            (business_connection_id, chat_id, message_id, sender_role, sender_id,
             sender_name, sender_username, text, message_kind, reply_to_message_id,
             sent_at, edited_at, ingested_at, media_file_id, voice_file_id,
             voice_data, transcript, transcript_status)
          VALUES (${m.businessConnectionId}, ${m.chatId}, ${m.messageId},
                  ${m.senderRole}, ${m.senderId ?? null}, ${m.senderName},
                  ${m.senderUsername ?? null}, ${m.text}, ${m.kind},
                  ${m.replyToMessageId ?? null}, ${m.sentAt}, ${m.editedAt ?? null},
                  ${m.ingestedAt}, ${m.mediaFileId ?? null}, ${m.voiceFileId ?? null},
                  ${m.voiceData ?? null}, ${m.transcript ?? null},
                  ${m.transcriptStatus})
          ON CONFLICT(business_connection_id, chat_id, message_id) DO UPDATE SET
            sender_role = excluded.sender_role,
            sender_id = excluded.sender_id,
            sender_name = excluded.sender_name,
            sender_username = excluded.sender_username,
            text = excluded.text,
            message_kind = excluded.message_kind,
            reply_to_message_id = excluded.reply_to_message_id,
            sent_at = excluded.sent_at,
            edited_at = excluded.edited_at,
            media_file_id = excluded.media_file_id,
            voice_file_id = COALESCE(excluded.voice_file_id, business_messages.voice_file_id),
            voice_data = COALESCE(excluded.voice_data, business_messages.voice_data),
            transcript = COALESCE(excluded.transcript, business_messages.transcript),
            transcript_status = CASE
              WHEN excluded.transcript_status = 'none'
                THEN business_messages.transcript_status
              ELSE excluded.transcript_status
            END`,
  });
  const selectMessage = SqlSchema.findOneOption({
    Request: MessageKey,
    Result: StoredMessage,
    execute: (key) =>
      sql`SELECT ${messageColumns} FROM business_messages
          WHERE business_connection_id = ${key.businessConnectionId}
            AND chat_id = ${key.chatId} AND message_id = ${key.messageId}`,
  });
  // The newest `limit` messages since `from`, handed back oldest first.
  const selectRecent = SqlSchema.findAll({
    Request: RecentQuery,
    Result: StoredMessage,
    execute: (q) =>
      sql`SELECT ${messageColumns} FROM (
            SELECT ${messageColumns} FROM business_messages
            WHERE business_connection_id = ${q.businessConnectionId}
              AND chat_id = ${q.chatId} AND sent_at >= ${q.from}
            ORDER BY sent_at DESC, message_id DESC LIMIT ${q.limit}
          ) ORDER BY sent_at, message_id`,
  });
  const updateTranscript = SqlSchema.void({
    Request: TranscriptWrite,
    execute: (t) =>
      sql`UPDATE business_messages
          SET transcript = ${t.transcript ?? null}, transcript_status = ${t.status}
          WHERE business_connection_id = ${t.businessConnectionId}
            AND chat_id = ${t.chatId} AND message_id = ${t.messageId}`,
  });
  const deleteMessage = SqlSchema.findAll({
    Request: MessageKey,
    Result: DeletedId,
    execute: (key) =>
      sql`DELETE FROM business_messages
          WHERE business_connection_id = ${key.businessConnectionId}
            AND chat_id = ${key.chatId} AND message_id = ${key.messageId}
          RETURNING id`,
  });
  const deleteExpired = SqlSchema.findAll({
    Request: Millis,
    Result: DeletedId,
    execute: (cutoff) =>
      sql`DELETE FROM business_messages WHERE sent_at < ${cutoff} RETURNING id`,
  });
  const deleteEmptyChats = sql`DELETE FROM business_chats
    WHERE NOT EXISTS (
      SELECT 1 FROM business_messages AS messages
      WHERE messages.business_connection_id = business_chats.business_connection_id
        AND messages.chat_id = business_chats.chat_id
    )`;

  /** Upsert the chat; a known one keeps `first_seen_at` and bumps `last_seen_at`. */
  const rememberChat = Effect.fn("BusinessMemoryRepo.rememberChat")(
    function* rememberChat(chat: BusinessChat) {
      const seenAt = yield* Clock.currentTimeMillis;
      yield* upsertChat({ ...chat, seenAt });
    },
    persistence("BusinessMemoryRepo.rememberChat")
  );

  /** Store (or re-store) one message; the chat row must already exist. */
  const record = Effect.fn("BusinessMemoryRepo.record")(function* record(
    message: BusinessMemoryMessage
  ) {
    yield* upsertMessage(message);
  }, persistence("BusinessMemoryRepo.record"));

  /** One message by its key, none when it was never archived. */
  const get = Effect.fn("BusinessMemoryRepo.get")(function* get(
    key: BusinessMessageKey
  ) {
    return yield* selectMessage(key);
  }, persistence("BusinessMemoryRepo.get"));

  /** The newest `limit` messages of a chat sent at or after `from`, oldest first. */
  const listRecent = Effect.fn("BusinessMemoryRepo.listRecent")(
    function* listRecent(query: {
      readonly businessConnectionId: string;
      readonly chatId: number;
      readonly from: number;
      readonly limit: number;
    }) {
      return yield* selectRecent(query);
    },
    persistence("BusinessMemoryRepo.listRecent")
  );

  /** Set a voice message's transcript and status; no transcript clears it. */
  const setTranscript = Effect.fn("BusinessMemoryRepo.setTranscript")(
    function* setTranscript(input: {
      readonly businessConnectionId: string;
      readonly chatId: number;
      readonly messageId: number;
      readonly status: TranscriptStatus;
      readonly transcript?: string;
    }) {
      yield* updateTranscript(input);
    },
    persistence("BusinessMemoryRepo.setTranscript")
  );

  /**
   * Delete the given messages of one chat and any chat left empty, in one
   * transaction. Returns how many messages existed.
   */
  const remove = Effect.fn("BusinessMemoryRepo.remove")(
    function* remove(input: {
      readonly businessConnectionId: string;
      readonly chatId: number;
      readonly messageIds: readonly number[];
    }) {
      return yield* sql.withTransaction(
        Effect.gen(function* removeInTransaction() {
          let changes = 0;
          for (const messageId of input.messageIds) {
            const deleted = yield* deleteMessage({
              businessConnectionId: input.businessConnectionId,
              chatId: input.chatId,
              messageId,
            });
            changes += deleted.length;
          }
          yield* deleteEmptyChats;
          return changes;
        })
      );
    },
    persistence("BusinessMemoryRepo.remove")
  );

  /**
   * Delete every message sent before `cutoff` and any chat left empty, in one
   * transaction. Returns how many messages went.
   */
  const cleanup = Effect.fn("BusinessMemoryRepo.cleanup")(function* cleanup(
    cutoff: number
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* cleanupInTransaction() {
        const deleted = yield* deleteExpired(cutoff);
        yield* deleteEmptyChats;
        return deleted.length;
      })
    );
  }, persistence("BusinessMemoryRepo.cleanup"));

  return {
    cleanup,
    get,
    listRecent,
    record,
    rememberChat,
    remove,
    setTranscript,
  } as const;
});

/**
 * The Telegram Business archive (`business_chats`, `business_messages` and its
 * FTS index, kept in step by triggers). Timestamps are epoch milliseconds.
 *
 * Transactions live only inside repositories. Never run the bridge, Telegram
 * or an agent inside `withTransaction`: the transaction holds the client's only
 * permit, so it would stall every other query in the process.
 */
export class BusinessMemoryRepo extends Context.Service<
  BusinessMemoryRepo,
  Effect.Success<typeof make>
>()("@workspace/db/BusinessMemoryRepo") {
  static readonly layer = Layer.effect(BusinessMemoryRepo, make);
}
