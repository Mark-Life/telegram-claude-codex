import { Effect, Stream } from "effect";

import { narrowAccess } from "./access-narrow";
import { compactSpec, foldCompactEvents } from "./compact";
import type { InterruptReason } from "./errors";
import { getProvider } from "./registry";
import { RunRegistry } from "./run-registry";
import { SessionStore } from "./session-store";
import { clampTier } from "./tier-models";
import type {
  AgentProvider,
  CompactEvent,
  ModelTier,
  ProviderId,
  ProviderSpec,
  RunKey,
  RunOptions,
} from "./types";

export { canRun, narrowAccess } from "./access-narrow";
export { pinLogSink } from "./log-sink";
export {
  apiInputPrompt,
  apiRunPrompt,
  boundTaskPrompt,
  REMINDERS_CLI,
  silentTaskPrompt,
  SKIP_OUTPUT,
  TASK_FAILED_PREFIX,
  taskWaitPrompt,
} from "./run-prompt";
export { discardClaudeSession } from "./claude-sessions";
export { generateTopicTitle } from "./codex-topic-title";

/**
 * The package surface. Everything that needs a service returns an Effect, so
 * the host application owns the runtime and this package never imports it.
 *
 * `runAgent` starts the run and hands back its events as a Stream the caller
 * runs in its own runtime, so logs and spans of the whole run land there.
 *
 *   const { runId, events } = yield* runAgent("codex", opts);
 *   yield* Stream.runForEach(events, handle);
 */

/**
 * Start a run and expose its queue as a Stream. The stream ends after the
 * run's terminal event, or right after `plan_ready`: a plan is the run's
 * product, so the process behind it is stopped. Any early end of the stream
 * (plan, consumer interrupt, consumer failure) stops the slot, but only while
 * this run still owns it. `unread` counts the follow-ups the agent never took
 * into its work, read once the stream ended.
 */
const streamRun = (spec: ProviderSpec, opts: RunOptions) =>
  Effect.gen(function* () {
    const registry = yield* RunRegistry;
    const { followUps, queue, runId } = yield* registry.start(spec, opts);
    const events = Stream.fromQueue(queue).pipe(
      Stream.takeUntil((event) => event.kind === "plan_ready"),
      Stream.ensuring(registry.stopIfOwner(opts, runId, "stopped"))
    );
    return { events, runId, unread: followUps.unread };
  });

/**
 * The run as its provider receives it: access narrowed to what the provider
 * can enforce and wire on this host, the granted record kept beside it, and
 * a `light` run pinned to the provider's light pick whatever was chosen, or
 * to the owner's light choice (a model named for this provider, else a tier
 * on the provider's slug for it, a level
 * mapped onto the model it ends on).
 */
const fitRun = (provider: AgentProvider, opts: RunOptions): RunOptions => {
  const access = narrowAccess(opts.access, provider.capabilities);
  const fitted = { ...opts, access, grantedAccess: opts.access };
  if (access.modelClass !== "light") {
    return fitted;
  }
  const light = provider.lightPick();
  const { effort, models, tier } = opts.lightChoice ?? {};
  const named = models?.[provider.id];
  const model =
    named ??
    (tier === undefined
      ? light.model
      : (clampTier(provider.tierModels(), tier) ?? light.model));
  return {
    ...fitted,
    effort:
      effort === undefined ? light.effort : provider.mapEffort(effort, model),
    model,
  };
};

/** Runs outside a topic whose access keeps the session are stored per project. */
const persistsSession = (opts: RunOptions) =>
  opts.access.persistSession &&
  (opts.threadId === undefined || opts.threadId === null);

/**
 * Run a provider agent. Succeeds with the registry's run id and the run's
 * normalized events; a failure is an in-stream `error` event, never a stream
 * failure.
 *
 * The per-project session store only tracks runs outside a forum topic: a topic
 * owns its own conversation, so letting two topics on one project write here
 * would just have them overwrite each other's session id. A run whose access
 * says the session is throwaway (every group run) is never stored at all.
 */
