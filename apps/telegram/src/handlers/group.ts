import type { Types } from "effect";

import { heardCallName } from "../access/call-name";
import { accessOf } from "../access/context";
import type { BotContext } from "../access/context";
import {
  clearGroupLog,
  recentGroupMessages,
  recordGroupMessage,
} from "../access/group-log";
import {
  quotaRefusalText,
  readLimits,
  takeGroupRun,
} from "../access/rate-limit";
import { ensureGroupDir, removeGroupDir } from "../access/scratch";
import { detectTrigger } from "../access/trigger";
import type { GroupMemoryMessage } from "../db";
import {
  forgetGroup,
  listKnownGroupChatIds,
  rememberGroupChat,
} from "../db/bridge";
import { t } from "../i18n";
import { logWarning } from "../log";
import type { Persona } from "../persona";
import { loadCallName, loadHeardNames, loadPersona } from "../persona";
import { TelegramBotError, tg } from "../telegram/bridge";
import { threadIdOf } from "../telegram/route";
import { judgeAddressedFor } from "./address-judge";
import type { HandlerDeps } from "./deps";

const TELEGRAM_SECONDS_TO_MS = 1000;

/**
 * What the bot does with a message in a group it is allowed to be in. It reads
 * everything (privacy mode is off, which is what makes the call name work) and
 * answers almost nothing: only a mention, a reply to itself, or its name used
 * as an address gets a run, and every run is charged to the sender's daily
 * budget.
 */

/** How the judge refers to a sender: their display name, else their id. */
const senderName = (ctx: BotContext) =>
  ctx.from?.first_name ?? ctx.from?.username ?? String(ctx.from?.id ?? "user");

/** Whether the judge is asked at all, and what it decides. */
const askJudge = async (input: {
  callName: string;
  chatId: number;
  userId: number;
}) =>
  await judgeAddressedFor({
    botName: input.callName,
    messages: [...recentGroupMessages(input.chatId)],
    surface: { kind: "group" },
    userId: input.userId,
    // The helper fallback runs a turn, which needs a directory: the group's,
    // never the sender's private scratch.
    workingDirectory: ensureGroupDir(input.chatId),
  });

const rememberCurrentGroup = async (ctx: BotContext, chatId: number) => {
  const { chat } = ctx;
  let title = String(chatId);
  let username: string | undefined;
  if (chat && "title" in chat) {
    const { title: chatTitle } = chat;
    if (chatTitle !== undefined && chatTitle.length > 0) {
      title = chatTitle;
    }
  }
  if (chat && "username" in chat) {
    ({ username } = chat);
  }
  const storedChat: Types.Mutable<Parameters<typeof rememberGroupChat>[0]> = {
    chatId,
    chatType: chat?.type ?? "group",
    isForum: Boolean(chat && "is_forum" in chat && chat.is_forum),
    title,
  };
  if (username !== undefined) {
    storedChat.username = username;
  }
  await rememberGroupChat(storedChat);
};

const recordCurrentGroupMessage = async (
  ctx: BotContext,
  input: { kind?: string; messageId: number; text: string },
  chatId: number,
  userId: number
) => {
  // Built key by key so an unknown value stays an absent key, not `undefined`;
  // the stored record is readonly, hence the mutable local.
  const metadata: Types.Mutable<
    Omit<
      GroupMemoryMessage,
      "chatId" | "createdAt" | "from" | "messageId" | "text"
    >
  > = {
    senderId: userId,
  };
  if (input.kind !== undefined) {
    metadata.kind = input.kind;
  }
  const replyToMessageId = ctx.message?.reply_to_message?.message_id;
  if (replyToMessageId !== undefined) {
    metadata.replyToMessageId = replyToMessageId;
  }
  const senderUsername = ctx.from?.username;
  if (senderUsername !== undefined) {
    metadata.senderUsername = senderUsername;
  }
  const sentAt = ctx.message?.date;
  if (sentAt !== undefined) {
    metadata.sentAt = sentAt * TELEGRAM_SECONDS_TO_MS;
  }
  const threadId = threadIdOf(ctx);
  if (threadId !== null) {
    metadata.threadId = threadId;
  }
  await recordGroupMessage(
    chatId,
    input.messageId,
    { from: senderName(ctx), text: input.text },
    metadata
  );
};

/**
 * Record a group message for context without judging it: the chat and the
 * message, as `shouldAnswerInGroup` records them first. False outside a chat.
 */
