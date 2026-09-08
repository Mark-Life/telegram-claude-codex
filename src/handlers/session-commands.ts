import { InlineKeyboard } from "grammy";
import {
  compactAgent,
  getDefaultEffort,
  getEffortLevels,
  getModels,
  hasActiveProcess,
  stopAgent,
  supportsCompaction,
} from "../agent";
import { listProviders } from "../agent/registry";
import { countSessions } from "../agent/session-store";
import type { CompactEvent } from "../agent/types";
import { getCurrentBranch } from "../git";
import { runtime } from "../runtime";
import { setActiveProvider, setEffort, setModel } from "../state";
import type { HandlerDeps, RunPipeline } from "./deps";
import {
  cleanupComposeStatus,
  cleanupQueueStatus,
  describeProject,
  EFFORT_CALLBACK_RE,
  MODEL_CALLBACK_RE,
  mainKeyboard,
  PROVIDER_CALLBACK_RE,
  swallow,
} from "./helpers";
import {
  forgetSession,
  resolveSessionId,
  setRouteProject,
} from "./session-routing";
import {
  activeProviderName,
  clearComposeMessages,
  getState,
} from "./user-state";
import { currentVerbosity } from "./verbosity";

/** /start plus the provider, model and effort pickers and their callbacks. */
export const registerProviderCommands = ({ bot }: HandlerDeps) => {
  bot.command("start", async (ctx) => {
    const state = getState(ctx);
    const project = state.activeProject || "(none)";
    await ctx.reply(
      `Coding agent bot ready.\nProvider: ${activeProviderName(state)}\nActive project: ${project}\n\nCommands:\n/projects - switch project\n/provider - switch coding agent provider\n/history - resume a past session\n/stop - kill active process\n/status - current state\n/new - reset session\n/compact - summarize session, keep going`,
      { reply_markup: mainKeyboard }
    );
  });

  bot.command("provider", async (ctx) => {
    const state = getState(ctx);
    const keyboard = new InlineKeyboard();
    for (const provider of listProviders()) {
      const mark = provider.id === state.activeProvider ? "✓ " : "";
      keyboard
        .text(`${mark}${provider.displayName}`, `provider:${provider.id}`)
        .row();
    }
    await ctx.reply("Select a coding agent provider:", {
      reply_markup: keyboard,
    });
  });

  bot.callbackQuery(PROVIDER_CALLBACK_RE, async (ctx) => {
    const chosen = ctx.match?.[1];
    const provider = listProviders().find((p) => p.id === chosen);
    if (!provider) {
      await ctx.answerCallbackQuery({ text: "Unknown provider" });
      return;
    }
    const state = getState(ctx);
    const wasRunning = hasActiveProcess(state);
    if (wasRunning) {
      stopAgent(state, "switched");
    }
    // setActiveProvider mutates state.activeProvider in place and persists;
    // re-pinning the same project carries the switch onto the topic's row, so
    // the topic starts a fresh session with the new provider.
    setActiveProvider(state, provider.id);
    if (state.activeProject) {
      setRouteProject(state, state.activeProject);
    }
    await ctx.answerCallbackQuery({
      text: `Switched to ${provider.displayName}`,
    });
    const stoppedSuffix = wasRunning ? " Previous run was stopped." : "";
    await ctx.editMessageText(
      `Active provider: ${provider.displayName}.${stoppedSuffix}`
    );
  });

  bot.command("model", async (ctx) => {
    const state = getState(ctx);
    const provider = state.activeProvider;
    const current = state.models[provider] ?? "default";
    const keyboard = new InlineKeyboard();
    for (const choice of getModels(provider)) {
      const mark = choice.id === current ? "✓ " : "";
      keyboard.text(`${mark}${choice.label}`, `model:${choice.id}`).row();
    }
    await ctx.reply(`Select a model for ${activeProviderName(state)}:`, {
      reply_markup: keyboard,
    });
  });

  bot.callbackQuery(MODEL_CALLBACK_RE, async (ctx) => {
    const chosen = ctx.match?.[1] as string;
    const state = getState(ctx);
    const provider = state.activeProvider;
    const choice = getModels(provider).find((m) => m.id === chosen);
    if (!choice) {
      await ctx.answerCallbackQuery({ text: "Unknown model" });
      return;
    }
    setModel(state, provider, chosen);
    await ctx.answerCallbackQuery({ text: `Model: ${choice.label}` });
    await ctx.editMessageText(
      `${activeProviderName(state)} model: ${choice.label}. Applies to your next message.`
    );
  });

  bot.command("effort", async (ctx) => {
    const state = getState(ctx);
    const provider = state.activeProvider;
    const defaultId = getDefaultEffort(provider);
    const current = state.efforts[provider] ?? defaultId;
    const keyboard = new InlineKeyboard();
    for (const choice of getEffortLevels(provider)) {
      const mark = choice.id === current ? "✓ " : "";
      const label =
        choice.id === defaultId ? `${choice.label} (default)` : choice.label;
      keyboard.text(`${mark}${label}`, `effort:${choice.id}`).row();
    }
    await ctx.reply(
      `Select reasoning effort for ${activeProviderName(state)}:`,
      {
        reply_markup: keyboard,
      }
    );
  });

  bot.callbackQuery(EFFORT_CALLBACK_RE, async (ctx) => {
    const chosen = ctx.match?.[1] as string;
    const state = getState(ctx);
    const provider = state.activeProvider;
    const choice = getEffortLevels(provider).find((e) => e.id === chosen);
    if (!choice) {
      await ctx.answerCallbackQuery({ text: "Unknown effort level" });
      return;
    }
    setEffort(state, provider, chosen);
    await ctx.answerCallbackQuery({ text: `Effort: ${choice.label}` });
    await ctx.editMessageText(
      `${activeProviderName(state)} reasoning effort: ${choice.label}. Applies to your next message.`
    );
  });
};

