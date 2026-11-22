import { getCapabilities, isReplaced, isRestartCut } from "@workspace/agent";
import { clipError, errorClassOf } from "@workspace/core/errors";
import { Cause, Effect, Exit, Option } from "effect";

import { accessOf } from "../access/context";
import type { AccessInfo, BotContext } from "../access/context";
import { providerFor } from "../access/provider-access";
import { runAccessFor, taskStampFor } from "../access/run-access";
import { readToggle } from "../bot-settings";
import { recordGroupMemory } from "../db/bridge";
import { t } from "../i18n";
import { logInfo } from "../log";
import { loadPersona } from "../persona";
import {
  carriedContinuation,
  forgetPark,
  recordPark,
} from "../runs/continuation";
import { pendingRunMeta, runDirOf, startPromptRun } from "../runs/start-run";
import { tgBestEffort } from "../telegram/bridge";
import { errorCopy } from "../telegram/errors";
import type { StreamResult } from "../telegram/format";
import { QUIET_POLICY } from "../telegram/render-policy";
import { requireRoute } from "../telegram/route";
import { streamToTelegram } from "../telegram/stream";
import {
  isRunning,
  isWaiting,
  retireRun,
  reprobeInBackground,
  runAgentProgram,
  steerRun,
} from "./agent-bridge";
import type {
  HandlerDeps,
  PresentPlan,
  PromptRouting,
  RunOrigin,
  RunPipeline,
} from "./deps";
import { logRejection, swallow } from "./helpers";
import {
  hasPendingPdfText,
  settlePdfTexts,
  withoutMissingPdfTexts,
} from "./pdf-text";
import { chargePrivateRun } from "./private-quota";
import { routeProvider, routeSwitchCount } from "./route-provider";
import { applyResultEconomics, recordRunEvent } from "./run-event";
import type { RunRecord } from "./run-event";
import {
  adoptSession,
  rememberRunSession,
  routeView,
  setRouteProject,
  storeRunSession,
} from "./session-routing";
import type { RouteState, RunDir } from "./session-routing";
import {
  cleanupQueueStatus,
  notifyQueuedProcessing,
  sendOrUpdateQueueStatus,
} from "./status";
import { activePendingPlan, getState } from "./user-state";
import type { QueuedMessage, UserState } from "./user-state";
import { currentRenderPolicy } from "./verbosity";

/**
 * Keep the bot's own answer in a group's memory, so a later question in that
 * chat can be answered from what was already said.
 */
const rememberGroupAnswer = async (
  access: AccessInfo,
  state: UserState,
  result: StreamResult
) => {
  if (
    access.surface !== "group" ||
    result.messageId === undefined ||
    result.text === undefined ||
    result.text.length === 0
  ) {
    return;
  }
  const { callName } = await loadPersona();
  await recordGroupMemory({
    chatId: state.chatId,
    createdAt: Date.now(),
    from: callName,
    messageId: result.messageId,
    text: result.text,
  });
};

/** Where an update's run comes from: its sender, its chat, its replies. */
const originOf = (ctx: BotContext): RunOrigin => ({
  access: accessOf(ctx),
  continuation: 0,
  ctx,
  reply: async (text) => {
    await ctx.reply(text);
  },
  route: requireRoute(ctx),
});

/** The router reads the sender's own message; without one, the whole prompt. */
const routingOf = (prompt: string, routing?: PromptRouting): PromptRouting =>
  routing ?? { kind: "text", message: prompt };

/** Fold how the render ended into the run record, before it is emitted. */
const settleRecord = <A, E>(rec: RunRecord, exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) {
    return rec;
  }
  if (Cause.hasInterruptsOnly(exit.cause)) {
    rec.outcome = "interrupted";
    return rec;
  }
  const error = Cause.squash(exit.cause);
  rec.outcome = "errored";
  rec.errorClass = errorClassOf(error, "ProviderCrashed");
  rec.errorMessage = clipError(
    error instanceof Error ? error.message : String(error)
  );
  return rec;
};

