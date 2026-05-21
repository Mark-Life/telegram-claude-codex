import { getProvider } from "./registry";
import { runProvider } from "./runner";
import type { ProviderId, RunOptions } from "./types";

export { hasActiveProcess, stopAgent, stopAll } from "./runner";

/** Run a provider agent, yielding normalized events */
export async function* runAgent(providerId: ProviderId, opts: RunOptions) {
  const provider = getProvider(providerId);
  yield* runProvider(provider, opts);
}

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
