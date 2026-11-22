import { supportsCompaction } from "@workspace/agent";
import type { CompactEvent } from "@workspace/agent/types";

import { accessOf } from "../access/context";
import type { BotContext } from "../access/context";
import { runAccessFor } from "../access/run-access";
import { isOperator } from "../access/tier";
import {
  carrySessionContext,
  clearSessionContext,
  succeedSession,
} from "../db/bridge";
import { t } from "../i18n";
import { logError } from "../log";
import { loadPersona } from "../persona";
import { forgetPark } from "../runs/continuation";
import { AGENTS_STOP_RE, isLiveAgentStatus } from "../telegram/agent-status";
import { tgBestEffort } from "../telegram/bridge";
import { kiloTokens } from "../telegram/format";
import { projectPathOr } from "../work-dir";
import { compactRun, isWaiting, stopRun } from "./agent-bridge";
import type { HandlerDeps, RunPipeline } from "./deps";
import {
  CONTEXT_COMPACT_RE,
  CONTEXT_NEW_RE,
  getUserId,
  logRejection,
  removedKeyboard,
  requireChat,
  swallow,
} from "./helpers";
import { startOnDefault } from "./provider";
import { routeProvider, routeStateFor } from "./route-provider";
import {
  adoptSession,
  forgetSession,
  resolveSessionId,
  resolveThreadPick,
  routeView,
} from "./session-routing";
import {
  cleanupComposeStatus,
  cleanupQueueStatus,
  notifyQueuedProcessing,
} from "./status";
import {
  cancelPendingStart,
  clearComposeMessages,
  getState,
} from "./user-state";
import type { UserState } from "./user-state";

/** Stable Telegram ids exposed at the boundary where Telegram supplies them. */
const startIdentityFooter = (input: {
  access: ReturnType<typeof accessOf>;
  chatId: number;
  userId: number;
}) => {
  const copy = t().session.start;
  if (input.access.surface !== "private") {
    return copy.groupId(input.chatId);
  }
  return input.access.tier === "guest"
    ? copy.guestId(input.userId)
    : copy.userId(input.userId);
};

/** The success copy, with how far the context shrank when both sizes are known. */
const doneText = (outcome: Extract<CompactEvent, { kind: "compact_done" }>) => {
  const copy = t().session.compact;
  const { postTokens, preTokens } = outcome;
  return preTokens === undefined || postTokens === undefined
    ? copy.done
    : `${copy.done} ${copy.context(kiloTokens(preTokens), kiloTokens(postTokens))}`;
};

/** What `/new` answers: where the new conversation starts. */
const newStartedText = (start: Awaited<ReturnType<typeof startOnDefault>>) => {
  const copy = t().session;
  switch (start.kind) {
    case "down": {
      return copy.newDefaultDown(start.name);
    }
    case "moved": {
      // The private chat's conversation on that provider is the executors'
      // too; `/provider` warns the same way.
      return start.privateChat
        ? `${copy.newStartedOn(start.name)} ${t().provider.menu.executorsToo(start.name)}`
        : copy.newStartedOn(start.name);
    }
    case "shared": {
      return copy.newShared;
    }
    case "stayed": {
      return copy.newStarted;
    }
    default: {
      return copy.newStarted;
    }
  }
};

/**
 * `/stop`: stop the run in the caller's slot and drop everything queued
 * behind it. Answers what the chat is told.
 */
const stopConversation = async (ctx: BotContext) => {
  const state = await getState(ctx);
  // A run still getting ready (waiting on PDF text) is not registered yet,
  // but the drain loop already owns the conversation: it is stopped too.
  const stopped = stopRun(state, "stopped") || state.draining;
  cancelPendingStart(state);
  // A wake-up the bot would resume this conversation for is dropped too.
  forgetPark(state);
  const hadQueue = state.queue.length + (state.parkedQueue?.length ?? 0) > 0;
  state.queue = [];
  state.parkedQueue = undefined;
  state.steered = [];
  state.pendingPlan = undefined;
  await clearComposeMessages(state);
  await cleanupQueueStatus(state, ctx);
  await cleanupComposeStatus(state, ctx);
  const copy = t().session.stop;
  return stopped
    ? `${copy.stopped}${hadQueue ? ` ${copy.queueCleared}` : ""}`
    : copy.idle;
};

/**
 * `/new` and `/compact` write the session pointer of the conversation they run
 * in, which outside a topic is the machine-wide one the owner's runs resume. A
 * sandboxed caller has no session of their own to reset there.
 */
