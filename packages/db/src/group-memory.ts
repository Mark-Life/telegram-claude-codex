import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import type { Fragment } from "effect/sql/Statement";

import { persistence } from "./errors";
import { Millis, OptionalFromNull, RowId } from "./schema";

/**
 * One durable message belonging to exactly one Telegram group. `kind` is an
 * open vocabulary (the producers return plain strings), so it stays a string.
 */
export const GroupMemoryMessageSchema = Schema.Struct({
  chatId: Schema.Int,
  createdAt: Millis,
  from: Schema.String,
  kind: OptionalFromNull(Schema.String),
  messageId: Schema.Int,
  replyToMessageId: OptionalFromNull(Schema.Int),
  senderId: OptionalFromNull(Schema.Int),
  senderUsername: OptionalFromNull(Schema.String),
  sentAt: OptionalFromNull(Millis),
  text: Schema.String,
  threadId: OptionalFromNull(Schema.Int),
});
export type GroupMemoryMessage = typeof GroupMemoryMessageSchema.Type;

/** A Telegram group known to the bot, addressable by title from owner runs. */
export const GroupChatSchema = Schema.Struct({
  chatId: Schema.Int,
  chatType: Schema.String,
  firstSeenAt: Millis,
  isForum: Schema.BooleanFromBit,
  lastSeenAt: Millis,
  title: Schema.String,
  username: OptionalFromNull(Schema.String),
});
export type GroupChat = typeof GroupChatSchema.Type;

/** One curated, independently editable fact belonging to one group. */
export const GroupFactSchema = Schema.Struct({
  chatId: Schema.Int,
  content: Schema.String,
  createdAt: Millis,
  createdByUserId: OptionalFromNull(Schema.Int),
  id: RowId,
  kind: Schema.String,
  sourceMessageId: OptionalFromNull(Schema.Int),
  updatedAt: Millis,
});
export type GroupFact = typeof GroupFactSchema.Type;

/**
 * A message search: full text when `query` has a non-blank trimmed form,
 * otherwise the newest messages matching the chat and time bounds.
 */
export const GroupMessageSearchSchema = Schema.Struct({
  chatId: Schema.optional(Schema.Int),
  from: Schema.optional(Millis),
  limit: Schema.Int,
  query: Schema.optional(Schema.String),
  to: Schema.optional(Millis),
});
export type GroupMessageSearch = typeof GroupMessageSearchSchema.Type;

const DEFAULT_CHAT_LIST_LIMIT = 20;

/** Curated facts for one Telegram group, isolated by its chat id. */
export const GroupFactSheetSchema = Schema.Struct({
  chatId: Schema.Int,
  chatTitle: Schema.String,
  content: Schema.String,
  updatedAt: Millis,
});
export type GroupFactSheet = typeof GroupFactSheetSchema.Type;

const MessageRecord = GroupMemoryMessageSchema.pipe(
  Schema.encodeKeys({
    chatId: "chat_id",
    createdAt: "created_at",
    from: "sender_name",
    kind: "message_kind",
    messageId: "message_id",
    replyToMessageId: "reply_to_message_id",
    senderId: "sender_id",
    senderUsername: "sender_username",
    sentAt: "sent_at",
    threadId: "thread_id",
  })
);
const ChatRecord = GroupChatSchema.pipe(
  Schema.encodeKeys({
    chatId: "chat_id",
    chatType: "chat_type",
    firstSeenAt: "first_seen_at",
    isForum: "is_forum",
    lastSeenAt: "last_seen_at",
  })
);
const FactRecord = GroupFactSchema.pipe(
  Schema.encodeKeys({
    chatId: "chat_id",
    createdAt: "created_at",
    createdByUserId: "created_by_user_id",
    sourceMessageId: "source_message_id",
    updatedAt: "updated_at",
  })
);
const FactSheetRecord = GroupFactSheetSchema.pipe(
  Schema.encodeKeys({
    chatId: "chat_id",
    chatTitle: "chat_title",
    updatedAt: "updated_at",
  })
);
const ChatIdRecord = Schema.Struct({ chatId: Schema.Int }).pipe(
  Schema.encodeKeys({ chatId: "chat_id" })
);
const FactIdRecord = Schema.Struct({ id: RowId });