export const runAgent = (providerId: ProviderId, requested: RunOptions) =>
  Effect.gen(function* () {
    const provider = getProvider(providerId);
    const opts = fitRun(provider, requested);
    // The model the run is on once fitted: a light run's is picked here.
    const run = { ...(yield* streamRun(provider, opts)), model: opts.model };
    if (!persistsSession(opts)) {
      return run;
    }
    const store = yield* SessionStore;
    // Stored as soon as it exists — on session_init AND result — so an
    // interrupted run's session is still resumable. A failed write is logged
    // (by the store, or here for a defect) and dropped: losing the id costs a
    // resume, killing the run would cost the answer.
    const events = run.events.pipe(
      Stream.tap((event) =>
        event.kind === "session_init" || event.kind === "result"
          ? store
              .set({
                project: opts.projectDir,
                provider: providerId,
                sessionId: event.sessionId,
              })
              .pipe(
                Effect.catchTag("PersistenceError", () => Effect.void),
                Effect.catchDefect((defect) =>
                  Effect.logWarning("session id not stored", defect)
                )
              )
          : Effect.void
      )
    );
    return { ...run, events };
  });

/**
 * Compact `opts.sessionId` for a provider, succeeding with the run's one
 * terminal event. It goes through the same registry as a prompt — single-flight
 * per user, /stop-able, capacity-bounded — but its stream is folded into an
 * outcome instead of streamed to chat.
 *
 * The store is written on success only, and only once the new session exists,
 * so any failure leaves the user on the conversation they already had.
 */
export const compactAgent = (providerId: ProviderId, requested: RunOptions) =>
  Effect.gen(function* () {
    const provider = getProvider(providerId);
    const opts = fitRun(provider, requested);
    if (!provider.compact) {
      const declined: CompactEvent = {
        kind: "compact_failed",
        reason: `${provider.displayName} does not support compaction.`,
      };
      return declined;
    }
    const { events } = yield* streamRun(
      compactSpec(provider.id, provider.compact),
      opts
    );
    const outcome = yield* foldCompactEvents(events);
    // Same split as runAgent: a topic's compacted session belongs to the topic.
    if (outcome.kind === "compact_done" && persistsSession(opts)) {
      const store = yield* SessionStore;
      yield* store.set({
        project: opts.projectDir,
        provider: providerId,
        sessionId: outcome.sessionId,
      });
    }
    return outcome;
  });

/** Stop the active run in one slot; succeeds with whether one was running. */
export const stopAgent = (key: RunKey, reason: InterruptReason = "stopped") =>
  Effect.flatMap(RunRegistry, (r) => r.stop(key, reason));

/** Stop every user's run in one chat and topic; succeeds with the count. */
export const stopRouteAgents = (
  route: Omit<RunKey, "userId">,
  reason: InterruptReason
) => Effect.flatMap(RunRegistry, (r) => r.stopRoute(route, reason));

/** Whether any user's run works in one chat and topic. */
export const isRouteBusy = (route: Omit<RunKey, "userId">) =>
  Effect.flatMap(RunRegistry, (r) => r.routeBusy(route));

/**
 * Fold a message into the run in a slot; succeeds with whether it took it.
 * A run whose provider cannot steer takes none.
 */
export const steerAgent = (key: RunKey, text: string) =>
  Effect.flatMap(RunRegistry, (r) => r.steer(key, text));

/**
 * End the run in a slot at its last answer, before its conversation moves to
 * another session, model or effort; see `RunRegistry.retire`.
 */
export const retireAgent = (key: RunKey) =>
  Effect.flatMap(RunRegistry, (r) => r.retire(key));

/** Whether the run in a slot answered and waits on background work. */
export const isAgentWaiting = (key: RunKey) =>
  Effect.flatMap(RunRegistry, (r) => r.waiting(key));

/**
 * Shutdown: no run takes another message. A run still parked on background
 * work stops waiting (`stopWaitingRuns` stops those first).
 */
