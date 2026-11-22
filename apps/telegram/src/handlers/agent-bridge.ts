import {
  compactAgent,
  getProvider,
  hasActiveProcess,
  isAgentWaiting,
  isRouteBusy,
  retireAgent,
  PROVIDER_IDS,
  Providers,
  snapshotOf,
  stopAgent,
  steerAgent,
  stopAll,
  stopRouteAgents,
} from "@workspace/agent";
import type { InterruptReason } from "@workspace/agent";
import type { ProviderId, RunKey, RunOptions } from "@workspace/agent/types";
import { Effect } from "effect";
import type { ManagedRuntime, Tracer } from "effect";

import { runtime } from "../runtime";

/**
 * Promise/sync facade over the Effect agent surface. grammy handlers are plain
 * async functions, so every crossing into the runtime happens here.
 */

type AppServices = ManagedRuntime.ManagedRuntime.Services<typeof runtime>;

/** Stop the active run in one slot; returns whether one was running. */
export const stopRun = (key: RunKey, reason: InterruptReason = "stopped") =>
  runtime.runSync(stopAgent(key, reason));

/**
 * Stop every user's run in one chat and topic (a provider switch there);
 * returns how many were running.
 */
export const stopRouteRuns = (
  route: Omit<RunKey, "userId">,
  reason: InterruptReason
) => runtime.runSync(stopRouteAgents(route, reason));

/**
 * Fold a message into the run in a slot; returns whether the run took it.
 * False means the caller queues it.
 */
export const steerRun = (key: RunKey, text: string) =>
  runtime.runSync(steerAgent(key, text));

/** Whether a slot has an active run. */
export const isRunning = (key: RunKey) =>
  runtime.runSync(hasActiveProcess(key));

/**
 * Whether any user's run works in one chat and topic: a topic's session is
 * shared, while a run slot is per user.
 */
export const isRouteRunning = (route: Omit<RunKey, "userId">) =>
  runtime.runSync(isRouteBusy(route));

/** Whether the run in a slot answered and waits on background work. */
export const isWaiting = (key: RunKey) => runtime.runSync(isAgentWaiting(key));

/**
 * End the run in a slot at its last answer, before its conversation moves to
 * another session, model or effort: a parked run's next turn would run on the
 * old ones, and its end would store the old session again.
 */
export const retireRun = (key: RunKey) => {
  runtime.runSync(retireAgent(key));
};

/**
 * Which providers this host can run, and which one each kind of work runs on:
 * the default for a route with no stored provider, the light one, the helper
 * per pass. A read of the last snapshot; it never waits on a CLI.
 */
export const effectiveProviders = () =>
  runtime.runSync(Effect.flatMap(Providers, (providers) => providers.current));

/**
 * Check providers again off the update path; see `Providers.reprobe`. A
 * handler must never await a CLI: polling is sequential.
 */
export const reprobeInBackground = (ids?: readonly ProviderId[]) => {
  runtime.runFork(
    Effect.flatMap(Providers, (providers) =>
      providers.reprobe({ ids, roles: false })
    )
  );
};

/**
 * Check providers again and wait for the snapshot, the cooldown honoured as
 * in `reprobeInBackground`. Only for work already off the update path.
 */
export const reprobeAndWait = async () =>
  await runtime.runPromise(
    Effect.flatMap(Providers, (providers) =>
      providers.reprobe({ roles: false })
    )
  );

/** Check every provider now and recompute the roles (after a login). */
export const refreshProviders = async () =>
  await runtime.runPromise(
    Effect.flatMap(Providers, (providers) => providers.reprobe({ roles: true }))
  );

/**
 * Re-read the live model list of every ready provider that has one, when the
 * list in hand is older than `maxAgeMs`. Off the update path; never rejects.
 */
export const refreshModelsInBackground = (maxAgeMs: number) => {
  const { snapshots } = effectiveProviders();
  for (const id of PROVIDER_IDS) {
    const { refreshModels } = getProvider(id);
    if (
      refreshModels !== undefined &&
      snapshotOf(snapshots, id).status === "ready"
    ) {
      void refreshModels({ maxAgeMs });
    }
  }
};

/** Interrupt every run and await settle (shutdown). */
export const stopAllRuns = async () => {
  await runtime.runPromise(stopAll);
};

/**
 * Nest `self` under `parent`, a span captured before a Promise hop: a runtime
 * crossing otherwise starts a new trace.
 */
export const underParent =
  (parent: Tracer.AnySpan | undefined) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    parent === undefined ? self : Effect.withParentSpan(self, parent);

/**
 * Run one agent program — the run's start and the whole consumption of its
 * events — in a single runtime crossing, so the run's logs and spans land in
 * the app runtime, under `parent` when given. A defect rejects with the
 * original error.
 */
export const runAgentProgram = async <A, E>(
  program: Effect.Effect<A, E, AppServices>,
  parent?: Tracer.AnySpan
) => await runtime.runPromise(underParent(parent)(program));

/** Compact a session; resolves to the single terminal compaction event. */
export const compactRun = async (providerId: ProviderId, opts: RunOptions) =>
  await runtime.runPromise(compactAgent(providerId, opts));
