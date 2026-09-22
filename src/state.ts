import type { ProviderId } from "./agent/types";
import {
  loadBotState,
  saveActiveProject,
  saveActiveProvider,
  saveEffort,
  saveModel,
} from "./db";

/**
 * The persisted selection a new conversation starts from. Derived from the db
 * so the two never drift apart.
 */
export type BotState = ReturnType<typeof loadBotState>;

/**
 * Active project, provider and the per-provider model/effort choices, read
 * from the settings table. Total: a first run, a missing key or a value that no
 * longer parses all degrade to the code defaults rather than failing.
 */
export const loadPersistedState = () => loadBotState();

/** Set the project new prompts run in and persist it. */
export const setActiveProject = (state: BotState, path: string) => {
  state.activeProject = path;
  saveActiveProject(path);
};

/** Set the agent CLI new prompts go to and persist it. */
export const setActiveProvider = (state: BotState, providerId: ProviderId) => {
  state.activeProvider = providerId;
  saveActiveProvider(providerId);
};

/** Set the model for one provider and persist it. */
export const setModel = (
  state: BotState,
  provider: ProviderId,
  model: string
) => {
  state.models[provider] = model;
  saveModel(provider, model);
};

/** Set the reasoning-effort level for one provider and persist it. */
export const setEffort = (
  state: BotState,
  provider: ProviderId,
  effort: string
) => {
  state.efforts[provider] = effort;
  saveEffort(provider, effort);
};
