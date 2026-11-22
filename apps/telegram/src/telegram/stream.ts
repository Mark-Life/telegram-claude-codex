import type { AgentEvent, ProviderCapabilities } from "@workspace/agent/types";
import { Cause, Effect, Schedule, Stream } from "effect";

import { t } from "../i18n";
import { isAgentEvent } from "./agent-board";
import { createAgentStatus } from "./agent-status";
import type { AgentStatus, AgentStatusOptions } from "./agent-status";
import { EDIT_INTERVAL_MS, TYPING_INTERVAL_MS } from "./format";
import type { EventOf } from "./format";
import type { RenderPolicy } from "./render-policy";
import { threadOpts } from "./route";
import type { Route } from "./route";
import { dispatchEvent } from "./stream-handlers";
import {
  finalizeStream,
  flushPending,
  initialStreamCtx,
  switchMode,
} from "./stream-state";
import type { StreamCtx } from "./stream-state";
import { TelegramBot } from "./telegram-bot";

export interface StreamArgs<R = never> {
  /**
   * Show the run's sub-agents and workflows as one live message, and what it
   * may do; absent shows none (a group run).
   */
  agentStatus?: AgentStatusOptions;
  branchName?: string | null;
  capabilities: ProviderCapabilities;
  events: Stream.Stream<AgentEvent>;
  /**
   * The run answered and waits on background work, so a message the user
   * queued while it worked can go in now. Hands over what it waits on.
   */
  onBackgroundWait?: (
    parked: Omit<Extract<EventOf<"background">, { state: "waiting" }>, "kind">
  ) => Effect.Effect<void>;
  /** Persist a new thread id before any later shutdown can interrupt the run. */
  onSessionInit?: (sessionId: string) => Effect.Effect<void, never, R>;
  /** How much of the run reaches the chat; quiet in production, full for dev. */
  policy: RenderPolicy;
  projectName: string;
  /** Chat and forum topic every message of this run goes to. */
  route: Route;
}

/** The typing indicator: superseded every few seconds, so never retried. */
const sendTyping = (route: Route) =>
  Effect.gen(function* () {
    const bot = yield* TelegramBot;
    yield* bot
      .use(
        "sendChatAction",
        async (api) =>
          await api.sendChatAction(route.chatId, "typing", threadOpts(route)),
        { logLevel: "debug", retry: false }
      )
      .pipe(Effect.ignore);
  });

/**
 * Deferred draft edits. Each flush is uninterruptible, so closing the render
 * waits for one already in flight instead of letting it land after the final
 * message.
 */
const flushLoop = (s: StreamCtx, status: AgentStatus | undefined) =>
  Effect.andThen(flushPending(s), status?.flush ?? Effect.void).pipe(
    Effect.uninterruptible,
    Effect.catchCause((cause) => Effect.logError("stream flush failed", cause)),
    Effect.repeat(Schedule.spaced(EDIT_INTERVAL_MS))
  );

/**
 * The only progress signal under the quiet policy, so it runs for the whole
 * stream regardless of what is being rendered, except while the run waits on
 * background work: nothing is being written then.
 */
const typingLoop = (s: StreamCtx) =>
  Effect.suspend(() => (s.waiting ? Effect.void : sendTyping(s.route))).pipe(
    Effect.repeat(Schedule.spaced(TYPING_INTERVAL_MS))
  );

/**
 * Background work a run started, once it answered. `waiting`: the answer and
 * its footer go out now, as at the end of a run, and the next turn starts a
 * fresh one. `expired` and `full`: the run stopped waiting at a cap, or never
 * waited for want of a slot, said like an error.
 */
const handleBackground = <R>(
  s: StreamCtx,
  args: Pick<StreamArgs<R>, "onBackgroundWait">,
  finalize: ReturnType<typeof finalizeStream>,
  event: EventOf<"background">
) =>
  Effect.gen(function* () {
    if (event.state === "waiting") {
      if (s.mode !== "text") {
        yield* switchMode(s, "none");
      }
      s.pendingEdit = false;
      yield* finalize;
      s.footerDue = false;
      s.mode = "none";
      s.textPersisted = false;
      s.waiting = true;
      if (args.onBackgroundWait) {
        yield* args.onBackgroundWait(event);
      }
    } else if (event.state === "expired" || event.state === "full") {
      if (s.mode !== "text") {
        yield* switchMode(s, "text");
      }
      const copy =
        event.state === "expired"
          ? t().status.backgroundExpired
          : t().status.backgroundFull;
      s.accumulated += s.accumulated ? `\n\n_${copy}_` : copy;
    }
  });

/** One event: persist a new session first, then render it; false stops. */
const handleEvent =
  <R>(
    s: StreamCtx,
    args: Pick<StreamArgs<R>, "onBackgroundWait" | "onSessionInit">,
    finalize: ReturnType<typeof finalizeStream>,
    status: AgentStatus | undefined
  ) =>
  (event: AgentEvent) =>
    Effect.gen(function* () {
      // A parked run's workflow still reports: the run is not writing.
      if (isAgentEvent(event)) {
        if (status !== undefined) {
          yield* status.apply(event);
        }
        return true;
      }
      s.waiting = false;
      if (event.kind === "session_init" && args.onSessionInit) {
        yield* args.onSessionInit(event.sessionId);
      }
      if (event.kind === "result" && status !== undefined) {
        yield* status.answered;
      }
      if (event.kind === "background") {
        yield* handleBackground(s, args, finalize, event);
        return true;
      }
      return !(yield* dispatchEvent(s, event));
    });

/**
 * Stream agent events into Telegram, gated by the provider's capabilities and
 * the render policy. The edit and typing loops live only while the events are
 * consumed: they stop on every exit path, interrupts included, and an edit
 * already in flight settles before the final message is written. Fails with
 * the `TelegramBotError` of a send that must not be dropped.
 */
export const streamToTelegram = Effect.fn("streamToTelegram")(function* <
  R = never,
>({
  agentStatus,
  branchName,
  capabilities,
  events,
  onBackgroundWait,
  onSessionInit,
  policy,
  projectName,
  route,
}: StreamArgs<R>) {
  const s = initialStreamCtx({ capabilities, policy, route });
  const finalize = finalizeStream(s, projectName, branchName);
  const status =
    agentStatus === undefined
      ? undefined
      : createAgentStatus(route, agentStatus);

  yield* Effect.gen(function* () {
    // The status closes on every exit, a stop included, so nothing stays
    // pinned; it closes before the answer goes out.
    if (status !== undefined) {
      yield* Effect.addFinalizer(() =>
        status.close.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("agent status not closed", cause)
          )
        )
      );
    }
    yield* Effect.forkScoped(flushLoop(s, status));
    yield* Effect.forkScoped(typingLoop(s));
    yield* Stream.runForEachWhile(
      events,
      handleEvent(s, { onBackgroundWait, onSessionInit }, finalize, status)
    );
  }).pipe(
    Effect.scoped,
    // A failed send (a plain-text fallback that still failed once its retries
    // were spent, say) must not cost the user the answer already produced:
    // persist it first. A failing finalize must not mask the original error,
    // and TelegramBot has already logged its own.
    Effect.tapCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.ignoreCause(finalize)
    )
  );

  yield* finalize;
  return s.result;
});
