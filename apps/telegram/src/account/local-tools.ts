import { Context, Effect, Layer } from "effect";

import { TelegramAccount } from "../telegram/telegram-account";
import { badInput, checkText, forumTopic, resolveChat } from "./inputs";
import { MarkRead } from "./mark-read";
import { clip, presentPeer } from "./present";
import type { ArgsOf } from "./tool-call-schema";

/**
 * The `telegram_account` tools that change only the owner's own view of their
 * account: read marks, the unread flag, a draft in a chat's input. Nobody else
 * sees any of it, so they go straight to the account with no confirmation,
 * and the ledger records them as `local`.
 */

/** How much of a draft that was replaced the run reads back. */
const REPLACED_DRAFT_CHARS = 500;

const make = Effect.gen(function* make() {
  const account = yield* TelegramAccount;
  const markRead = yield* MarkRead;
  const resolve = (raw: number | string) => resolveChat(account, raw);

  /** The run asked for it, so the owner's switch does not apply. */
  const markChatRead = Effect.fnUntraced(function* (
    input: ArgsOf<"mark_read">
  ) {
    const peer = yield* resolve(input.chat);
    yield* markRead.markChat(peer, input.up_to_id);
    return {
      peerId: peer.id,
      value: { chat: presentPeer(peer), read_up_to: input.up_to_id ?? "all" },
    };
  });

  const markUnread = Effect.fnUntraced(function* (
    input: ArgsOf<"mark_unread">
  ) {
    const peer = yield* resolve(input.chat);
    yield* account.use("markChatUnread", async (client) => {
      await client.markChatUnread(peer.id);
    });
    return {
      peerId: peer.id,
      value: { chat: presentPeer(peer), unread: true },
    };
  });

  /**
   * Leave text in a chat's input for the owner to send, or clear it. Nothing
   * is sent. The draft it replaces goes back to the run, so it can say so.
   */
  const saveDraft = Effect.fnUntraced(function* (input: ArgsOf<"save_draft">) {
    const clear = input.clear === true;
    if (clear && (input.text ?? "").trim() !== "") {
      return yield* badInput("Leave out text to clear the draft.");
    }
    const text = clear ? "" : yield* checkText(input.text ?? "");
    const peer = yield* resolve(input.chat);
    const topic =
      input.thread_id === undefined
        ? undefined
        : yield* forumTopic({
            account,
            chat: peer,
            id: input.thread_id,
            param: "thread_id",
          });
    const previous =
      topic === undefined
        ? yield* account.use("getPeerDialogs", async (client) => {
            const [dialog] = await client.getPeerDialogs(peer.id);
            return dialog?.draftMessage ?? null;
          })
        : topic.draft;
    const replyToMsgId = input.reply_to ?? topic?.id;
    yield* account.use("saveDraft", async (client) => {
      await client.saveDraft(peer.id, {
        message: text,
        replyTo:
          replyToMsgId === undefined
            ? undefined
            : {
                _: "inputReplyToMessage",
                replyToMsgId,
                topMsgId: topic?.id,
              },
      });
    });
    return {
      peerId: peer.id,
      value: {
        chat: presentPeer(peer),
        cleared: clear,
        replaced_draft:
          previous === null || previous.text === ""
            ? null
            : clip(previous.text, REPLACED_DRAFT_CHARS),
        saved: !clear,
        sent: false,
      },
    };
  });

  return { markChatRead, markUnread, saveDraft } as const;
});

/** The `telegram_account` tools that change only what the owner sees. */
export class LocalTools extends Context.Service<
  LocalTools,
  Effect.Success<typeof make>
>()("@workspace/LocalTools") {
  static readonly layer = Layer.effect(LocalTools, make);
}