/**
 * Whether a message sent while a run works may go into that run: outside a
 * group, with the `steer` switch on. A group run is a short light answer whose
 * prompt carries the chat's excerpt, so its messages queue. Read before the
 * running check, so that check and the queue push stay one synchronous step.
 * A failed read of the switch steers, the default.
 */
const maySteer = async (ctx: BotContext) => {
  if (accessOf(ctx).surface === "group") {
    return false;
  }
  try {
    return await readToggle("steer");
  } catch (error) {
    logRejection("Steer setting read failed")(error);
    return true;
  }
};

/** The reaction that tells the sender the running answer took their message. */
const STEERED_REACTION = "👀";

/**
 * Mark a message the run took: a reaction, so nothing new lands in the chat.
 * Where reactions are off, a short silent reply says it instead. Resolves true
 * when the reaction was set.
 */
const acknowledgeSteer = async (ctx: BotContext) => {
  const chatId = ctx.chat?.id;
  const messageId = ctx.message?.message_id;
  if (chatId === undefined) {
    return false;
  }
  // A composed batch arrives from a button press: no message to react to.
  if (messageId === undefined) {
    await ctx
      .reply(t().status.steered, { disable_notification: true })
      .catch(swallow);
    return false;
  }
  const reacted = await tgBestEffort(
    "setMessageReaction",
    async (api) =>
      await api.setMessageReaction(chatId, messageId, [
        { emoji: STEERED_REACTION, type: "emoji" },
      ]),
    { retry: false }
  );
  if (reacted === undefined) {
    await ctx
      .reply(t().status.steered, {
        disable_notification: true,
        reply_parameters: { message_id: messageId },
      })
      .catch(swallow);
    return false;
  }
  return true;
};

/** Steer one message into the run's list, its acknowledgement under way. */
const markSteered = (message: QueuedMessage) => {
  message.acknowledged = acknowledgeSteer(message.ctx);
  return message;
};

/**
 * Take the steered reaction back off a message the run never read: it runs
 * on its own, so it must not claim it joined the earlier task. Waits for the
 * acknowledgement, so a reaction still on its way is not left behind.
 */
const unmarkSteered = async (message: QueuedMessage) => {
  const { acknowledged } = message;
  delete message.acknowledged;
  const chatId = message.ctx.chat?.id;
  const messageId = message.ctx.message?.message_id;
  if (
    (await acknowledged) !== true ||
    chatId === undefined ||
    messageId === undefined
  ) {
    return;
  }
  await tgBestEffort(
    "setMessageReaction",
    async (api) => await api.setMessageReaction(chatId, messageId, []),
    { retry: false }
  );
};

/**
 * Give back what a finished run was handed and never took into its work: the
 * newest steered messages, ahead of the queue, or ahead of the parked queue
 * while a compaction holds the slot. One it took and then failed on stays
 * gone, like the prompt it joined, so nothing runs twice. Succeeds with how
 * many it took.
 */
const settleSteered = (state: UserState, unread: number) => {
  const handed = state.steered;
  state.steered = [];
  if (unread > 0) {
    const requeued = handed.slice(-unread);
    (state.parkedQueue ?? state.queue).unshift(...requeued);
    // Never rejects: the reaction call is best effort.
    void Promise.all(requeued.map(unmarkSteered));
  }
  return handed.length - Math.min(unread, handed.length);
};

/**
 * Whether the sender may still run on the whole machine: only such a run
 * parks, and a sender demoted since it started must not reach it.
 */
const holdsFullAccess = (ctx: BotContext) =>
  runAccessFor(accessOf(ctx)).agent.sandbox === "danger-full-access";

/**
 * Steer `prompt` into the running run, unless the run kept no pick (the
 * words must be routed, so they queue) or a PDF it carries is still turning
 * into text (its run waits for the text). A PDF that gave none loses its line.
 */
