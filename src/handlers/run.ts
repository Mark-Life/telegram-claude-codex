import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { Effect } from "effect";
import type { Context } from "grammy";
import {
  getCapabilities,
  hasActiveProcess,
  runAgent,
  stopAgent,
} from "../agent";
import { classifyOutcome, runOutcomeOf } from "../agent/errors";
import { getCurrentBranch } from "../git";
import {
  clipError,
  Observability,
  RUN_EVENT_MARKER,
  RunEvent,
} from "../observability";
import { runtime } from "../runtime";
import { type StreamResult, streamToTelegram } from "../telegram";
import type { HandlerDeps, PresentPlan, RunPipeline } from "./deps";
import {
  buildPromptWithReplyContext,
  CLEAR_QUEUE_RE,
  cleanupQueueStatus,
  describeProject,
  FORCE_SEND_RE,
  mainKeyboard,
  notifyQueuedProcessing,
  sendOrUpdateQueueStatus,
  swallow,
} from "./helpers";
import {
  adoptSession,
  pinTopicIfNew,
  rememberRunSession,
  resolveSessionId,
  setRouteProject,
} from "./session-routing";
import { titleImplicitTopic } from "./topic-titles";
import { activePendingPlan, getState, type UserState } from "./user-state";
import { currentRenderPolicy } from "./verbosity";

