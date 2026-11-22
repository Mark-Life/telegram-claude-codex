// Who a helper script may send to: the one check `send-file-to-user.ts` and
// `send-voice-to-user.ts` share, so a prompt cannot steer either of them to
// someone else.

import { UsersRepo } from "@workspace/db";
import { Effect, Option } from "effect";

import { refuse } from "./db-cli";

/**
 * The chat and topic a send goes to, checked: a private chat of the owner or
 * of an executor (a private chat id equals its user's id), and a positive
 * topic id when one is given. Members, guests and group chats are refused
 * even when a prompt names them.
 */
export const checkRecipient = Effect.fnUntraced(
  function* checkRecipient(input: {
    /** `--chat`, or `TELEGRAM_CHAT_ID` for compat. */
    readonly chat: string | undefined;
    /** Whether `--thread` was given at all, so a bare flag is refused. */
    readonly hasThread: boolean;
    readonly thread: string | undefined;
  }) {
    const { chat } = input;
    if (chat === undefined || chat.length === 0) {
      return yield* refuse("Missing chat id (--chat / TELEGRAM_CHAT_ID)");
    }
    const chatId = Number(chat);
    if (!Number.isSafeInteger(chatId) || chatId <= 0) {
      return yield* refuse(
        "Blocked: --chat must be a positive private Telegram chat id"
      );
    }
    const ownerId = Number(
      process.env.ALLOWED_USER_ID ?? process.env.TELEGRAM_CHAT_ID
    );
    const isOwner = Number.isSafeInteger(ownerId) && chatId === ownerId;
    if (!isOwner) {
      const recipient = yield* UsersRepo.use((repo) => repo.get(chatId));
      if (Option.getOrUndefined(recipient)?.tier !== "executor") {
        return yield* refuse(
          `Blocked: chat ${chat} is not an owner or executor recipient`
        );
      }
    }
    const threadId =
      input.thread === undefined ? undefined : Number(input.thread);
    if (
      input.hasThread &&
      (threadId === undefined ||
        !Number.isSafeInteger(threadId) ||
        threadId <= 0)
    ) {
      return yield* refuse(
        "Blocked: --thread must be a positive Telegram topic id"
      );
    }
    return { chatId, threadId };
  }
);