const maySteerSession = (ctx: BotContext) => isOperator(accessOf(ctx).tier);

/**
 * `/context`'s buttons act on the conversation of the user it was sent to,
 * so only they may press them; the command's own check then runs as typed.
 */
const contextButton =
  (act: (ctx: BotContext) => Promise<void>) => async (ctx: BotContext) => {
    if (ctx.from?.id !== Number(ctx.match?.[1] ?? "")) {
      await ctx.answerCallbackQuery({ text: t().notYourButton });
      return;
    }
    await ctx.answerCallbackQuery();
    // Pressed once: the figure above is about to change.
    await ctx.editMessageReplyMarkup().catch(logRejection("context buttons"));
    await act(ctx);
  };

/** `/new`, typed or pressed under `/context`. */
const startNew = async (ctx: BotContext) => {
  if (!maySteerSession(ctx)) {
    await ctx.reply(t().notForYou, { reply_markup: removedKeyboard });
    return;
  }
  const state = await getState(ctx);
  // Interrupt any in-flight run first: its session_init/result tap would
  // otherwise re-persist the session id right after we clear it. In a topic
  // this resets that topic alone.
  // A run parked on background work already answered: it ends quietly.
  stopRun(state, isWaiting(state) ? "replaced" : "stopped");
  cancelPendingStart(state);
  // Emptied before the first await: the stopped run settles meanwhile and
  // must find nothing to give back or drain onto the fresh session.
  state.queue = [];
  state.parkedQueue = undefined;
  state.steered = [];
  const route = await routeProvider({ access: accessOf(ctx), state });
  await forgetSession(routeView(state, route.provider));
  state.unpicked = undefined;
  // A new conversation starts on the caller's default provider.
  const start = await startOnDefault({ ctx, route, state });
  state.pendingPlan = undefined;
  await clearComposeMessages(state);
  await cleanupQueueStatus(state, ctx);
  await cleanupComposeStatus(state, ctx);
  await ctx.reply(newStartedText(start), { reply_markup: removedKeyboard });
};