export const closeRunInboxes = Effect.flatMap(
  RunRegistry,
  (r) => r.closeInboxes
);

/**
 * Shutdown: stop every run parked on background work at once, as `restart`,
 * so the bot can resume it after boot. Succeeds with how many it stopped.
 */
export const stopWaitingRuns = Effect.flatMap(RunRegistry, (r) =>
  r.stopWaiting("restart")
);

/**
 * Whether a run of `priority` would get a working permit right now; see
 * `RunRegistry.canStart`.
 */
export const canStartRun = (priority: RunOptions["access"]["priority"]) =>
  Effect.flatMap(RunRegistry, (r) => r.canStart(priority));

/** Whether a slot has an active run. */
export const hasActiveProcess = (key: RunKey) =>
  Effect.flatMap(RunRegistry, (r) => r.has(key));

/** Interrupt all runs and await settle (shutdown). */
export const stopAll = Effect.flatMap(RunRegistry, (r) => r.stopAll);

/** Get a provider's capabilities */
export const getCapabilities = (providerId: ProviderId) =>
  getProvider(providerId).capabilities;

/** Whether a provider can compact a session (gates /compact) */
export const supportsCompaction = (providerId: ProviderId) =>
  getProvider(providerId).capabilities.compaction;

/** Get a provider's selectable models */
export const getModels = (providerId: ProviderId) =>
  getProvider(providerId).models();

/** Get a provider's selectable reasoning-effort levels */
export const getEffortLevels = (providerId: ProviderId) =>
  getProvider(providerId).effortLevels;

/** The levels `model` takes on a provider; empty when it sets none. */
export const getEffortLevelsFor = (
  providerId: ProviderId,
  model: string | undefined
) => {
  const provider = getProvider(providerId);
  return provider.effortLevelsFor?.(model) ?? provider.effortLevels;
};

/** Get a provider's default reasoning-effort id (used when the user has not chosen) */
export const getDefaultEffort = (providerId: ProviderId) =>
  getProvider(providerId).defaultEffort;

/**
 * The provider slug a routed tier runs on, clamped to the nearest tier it
 * offers (see `clampTier`). Undefined only if it declares no tier at all.
 */
export const tierModel = (providerId: ProviderId, tier: ModelTier) =>
  clampTier(getProvider(providerId).tierModels(), tier);

export * from "./address-judge";
export * from "./codex-format";
export * from "./codex-judge";
export {
  listTurns,
  onTurnChange,
  turnCount,
  waitForTurnsIdleFor,
} from "./agent-turns";
export type {
  LiveTurn,
  TurnChange,
  TurnKind,
  TurnOutcome,
} from "./agent-turns";
export { continuationPrompt } from "./claude-background";
export * from "./errors";
export * from "./model-router";
export {
  exactPiModel,
  findPiModel,
  loadPiModels,
  PI_BIG_PROVIDER,
  piCustomModels,
  piFavourites,
  piLightList,
  piLightModel,
  piModelList,
  piRunsLight,
  searchPiModels,
} from "./pi-models";
export type { PiModel, PiModelList } from "./pi-models";
export { piDefaultModel } from "./pi-account";
export * from "./providers";
export {
  decodeOwnerSettings,
  PROVIDER_SETTINGS,
  settingControl,
  settingFields,
  settingValues,
} from "./provider-settings";
export type { SettingControl, SettingValue } from "./provider-settings";
export type { ExecutionOutcome } from "./executor-outcome";
export * from "./executor-rest";
export * from "./registry";
export * from "./reminder-intent";
export * from "./run-registry";
export * from "./session-store";
export * from "./task-verdict";
export * from "./telegram-account-mcp";
export * from "./typesafe";
export * from "./elevenlabs";
export {
  AUTO_MODEL,
  DEFAULT_MODEL,
  isModelTier,
  isRoutedEffort,
  MODEL_TIERS,
  ONE_TURN_USES,
  ROUTED_EFFORTS,
} from "./types";
export type * from "./types";