export const recordInGroup = async (
  ctx: BotContext,
  input: { kind?: string; messageId: number; text: string }
) => {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (chatId === undefined || userId === undefined) {
    return false;
  }
  await rememberCurrentGroup(ctx, chatId);
  await recordCurrentGroupMessage(ctx, input, chatId, userId);
  return true;
};

/**
 * Record the message for context and decide whether it deserves an answer.
 * Returns false for the overwhelming majority — ordinary group chatter — and
 * for a sender who has spent their day's budget, who is told so once.
 */
export const shouldAnswerInGroup = async (
  ctx: BotContext,
  input: {
    botId: number;
    kind?: string;
    messageId: number;
    /** What the group's memory keeps, when not `text` (a file's marker). */
    recordText?: string;
    text: string;
  }
) => {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (
    chatId === undefined ||
    userId === undefined ||
    !(await recordInGroup(ctx, {
      ...input,
      text: input.recordText ?? input.text,
    }))
  ) {
    return false;
  }

  const heard = await loadHeardNames();
  const trigger = detectTrigger({
    botId: input.botId,
    botUsername: ctx.me.username,
    callNames: heard,
    replyToUserId: ctx.message?.reply_to_message?.from?.id,
    text: input.text,
  });
  if (trigger === "none") {
    return false;
  }
  if (
    trigger === "call_name" &&
    !(await askJudge({
      // The judge hears the name the message used, not the language default.
      callName: heardCallName(input.text, heard) ?? (await loadCallName()),
      chatId,
      userId,
    }))
  ) {
    return false;
  }

  const limits = await readLimits("group");
  const verdict = await takeGroupRun({
    limits,
    tier: accessOf(ctx).tier,
    userId,
  });
  if (verdict.ok) {
    return true;
  }
  await ctx.reply(
    quotaRefusalText({ scope: verdict.scope, userLimit: limits.user })
  );
  return false;
};

/** Statuses that mean the bot itself is no longer in the chat. */
const GONE_STATUSES = new Set(["kicked", "left"]);

/** Statuses that mean the bot has just become usable in the chat. */
const ACTIVE_STATUSES = new Set([
  "administrator",
  "creator",
  "member",
  "restricted",
]);

export const becameActiveInGroup = (input: {
  newStatus: string;
  oldStatus: string;
}) =>
  GONE_STATUSES.has(input.oldStatus) && ACTIVE_STATUSES.has(input.newStatus);

/** The introduction a group gets when the bot is added to it. */
export const groupReadyText = (persona: Persona) => t().group.ready(persona);

/** Fill titles for the handful of chats recorded before the registry existed. */
export const backfillGroupRegistry = async () => {
  for (const chatId of await listKnownGroupChatIds()) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Telegram calls are deliberately serialized
      const chat = await tg(
        "getChat",
        async (api) => await api.getChat(chatId),
        { retry: "all" }
      );
      if (chat.type === "private") {
        continue;
      }
      const storedChat: Types.Mutable<Parameters<typeof rememberGroupChat>[0]> =
        {
          chatId,
          chatType: chat.type,
          isForum: "is_forum" in chat && chat.is_forum === true,
          title: "title" in chat && chat.title ? chat.title : String(chatId),
        };
      if (
        "username" in chat &&
        chat.username !== undefined &&
        chat.username.length > 0
      ) {
        storedChat.username = chat.username;
      }
      // oxlint-disable-next-line no-await-in-loop -- one chat is stored before the next is fetched
      await rememberGroupChat(storedChat);
    } catch (error) {
      // A Telegram failure was already logged by TelegramBot with its reason.
      logWarning(
        `Could not backfill Telegram group ${chatId}`,
        error instanceof TelegramBotError ? undefined : error
      );
    }
  }
};

/**
 * Forget a chat the bot has been removed from, so a later re-add is checked
 * against the owner's membership again instead of an answer from before. The
 * files its members sent go with it.
 */
export const registerGroupHandlers = ({ bot }: HandlerDeps) => {
  bot.on("my_chat_member", async (ctx, proceed) => {
    const oldStatus = ctx.myChatMember.old_chat_member.status;
    const newStatus = ctx.myChatMember.new_chat_member.status;
    if (GONE_STATUSES.has(newStatus)) {
      await forgetGroup(ctx.chat.id);
      clearGroupLog(ctx.chat.id);
      removeGroupDir(ctx.chat.id);
    } else if (becameActiveInGroup({ newStatus, oldStatus })) {
      await ctx.reply(groupReadyText(await loadPersona()));
    }
    await proceed();
  });
};
