import { readFileSync } from "node:fs";
import { type Context, InlineKeyboard } from "grammy";
import { sendRichMarkdown, splitText } from "../telegram";
import { threadOpts } from "../telegram/route";
import type { HandlerDeps, RunPipeline } from "./deps";
import {
  mainKeyboard,
  PLAN_CANCEL_RE,
  PLAN_MODIFY_RE,
  PLAN_NEW_RE,
  PLAN_RESUME_RE,
} from "./helpers";
import {
  adoptSession,
  forgetSession,
  setRouteProject,
} from "./session-routing";
import { activePendingPlan, getState, type UserState } from "./user-state";

/** Read plan file and send to user with action buttons */
export const presentPlan = async (
  ctx: Context,
  state: UserState,
  result: { planPath?: string; sessionId?: string }
) => {
  const planPath = result.planPath;
  if (!planPath) {
    await ctx.reply("Could not read plan file.", {
      reply_markup: mainKeyboard,
    });
    return;
  }
  let planContent: string;
  try {
    planContent = readFileSync(planPath, "utf-8");
  } catch {
    await ctx.reply("Could not read plan file.", {
      reply_markup: mainKeyboard,
    });
    return;
  }

  state.pendingPlan = {
    planPath,
    sessionId: result.sessionId,
    projectPath: state.activeProject,
  };

  const route = { chatId: state.chatId, threadId: state.threadId };
  const chunks = splitText(planContent);
  for (const chunk of chunks) {
    await sendRichMarkdown({ ctx, markdown: chunk, route });
  }

  const keyboard = new InlineKeyboard()
    .text("Execute (new session)", `plan_new:${state.userId}`)
    .row()
    .text("Execute (keep context)", `plan_resume:${state.userId}`)
    .row()
    .text("Modify plan", `plan_modify:${state.userId}`);

  await ctx.api.sendMessage(
    route.chatId,
    "Plan ready. How would you like to proceed?",
    { reply_markup: keyboard, ...threadOpts(route) }
  );
};

/** Plan-mode buttons: execute in a new session, keep context, modify, cancel. */
export const registerPlanHandlers = (
  { bot }: HandlerDeps,
  { runAndDrain }: RunPipeline
) => {
  bot.callbackQuery(PLAN_NEW_RE, async (ctx) => {
    const state = getState(ctx);
    const plan = activePendingPlan(state);
    if (!plan) {
      await ctx.answerCallbackQuery({ text: "No pending plan" });
      return;
    }

    let planContent: string;
    try {
      planContent = readFileSync(plan.planPath, "utf-8");
    } catch {
      await ctx.answerCallbackQuery({ text: "Could not read plan file" });
      state.pendingPlan = undefined;
      return;
    }

    setRouteProject(state, plan.projectPath);
    await forgetSession(state);
    state.pendingPlan = undefined;
    await ctx.answerCallbackQuery({ text: "Executing plan (new session)..." });
    await ctx.editMessageText("Executing plan (new session)...");

    const prompt = `Execute the following plan. Do not re-enter plan mode.\n\n${planContent}`;
    runAndDrain(ctx, prompt, state).catch((e) =>
      console.error("plan_new error:", e)
    );
  });

  bot.callbackQuery(PLAN_RESUME_RE, async (ctx) => {
    const state = getState(ctx);
    const plan = activePendingPlan(state);
    if (!plan) {
      await ctx.answerCallbackQuery({ text: "No pending plan" });
      return;
    }

    setRouteProject(state, plan.projectPath);
    if (plan.sessionId) {
      await adoptSession(state, plan.sessionId);
    }
    state.pendingPlan = undefined;
    await ctx.answerCallbackQuery({
      text: "Executing plan (keeping context)...",
    });
    await ctx.editMessageText("Executing plan (keeping context)...");

    const prompt =
      "The plan has been approved. Proceed with execution. Do not re-enter plan mode.";
    runAndDrain(ctx, prompt, state).catch((e) =>
      console.error("plan_resume error:", e)
    );
  });

  bot.callbackQuery(PLAN_MODIFY_RE, async (ctx) => {
    const state = getState(ctx);
    if (!activePendingPlan(state)) {
      await ctx.answerCallbackQuery({ text: "No pending plan" });
      return;
    }
    const cancelKeyboard = new InlineKeyboard().text(
      "Cancel",
      `plan_cancel:${state.userId}`
    );
    await ctx.answerCallbackQuery({ text: "Send your feedback" });
    await ctx.editMessageText(
      "Send your feedback. Next message will continue the conversation with plan context.",
      { reply_markup: cancelKeyboard }
    );
  });

  bot.callbackQuery(PLAN_CANCEL_RE, async (ctx) => {
    const state = getState(ctx);
    if (!activePendingPlan(state)) {
      await ctx.answerCallbackQuery({ text: "No pending plan" });
      return;
    }
    const keyboard = new InlineKeyboard()
      .text("Execute (new session)", `plan_new:${state.userId}`)
      .row()
      .text("Execute (keep context)", `plan_resume:${state.userId}`)
      .row()
      .text("Modify plan", `plan_modify:${state.userId}`);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Plan ready. How would you like to proceed?", {
      reply_markup: keyboard,
    });
  });
};
