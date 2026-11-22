import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";

import { accessOf } from "../access/context";
import type { BotContext } from "../access/context";
import { isOwner } from "../access/tier";
import { t } from "../i18n";
import { tgBestEffort } from "../telegram/bridge";
import { stopRun } from "./agent-bridge";
import type { HandlerDeps } from "./deps";
import {
  CLEAR_QUEUE_RE,
  escapeHtml,
  FORCE_SEND_RE,
  requireChat,
  swallow,
} from "./helpers";
import { getState } from "./user-state";
import type { UserState } from "./user-state";

// The status messages here are bookkeeping, so they arrive without a sound:
// only the answer to the user's message notifies. An edit never makes one.

const QUEUE_PREVIEW_MAX_CHARS = 200;
/**
 * Whether the presser may act on a queue button. The callback data carries the
 * id of the user the status message was sent for, and in a group everyone sees
 * that message — so only that user, or the owner, gets to press it.
 */
const mayPressQueueButton = (ctx: BotContext) =>
  ctx.from?.id === Number(ctx.match?.[1] ?? "") || isOwner(accessOf(ctx).tier);

/** Send or update the "Message queued" status message. */
export const sendOrUpdateQueueStatus = async (
  ctx: Context,
  state: UserState
) => {
  const text = t().status.queued(state.queue.length);
  const keyboard = new InlineKeyboard()
    .text(t().status.forceSend, `force_send:${ctx.from?.id}`)
    .row()
    .text(t().status.clearQueue, `clear_queue:${ctx.from?.id}`);
  if (state.queueStatusMessageId !== undefined) {
    const chatId = requireChat(ctx);
    const messageId = state.queueStatusMessageId;
    // A later status edit supersedes this one, so it is not retried.
    await tgBestEffort(
      "editMessageText",
      async (api) =>
        await api.editMessageText(chatId, messageId, text, {
          reply_markup: keyboard,
        }),
      { retry: false }
    );
    return;
  }
  const msg = await ctx.reply(text, {
    disable_notification: true,
    reply_markup: keyboard,
  });
  state.queueStatusMessageId = msg.message_id;
};

/** Delete the queue status message if it exists. */
export const cleanupQueueStatus = async (state: UserState, ctx: Context) => {
  if (state.queueStatusMessageId === undefined) {
    return;
  }
  const chatId = requireChat(ctx);
  const messageId = state.queueStatusMessageId;
  await tgBestEffort(
    "deleteMessage",
    async (api) => await api.deleteMessage(chatId, messageId),
    { retry: false }
  );
  state.queueStatusMessageId = undefined;
};

/** Send or update the compose-mode status message. */
export const updateComposeStatus = async (ctx: Context, state: UserState) => {
  const count = state.composeMessages?.length ?? 0;
  const text = t().compose.collecting(count);
  const keyboard = new InlineKeyboard()
    .text(t().compose.send, `compose_send:${ctx.from?.id}`)
    .text(t().cancel, `compose_cancel:${ctx.from?.id}`);
  if (state.composeStatusMessageId !== undefined) {
    const chatId = requireChat(ctx);
    const messageId = state.composeStatusMessageId;
    // A later status edit supersedes this one, so it is not retried.
    await tgBestEffort(
      "editMessageText",
      async (api) =>
        await api.editMessageText(chatId, messageId, text, {
          reply_markup: keyboard,
        }),
      { retry: false }
    );
    return;
  }
  const msg = await ctx.reply(text, {
    disable_notification: true,
    reply_markup: keyboard,
  });
  state.composeStatusMessageId = msg.message_id;
};

/** Delete the compose status message if it exists. */
export const cleanupComposeStatus = async (state: UserState, ctx: Context) => {
  if (state.composeStatusMessageId === undefined) {
    return;
  }
  const chatId = requireChat(ctx);
  const messageId = state.composeStatusMessageId;
  await tgBestEffort(
    "deleteMessage",
    async (api) => await api.deleteMessage(chatId, messageId),
    { retry: false }
  );
  state.composeStatusMessageId = undefined;
};

/** Tell the user a queued message is now being processed. */
export const notifyQueuedProcessing = async (
  ctx: Context,
  prompt: string,
  state: UserState
) => {
  const remaining = state.queue.length;
  const queueInfo = remaining > 0 ? ` ${t().status.moreQueued(remaining)}` : "";
  const preview =
    prompt.length > QUEUE_PREVIEW_MAX_CHARS
      ? `${prompt.slice(0, QUEUE_PREVIEW_MAX_CHARS)}...`
      : prompt;
  await ctx
    .reply(
      `<b>${t().status.takingNext}</b>${queueInfo}\n<pre>${escapeHtml(preview)}</pre>`,
      { disable_notification: true, parse_mode: "HTML" }
    )
    .catch(swallow);
};

export const registerQueueCallbacks = ({ bot }: HandlerDeps) => {
  bot.callbackQuery(FORCE_SEND_RE, async (ctx) => {
    if (!mayPressQueueButton(ctx)) {
      await ctx.answerCallbackQuery({ text: t().notYourButton });
      return;
    }
    const stopped = stopRun(await getState(ctx), "new_prompt");
    await ctx.answerCallbackQuery({
      text: stopped ? t().status.stopping : t().status.idle,
    });
  });

  bot.callbackQuery(CLEAR_QUEUE_RE, async (ctx) => {
    if (!mayPressQueueButton(ctx)) {
      await ctx.answerCallbackQuery({ text: t().notYourButton });
      return;
    }
    const state = await getState(ctx);
    const count = state.queue.length;
    state.queue = [];
    await cleanupQueueStatus(state, ctx);
    await ctx.answerCallbackQuery({
      text: count > 0 ? t().status.queueCleared(count) : t().status.queueEmpty,
    });
  });
};
