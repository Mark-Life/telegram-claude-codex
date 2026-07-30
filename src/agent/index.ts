import { Exit, Queue } from "effect";
import { runtime } from "../runtime";
import type { InterruptReason } from "./errors";
import { getProvider } from "./registry";
import { hasRun, startRun, stopAllRuns, stopRun } from "./run-registry";
import { setSession } from "./session-store";
import type { AgentEvent, ProviderId, RunOptions } from "./types";

/** Run a provider agent, yielding normalized events. Stays an AsyncGenerator. */
export async function* runAgent(
  providerId: ProviderId,
  opts: RunOptions
): AsyncGenerator<AgentEvent> {
  const spec = getProvider(providerId);
  const queue = await runtime.runPromise(startRun(spec, opts));
  try {
    while (true) {
      const exit = await runtime.runPromiseExit(Queue.take(queue));
      if (Exit.isFailure(exit)) {
        return; // Cause.Done (end) or interrupt of the take => stream over
      }
      const event = exit.value;
      // Persist the session id as soon as it exists — on session_init AND result,
      // not result-only — so an interrupted run's session is still resumable.
      if (event.kind === "session_init" || event.kind === "result") {
        runtime.runFork(
          setSession({
            project: opts.projectDir,
            provider: providerId,
            sessionId: event.sessionId,
          })
        );
      }
      yield event;
    }
  } finally {
    // Consumer abandoned early (e.g. telegram broke on plan_ready) => tear the
    // producer down. No-op if it already ended.
    runtime.runFork(stopRun(opts.userId, "stopped"));
  }
}

/** Stop the active run for a user; returns whether one was running. */
export const stopAgent = (
  userId: number,
  reason: InterruptReason = "stopped"
) => runtime.runSync(stopRun(userId, reason));

/** Whether a user has an active run. */
export const hasActiveProcess = (userId: number) =>
  runtime.runSync(hasRun(userId));

/** Interrupt all runs and await settle (shutdown). */
export const stopAll = () => runtime.runPromise(stopAllRuns);

/** List all stored sessions for a provider */
export function listAllSessions(providerId: ProviderId) {
  return getProvider(providerId).listAllSessions();
}

/** Look up a session's project path for a provider */
export function getSessionProject(providerId: ProviderId, sessionId: string) {
  return getProvider(providerId).getSessionProject(sessionId);
}

/** Clear a provider's session-to-project cache */
export function clearSessionCache(providerId: ProviderId) {
  getProvider(providerId).clearSessionCache();
}

/** Get a provider's capabilities */
export function getCapabilities(providerId: ProviderId) {
  return getProvider(providerId).capabilities;
}

/** Get a provider's selectable models */
export function getModels(providerId: ProviderId) {
  return getProvider(providerId).models;
}

/** Get a provider's selectable reasoning-effort levels */
export function getEffortLevels(providerId: ProviderId) {
  return getProvider(providerId).effortLevels;
}