const MessagePage = Schema.Struct({ chatId: Schema.Int, limit: Schema.Int });
const ChatPage = Schema.Struct({ limit: Schema.Int });
const ChatSearch = Schema.Struct({ limit: Schema.Int, pattern: Schema.String });

/** What `addFact` takes: the fact's own columns, timestamps added here. */
const FactInsert = Schema.Struct({
  chatId: Schema.Int,
  content: Schema.String,
  createdByUserId: Schema.optional(Schema.Int),
  kind: Schema.String,
  sourceMessageId: Schema.optional(Schema.Int),
});
export type GroupFactInsert = Schema.Schema.Type<typeof FactInsert>;
const FactInsertRow = Schema.Struct({ ...FactInsert.fields, now: Millis });

/** What `updateFact` takes: an absent field keeps the stored value. */
const FactPatch = Schema.Struct({
  content: Schema.optional(Schema.String),
  id: RowId,
  kind: Schema.optional(Schema.String),
});
export type GroupFactPatch = Schema.Schema.Type<typeof FactPatch>;
const FactPatchRow = Schema.Struct({ ...FactPatch.fields, now: Millis });

/** What `rememberChat` takes; `first_seen_at` is set once and kept. */
export type GroupChatSeen = Pick<
  GroupChat,
  "chatId" | "chatType" | "isForum" | "title"
> & { readonly username?: string };

/** What `setFactSheet` takes; `updated_at` is set here. */
export type GroupFactSheetWrite = Pick<
  GroupFactSheet,
  "chatId" | "chatTitle" | "content"
>;

