import { statSync } from "node:fs";
import { basename, join } from "node:path";
import { InlineKeyboard } from "grammy";
import {
  getCurrentBranch,
  getGitHubUrl,
  listBranches,
  listOpenPRs,
} from "../git";
import type { HandlerDeps } from "./deps";
import {
  cleanupComposeStatus,
  cleanupQueueStatus,
  escapeHtml,
  listProjects,
  mainKeyboard,
  PROJECT_CALLBACK_RE,
  PROJECTS_PAGE_RE,
  repinMessage,
} from "./helpers";
import { setRouteProject } from "./session-routing";
import {
  activeProviderName,
  clearComposeMessages,
  getState,
  PROJECT_PAGE_SIZE,
} from "./user-state";

/** Build paginated project selection message with inline keyboard */
const buildProjectsMessage = (page: number, projectsDir: string) => {
  const projects = listProjects(projectsDir);

  if (projects.length === 0) {
    return null;
  }

  const totalPages = Math.ceil(projects.length / PROJECT_PAGE_SIZE);
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const pageSlice = projects.slice(
    safePage * PROJECT_PAGE_SIZE,
    (safePage + 1) * PROJECT_PAGE_SIZE
  );

  const keyboard = new InlineKeyboard();
  keyboard.text("General (all projects)", "project:__general__").row();
  for (const name of pageSlice) {
    keyboard.text(name, `project:${name}`).row();
  }

  const navRow: { text: string; data: string }[] = [];
  if (safePage > 0) {
    navRow.push({ text: "<< Prev", data: `projects:${safePage - 1}` });
  }
  if (safePage < totalPages - 1) {
    navRow.push({ text: "Next >>", data: `projects:${safePage + 1}` });
  }
  if (navRow.length > 0) {
    for (const btn of navRow) {
      keyboard.text(btn.text, btn.data);
    }
    keyboard.row();
  }

  const pageIndicator =
    totalPages > 1 ? ` (${safePage + 1}/${totalPages})` : "";
  return { text: `Select a project${pageIndicator}:`, keyboard };
};

/** /projects, its pagination callback and the project-selection callback. */
export const registerProjectHandlers = ({ bot, projectsDir }: HandlerDeps) => {
  bot.command("projects", async (ctx) => {
    const result = buildProjectsMessage(0, projectsDir);

    if (!result) {
      await ctx.reply(`No projects found in ${projectsDir}`, {
        reply_markup: mainKeyboard,
      });
      return;
    }

    await ctx.reply(result.text, { reply_markup: result.keyboard });
  });

  bot.callbackQuery(PROJECTS_PAGE_RE, async (ctx) => {
    const page = Number.parseInt(ctx.match?.[1] ?? "", 10);
    const result = buildProjectsMessage(page, projectsDir);

    if (!result) {
      await ctx.answerCallbackQuery({ text: "No projects found" });
      return;
    }

    await ctx.editMessageText(result.text, { reply_markup: result.keyboard });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(PROJECT_CALLBACK_RE, async (ctx) => {
    const name = ctx.match?.[1] ?? "";
    const isGeneral = name === "__general__";
    const fullPath = isGeneral ? projectsDir : join(projectsDir, name);
    const displayName = isGeneral ? "general (all projects)" : name;

    if (!isGeneral) {
      try {
        statSync(fullPath);
      } catch {
        await ctx.answerCallbackQuery({ text: "Project not found" });
        return;
      }
    }

    const state = getState(ctx);
    // In a topic this re-pins the row, so the topic's session starts fresh on
    // the new project while other topics keep theirs.
    setRouteProject(state, fullPath);
    state.queue = [];
    state.pendingPlan = undefined;
    clearComposeMessages(state);
    await cleanupQueueStatus(state, ctx);
    await cleanupComposeStatus(state, ctx);
    await ctx.answerCallbackQuery({ text: `Switched to ${displayName}` });
    const ghUrl = isGeneral ? null : getGitHubUrl(fullPath);
    const projectLabel = ghUrl
      ? `<a href="${escapeHtml(ghUrl)}">${escapeHtml(displayName)}</a>`
      : escapeHtml(displayName);
    const branch = isGeneral ? null : getCurrentBranch(fullPath);
    const branchSuffix = branch ? ` [${escapeHtml(branch)}]` : "";
    const providerSuffix = ` · ${escapeHtml(activeProviderName(state))}`;
    const msg = await ctx.editMessageText(
      `Active project: ${projectLabel}${branchSuffix}${providerSuffix}`,
      { parse_mode: "HTML" }
    );
    await repinMessage(ctx, state.chatId, msg);
  });
};

/** Repository commands for the active project: /branch and /pr. */
export const registerGitCommands = ({ bot, projectsDir }: HandlerDeps) => {
  bot.command("branch", async (ctx) => {
    const state = getState(ctx);
    if (!state.activeProject || state.activeProject === projectsDir) {
      await ctx.reply("No project selected or in general mode.", {
        reply_markup: mainKeyboard,
      });
      return;
    }

    const current = getCurrentBranch(state.activeProject);
    if (!current) {
      await ctx.reply("Not a git repository.", { reply_markup: mainKeyboard });
      return;
    }

    const branches = listBranches(state.activeProject);
    const projectName = basename(state.activeProject);
    const others = (branches ?? []).filter((b) => b !== current);
    const visible = others.slice(0, 10);
    const collapsed = others.slice(10);
    const lines = [
      `<b>${escapeHtml(projectName)}</b>`,
      `Current: <code>${escapeHtml(current)}</code>`,
    ];
    if (visible.length > 0) {
      lines.push("", ...visible.map((b) => `<code>${escapeHtml(b)}</code>`));
    }
    if (collapsed.length > 0) {
      const collapsedLines = collapsed
        .map((b) => `<code>${escapeHtml(b)}</code>`)
        .join("\n");
      lines.push(`\n<blockquote expandable>${collapsedLines}</blockquote>`);
    }
    // listBranches caps at 50; if we got exactly 50 others, there are likely more
    if (others.length >= 49) {
      lines.push("<i>...showing most recent branches only</i>");
    }
    await ctx.reply(lines.join("\n"), {
      parse_mode: "HTML",
      reply_markup: mainKeyboard,
    });
  });

  bot.command("pr", async (ctx) => {
    const state = getState(ctx);
    if (!state.activeProject || state.activeProject === projectsDir) {
      await ctx.reply("No project selected or in general mode.", {
        reply_markup: mainKeyboard,
      });
      return;
    }

    const prs = listOpenPRs(state.activeProject);
    if (prs === null) {
      await ctx.reply("Could not fetch PRs. Is gh CLI authenticated?", {
        reply_markup: mainKeyboard,
      });
      return;
    }
    if (prs.length === 0) {
      await ctx.reply("No open PRs.", { reply_markup: mainKeyboard });
      return;
    }

    const lines = prs.map(
      (pr) =>
        `#${pr.number} <a href="${escapeHtml(pr.url)}">${escapeHtml(pr.title)}</a> (<code>${escapeHtml(pr.headRefName)}</code>)`
    );
    await ctx.reply(lines.join("\n"), {
      parse_mode: "HTML",
      reply_markup: mainKeyboard,
    });
  });
};
