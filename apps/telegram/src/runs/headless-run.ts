import {
  isReplaced,
  isRestartCut,
  isRunnable,
  orderedSnapshots,
  runAgent,
  snapshotOf,
} from "@workspace/agent";
import type { AgentError, ProviderId, RunRegistry } from "@workspace/agent";
import type { AgentEvent, RunOptions } from "@workspace/agent/types";
import { Effect, Stream } from "effect";
import type { Tracer } from "effect";

import {
  effectiveProviders,
  reprobeInBackground,
  runAgentProgram,
} from "../handlers/agent-bridge";
import { TaskRunFailed } from "../tasks/run-failed";
import type { TaskRunEnd } from "../tasks/run-failed";

/**
 * The headless prompt-run core: a run nobody watches in a chat, drained to
 * its final answer. A scheduled task's fire and an HTTP API run both go
 * through it, so both compete for the registry's slots on the same terms,
 * end the same ways and report the same answer.
 */

/** What a run told so far, for the report or the ending it becomes. */
interface RunFold {
  /** A result arrived after `full`: the CLI's late report, within its 10 min. */
  afterFull: boolean;
  /** The run stopped waiting at a cap (`expired`), or had no slot (`full`). */
  ended?: "expired" | "full";
  error?: AgentError;
  failure?: string;
  /** The last turn's answer. */
  text: string;
  /** A turn began after a park and gave no answer yet. */
  turnOpen: boolean;
  /** Parked on background work and no later turn began. */
  waitingNow: boolean;
}

const foldRun = (acc: RunFold, event: AgentEvent): RunFold => {
  if (event.kind === "result") {
    return {
      ...acc,
      afterFull: acc.afterFull || acc.ended === "full",
      text: event.text,
      turnOpen: false,
    };
  }
  if (event.kind === "background") {
    if (event.state === "waiting") {
      return { ...acc, waitingNow: true };
    }
    return event.state === "working"
      ? { ...acc, turnOpen: true, waitingNow: false }
      : { ...acc, ended: event.state };
  }
  if (event.kind === "error") {
    return { ...acc, error: event.class, failure: event.message };
  }
  return acc;
};

/** How the run ended, when it left no report to deliver; none when it did. */
const endOf = ({
  afterFull,
  ended,
  error,
  failure,
  text,
  turnOpen,
  waitingNow,
}: RunFold): TaskRunEnd | undefined => {
  if (isRestartCut(error)) {
    return "cut";
  }
  if (isReplaced(error)) {
    return "replaced";
  }
  if (error?._tag === "AgentInterrupted" && error.reason === "stopped") {
    return "stopped";
  }
  if (error?._tag === "AtCapacity") {
    return "busy";
  }
  if (ended === "full" && !afterFull) {
    return "full";
  }
  if (ended === "expired") {
    return "expired";
  }
  // An error after a clean last turn keeps that turn's report; one while
  // the run still waited cut the work it was waiting on, and one in the
  // turn that work's report began leaves only the answer before the park.
  return failure !== undefined &&
    (text.trim().length === 0 || waitingNow || turnOpen)
    ? "error"
    : undefined;
};

/** Where a run's ending is kept for whoever cleans up after it. */
export interface RunEnding {
  value?: TaskRunEnd;
}

/**
 * Drain a run to its final turn's message, the report once any background
 * work it waited on reported. A run that left no report fails with
 * `TaskRunFailed`, its `end` saying why (also kept in `ends`, for the
 * caller's cleanup), so the caller reports a failed run rather than sending
 * an empty or stale message.
 */
export const collectFinalText = <E, R>(
  events: Stream.Stream<AgentEvent, E, R>,
  ends: RunEnding = {}
) =>
  Stream.runFold(
    events,
    (): RunFold => ({
      afterFull: false,
      text: "",
      turnOpen: false,
      waitingNow: false,
    }),
    foldRun
  ).pipe(
    Effect.flatMap((fold) => {
      const end = endOf(fold);
      ends.value = end;
      return end === undefined
        ? Effect.succeed(fold.text)
        : Effect.fail(new TaskRunFailed({ end, message: fold.failure ?? end }));
    })
  );

/**
 * The provider a headless run goes to: `intended` while it can run, else the
 * first runnable one now. The default is fixed until a login, so a provider
 * that logged out since boot can still be it; a headless run has no
 * conversation to keep and moves on.
 */
export const runnableProvider = (intended: ProviderId) => {
  const { default: fallback, snapshots } = effectiveProviders();
  return isRunnable(snapshotOf(snapshots, intended).status)
    ? intended
    : (orderedSnapshots(snapshots).find(({ status }) => isRunnable(status))
        ?.id ?? fallback);
};

/** What one headless run needs: see `runHeadless`. */
export interface HeadlessRun {
  /** Where its ending is kept, read by the caller's cleanup. */
  ends: RunEnding;
  /** Told the model the run is on, as soon as the registry fitted it. */
  onModel?: (model: string | undefined) => void;
  options: RunOptions;
  /** The span the run nests under, captured before a Promise hop. */
  parent: Tracer.AnySpan | undefined;
  provider: ProviderId;
  /** Runs once the run is registered, where a stop reaches it. */
  registered?: Effect.Effect<void, never, RunRegistry>;
  /** The run's own span. */
  span: {
    attributes: Readonly<Record<string, number | string>>;
    name: string;
  };
  /** Per-event work of the caller's, in order, before the fold sees it. */
  tap?: (event: AgentEvent) => Effect.Effect<void>;
}

/**
 * Start one run in the registry and drain it to its final answer, in one
 * runtime crossing (`runAgentProgram`). Resolves the answer; rejects with
 * `TaskRunFailed` when it left none (`ends` says why). A failed run checks
 * its provider again, so the next one moves to a provider that can run: a
 * logout after boot leaves the snapshot runnable.
 */
export const runHeadless = async ({
  ends,
  onModel,
  options,
  parent,
  provider,
  registered = Effect.void,
  span,
  tap,
}: HeadlessRun) =>
  await runAgentProgram(
    Effect.flatMap(runAgent(provider, options), ({ events, model }) => {
      onModel?.(model);
      return Effect.andThen(
        registered,
        collectFinalText(
          tap === undefined ? events : events.pipe(Stream.tap(tap)),
          ends
        )
      );
    }).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          reprobeInBackground([provider]);
        })
      ),
      Effect.withSpan(span.name, { attributes: span.attributes })
    ),
    parent
  );
