import type { PersistenceError, TaskStamp } from "@workspace/db";
import { Context, Effect, Layer } from "effect";

import type { TelegramAccountError } from "../telegram/telegram-account";
import { accountErrorText, recordAccountCall } from "./actions";
import type { AccountWriteFailed } from "./actions";
import type { BadInput } from "./inputs";
import { LocalTools } from "./local-tools";
import { outputText } from "./present";
import type { ToolOutput } from "./present";
import type { RawSchemaError } from "./raw-schema";
import { RawTools } from "./raw-tools";
import { ReadTools } from "./read-tools";
import type { ArgsOf, ToolCall } from "./tool-call-schema";
import { WriteTools } from "./write-tools";

/**
 * What each `telegram_account` tool does. A call is decoded once, at the MCP
 * boundary, into one `ToolCall` variant; everything below works on typed
 * input. Reads go straight to the account (`read-tools.ts`); so do changes
 * to the owner's own view of it, like read marks and drafts
 * (`local-tools.ts`); writes others see go through `AccountActions`, which
 * decides between the owner's button and `direct` (`write-tools.ts`). The
 * raw API tools (`raw-tools.ts`) reach any other Telegram method, classed
 * per method by `raw-policy.ts`.
 */

/**
 * How each tool touches the account, as its ledger line says: `read` only
 * reads, `local` changes what only the owner sees, `write` acts as the owner
 * where others see it. `dynamic` is `tg_call`, whose class is its method's:
 * a read or a read mark names its own ledger line (`ToolOutput.ledger`), a
 * write is recorded by `AccountActions`, and a failure is recorded as a
 * write, the class it might have had. Exhaustive, so a new tool cannot go
 * unclassified.
 */
const TOOL_ACCESS: Record<
  ToolCall["name"],
  "dynamic" | "local" | "read" | "write"
> = {
  archive: "write",
  create_poll: "write",
  delete_messages: "write",
  delete_scheduled: "write",
  download_media: "read",
  edit_message: "write",
  forward_messages: "write",
  get_album: "read",
  get_chat: "read",
  get_common_chats: "read",
  get_history: "read",
  get_messages: "read",
  get_reactions: "read",
  list_contacts: "read",
  list_dialogs: "read",
  list_drafts: "read",
  list_folders: "read",
  list_members: "read",
  list_scheduled: "read",
  list_topics: "read",
  mark_read: "local",
  mark_unread: "local",
  mute: "write",
  pin: "write",
  react: "write",
  read_date: "read",
  save_draft: "local",
  search_messages: "read",
  send_media: "write",
  send_message: "write",
  send_scheduled_now: "write",
  tg_call: "dynamic",
  tg_describe: "read",
  tg_search_methods: "read",
  transcribe_voice: "read",
  translate: "read",
  unpin: "write",
  unread_mentions: "read",
  vote: "write",
};

type ToolFailure =
  | AccountWriteFailed
  | BadInput
  | PersistenceError
  | RawSchemaError
  | TelegramAccountError;

/** A tool's answer as MCP carries it: compact JSON within the output cap. */
const jsonResult = (output: ToolOutput) => ({
  content: [{ text: outputText(output), type: "text" as const }],
});

export const errorResult = (message: string) => ({
  content: [{ text: message, type: "text" as const }],
  isError: true,
});

type ToolName = ToolCall["name"];

/**
 * One handler per tool, keyed by its name. A mapped type, so a tool decoded
 * by `ToolCallSchema` without a handler fails the typecheck.
 */
type Handlers = {
  readonly [Name in ToolName]: (
    input: ArgsOf<Name>,
    requester: TaskStamp
  ) => Effect.Effect<ToolOutput, ToolFailure>;
};

const make = Effect.gen(function* make() {
  const reads = yield* ReadTools;
  const locals = yield* LocalTools;
  const writes = yield* WriteTools;
  const raw = yield* RawTools;

  const handlers: Handlers = {
    archive: writes.archive,
    create_poll: writes.createPoll,
    delete_messages: writes.deleteMessages,
    delete_scheduled: writes.deleteScheduled,
    download_media: reads.downloadMedia,
    edit_message: writes.editMessage,
    forward_messages: writes.forwardMessages,
    get_album: reads.getAlbum,
    get_chat: reads.getChat,
    get_common_chats: reads.getCommonChats,
    get_history: reads.getHistory,
    get_messages: reads.getMessages,
    get_reactions: reads.getReactions,
    list_contacts: reads.listContacts,
    list_dialogs: reads.listDialogs,
    list_drafts: reads.listDrafts,
    list_folders: reads.listFolders,
    list_members: reads.listMembers,
    list_scheduled: reads.listScheduled,
    list_topics: reads.listTopics,
    mark_read: locals.markChatRead,
    mark_unread: locals.markUnread,
    mute: writes.mute,
    pin: writes.pin,
    react: writes.react,
    read_date: reads.readDate,
    save_draft: locals.saveDraft,
    search_messages: reads.searchMessages,
    send_media: writes.sendMedia,
    send_message: writes.sendMessage,
    send_scheduled_now: writes.sendScheduledNow,
    tg_call: raw.call,
    tg_describe: raw.describe,
    tg_search_methods: raw.searchMethods,
    transcribe_voice: reads.transcribeVoice,
    translate: reads.translate,
    unpin: writes.unpin,
    unread_mentions: reads.unreadMentions,
    vote: writes.vote,
  };

  /** The handler of a call's own tool, with that call's arguments. */
  const dispatch = <Name extends ToolName>(
    name: Name,
    input: ArgsOf<Name>,
    requester: TaskStamp
  ) => handlers[name](input, requester);

  /**
   * Run one decoded call: its JSON answer, or an error the run can read. A
   * read or local call writes its own ledger line; a write's steps are
   * recorded by `AccountActions`, so only a write failure it did not record
   * is. `requester` is who the run works for, named in a write's
   * confirmation.
   */
  const run = (toolCall: ToolCall, requester: TaskStamp) => {
    const declared = TOOL_ACCESS[toolCall.name];
    const access = declared === "dynamic" ? "write" : declared;
    return dispatch(toolCall.name, toolCall.arguments, requester).pipe(
      Effect.tap(({ ledger, peerId }) => {
        const line =
          ledger ??
          (access === "write" ? undefined : { access, tool: toolCall.name });
        return line === undefined
          ? Effect.void
          : recordAccountCall({
              access: line.access,
              actionId: null,
              errorReason: null,
              outcome: "ok",
              peerId,
              tool: line.tool,
            });
      }),
      Effect.map(jsonResult),
      Effect.catchTags({
        AccountWriteFailed: (error) =>
          Effect.succeed(errorResult(error.message)),
        TelegramAccountError: (error) =>
          recordAccountCall({
            access,
            actionId: null,
            errorReason: error.reason,
            outcome: "failed",
            peerId: null,
            tool: toolCall.name,
          }).pipe(Effect.as(errorResult(accountErrorText(error)))),
      }),
      Effect.catch((error) =>
        recordAccountCall({
          access,
          actionId: null,
          errorReason: error._tag,
          outcome: "failed",
          peerId: null,
          tool: toolCall.name,
        }).pipe(Effect.as(errorResult(error.message)))
      ),
      Effect.withSpan(`AccountMcp.${toolCall.name}`)
    );
  };

  return { run } as const;
});

/** Runs one decoded `telegram_account` tool call for a requester. */
export class ToolCalls extends Context.Service<
  ToolCalls,
  Effect.Success<typeof make>
>()("@workspace/ToolCalls") {
  static readonly layer = Layer.effect(ToolCalls, make);
}