export const registerSessionCommands = (
  { bot, pendingWork }: HandlerDeps,
  pipeline: RunPipeline
) => {
  /**
   * Process whatever queued while compaction held the user's single process
   * slot: the messages parked before it started, then the ones that arrived
   * during it. The prompt path drains its own queue at the end of runAndDrain,
   * so without this those messages would wait for the next prompt.
   */
  const drainQueuedMessages = async (state: UserState) => {
    const parked = state.parkedQueue ?? [];
    state.parkedQueue = undefined;
    state.queue = [...parked, ...state.queue];
    const next = state.queue.shift();
    if (!next) {
      return;
    }
    if (state.queue.length === 0) {
      await cleanupQueueStatus(state, next.ctx);
    }
    await notifyQueuedProcessing(next.ctx, next.prompt, state);
    pipeline
      .runAndDrain(next.ctx, next.prompt, state, next.routing)
      .catch(logRejection("queue drain"));
  };

  bot.command("start", async (ctx) => {
    const access = accessOf(ctx);
    const footer = startIdentityFooter({
      access,
      chatId: requireChat(ctx),
      userId: getUserId(ctx),
    });
    await ctx.reply(
      `${t().session.start.lines(isOperator(access.tier)).join("\n")}\n\n${footer}`,
      {
        parse_mode: "HTML",
        reply_markup: removedKeyboard,
      }
    );
  });

  bot.command("stop", async (ctx) => {
    await ctx.reply(await stopConversation(ctx), {
      reply_markup: removedKeyboard,
    });
  });

  // The stop button of a run's sub-agent status: `/stop`, for the run's own
  // user only.
  bot.callbackQuery(AGENTS_STOP_RE, async (ctx) => {
    if (ctx.from.id !== Number(ctx.match[1])) {
      await ctx.answerCallbackQuery({ text: t().notYourButton });
      return;
    }
    // A finished status whose summary edit failed keeps its button, and
    // must not stop a later run.
    const { message } = ctx.callbackQuery;
    if (
      message === undefined ||
      !isLiveAgentStatus(message.chat.id, message.message_id)
    ) {
      await ctx.answerCallbackQuery({ text: t().session.stop.idle });
      await ctx.editMessageReplyMarkup().catch(swallow);
      return;
    }
    await ctx.answerCallbackQuery({ text: await stopConversation(ctx) });
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      t()
        .session.help(isOperator(accessOf(ctx).tier))
        .join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: removedKeyboard,
      }
    );
  });

  /** `/compact`, typed or pressed under `/context`. */
  const compactNow = async (ctx: BotContext) => {
    if (!maySteerSession(ctx)) {
      await ctx.reply(t().notForYou, { reply_markup: removedKeyboard });
      return;
    }
    const state = await getState(ctx);
    // Already compacting: a second would replay the session underneath the
    // first and drop the queue the first parked (a stale «Sum up» press).
    if (state.parkedQueue !== undefined) {
      await ctx.reply(t().session.compact.working, {
        reply_markup: removedKeyboard,
      });
      return;
    }
    const conversation = await routeStateFor(ctx, state);
    const provider = conversation.activeProvider;
    if (!supportsCompaction(provider)) {
      await ctx.reply(t().session.compact.unsupported, {
        reply_markup: removedKeyboard,
      });
      return;
    }

    const project = projectPathOr(state.activeProject);
    const sessionId = await resolveSessionId(conversation);
    // Compaction is a turn of this conversation, so it runs on the model this
    // conversation was routed to rather than routing a summary of its own.
    const pick = await resolveThreadPick(conversation);
    if (sessionId === undefined) {
      await ctx.reply(t().session.compact.nothing, {
        reply_markup: removedKeyboard,
      });
      return;
    }

    // Compaction replays the session it summarizes, so it must not run
    // underneath a live turn: interrupt one first, exactly as /new does. The
    // queue moves out of reach in the same tick, or the interrupted run would
    // drain it and start a prompt on top of the compaction.
    state.parkedQueue = state.queue;
    state.queue = [];
    // A plan presented before compaction carries the old session id, which the
    // next message would write back over the compacted one.
    state.pendingPlan = undefined;
    // A run parked on background work already answered: it ends quietly.
    const parked = isWaiting(state);
    const stopped = stopRun(state, parked ? "replaced" : "stopped");
    cancelPendingStart(state);
    const copy = t().session.compact;
    const note = stopped && !parked ? `${copy.stoppedFirst} ` : "";
    const status = await ctx.reply(copy.working);

    /**
     * Compaction is two model turns, minutes of them at high effort. grammy
     * handles updates one at a time, so awaiting it in the handler would hold
     * off every later update — /stop included — until it finished.
     */
    const reportCompaction = async () => {
      let outcome: CompactEvent;
      try {
        outcome = await compactRun(provider, {
          access: runAccessFor(accessOf(ctx)).agent,
          chatId: state.chatId,
          effort: pick.effort,
          model: pick.model,
          persona: await loadPersona(),
          projectDir: project,
          // Compaction carries no user turn; the provider supplies its own input.
          prompt: "",
          sessionId,
          threadId: state.threadId,
          userId: state.userId,
        });
      } catch (error) {
        outcome = {
          kind: "compact_failed",
          reason: error instanceof Error ? error.message : "unknown error",
        };
      }

      if (outcome.kind === "compact_done") {
        // A topic owns its session, so the compacted one is recorded here
        // rather than by the agent package's per-project store.
        await adoptSession(conversation, outcome.sessionId);
        // `/context` shows what the summary left when the compaction
        // measured it, else nothing until the next answer does: the
        // figure from before no longer holds.
        const { contextTokens } = outcome;
        await (
          contextTokens === undefined
            ? clearSessionContext({ provider, sessionId: outcome.sessionId })
            : carrySessionContext({
                from: sessionId,
                provider,
                to: outcome.sessionId,
                usedTokens: contextTokens,
              })
        ).catch(logRejection("compact context"));
        // A compaction that started a fresh session (Codex) continues the
        // conversation: `/history` lists it once, under the new id.
        if (outcome.sessionId !== sessionId) {
          await succeedSession({
            from: sessionId,
            provider,
            reason: "compact",
            to: outcome.sessionId,
          }).catch(logRejection("compact history"));
        }
      } else {
        logError(`compaction failed: ${outcome.reason}`);
      }
      const text =
        outcome.kind === "compact_done" ? doneText(outcome) : copy.failed;
      const chatId = requireChat(ctx);
      await tgBestEffort(
        "editMessageText",
        async (api) =>
          await api.editMessageText(
            chatId,
            status.message_id,
            `${note}${text}`
          ),
        { retry: "all" }
      );
      await drainQueuedMessages(state);
    };

    pendingWork.track(reportCompaction()).catch(logRejection("compact"));
  };

  bot.command("new", startNew);
  bot.command("compact", compactNow);

  bot.callbackQuery(CONTEXT_COMPACT_RE, contextButton(compactNow));
  bot.callbackQuery(CONTEXT_NEW_RE, contextButton(startNew));
};
