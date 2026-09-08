import type { ProviderId } from "../agent/types";

// A total map rather than a list: adding a provider to ProviderId fails to
// compile here until it is acknowledged. Type-only import of the agent layer
// keeps the db free of the provider SDKs.
const KNOWN_PROVIDERS: Record<ProviderId, true> = { claude: true, codex: true };

/** Narrow an untrusted string (db column, JSON file) to a provider this build knows. */
export const isProviderId = (value: unknown): value is ProviderId =>
  typeof value === "string" && Object.hasOwn(KNOWN_PROVIDERS, value);

/** Provider used when nothing was ever chosen. */
export const DEFAULT_PROVIDER: ProviderId = "claude";
