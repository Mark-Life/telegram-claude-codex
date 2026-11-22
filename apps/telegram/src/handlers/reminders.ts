import type { ReminderTopic } from "@workspace/db";
import { Effect } from "effect";

import { accessOf } from "../access/context";
import type { BotContext } from "../access/context";
import { canManageTasks } from "../access/tier";
import {
  acknowledgeReminder,
  completeReminder,
  countReminders,
  getReminder,
  listReminders,
  moveReminder,
  setReminderDestination,
} from "../db/bridge";
import { t } from "../i18n";
import {
  formatDue,
  formatReminderPage,
  pageButtons,
  postponeButtons,
  REMINDER_PAGE_SIZE,
  reminderButtons,
  SNOOZE_CHOICES,
} from "../reminders/format";
import { readHomeTz } from "../reminders/home-tz";
import { tgBestEffort } from "../telegram/bridge";
import type { HandlerDeps } from "./deps";
import { getState } from "./user-state";

const PAGE_RE = /^rempage:(?<value>\d+)$/u;
const DONE_RE = /^remdone:(?<value>\d+)$/u;
const POSTPONE_RE = /^rempostpone:(?<value>\d+)$/u;
const SNOOZE_RE = new RegExp(
  `^remsnooze:(?<choice>${SNOOZE_CHOICES.map((choice) => choice.minutes).join("|")}):(?<value>\\d+)$`,
  "u"
);
const CUSTOM_RE = /^remcustom:(?<value>\d+)$/u;
const SNOOZE_ID_INDEX = 2;
const MINUTE_MS = 60_000;

const callbackNumber = (ctx: BotContext, index = 1) => {
  const value = Number(ctx.match?.[index] ?? "");
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
};

/**
 * Close a reminder's topic: the Done button calls it after answering, the
 * HTTP API hands it to `ReminderService` as the closeTopic port. The row is already completed, so a missing
 * permission must not undo it; no retry, since the callback update waits on
 * this call.
 */
export const closeReminderTopic = (topic: ReminderTopic) =>
  Effect.promise(async () => {
    await tgBestEffort(
      "closeForumTopic",
      async (api) => await api.closeForumTopic(topic.chatId, topic.threadId),
      { retry: false }
    );
  });

/** Shared operational guard: owner and executor, never ordinary members. */
const mayManage = (ctx: BotContext) => canManageTasks(accessOf(ctx).tier);

const savePageContext = async (
  ctx: BotContext,
  page: number,
  ids: readonly number[]
) => {
  const state = await getState(ctx);
  state.lastReminderPage = { ids: [...ids], page, shownAt: Date.now() };
};

const renderPage = async (pageRequested: number, envTz: string) => {
  const homeTz = await readHomeTz(envTz);
  const total = await countReminders();
  const pages = Math.max(1, Math.ceil(total / REMINDER_PAGE_SIZE));
  const page = Math.min(Math.max(0, pageRequested), pages - 1);
  const reminders = await listReminders({
    limit: REMINDER_PAGE_SIZE,
    offset: page * REMINDER_PAGE_SIZE,
  });
  return {
    ids: reminders.map((reminder) => reminder.id),
    markup: pageButtons({ page, pages }),
    page,
    text: formatReminderPage({ homeTz, page, reminders, total }),
  };
};