const steerable = (state: UserState, prompt: string) => {
  if (state.unpicked !== undefined) {
    // A run parked on background work already answered: it ends there, so
    // the queued words start at once rather than when that work is done.
    if (isWaiting(state)) {
      retireRun(state);
    }
    return false;
  }
  return (
    !hasPendingPdfText(prompt) &&
    steerRun(state, withoutMissingPdfTexts(prompt))
  );
};

/**
 * Hand a run that waits on background work the messages queued while it
 * worked, oldest first: nothing is working, so each is the next turn of the
 * same conversation, steer switch or not. Stops at the first it refuses.
 */
const steerQueued = async (state: UserState) => {
  const handed: UserState["queue"] = [];
  for (const queued of state.queue) {
    if (
      !(
        holdsFullAccess(queued.ctx) &&
        (queued.routing?.images ?? []).length === 0 &&
        steerable(state, queued.prompt)
      )
    ) {
      break;
    }
    handed.push(queued);
  }
  const last = handed.at(-1);
  if (last === undefined) {
    return;
  }
  // One synchronous step with the offers, so no handler sees them half moved.
  state.queue.splice(0, handed.length);
  state.steered.push(...handed.map(markSteered));
  logInfo(
    `[run] steered queued=${handed.length} user_id=${state.userId} chat_id=${state.chatId} thread_id=${state.threadId ?? "main"}`
  );
  if (state.queue.length === 0) {
    await cleanupQueueStatus(state, last.ctx);
  }
  await Promise.all(handed.map(async ({ acknowledged }) => await acknowledged));
};

/**
 * Build the prompt pipeline. `presentPlan` is injected so plan-mode UI can call
 * back into the runner without the two modules importing each other.
 */