/** /stop, /status and /help. */
export const registerControlCommands = ({ bot, projectsDir }: HandlerDeps) => {
  bot.command("stop", async (ctx) => {
    const state = getState(ctx);
    const stopped = stopAgent(state, "stopped");
    const hadQueue = state.queue.length > 0;
    state.queue = [];
    state.pendingPlan = undefined;
    clearComposeMessages(state);
    await cleanupQueueStatus(state, ctx);
    await cleanupComposeStatus(state, ctx);
    const msg = stopped
      ? `Process stopped.${hadQueue ? " Queue cleared." : ""}`
      : "No active process.";
    await ctx.reply(msg, { reply_markup: mainKeyboard });
  });

  bot.command("status", async (ctx) => {
    const state = getState(ctx);
    const project = describeProject(state.activeProject, projectsDir);
    const running = hasActiveProcess(state) ? "Yes" : "No";
    const sessionCount = await runtime.runPromise(
      countSessions(state.activeProvider)
    );
    const branch =
      state.activeProject && state.activeProject !== projectsDir
        ? getCurrentBranch(state.activeProject)
        : null;
    const branchLine = branch ? `\nBranch: ${branch}` : "";
    const queueLine =
      state.queue.length > 0 ? `\nQueued: ${state.queue.length}` : "";
    const composeLine = state.composeMessages
      ? `\nComposing: ${state.composeMessages.length} messages`
      : "";
    const provider = state.activeProvider;
    const modelId = state.models[provider] ?? "default";
    const modelLabel =
      getModels(provider).find((m) => m.id === modelId)?.label ?? modelId;
    const effortId = state.efforts[provider] ?? getDefaultEffort(provider);
    const effortLabel =
      getEffortLevels(provider).find((e) => e.id === effortId)?.label ??
      effortId;

    await ctx.reply(
      `Provider: ${activeProviderName(state)}\nModel: ${modelLabel} · Effort: ${effortLabel}\nProject: ${project}\nRunning: ${running}\nSessions: ${sessionCount}\nVerbosity: ${currentVerbosity()}${branchLine}${queueLine}${composeLine}`,
      { reply_markup: mainKeyboard }
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      [
        "<b>Commands:</b>",
        "/projects — switch active project",
        "/provider — switch coding agent provider",
        "/model — switch model for the active provider",
        "/effort — switch reasoning effort for the active provider",
        "/history — resume a past session",
        "/new — start fresh conversation",
        "/compact — summarize the current session and keep it",
        "/stop — kill active process",
        "/status — show current state",
        "/verbose — toggle tool calls, thinking and the footer",
        "/branch — show current git branch",
        "/pr — list open pull requests",
        "/compose — start collecting messages",
        "/send — send composed messages",
        "/cancel — cancel compose mode",
        "/help — show this message",
        "",
        "Send any text or voice message to chat with the active coding agent in the active project.",
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: mainKeyboard }
    );
  });
};

