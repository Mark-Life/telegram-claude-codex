import path from "node:path";

import {
  decodeProviderId,
  getProvider,
  PROVIDER_IDS,
} from "@workspace/agent/registry";
import type { ProviderId } from "@workspace/agent/types";
import type { SessionHistoryListed, TaskRun } from "@workspace/db";
import { Option } from "effect";
import { InlineKeyboard } from "grammy";

import { accessOf } from "../access/context";
import type { BotContext } from "../access/context";
import { isOperator, isOwner } from "../access/tier";
import {
  countHistory,
  countTaskRuns,
  getHistoryEntry,
  listHistory,
  listTaskRuns,
} from "../db/bridge";
import { t } from "../i18n";
import { loadPersona } from "../persona";
import { projectPathOr } from "../work-dir";
import { retireRun } from "./agent-bridge";
import type { HandlerDeps } from "./deps";
import {
  escapeHtml,
  HISTORY_PAGE_RE,
  HISTORY_TASKS_RE,
  removedKeyboard,
  repinMessage,
  requireChat,
  SESSION_CALLBACK_RE,
} from "./helpers";
import { nameOf, readyNow, switchableRoute, switchTo } from "./provider";
import { routeStateFor } from "./route-provider";
import { adoptSession, routeView, setRouteProject } from "./session-routing";
import { getState, HISTORY_PAGE_SIZE } from "./user-state";
import type { UserState } from "./user-state";

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const DAYS_PER_WEEK = 7;

/** Telegram's limit on a button's callback data, in bytes. */
const CALLBACK_DATA_MAX_BYTES = 64;

/** Format an epoch-ms time as a compact relative time ("5 min ago", "3 Mar"). */
const formatRelativeTime = (at: number) => {
  const copy = t().history.ago;
  const diffMin = Math.floor((Date.now() - at) / MS_PER_MINUTE);
  if (diffMin < 1) {
    return copy.now;
  }
  if (diffMin < MINUTES_PER_HOUR) {
    return copy.minutes(diffMin);
  }
  const diffHour = Math.floor(diffMin / MINUTES_PER_HOUR);
  if (diffHour < HOURS_PER_DAY) {
    return copy.hours(diffHour);
  }
  const diffDay = Math.floor(diffHour / HOURS_PER_DAY);
  if (diffDay < DAYS_PER_WEEK) {
    return copy.days(diffDay);
  }
  return new Date(at).toLocaleDateString(t().dateLocale, {
    day: "numeric",
    month: "short",
  });
};

/**
 * The provider and the model a session or a fire ran on, as one phrase:
 * the model's name in the provider's list, else its slug without the
 * account prefix (pi's `openrouter/z-ai/glm-5.2` reads `glm-5.2`).
 */
const ranOn = (entry: { model?: string; provider?: string }) => {
  const provider = Option.getOrUndefined(decodeProviderId(entry.provider));
  if (provider === undefined) {
    return null;
  }
  const { model } = entry;
  if (model === undefined) {
    return nameOf(provider);
  }
  const label =
    getProvider(provider)
      .models()
      .find((choice) => choice.id === model)?.label ??
    model.slice(model.lastIndexOf("/") + 1);
  return `${nameOf(provider)} ${label}`;
};

/** The first line of one row: when, what it ran on, and the project when it differs. */
const rowHeader = (input: { entry: SessionHistoryListed; project: string }) => {
  const { entry } = input;
  const ran = ranOn(entry);
  const parts = [
    formatRelativeTime(entry.lastActiveAt),
    ...(ran === null ? [] : [ran]),
    ...(entry.projectPath.length > 0 &&
    projectPathOr(entry.projectPath) !== projectPathOr(input.project)
      ? [path.basename(entry.projectPath)]
      : []),
  ];
  return parts.map((part) => escapeHtml(part)).join(" · ");
};

/** A row's title: its topic's name when it has one, else its first message. */
const rowTitle = (entry: SessionHistoryListed) => {
  if (entry.topicTitle !== undefined) {
    return `🗂️ ${escapeHtml(entry.topicTitle)}`;
  }
  return escapeHtml(entry.title.trim() || t().history.noTopic);
};

