import { Schema } from "effect";

import { claudeProvider } from "./claude";
import { codexProvider } from "./codex";
import { piProvider } from "./pi";
import { PROVIDER_IDS } from "./types";
import type { AgentProvider, ProviderId } from "./types";

export { PROVIDER_IDS } from "./types";

/** Registered providers */
const providers = {
  claude: claudeProvider,
  codex: codexProvider,
  pi: piProvider,
} satisfies Partial<Record<ProviderId, AgentProvider>>;

/** A provider id read from outside the code: a setting, a file, a button. */
export const decodeProviderId = Schema.decodeUnknownOption(
  Schema.Literals(PROVIDER_IDS)
);

/** Get a provider by its identifier */
export const getProvider = (id: ProviderId) => {
  // Typed as optional so a ProviderId added without a `providers` entry throws
  // here rather than handing back undefined.
  const provider: AgentProvider | undefined = providers[id];
  if (provider === undefined) {
    throw new Error(`Unknown provider: ${id}`);
  }
  return provider;
};

/** List all registered providers */
export const listProviders = () => Object.values(providers);