export const createRunPipeline = (
  { ownerId, pendingWork, projectsDir }: HandlerDeps,
  presentPlan: PresentPlan
): RunPipeline => {
  /**
   * What happens in the chat once the run's events are rendered: group memory,
   * the session a topic owns, the economics and a plan to present. Resolves
   * true when a plan was presented (halts draining).
   */
  const afterRender = async (input: {
    origin: RunOrigin;
    persistSession: boolean;
    rec: RunRecord;
    result: StreamResult;
    runDir: RunDir;
    runState: RouteState;
    state: UserState;
  }) => {
    const { origin, persistSession, rec, result, runDir, runState, state } =
      input;
    const provider = runState.activeProvider;
    await rememberGroupAnswer(origin.access, state, result);
    if (
      result.sessionId !== undefined &&
      persistSession &&
      !isReplaced(result.errorClass)
    ) {
      // Outside a topic the runner's stream tap already persisted it; a topic
      // owns its session here. A replaced run's conversation has moved on.
      await rememberRunSession(runState, result.sessionId, runDir);
      rec.sessionId = result.sessionId;
    }
    applyResultEconomics(result, rec);
    if (
      result.planPath === undefined ||
      origin.ctx === undefined ||
      !getCapabilities(provider).planMode
    ) {
      return false;
    }
    // The event stream already ended on plan_ready and stopped its process.
    await presentPlan(origin.ctx, state, { ...result, provider });
    return true;
  };

  /** Run one prompt to completion; true when a plan was presented (halts draining). */
  const runSinglePromptOnce = async (
    origin: RunOrigin,
    prompt: string,
    state: UserState,
    routing: PromptRouting
  ) => {
    // Who asked, and from where, decides the sandbox, the Executor wiring and
    // whether this conversation is remembered at all.
    const { access, route } = origin;
    const granted = runAccessFor(access);
    const switchesBefore = routeSwitchCount(route);
    // The provider is resolved once, here: the whole run, its late session
    // write included, stays on it whatever `/provider` does meanwhile. A
    // switch before the start stops the run instead.
    const verdict = providerFor({
      access: granted.agent,
      route: await routeProvider({ access, state }),
      tier: access.tier,
    });
    if (!verdict.allowed) {
      await origin.reply(verdict.reply);
      origin.onSettle?.();
      origin.onDone?.({ refused: true });
      return false;
    }
    const decision = { ...granted, agent: verdict.access };
    const { persistSession } = decision.agent;
    const { provider } = verdict.route;
    const policy = decision.forceQuiet
      ? QUIET_POLICY
      : await currentRenderPolicy();

    // Recorded on every exit path; the start swaps in the registry's run id.
    const rec: RunRecord = {
      costUsd: null,
      durationMs: null,
      outcome: "done",
      sessionId: null,
      totalTokens: null,
      turns: null,
    };
    let meta = pendingRunMeta({ decision, prompt, provider, state });
    const persona = await loadPersona();
    // A run on a slot whose resume has not run yet takes the pending
    // background work along: a user's message, or a task fired into the
    // conversation. A resume itself (continuation 1 or more) is that work.
    let carried: string | undefined;
    if (
      origin.continuation === 0 &&
      decision.agent.sandbox === "danger-full-access"
    ) {
      try {
        carried = Option.getOrUndefined(
          await carriedContinuation(state, provider)
        );
      } catch (error) {
        logRejection("Carried continuation not read")(error);
      }
    }
    const runPrompt =
      carried === undefined
        ? prompt
        : `${carried}\n\nThen handle the new message:\n\n${prompt}`;
    // What this run is handed while it works, and how many of those it took.
    state.steered = [];
    let unread: (() => number) | undefined;
    // A parked run the restart cut keeps its record, so boot resumes it; so
    // does a run that found no free slot, which never took the work along.
    let keepsPark = false;
    // How the render ended, for a caller that waits on this run (`onDone`).
    let final: StreamResult | undefined;

    const program = Effect.gen(function* () {
      const run = yield* startPromptRun({
        decision,
        persona,
        projectsDir,
        prompt: runPrompt,
        provider,
        // A light run is on the light provider, which a switch never moves.
        routeSwitched: () =>
          verdict.route.source !== "light" &&
          routeSwitchCount(route) !== switchesBefore,
        routing,
        state,
        taskAuthor: taskStampFor({ tier: access.tier, userId: state.userId }),
      });
      ({ meta, unread } = run);
      rec.sessionId = run.sessionId ?? null;
      yield* Effect.annotateCurrentSpan("run.id", meta.runId);
      const result = yield* streamToTelegram({
        agentStatus: decision.forceQuiet ? undefined : { userId: state.userId },
        branchName: run.branchName,
        capabilities: getCapabilities(provider),
        events: run.events,
        onBackgroundWait: (parked) =>
          Effect.promise(async () => {
            await recordPark({
              origin,
              parked,
              projectPath: run.runDir.projectPath,
              provider,
              state,
            });
            origin.onSettle?.();
            await steerQueued(state);
          }),
        onSessionInit: persistSession
          ? (newSessionId) =>
              // The write runs alongside the stream; its failure is logged.
              storeRunSession(run.runState, newSessionId, run.runDir).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("run session not stored", cause)
                ),
                Effect.forkDetach,
                Effect.asVoid
              )
          : undefined,
        policy,
        projectName: run.projectName,
        route,
      });
      final = result;
      keepsPark =
        isRestartCut(result.errorClass) ||
        result.errorClass?._tag === "AtCapacity";
      return yield* Effect.promise(
        async () =>
          await afterRender({
            origin,
            persistSession,
            rec,
            result,
            runDir: run.runDir,
            runState: run.runState,
            state,
          })
      );
    }).pipe(
      // Stopped by a `/provider` switch before it started: told like a run
      // the switch stopped mid-answer.
      Effect.catchTag("AgentInterrupted", (error) => {
        rec.outcome = "interrupted";
        // The chat is told below, so a caller waiting on the run hears it.
        final ??= { errorClass: error };
        return Effect.tryPromise(async () => {
          await origin.reply(errorCopy(error));
        }).pipe(Effect.ignore, Effect.as(false));
      }),
      // One wide event per run, on every exit path, a failed start included.
      Effect.onExit((exit) => {
        const steered = settleSteered(state, unread?.() ?? 0);
        if (steered > 0) {
          rec.steered = steered;
        }
        const settled = settleRecord(rec, exit);
        // A logout after boot leaves the snapshot `ready`; a failed run checks
        // again, so the next message on a stored route (a topic row or
        // `owner_provider`) gets the refusal and its hint. A default route
        // keeps the ordinary error sentence.
        if (settled.outcome === "errored") {
          reprobeInBackground([provider]);
        }
        if (!keepsPark) {
          forgetPark(state);
        }
        origin.onSettle?.();
        origin.onDone?.({ provider, result: final });
        return recordRunEvent(settled, meta);
      }),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logError("run failed", cause).pipe(Effect.as(false))
      ),
      // The start, the render and the wide event, as one span per run.
      Effect.withSpan("Run.prompt", {
        attributes: {
          "run.model_class": decision.agent.modelClass,
          "run.provider": provider,
          "run.surface": access.surface,
          "run.user_id": state.userId,
        },
      })
    );
    return await runAgentProgram(program);
  };

  /**
   * `runSinglePromptOnce`, with its origin's `onDone` called exactly once
   * whatever happens: a caller waiting on it (a task fired into the
   * conversation) must never wait forever on a run that threw before it
   * started.
   */
  const runSinglePrompt = async (
    origin: RunOrigin,
    prompt: string,
    state: UserState,
    routing: PromptRouting
  ) => {
    let done = false;
    const once: RunOrigin["onDone"] = (outcome) => {
      if (!done) {
        done = true;
        origin.onDone?.(outcome);
      }
    };
    try {
      return await runSinglePromptOnce(
        { ...origin, onDone: once },
        prompt,
        state,
        routing
      );
    } finally {
      once({});
    }
  };

  /**
   * Run a prompt and then drain any messages queued while it was running.
   * `state.draining` is raised before the first await and lowered in the same
   * synchronous step that finds the queue empty, so no message can slip into a
   * queue nobody is draining.
   */
  const runAndDrainImpl = async (
    origin: RunOrigin,
    prompt: string,
    state: UserState,
    routing: PromptRouting
  ) => {
    state.draining = true;
    let currentOrigin = origin;
    let currentPrompt = prompt;
    let currentRouting = routing;
    try {
      while (true) {
        // oxlint-disable-next-line no-await-in-loop -- queued prompts run one at a time
        const presentedPlan = await runSinglePrompt(
          currentOrigin,
          currentPrompt,
          state,
          currentRouting
        );
        if (presentedPlan) {
          return;
        }
        const next = state.queue.shift();
        if (!next) {
          state.draining = false;
          break;
        }
        currentPrompt = next.prompt;
        currentOrigin = originOf(next.ctx);
        currentRouting = routingOf(next.prompt, next.routing);
        if (state.queue.length === 0) {
          // oxlint-disable-next-line no-await-in-loop -- the status edit belongs to this iteration
          await cleanupQueueStatus(state, next.ctx);
        }
        // oxlint-disable-next-line no-await-in-loop -- notify before the next prompt starts
        await notifyQueuedProcessing(next.ctx, currentPrompt, state);
      }
    } finally {
      state.draining = false;
    }
  };

  /**
   * One drain loop per conversation. A prompt handed over while a loop is
   * running joins its queue instead of starting a second loop — two loops would
   * shift the same queue and the second run would interrupt the first.
   */
  const runAndDrain: RunPipeline["runAndDrain"] = async (
    ctx,
    prompt,
    state,
    routing
  ) => {
    if (state.draining) {
      state.queue.push({ ctx, prompt, routing });
      return;
    }
    await pendingWork.track(
      runAndDrainImpl(originOf(ctx), prompt, state, routingOf(prompt, routing))
    );
  };

  /**
   * Start a run the bot itself asks for, with no update behind it: a
   * conversation picked up again after a restart, or a task fired into a
   * chat's conversation. A conversation already running or draining is left
   * alone: whatever the user started there wins. Returns false then; the
   * check and the start are one synchronous step. How the run ended reaches
   * the caller through `origin.onDone`, after which the drain goes on with
   * whatever was queued meanwhile.
   */
  const resume: RunPipeline["resume"] = (origin, prompt, state) => {
    if (state.draining || isRunning(state)) {
      return false;
    }
    pendingWork
      .track(runAndDrainImpl(origin, prompt, state, routingOf(prompt)))
      .catch(logRejection("Resumed run failed"));
    return true;
  };

  /** Send a prompt to the active provider and stream the response. */
  const handlePrompt = async (
    ctx: BotContext,
    prompt: string,
    routing?: PromptRouting
  ) => {
    const state = await getState(ctx);
    const decision = runAccessFor(accessOf(ctx));
    // A run its provider refuses never starts, so it costs no budget.
    const verdict = providerFor({
      access: decision.agent,
      route: await routeProvider({ access: accessOf(ctx), state }),
      tier: accessOf(ctx).tier,
    });
    if (!verdict.allowed) {
      await ctx.reply(verdict.reply);
      return;
    }
    // Every way into a run outside a group arrives here — text, an upload, a
    // composed batch — so this is where a day's budget is spent.
    if (!(await chargePrivateRun(ctx, ownerId))) {
      return;
    }

    // A sandboxed run works in its own scratch directory, so the project the
    // conversation is pointed at never comes up.
    if (!state.activeProject && decision.scratch === false) {
      const { provider } = await routeProvider({
        access: accessOf(ctx),
        state,
      });
      await setRouteProject(state, projectsDir, provider);
    }

    const pendingPlan = activePendingPlan(state);
    if (pendingPlan) {
      await setRouteProject(
        state,
        pendingPlan.projectPath,
        pendingPlan.provider
      );
      if (pendingPlan.sessionId !== undefined) {
        // The plan ran where this prompt will run, so its session is adopted
        // under that same directory — a sandboxed plan never lands on the
        // conversation's project session.
        await adoptSession(
          routeView(state, pendingPlan.provider),
          pendingPlan.sessionId,
          runDirOf(decision, state)
        );
      }
      state.pendingPlan = undefined;
      const feedbackPrompt = `Plan feedback from user: ${prompt}\n\nRevise the plan based on this feedback. Do not execute yet — present the updated plan.`;
      await runAndDrain(ctx, feedbackPrompt, state, routing);
      return;
    }

    const steering = await maySteer(ctx);
    if (isRunning(state) || state.draining) {
      // Behind older queued messages it queues too, so the order holds. A
      // run that waits on background work is not working: the message is
      // its next turn, steer switch or not, for a sender still entitled to
      // the full access it runs with.
      if (
        (steering || (isWaiting(state) && holdsFullAccess(ctx))) &&
        state.queue.length === 0 &&
        // A follow-up carries text only: images start a run of their own.
        // Checked first, since `steerable` already hands the text over.
        (routing?.images ?? []).length === 0 &&
        steerable(state, prompt)
      ) {
        const steered = markSteered({ ctx, prompt, routing });
        state.steered.push(steered);
        logInfo(
          `[run] steered user_id=${state.userId} chat_id=${state.chatId} thread_id=${state.threadId ?? "main"} prompt_chars=${prompt.length}`
        );
        await steered.acknowledged;
        return;
      }
      state.queue.push({ ctx, prompt, routing });
      await sendOrUpdateQueueStatus(ctx, state);
      // A parked run takes the next turn only when it parks, and it already
      // has: hand it the queue again once the PDF text it waited for is in.
      if (isWaiting(state) && hasPendingPdfText(prompt)) {
        pendingWork
          .track(
            (async () => {
              await settlePdfTexts(prompt);
              if (isWaiting(state)) {
                await steerQueued(state);
              }
            })()
          )
          .catch(logRejection("steer after PDF text"));
      }
      return;
    }

    await runAndDrain(ctx, prompt, state, routing);
  };

  return { handlePrompt, resume, runAndDrain };
};