/** Back and next for page `page` of `totalPages`, as `data(page)` names them. */
const pageButtons = (
  keyboard: InlineKeyboard,
  input: { data: (page: number) => string; page: number; totalPages: number }
) => {
  if (input.page > 0) {
    keyboard.text(t().history.back, input.data(input.page - 1));
  }
  if (input.page < input.totalPages - 1) {
    keyboard.text(t().history.next, input.data(input.page + 1));
  }
};

/** Build one page of past conversations, or null when there are none. */
const buildHistoryMessage = async (page: number, state: UserState) => {
  const [counts, taskRuns] = await Promise.all([
    countHistory(PROVIDER_IDS),
    countTaskRuns(),
  ]);
  const total = counts.reduce((sum, row) => sum + row.n, 0);
  if (total === 0 && taskRuns === 0) {
    return null;
  }
  if (total === 0) {
    return {
      keyboard: new InlineKeyboard().text(t().history.tasks, "history_tasks:0"),
      text: t().history.empty,
    };
  }
  const totalPages = Math.ceil(total / HISTORY_PAGE_SIZE);
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const entries = await listHistory({
    limit: HISTORY_PAGE_SIZE,
    offset: safePage * HISTORY_PAGE_SIZE,
    providers: PROVIDER_IDS,
  });
  const keyboard = new InlineKeyboard();
  const blocks = entries.map((entry, i) => {
    const n = i + 1;
    const data = `session:${entry.provider}:${entry.sessionId}`;
    if (Buffer.byteLength(data) <= CALLBACK_DATA_MAX_BYTES) {
      keyboard.text(String(n), data);
    }
    const header = rowHeader({ entry, project: state.activeProject });
    return `<b>${n}.</b> ${header}\n${rowTitle(entry)}`;
  });
  keyboard.row();

  if (taskRuns > 0) {
    keyboard.text(t().history.tasks, "history_tasks:0");
  }
  pageButtons(keyboard, {
    data: (to) => `history:${to}`,
    page: safePage,
    totalPages,
  });
  keyboard.row();

  const pageIndicator =
    totalPages > 1 ? ` (${safePage + 1}/${totalPages})` : "";
  const text = `<b>${t().history.title}${pageIndicator}</b>\n\n${blocks.join("\n\n")}`;
  return { keyboard, text };
};

/** One fire in the Tasks view: when, what it ran on, how it ended. */
const taskRunBlock = (run: TaskRun, n: number) => {
  const ran = ranOn(run);
  const header = [
    formatRelativeTime(run.finishedAt),
    ...(ran === null ? [] : [ran]),
    t().tasks.list.status[run.status],
  ]
    .map((part) => escapeHtml(part))
    .join(" · ");
  return `<b>${n}.</b> ${header}\n${escapeHtml(run.title)}`;
};

/**
 * One page of task fires, the latest first: a run log, nothing to resume.
 * Null when there are none.
 */
const buildTaskRunsMessage = async (page: number) => {
  const total = await countTaskRuns();
  if (total === 0) {
    return null;
  }
  const totalPages = Math.ceil(total / HISTORY_PAGE_SIZE);
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const runs = await listTaskRuns({
    limit: HISTORY_PAGE_SIZE,
    offset: safePage * HISTORY_PAGE_SIZE,
  });
  const keyboard = new InlineKeyboard().text(
    t().history.conversations,
    "history:0"
  );
  pageButtons(keyboard, {
    data: (to) => `history_tasks:${to}`,
    page: safePage,
    totalPages,
  });
  const pageIndicator =
    totalPages > 1 ? ` (${safePage + 1}/${totalPages})` : "";
  const blocks = runs.map((run, i) => taskRunBlock(run, i + 1));
  return {
    keyboard,
    text: `<b>${t().history.tasksTitle}${pageIndicator}</b>\n\n${blocks.join("\n\n")}`,
  };
};

/**
 * History is machine-wide, so browsing it means reading every conversation
 * the bot ever had and adopting one means continuing it.
 */
const historyAllowed = (ctx: BotContext) => isOperator(accessOf(ctx).tier);

