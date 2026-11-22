import { readFileSync } from "node:fs";

import type { ProviderId } from "@workspace/agent/types";
import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";

import { t } from "../i18n";
import { sendRichMarkdown } from "../telegram/bridge";
import { splitText } from "../telegram/format";
import { requireRoute } from "../telegram/route";
import type { HandlerDeps, RunPipeline } from "./deps";
import {
  logRejection,
  removedKeyboard,
  PLAN_CANCEL_RE,
  PLAN_MODIFY_RE,
  PLAN_NEW_RE,
  PLAN_RESUME_RE,
} from "./helpers";
import {
  adoptSession,
  forgetSession,
  routeView,
  setRouteProject,
} from "./session-routing";
import { activePendingPlan, cancelPendingStart, getState } from "./user-state";
import type { UserState } from "./user-state";

const planKeyboard = (userId: number) =>
  new InlineKeyboard()
    .text(t().plan.runFresh, `plan_new:${userId}`)
    .row()
    .text(t().plan.runResume, `plan_resume:${userId}`)
    .row()
    .text(t().plan.modify, `plan_modify:${userId}`);

/** Send the plan file to the user with the execute/modify choices. */
export const presentPlan = async (
  ctx: Context,
  state: UserState,
  result: { planPath?: string; provider: ProviderId; sessionId?: string }
) => {
  const planPath = result.planPath ?? "";
  if (planPath.length === 0) {
    await ctx.reply(t().plan.unreadable, {
      reply_markup: removedKeyboard,
    });
    return;
  }
  let planContent: string;
  try {
    planContent = readFileSync(planPath, "utf-8");
  } catch {
    await ctx.reply(t().plan.unreadable, {
      reply_markup: removedKeyboard,
    });
    return;
  }

  state.pendingPlan = {
    planPath,
    projectPath: state.activeProject,
    provider: result.provider,
    sessionId: result.sessionId,
  };

  const route = requireRoute(ctx);
  for (const chunk of splitText(planContent)) {
    // oxlint-disable-next-line no-await-in-loop -- chunks must arrive in order
    await sendRichMarkdown({ markdown: chunk, route });
  }

  await ctx.reply(t().plan.ready, {
    reply_markup: planKeyboard(state.userId),
  });
};

export const registerPlanHandlers = (
  { bot }: HandlerDeps,
  pipeline: RunPipeline
) => {
  bot.callbackQuery(PLAN_NEW_RE, async (ctx) => {
    const state = await getState(ctx);
    const plan = activePendingPlan(state);
    if (!plan) {
      await ctx.answerCallbackQuery({ text: t().plan.none });
      return;
    }

    let planContent: string;
    try {
      planContent = readFileSync(plan.planPath, "utf-8");
    } catch {
      await ctx.answerCallbackQuery({ text: t().plan.unreadable });
      state.pendingPlan = undefined;
      return;
    }

    await setRouteProject(state, plan.projectPath, plan.provider);
    await forgetSession(routeView(state, plan.provider));
    state.unpicked = undefined;
    cancelPendingStart(state);
    state.pendingPlan = undefined;
    await ctx.answerCallbackQuery({ text: t().plan.runningToast });
    await ctx.editMessageText(t().plan.runningFresh);

    const prompt = `Execute the following plan. Do not re-enter plan mode.\n\n${planContent}`;
    // The plan, not the bot's instruction, is what the new session is about.
    pipeline
      .runAndDrain(ctx, prompt, state, { kind: "text", message: planContent })
      .catch(logRejection("plan_new error"));
  });

  bot.callbackQuery(PLAN_RESUME_RE, async (ctx) => {
    const state = await getState(ctx);
    const plan = activePendingPlan(state);
    if (!plan) {
      await ctx.answerCallbackQuery({ text: t().plan.none });
      return;
    }

    await setRouteProject(state, plan.projectPath, plan.provider);
    if (plan.sessionId !== undefined) {
      await adoptSession(routeView(state, plan.provider), plan.sessionId);
    }
    state.pendingPlan = undefined;
    await ctx.answerCallbackQuery({ text: t().plan.runningToast });
    await ctx.editMessageText(t().plan.runningResume);

    const prompt =
      "The plan has been approved. Proceed with execution. Do not re-enter plan mode.";
    pipeline
      .runAndDrain(ctx, prompt, state)
      .catch(logRejection("plan_resume error"));
  });

  bot.callbackQuery(PLAN_MODIFY_RE, async (ctx) => {
    const state = await getState(ctx);
    if (!activePendingPlan(state)) {
      await ctx.answerCallbackQuery({ text: t().plan.none });
      return;
    }
    const cancelKeyboard = new InlineKeyboard().text(
      t().cancel,
      `plan_cancel:${state.userId}`
    );
    await ctx.answerCallbackQuery({ text: t().plan.awaitingEdits });
    await ctx.editMessageText(t().plan.askEdits, {
      reply_markup: cancelKeyboard,
    });
  });

  bot.callbackQuery(PLAN_CANCEL_RE, async (ctx) => {
    const state = await getState(ctx);
    if (!activePendingPlan(state)) {
      await ctx.answerCallbackQuery({ text: t().plan.none });
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(t().plan.ready, {
      reply_markup: planKeyboard(state.userId),
    });
  });
};
