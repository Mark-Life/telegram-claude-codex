import { ACCOUNT_MEDIA_KINDS } from "@workspace/db";
import { Schema } from "effect";

/** The `telegram_account` tool calls as they arrive over MCP. */

const ChatRef = Schema.Union([Schema.String, Schema.Number]);
const Ids = Schema.Array(Schema.Int);
const Limit = Schema.optional(Schema.Number);
const Offset = Schema.optional(
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
);

/** What `search_messages` may narrow to, by the kind of message. */
export const SEARCH_FILTERS = [
  "photo",
  "video",
  "photo_video",
  "document",
  "url",
  "gif",
  "voice",
  "audio",
  "round",
  "round_voice",
  "mention",
  "location",
  "contact",
  "pinned",
  "poll",
] as const;

/** Which members `list_members` lists. */
export const MEMBER_TYPES = [
  "all",
  "banned",
  "restricted",
  "bots",
  "recent",
  "admins",
  "contacts",
  "mention",
] as const;

const call = <const Name extends string, F extends Schema.Struct.Fields>(
  name: Name,
  fields: F
) =>
  Schema.Struct({
    arguments: Schema.Struct(fields),
    name: Schema.Literal(name),
  });

/** One tool call as the run made it, decoded. */
export const ToolCallSchema = Schema.Union([
  call("list_dialogs", {
    archived: Schema.optional(Schema.Boolean),
    folder: Schema.optional(ChatRef),
    limit: Limit,
    offset: Offset,
    unread_only: Schema.optional(Schema.Boolean),
  }),
  call("get_history", {
    after_id: Schema.optional(Schema.Int),
    before_id: Schema.optional(Schema.Int),
    chat: ChatRef,
    from: Schema.optional(Schema.String),
    limit: Limit,
    to: Schema.optional(Schema.String),
  }),
  call("search_messages", {
    chat: Schema.optional(ChatRef),
    cursor: Schema.optional(Schema.String),
    filter: Schema.optional(Schema.Literals(SEARCH_FILTERS)),
    from: Schema.optional(Schema.String),
    from_user: Schema.optional(ChatRef),
    limit: Limit,
    query: Schema.optional(Schema.String),
    thread_id: Schema.optional(Schema.Int),
    to: Schema.optional(Schema.String),
  }),
  call("get_chat", { chat: ChatRef }),
  call("get_album", { chat: ChatRef, message_id: Schema.Int }),
  call("download_media", { chat: ChatRef, message_id: Schema.Int }),
  call("mark_read", {
    chat: ChatRef,
    up_to_id: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  }),
  call("send_message", {
    chat: ChatRef,
    clear_draft: Schema.optional(Schema.Boolean),
    reply_to: Schema.optional(Schema.Int),
    schedule: Schema.optional(Schema.String),
    silent: Schema.optional(Schema.Boolean),
    text: Schema.String,
    thread_id: Schema.optional(Schema.Int),
  }),
  call("forward_messages", {
    from_chat: ChatRef,
    message_ids: Ids,
    to_chat: ChatRef,
    to_thread_id: Schema.optional(Schema.Int),
  }),
  call("edit_message", {
    chat: ChatRef,
    message_id: Schema.Int,
    text: Schema.String,
  }),
  call("delete_messages", {
    chat: ChatRef,
    message_ids: Ids,
    revoke: Schema.optional(Schema.Boolean),
  }),
  call("save_draft", {
    chat: ChatRef,
    clear: Schema.optional(Schema.Boolean),
    reply_to: Schema.optional(Schema.Int),
    text: Schema.optional(Schema.String),
    thread_id: Schema.optional(Schema.Int),
  }),
  call("list_drafts", {}),
  call("mark_unread", { chat: ChatRef }),
  call("list_topics", {
    chat: ChatRef,
    cursor: Schema.optional(Schema.String),
    limit: Limit,
    query: Schema.optional(Schema.String),
  }),
  call("get_messages", {
    chat: Schema.optional(ChatRef),
    comments_of: Schema.optional(Schema.Int),
    link: Schema.optional(Schema.String),
    message_ids: Schema.optional(Ids),
    reply_chain_of: Schema.optional(Schema.Int),
  }),
  call("list_contacts", {
    limit: Limit,
    offset: Offset,
    query: Schema.optional(Schema.String),
  }),
  call("get_common_chats", { user: ChatRef }),
  call("list_members", {
    chat: ChatRef,
    limit: Limit,
    offset: Offset,
    query: Schema.optional(Schema.String),
    type: Schema.optional(Schema.Literals(MEMBER_TYPES)),
  }),
  call("list_scheduled", { chat: ChatRef }),
  call("get_reactions", {
    chat: ChatRef,
    cursor: Schema.optional(Schema.String),
    emoji: Schema.optional(Schema.String),
    limit: Limit,
    message_id: Schema.Int,
  }),
  call("unread_mentions", { chat: Schema.optional(ChatRef), limit: Limit }),
  call("read_date", { chat: ChatRef, message_id: Schema.Int }),
  call("transcribe_voice", { chat: ChatRef, message_id: Schema.Int }),
  call("translate", {
    chat: Schema.optional(ChatRef),
    message_id: Schema.optional(Schema.Int),
    text: Schema.optional(Schema.String),
    to_language: Schema.String,
  }),
  call("list_folders", {}),
  call("send_media", {
    caption: Schema.optional(Schema.String),
    chat: ChatRef,
    files: Schema.Array(
      Schema.Struct({
        as: Schema.optional(Schema.Literals(ACCOUNT_MEDIA_KINDS)),
        path: Schema.String,
      })
    ),
    reply_to: Schema.optional(Schema.Int),
    schedule: Schema.optional(Schema.String),
    silent: Schema.optional(Schema.Boolean),
    thread_id: Schema.optional(Schema.Int),
  }),
  call("react", {
    big: Schema.optional(Schema.Boolean),
    chat: ChatRef,
    emoji: Schema.optional(Schema.String),
    message_id: Schema.Int,
  }),
  call("pin", {
    both_sides: Schema.optional(Schema.Boolean),
    chat: ChatRef,
    message_id: Schema.Int,
    notify: Schema.optional(Schema.Boolean),
  }),
  call("unpin", { chat: ChatRef, message_id: Schema.Int }),
  call("archive", {
    archived: Schema.optional(Schema.Boolean),
    chat: ChatRef,
  }),
  call("mute", {
    chat: ChatRef,
    unmute: Schema.optional(Schema.Boolean),
    until: Schema.optional(Schema.String),
  }),
  call("delete_scheduled", { chat: ChatRef, message_ids: Ids }),
  call("send_scheduled_now", { chat: ChatRef, message_ids: Ids }),
  call("create_poll", {
    answers: Schema.Array(Schema.String),
    chat: ChatRef,
    multiple: Schema.optional(Schema.Boolean),
    public: Schema.optional(Schema.Boolean),
    question: Schema.String,
    reply_to: Schema.optional(Schema.Int),
    schedule: Schema.optional(Schema.String),
    silent: Schema.optional(Schema.Boolean),
    thread_id: Schema.optional(Schema.Int),
  }),
  call("vote", {
    chat: ChatRef,
    message_id: Schema.Int,
    options: Schema.Array(Schema.Int),
  }),
  call("tg_search_methods", {
    limit: Limit,
    namespace: Schema.optional(Schema.String),
    query: Schema.String,
  }),
  call("tg_describe", { name: Schema.String }),
  call("tg_call", {
    method: Schema.String,
    params: Schema.optional(Schema.JsonObject),
  }),
]);

export type ToolCall = typeof ToolCallSchema.Type;

/** The decoded arguments of one tool. */
export type ArgsOf<Name extends ToolCall["name"]> = Extract<
  ToolCall,
  { name: Name }
>["arguments"];

/** Decode a call off the wire; a malformed one is answered, never thrown. */
export const decodeToolCall = Schema.decodeUnknownEffect(ToolCallSchema);