/**
 * Put the route on `provider` before a session of it is adopted, the way
 * `/provider` would. Answers the refusal to show, or null when the route
 * is on `provider` now. Only the owner switches; an executor is told
 * whose the conversation was.
 */
const switchFor = async (input: {
  ctx: BotContext;
  current: ProviderId;
  provider: ProviderId;
  state: UserState;
}) => {
  const { ctx, provider, state } = input;
  if (input.current === provider) {
    return null;
  }
  if (!isOwner(accessOf(ctx).tier)) {
    return t().history.ownerSwitches(nameOf(provider));
  }
  const route = await switchableRoute(ctx, state);
  if (route === undefined) {
    return t().provider.menu.notHere;
  }
  if (!readyNow(provider)) {
    return t().provider.unavailable(nameOf(provider));
  }
  await switchTo({ next: provider, route, state });
  return null;
};

export const registerHistoryHandlers = ({ bot }: HandlerDeps) => {
  bot.command("history", async (ctx) => {
    if (!historyAllowed(ctx)) {
      await ctx.reply(t().notForYou, { reply_markup: removedKeyboard });
      return;
    }
    const result = await buildHistoryMessage(0, await getState(ctx));
    if (!result) {
      await ctx.reply(t().history.empty, {
        reply_markup: removedKeyboard,
      });
      return;
    }
    await ctx.reply(result.text, {
      parse_mode: "HTML",
      reply_markup: result.keyboard,
    });
  });

  bot.callbackQuery(HISTORY_PAGE_RE, async (ctx) => {
    if (!historyAllowed(ctx)) {
      await ctx.answerCallbackQuery({ text: t().notForYou });
      return;
    }
    const page = Math.trunc(Number(ctx.match?.[1] ?? ""));
    const result = await buildHistoryMessage(page, await getState(ctx));
    if (!result) {
      await ctx.answerCallbackQuery({ text: t().history.notFound });
      return;
    }
    await ctx.editMessageText(result.text, {
      parse_mode: "HTML",
      reply_markup: result.keyboard,
    });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(HISTORY_TASKS_RE, async (ctx) => {
    if (!historyAllowed(ctx)) {
      await ctx.answerCallbackQuery({ text: t().notForYou });
      return;
    }
    const page = Math.trunc(Number(ctx.match?.[1] ?? ""));
    const result = await buildTaskRunsMessage(page);
    if (!result) {
      await ctx.answerCallbackQuery({ text: t().history.notFound });
      return;
    }
    await ctx.editMessageText(result.text, {
      parse_mode: "HTML",
      reply_markup: result.keyboard,
    });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(SESSION_CALLBACK_RE, async (ctx) => {
    if (!historyAllowed(ctx)) {
      await ctx.answerCallbackQuery({ text: t().notForYou });
      return;
    }
    const state = await getState(ctx);
    // A button from before providers were named holds the id alone and
    // meant the route's own provider.
    const conversation = await routeStateFor(ctx, state);
    const before = conversation.activeProvider;
    const [, named, sessionId = ""] = ctx.match ?? [];
    const provider = Option.getOrElse(decodeProviderId(named), () => before);
    const entry = await getHistoryEntry({ provider, sessionId });
    if (entry === undefined) {
      await ctx.answerCallbackQuery({ text: t().history.notFound });
      return;
    }
    const refusal = await switchFor({ ctx, current: before, provider, state });
    if (refusal !== null) {
      await ctx.answerCallbackQuery({ text: refusal });
      return;
    }

    retireRun(state);
    if (entry.projectPath.length > 0) {
      await setRouteProject(state, entry.projectPath, provider);
    }
    await adoptSession(routeView(state, provider), sessionId);
    const chatId = requireChat(ctx);
    await ctx.answerCallbackQuery({ text: t().history.resuming });
    const persona = await loadPersona();
    const msg = await ctx.editMessageText(
      before === provider
        ? t().history.resumed(persona)
        : t().history.resumedOn(persona, nameOf(provider)),
      { parse_mode: "HTML" }
    );
    await repinMessage(ctx, chatId, msg);
  });
};