export const registerReminderHandlers = ({ bot, defaultTz }: HandlerDeps) => {
  bot.command("reminders", async (ctx) => {
    if (!mayManage(ctx)) {
      await ctx.reply(t().notForYou);
      return;
    }
    const view = await renderPage(0, defaultTz);
    await savePageContext(ctx, view.page, view.ids);
    await ctx.reply(view.text, { reply_markup: view.markup });
  });

  bot.callbackQuery(PAGE_RE, async (ctx) => {
    if (!mayManage(ctx)) {
      await ctx.answerCallbackQuery({ text: t().notForYou });
      return;
    }
    const requested = callbackNumber(ctx);
    const view = await renderPage(requested ?? 0, defaultTz);
    await savePageContext(ctx, view.page, view.ids);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(view.text, { reply_markup: view.markup });
  });

  bot.callbackQuery(POSTPONE_RE, async (ctx) => {
    if (!mayManage(ctx)) {
      await ctx.answerCallbackQuery({ text: t().notForYou });
      return;
    }
    const id = callbackNumber(ctx);
    if (id === undefined || (await getReminder(id)) === undefined) {
      await ctx.answerCallbackQuery({ text: t().reminders.missing });
      return;
    }
    await acknowledgeReminder({ at: Date.now(), id });
    await ctx.answerCallbackQuery({ text: t().reminders.askWhen });
    await ctx.editMessageReplyMarkup({ reply_markup: postponeButtons(id) });
  });

  bot.callbackQuery(SNOOZE_RE, async (ctx) => {
    if (!mayManage(ctx)) {
      await ctx.answerCallbackQuery({ text: t().notForYou });
      return;
    }
    const choice = ctx.match?.[1];
    const id = callbackNumber(ctx, SNOOZE_ID_INDEX);
    const reminder = id === undefined ? undefined : await getReminder(id);
    if (!reminder) {
      await ctx.answerCallbackQuery({ text: t().reminders.missing });
      return;
    }
    const now = Date.now();
    const minutes = Number(choice);
    const dueAt = now + minutes * MINUTE_MS;
    const updated = await moveReminder({ dueAt, id: reminder.id });
    if (!updated) {
      await ctx.answerCallbackQuery({ text: t().reminders.postponeFailed });
      return;
    }
    const due = formatDue(updated, await readHomeTz(defaultTz));
    await ctx.answerCallbackQuery({ text: t().reminders.postponed(due) });
    const original = ctx.callbackQuery.message?.text ?? reminder.text;
    await ctx.editMessageText(`${original}\n\n${t().reminders.postponed(due)}`);
  });

  bot.callbackQuery(CUSTOM_RE, async (ctx) => {
    if (!mayManage(ctx)) {
      await ctx.answerCallbackQuery({ text: t().notForYou });
      return;
    }
    const id = callbackNumber(ctx);
    const reminder = id === undefined ? undefined : await getReminder(id);
    if (!reminder) {
      await ctx.answerCallbackQuery({ text: t().reminders.missing });
      return;
    }
    await ctx.answerCallbackQuery();
    const prompt = await ctx.reply(t().reminders.askNewDue(reminder.id), {
      reply_markup: { force_reply: true, selective: true },
    });
    if (ctx.chat) {
      await setReminderDestination({
        chatId: ctx.chat.id,
        id: reminder.id,
        messageId: prompt.message_id,
        threadId: reminder.threadId,
      });
    }
    await ctx.editMessageReplyMarkup({
      reply_markup: reminderButtons(reminder.id),
    });
  });

  bot.callbackQuery(DONE_RE, async (ctx) => {
    if (!mayManage(ctx)) {
      await ctx.answerCallbackQuery({ text: t().notForYou });
      return;
    }
    const id = callbackNumber(ctx);
    // The topic closes after the toast and the edit, so a slow
    // closeForumTopic never delays the callback answer.
    const reminder =
      id === undefined
        ? undefined
        : await completeReminder({ closeTopic: () => Effect.void, id });
    if (!reminder) {
      await ctx.answerCallbackQuery({ text: t().reminders.missing });
      return;
    }
    await ctx.answerCallbackQuery({ text: t().reminders.doneToast });
    const original = ctx.callbackQuery.message?.text ?? reminder.text;
    await ctx.editMessageText(`${original}\n\n✅ ${t().reminders.completed}`);
    if (reminder.chatId !== undefined && reminder.threadId !== undefined) {
      await Effect.runPromise(
        closeReminderTopic({
          chatId: reminder.chatId,
          threadId: reminder.threadId,
        })
      );
    }
  });
};