/**
 * How a finished compaction reads. Token counts are only quoted when the
 * provider reported both sides of the boundary; otherwise the reply just says
 * it finished, rather than implying a number it does not have.
 */
const describeCompaction = (
  event: Extract<CompactEvent, { kind: "compact_done" }>
) => {
  const before = event.preTokens;
  const after = event.postTokens;
  const numbers =
    before === undefined || after === undefined
      ? ""
      : ` Context: ${before.toLocaleString("en-US")} → ${after.toLocaleString("en-US")} tokens.`;
  return `Compaction finished.${numbers} Same session — your next message continues it.`;
};

/** Session lifecycle: /new and /compact. */
export const registerSessionLifecycle = (
  { bot, projectsDir }: HandlerDeps,
  { drainQueuedMessages }: RunPipeline
) => {
  bot.command("new", async (ctx) => {
    const state = getState(ctx);
    if (!state.activeProject) {
      setRouteProject(state, projectsDir);
    }
    // Interrupt this conversation's in-flight run first: otherwise its
    // session_init/result tap would re-persist the session id right after we
    // clear it, so /new would fail to start a fresh conversation.
    stopAgent(state, "stopped");
    await forgetSession(state);
    state.queue = [];
    state.pendingPlan = undefined;
    clearComposeMessages(state);
    await cleanupQueueStatus(state, ctx);
    await cleanupComposeStatus(state, ctx);
    await ctx.reply(
      "Session cleared. Next message starts a fresh conversation.",
      { reply_markup: mainKeyboard }
    );
  });

  bot.command("compact", async (ctx) => {
    const state = getState(ctx);
    const provider = state.activeProvider;
    if (!supportsCompaction(provider)) {
      await ctx.reply(
        `${activeProviderName(state)} cannot compact a session. Use /new to start a fresh conversation.`,
        { reply_markup: mainKeyboard }
      );
      return;
    }

    const project = state.activeProject;
    const sessionId = project ? await resolveSessionId(state) : undefined;
    if (!(project && sessionId)) {
      await ctx.reply("No session to compact yet. Send a message first.", {
        reply_markup: mainKeyboard,
      });
      return;
    }

    // Compaction rewrites the session, so it must not run underneath a live
    // turn: interrupt one first, exactly as /new does.
    const stopped = stopAgent(state, "stopped");
    const note = stopped ? "Stopped the run in progress first. " : "";
    const status = await ctx.reply(
      `Compacting ${describeProject(project, projectsDir)}...`
    );

    let outcome: CompactEvent;
    try {
      outcome = await compactAgent(provider, {
        userId: state.userId,
        // Compaction carries no user turn; the provider supplies its own input.
        prompt: "",
        projectDir: project,
        chatId: state.chatId,
        threadId: state.threadId,
        sessionId,
      });
    } catch (e) {
      outcome = {
        kind: "compact_failed",
        reason: e instanceof Error ? e.message : "unknown error",
      };
    }
    const text =
      outcome.kind === "compact_done"
        ? describeCompaction(outcome)
        : `Compaction did not run: ${outcome.reason}\nThe session is unchanged.`;
    await ctx.api
      .editMessageText(state.chatId, status.message_id, `${note}${text}`)
      .catch(swallow);
    await drainQueuedMessages(state);
  });
};