/** Read package.json once at load to stamp a version onto every wide event. */
const readVersion = () => {
  try {
    const path = join(import.meta.dir, "..", "..", "package.json");
    const raw = readFileSync(path, "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
};

/** App version stamped onto every wide event. */
const VERSION = readVersion();

/** Mutable outcome/economics accumulator for a single prompt run. */
interface RunRecord {
  costUsd: number | null;
  durationMs: number | null;
  errorClass?: string;
  errorMessage?: string;
  outcome:
    | "done"
    | "errored"
    | "interrupted"
    | "timeout"
    | "already_running"
    | "at_capacity";
  sessionId: string | null;
  totalTokens: number | null;
  turns: number | null;
}

/** Immutable per-run context captured before streaming starts. */
interface RunEventMeta {
  project: string;
  promptChars: number;
  provider: string;
  queueDepth: number;
  runId: string;
  userId: number;
}

/**
 * Fold a completed stream result into the run record: economics are populated
 * only when the provider reported them, and an in-stream error (surfaced on the
 * result rather than thrown) is mapped to its outcome, nulling economics on any
 * degraded (non-errored) outcome.
 */
const applyResultEconomics = (result: StreamResult, rec: RunRecord) => {
  rec.costUsd = result.cost ?? null;
  rec.turns = result.turns ?? null;
  rec.totalTokens = result.totalTokens ?? null;
  rec.durationMs = result.durationMs ?? null;
  if (!result.errorClass) {
    return;
  }
  rec.outcome = runOutcomeOf(result.errorClass);
  if (rec.outcome === "errored") {
    rec.errorClass = result.errorClass._tag;
    rec.errorMessage = clipError(classifyOutcome(result.errorClass).copy);
  } else {
    rec.costUsd = null;
    rec.turns = null;
    rec.totalTokens = null;
    rec.durationMs = null;
  }
};

/**
 * Emit the single wide event for a run. NULLs economics on any non-terminal
 * outcome, then bridges into the Effect runtime; a rejected bridge is swallowed
 * so observability can never break a user's chat.
 */
const emitRunEvent = async (rec: RunRecord, meta: RunEventMeta) => {
  if (rec.outcome !== "done" && rec.outcome !== "errored") {
    rec.costUsd = null;
    rec.turns = null;
    rec.totalTokens = null;
    rec.durationMs = null;
  }
  try {
    // RunEvent construction validates synchronously and can throw; keep it
    // inside the guard so the emit is fully best-effort on every path.
    const evt = new RunEvent({
      ts: new Date().toISOString(),
      event: RUN_EVENT_MARKER,
      runId: meta.runId,
      userId: meta.userId,
      provider: meta.provider,
      project: meta.project,
      sessionId: rec.sessionId,
      promptChars: meta.promptChars,
      outcome: rec.outcome,
      costUsd: rec.costUsd,
      turns: rec.turns,
      totalTokens: rec.totalTokens,
      durationMs: rec.durationMs,
      queueDepth: meta.queueDepth,
      errorClass: rec.errorClass,
      errorMessage: rec.errorMessage,
      version: VERSION,
      host: hostname(),
    });
    await runtime.runPromise(
      Effect.flatMap(Observability, (o) => o.recordRun(evt))
    );
  } catch {
    // swallow: observability is best-effort and must never break a chat
  }
};

/**
 * Build the prompt pipeline. `presentPlan` is injected so plan-mode UI can call
 * back into the runner without the two modules importing each other.
 */
export const createRunPipeline = (
  { projectsDir }: HandlerDeps,
  presentPlan: PresentPlan
): RunPipeline => {
  /** Run one prompt to completion; returns true if a plan was presented (halts draining) */
  const runSinglePrompt = async (
    ctx: Context,
    prompt: string,
    state: UserState
  ) => {
    const sessionId = await resolveSessionId(state);
    const projectName =
      state.activeProject === projectsDir
        ? "general"
        : basename(state.activeProject);
    const branchName =
      state.activeProject !== projectsDir
        ? getCurrentBranch(state.activeProject)
        : null;

    // Wide-event context captured up front so every return path emits once.
    const provider = state.activeProvider;
    const project = state.activeProject;
    const route = { chatId: state.chatId, threadId: state.threadId };
    const meta: RunEventMeta = {
      runId: crypto.randomUUID(),
      userId: state.userId,
      provider,
      project,
      promptChars: prompt.length,
      queueDepth: state.queue.length,
    };

    const rec: RunRecord = {
      outcome: "done",
      costUsd: null,
      turns: null,
      totalTokens: null,
      durationMs: null,
      sessionId: sessionId ?? null,
    };
    let presentedPlan = false;

    try {
      const events = runAgent(provider, {
        userId: state.userId,
        prompt,
        projectDir: project,
        chatId: route.chatId,
        threadId: route.threadId,
        sessionId,
        model: state.models[provider],
        effort: state.efforts[provider],
      });
      const result = await streamToTelegram({
        ctx,
        events,
        projectName,
        capabilities: getCapabilities(provider),
        policy: currentRenderPolicy(),
        route,
        branchName,
        // A topic's session id lives on its thread row, so it is recorded here
        // rather than by the runner's project-wide tap.
        onSessionInit: (id) => rememberRunSession(state, id),
      });
      if (result.sessionId) {
        rec.sessionId = result.sessionId;
        rememberRunSession(state, result.sessionId);
      }
      applyResultEconomics(result, rec);

      if (result.planPath && getCapabilities(provider).planMode) {
        stopAgent(state, "stopped");
        await presentPlan(ctx, state, result);
        presentedPlan = true;
      }
    } catch (e) {
      rec.outcome = "errored";
      rec.errorClass =
        (e as { _tag?: string })?._tag ??
        (e as Error)?.name ??
        "ProviderCrashed";
      rec.errorMessage = clipError(String((e as Error)?.message ?? e));
      console.error("runAndDrain error:", e);
    } finally {
      await emitRunEvent(rec, meta);
    }
    return presentedPlan;
  };

  /** Run an agent prompt and drain any queued messages afterward */
  const runAndDrain = async (
    ctx: Context,
    prompt: string,
    state: UserState
  ) => {
    let currentCtx = ctx;
    let currentPrompt = prompt;
    while (true) {
      const presentedPlan = await runSinglePrompt(
        currentCtx,
        currentPrompt,
        state
      );
      if (presentedPlan) {
        return;
      }
      const next = state.queue.shift();
      if (!next) {
        break;
      }
      currentPrompt = next.prompt;
      currentCtx = next.ctx;
      if (state.queue.length === 0) {
        await cleanupQueueStatus(state, currentCtx);
      }
      await notifyQueuedProcessing(currentCtx, currentPrompt, state);
    }
  };

  /** Send a prompt to the active provider and stream the response */
  const handlePrompt = async (ctx: Context, prompt: string) => {
    const state = getState(ctx);

    if (!state.activeProject) {
      setRouteProject(state, projectsDir);
      await ctx.reply("No project selected. Using General (all projects).", {
        reply_markup: mainKeyboard,
      });
    }

    // A topic used for the first time inherits the global default project, so
    // say which one it just took: quiet mode drops the footer that named it.
    if (pinTopicIfNew(state)) {
      await ctx
        .reply(
          `Topic pinned to ${describeProject(state.activeProject, projectsDir)}. /projects to change.`
        )
        .catch(swallow);
    }

    const pendingPlan = activePendingPlan(state);
    if (pendingPlan) {
      const plan = pendingPlan;
      setRouteProject(state, plan.projectPath);
      if (plan.sessionId) {
        await adoptSession(state, plan.sessionId);
      }
      state.pendingPlan = undefined;
      const feedbackPrompt = `Plan feedback from user: ${prompt}\n\nRevise the plan based on this feedback. Do not execute yet — present the updated plan.`;
      await runAndDrain(ctx, feedbackPrompt, state);
      return;
    }

    // Only this conversation's run blocks: a sibling topic runs in parallel.
    if (hasActiveProcess(state)) {
      state.queue.push({ prompt, ctx });
      await sendOrUpdateQueueStatus(ctx, state);
      return;
    }

    await runAndDrain(ctx, prompt, state);
  };

  /**
   * Process whatever queued up while compaction held the user's single process
   * slot. The prompt path drains its own queue at the end of runAndDrain, so
   * without this those messages would wait for the next prompt.
   */
  const drainQueuedMessages = async (state: UserState) => {
    const next = state.queue.shift();
    if (!next) {
      return;
    }
    if (state.queue.length === 0) {
      await cleanupQueueStatus(state, next.ctx);
    }
    await notifyQueuedProcessing(next.ctx, next.prompt, state);
    runAndDrain(next.ctx, next.prompt, state).catch((e) =>
      console.error("queue drain error:", e)
    );
  };

  return { drainQueuedMessages, handlePrompt, runAndDrain };
};

/** Force-send and clear-queue buttons on the "message queued" status message. */
export const registerQueueCallbacks = ({ bot }: HandlerDeps) => {
  bot.callbackQuery(FORCE_SEND_RE, async (ctx) => {
    const stopped = stopAgent(getState(ctx), "new_prompt");
    await ctx.answerCallbackQuery({
      text: stopped ? "Stopping current task..." : "No active process",
    });
  });

  bot.callbackQuery(CLEAR_QUEUE_RE, async (ctx) => {
    const state = getState(ctx);
    const count = state.queue.length;
    state.queue = [];
    await cleanupQueueStatus(state, ctx);
    await ctx.answerCallbackQuery({
      text:
        count > 0 ? `Cleared ${count} queued message(s).` : "Queue is empty.",
    });
  });
};

/** Plain text messages: the main prompt entry point. */
export const registerTextHandler = (
  { bot, botId, projectsDir }: HandlerDeps,
  { handlePrompt }: RunPipeline
) => {
  bot.on("message:text", (ctx) => {
    const state = getState(ctx);
    // Fired, not awaited: a topic rename must never hold up the prompt.
    titleImplicitTopic({
      content: ctx.message.text,
      ctx,
      provider: state.activeProvider,
      workingDirectory: state.activeProject || projectsDir,
    }).catch(swallow);
    const prompt = buildPromptWithReplyContext(ctx, ctx.message.text, botId);
    handlePrompt(ctx, prompt).catch((e) =>
      console.error("handlePrompt error:", e)
    );
  });
};