const make = Effect.gen(function* makeGroupMemoryRepo() {
  const sql = yield* SqlClient.SqlClient;

  // Every message SELECT reads `group_messages` under the alias `gm`, so an
  // ORDER BY can name the raw `gm.sent_at` while the result carries the
  // pre-v6 fallback `COALESCE(sent_at, created_at)` the old mapper applied.
  const messageColumns = sql.literal(
    `gm.chat_id, gm.message_id, gm.sender_name, gm.text, gm.created_at,
     gm.thread_id, gm.sender_id, gm.sender_username,
     COALESCE(gm.sent_at, gm.created_at) AS sent_at,
     gm.reply_to_message_id, gm.message_kind`
  );
  const factColumns = sql.literal(
    `id, chat_id, kind, content, source_message_id, created_by_user_id,
     created_at, updated_at`
  );

  const selectMessages = SqlSchema.findAll({
    Request: MessagePage,
    Result: MessageRecord,
    execute: (page) =>
      sql`SELECT ${messageColumns}
          FROM (
            SELECT chat_id, message_id, sender_name, text, created_at, thread_id,
                   sender_id, sender_username, sent_at, reply_to_message_id, message_kind
            FROM group_messages
            WHERE chat_id = ${page.chatId}
            ORDER BY sent_at DESC, message_id DESC
            LIMIT ${page.limit}
          ) AS gm
          ORDER BY gm.sent_at, gm.message_id`,
  });
  const selectChats = SqlSchema.findAll({
    Request: ChatPage,
    Result: ChatRecord,
    execute: (page) =>
      sql`SELECT chat_id, title, chat_type, username, is_forum, first_seen_at, last_seen_at
          FROM group_chats ORDER BY last_seen_at DESC LIMIT ${page.limit}`,
  });
  const searchChats = SqlSchema.findAll({
    Request: ChatSearch,
    Result: ChatRecord,
    execute: (search) =>
      sql`SELECT chat_id, title, chat_type, username, is_forum, first_seen_at, last_seen_at
          FROM group_chats WHERE lower(title) LIKE lower(${search.pattern})
          ORDER BY last_seen_at DESC LIMIT ${search.limit}`,
  });
  const selectKnownChatIds = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ChatIdRecord,
    execute: () =>
      sql`SELECT chat_id FROM group_chats
          UNION SELECT chat_id FROM group_messages
          UNION SELECT chat_id FROM group_fact_sheets`,
  });
  const selectFacts = SqlSchema.findAll({
    Request: Schema.Int,
    Result: FactRecord,
    execute: (chatId) =>
      sql`SELECT ${factColumns} FROM group_facts
          WHERE chat_id = ${chatId} ORDER BY updated_at DESC, id DESC`,
  });
  const selectFact = SqlSchema.findOneOption({
    Request: RowId,
    Result: FactRecord,
    execute: (id) =>
      sql`SELECT ${factColumns} FROM group_facts WHERE id = ${id}`,
  });
  const insertFact = SqlSchema.findOne({
    Request: FactInsertRow,
    Result: FactRecord,
    execute: (fact) =>
      sql`INSERT INTO group_facts
            (chat_id, kind, content, source_message_id, created_by_user_id, created_at, updated_at)
          VALUES (${fact.chatId}, ${fact.kind}, ${fact.content},
            ${fact.sourceMessageId ?? null}, ${fact.createdByUserId ?? null},
            ${fact.now}, ${fact.now})
          RETURNING ${factColumns}`,
  });
  const patchFact = SqlSchema.findOneOption({
    Request: FactPatchRow,
    Result: FactRecord,
    execute: (patch) =>
      sql`UPDATE group_facts
          SET kind = COALESCE(${patch.kind ?? null}, kind),
              content = COALESCE(${patch.content ?? null}, content),
              updated_at = ${patch.now}
          WHERE id = ${patch.id}
          RETURNING ${factColumns}`,
  });
  const removeFact = SqlSchema.findOneOption({
    Request: RowId,
    Result: FactIdRecord,
    execute: (id) => sql`DELETE FROM group_facts WHERE id = ${id} RETURNING id`,
  });
  const selectFactSheet = SqlSchema.findOneOption({
    Request: Schema.Int,
    Result: FactSheetRecord,
    execute: (chatId) =>
      sql`SELECT chat_id, chat_title, content, updated_at
          FROM group_fact_sheets WHERE chat_id = ${chatId}`,
  });

  /** The chat and time bounds of a search, each present only when asked for. */
  const messageFilters = (search: GroupMessageSearch) => {
    const filters: Fragment[] = [];
    if (search.chatId !== undefined) {
      filters.push(sql`gm.chat_id = ${search.chatId}`);
    }
    if (search.from !== undefined) {
      filters.push(sql`gm.sent_at >= ${search.from}`);
    }
    if (search.to !== undefined) {
      filters.push(sql`gm.sent_at < ${search.to}`);
    }
    return filters;
  };
  const findMessages = SqlSchema.findAll({
    Request: GroupMessageSearchSchema,
    Result: MessageRecord,
    execute: (search) => {
      const query = search.query?.trim() ?? "";
      const filters = messageFilters(search);
      // The trimmed text is bound as the MATCH operand as typed, unescaped:
      // the MCP server hands the agent's FTS syntax through on purpose.
      return query.length > 0
        ? sql`SELECT ${messageColumns}
              FROM group_messages_fts
              JOIN group_messages gm ON gm.rowid = group_messages_fts.rowid
              WHERE ${sql.and([sql`group_messages_fts MATCH ${query}`, ...filters])}
              ORDER BY rank, gm.sent_at DESC LIMIT ${search.limit}`
        : sql`SELECT ${messageColumns}
              FROM group_messages gm
              WHERE ${sql.and(filters)}
              ORDER BY gm.sent_at DESC, gm.message_id DESC LIMIT ${search.limit}`;
    },
  });

  /**
   * Store one message, or replace it when Telegram redelivers the same
   * `(chat_id, message_id)`. The FTS triggers follow the insert and update.
   */
  const record = Effect.fn("GroupMemoryRepo.record")(function* record(
    message: GroupMemoryMessage
  ) {
    yield* sql`INSERT INTO group_messages
        (chat_id, message_id, sender_name, text, created_at, thread_id,
         sender_id, sender_username, sent_at, reply_to_message_id, message_kind)
      VALUES (${message.chatId}, ${message.messageId}, ${message.from},
        ${message.text}, ${message.createdAt}, ${message.threadId ?? null},
        ${message.senderId ?? null}, ${message.senderUsername ?? null},
        ${message.sentAt ?? message.createdAt},
        ${message.replyToMessageId ?? null}, ${message.kind ?? "text"})
      ON CONFLICT(chat_id, message_id) DO UPDATE SET
        sender_name = excluded.sender_name,
        text = excluded.text,
        thread_id = excluded.thread_id,
        sender_id = excluded.sender_id,
        sender_username = excluded.sender_username,
        sent_at = excluded.sent_at,
        reply_to_message_id = excluded.reply_to_message_id,
        message_kind = excluded.message_kind`;
  }, persistence("GroupMemoryRepo.record"));

  /** The newest `limit` messages of one chat, oldest first. */
  const list = Effect.fn("GroupMemoryRepo.list")(function* list(
    chatId: number,
    limit: number
  ) {
    return yield* selectMessages({ chatId, limit });
  }, persistence("GroupMemoryRepo.list"));

  /** The legacy one-document fact sheet of a chat, if it has one. */
  const getFactSheet = Effect.fn("GroupMemoryRepo.getFactSheet")(
    function* getFactSheet(chatId: number) {
      return yield* selectFactSheet(chatId);
    },
    persistence("GroupMemoryRepo.getFactSheet")
  );

  /** Replace a chat's fact sheet, stamping it with the current time. */
  const setFactSheet = Effect.fn("GroupMemoryRepo.setFactSheet")(
    function* setFactSheet(sheet: GroupFactSheetWrite) {
      const updatedAt = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO group_fact_sheets (chat_id, chat_title, content, updated_at)
          VALUES (${sheet.chatId}, ${sheet.chatTitle}, ${sheet.content}, ${updatedAt})
          ON CONFLICT(chat_id) DO UPDATE SET
            chat_title = excluded.chat_title,
            content = excluded.content,
            updated_at = excluded.updated_at`;
    },
    persistence("GroupMemoryRepo.setFactSheet")
  );

  /** Note a chat the bot can see: first sight is kept, last sight is now. */
  const rememberChat = Effect.fn("GroupMemoryRepo.rememberChat")(
    function* rememberChat(chat: GroupChatSeen) {
      const now = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO group_chats
          (chat_id, title, chat_type, username, is_forum, first_seen_at, last_seen_at)
        VALUES (${chat.chatId}, ${chat.title}, ${chat.chatType},
          ${chat.username ?? null}, ${chat.isForum ? 1 : 0}, ${now}, ${now})
        ON CONFLICT(chat_id) DO UPDATE SET
          title = excluded.title,
          chat_type = excluded.chat_type,
          username = excluded.username,
          is_forum = excluded.is_forum,
          last_seen_at = excluded.last_seen_at`;
    },
    persistence("GroupMemoryRepo.rememberChat")
  );

  /**
   * Known chats, most recently seen first. A non-blank `query` narrows them
   * to titles containing it, case-insensitively.
   */
  const listChats = Effect.fn("GroupMemoryRepo.listChats")(function* listChats(
    query?: string,
    limit?: number
  ) {
    const size = limit ?? DEFAULT_CHAT_LIST_LIMIT;
    const trimmed = query?.trim() ?? "";
    if (trimmed.length === 0) {
      return yield* selectChats({ limit: size });
    }
    return yield* searchChats({ limit: size, pattern: `%${trimmed}%` });
  }, persistence("GroupMemoryRepo.listChats"));

  /** Every chat id that has a chat row, a message or a fact sheet. */
  const listKnownChatIds = Effect.fn("GroupMemoryRepo.listKnownChatIds")(
    function* listKnownChatIds() {
      const rows = yield* selectKnownChatIds();
      return rows.map((row) => row.chatId);
    },
    persistence("GroupMemoryRepo.listKnownChatIds")
  );

  /** A chat's facts, most recently updated first. */
  const listFacts = Effect.fn("GroupMemoryRepo.listFacts")(function* listFacts(
    chatId: number
  ) {
    return yield* selectFacts(chatId);
  }, persistence("GroupMemoryRepo.listFacts"));

  /** One fact by id, from any chat; the MCP server checks the chat itself. */
  const getFact = Effect.fn("GroupMemoryRepo.getFact")(function* getFact(
    id: number
  ) {
    return yield* selectFact(id);
  }, persistence("GroupMemoryRepo.getFact"));

  /**
   * Add a fact and return it as stored. A chat `group_chats` does not know
   * fails the foreign key, which reads as `reason: "Constraint"`.
   */
  const addFact = Effect.fn("GroupMemoryRepo.addFact")(function* addFact(
    fact: GroupFactInsert
  ) {
    const now = yield* Clock.currentTimeMillis;
    return yield* insertFact({ ...fact, now }).pipe(
      // An INSERT ... RETURNING that returns no row is not a data condition.
      Effect.catchTag("NoSuchElementError", (cause) => Effect.die(cause))
    );
  }, persistence("GroupMemoryRepo.addFact"));

  /**
   * Change a fact's kind and/or content in one statement; an absent field
   * keeps its value. None when there is no such fact.
   */
  const updateFact = Effect.fn("GroupMemoryRepo.updateFact")(
    function* updateFact(patch: GroupFactPatch) {
      const now = yield* Clock.currentTimeMillis;
      return yield* patchFact({ ...patch, now });
    },
    persistence("GroupMemoryRepo.updateFact")
  );

  /** Delete a fact; true when there was one. */
  const deleteFact = Effect.fn("GroupMemoryRepo.deleteFact")(
    function* deleteFact(id: number) {
      const removed = yield* removeFact(id);
      return Option.isSome(removed);
    },
    persistence("GroupMemoryRepo.deleteFact")
  );

  /**
   * Messages matching a search: full-text ranked when it has a query, else
   * the newest within the bounds. Both honour the chat and time bounds.
   */
  const searchMessages = Effect.fn("GroupMemoryRepo.searchMessages")(
    function* searchMessages(search: GroupMessageSearch) {
      return yield* findMessages(search);
    },
    persistence("GroupMemoryRepo.searchMessages")
  );

  return {
    addFact,
    deleteFact,
    getFact,
    getFactSheet,
    list,
    listChats,
    listFacts,
    listKnownChatIds,
    record,
    rememberChat,
    searchMessages,
    setFactSheet,
    updateFact,
  } as const;
});

/**
 * Durable per-group conversation memory: messages with full-text search
 * (`group_messages`, `group_messages_fts`), the chats they belong to
 * (`group_chats`), curated facts (`group_facts`) and the legacy fact sheets
 * (`group_fact_sheets`).
 *
 * Transactions live only inside repositories. Never run the bridge, Telegram
 * or an agent inside `withTransaction`: the transaction holds the client's only
 * permit, so it would stall every other query in the process.
 */
export class GroupMemoryRepo extends Context.Service<
  GroupMemoryRepo,
  Effect.Success<typeof make>
>()("@workspace/db/GroupMemoryRepo") {
  static readonly layer = Layer.effect(GroupMemoryRepo, make);
}
