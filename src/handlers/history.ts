import { basename } from "node:path";
import { InlineKeyboard } from "grammy";
import { getSessionProject, listAllSessions } from "../agent";
import type { ProviderId } from "../agent/types";
import type { HandlerDeps } from "./deps";
import {
  escapeHtml,
  formatRelativeTime,
  HISTORY_PAGE_RE,
  mainKeyboard,
  repinMessage,
  SESSION_CALLBACK_RE,
} from "./helpers";
import { adoptSession, setRouteProject } from "./session-routing";
import { getState, HISTORY_PAGE_SIZE } from "./user-state";

/** Build paginated history message with inline keyboard */
const buildHistoryMessage = (page: number, providerId: ProviderId) => {
  const sessions = listAllSessions(providerId);

  if (sessions.length === 0) {
    return null;
  }

  const totalPages = Math.ceil(sessions.length / HISTORY_PAGE_SIZE);
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const pageSlice = sessions.slice(
    safePage * HISTORY_PAGE_SIZE,
    (safePage + 1) * HISTORY_PAGE_SIZE
  );

  const keyboard = new InlineKeyboard();
  const blocks = pageSlice.map((s, i) => {
    const n = i + 1;
    keyboard.text(String(n), `session:${s.sessionId}`);
    const when = escapeHtml(formatRelativeTime(s.lastActiveAt));
    const project = escapeHtml(s.projectName);
    const topic = escapeHtml(s.summary.trim() || "(no topic)");
    return `<b>${n}.</b> ${when} · <i>${project}</i>\n${topic}`;
  });
  keyboard.row();

  const navRow: { text: string; data: string }[] = [];
  if (safePage > 0) {
    navRow.push({ text: "<< Prev", data: `history:${safePage - 1}` });
  }
  if (safePage < totalPages - 1) {
    navRow.push({ text: "Next >>", data: `history:${safePage + 1}` });
  }
  if (navRow.length > 0) {
    for (const btn of navRow) {
      keyboard.text(btn.text, btn.data);
    }
    keyboard.row();
  }

  const pageIndicator =
    totalPages > 1 ? ` (${safePage + 1}/${totalPages})` : "";
  const text = `<b>Sessions${pageIndicator}</b>\n\n${blocks.join("\n\n")}`;
  return { text, keyboard };
};

/** /history plus its pagination and session-resume callbacks. */
export const registerHistoryHandlers = ({ bot }: HandlerDeps) => {
  bot.command("history", async (ctx) => {
    const state = getState(ctx);
    const result = buildHistoryMessage(0, state.activeProvider);

    if (!result) {
      await ctx.reply("No session history found.", {
        reply_markup: mainKeyboard,
      });
      return;
    }

    await ctx.reply(result.text, {
      reply_markup: result.keyboard,
      parse_mode: "HTML",
    });
  });

  bot.callbackQuery(HISTORY_PAGE_RE, async (ctx) => {
    const page = Number.parseInt(ctx.match?.[1] ?? "", 10);
    const state = getState(ctx);
    const result = buildHistoryMessage(page, state.activeProvider);

    if (!result) {
      await ctx.answerCallbackQuery({ text: "No sessions found" });
      return;
    }

    await ctx.editMessageText(result.text, {
      reply_markup: result.keyboard,
      parse_mode: "HTML",
    });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(SESSION_CALLBACK_RE, async (ctx) => {
    const sessionId = ctx.match?.[1] ?? "";
    const state = getState(ctx);

    const cachedProject = getSessionProject(state.activeProvider, sessionId);
    if (cachedProject) {
      setRouteProject(state, cachedProject);
    }

    if (!state.activeProject) {
      await ctx.answerCallbackQuery({ text: "No project selected" });
      return;
    }

    await adoptSession(state, sessionId);
    const projectName = basename(state.activeProject);
    await ctx.answerCallbackQuery({ text: "Session resumed" });
    const msg = await ctx.editMessageText(
      `Resumed session in <b>${escapeHtml(projectName)}</b>. Next message continues this conversation.`,
      { parse_mode: "HTML" }
    );
    await repinMessage(ctx, state.chatId, msg);
  });
};
