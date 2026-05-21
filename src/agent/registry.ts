import { claudeProvider } from "./claude";
import { codexProvider } from "./codex";
import type { AgentProvider, ProviderId } from "./types";

/** Registered providers */
const providers: Partial<Record<ProviderId, AgentProvider>> = {
  claude: claudeProvider,
  codex: codexProvider,
};

/** Get a provider by its identifier */
export function getProvider(id: ProviderId) {
  const provider = providers[id];
  if (!provider) {
    throw new Error(`Unknown provider: ${id}`);
  }
  return provider;
}

/** List all registered providers */
export function listProviders() {
  return Object.values(providers) as AgentProvider[];
}
