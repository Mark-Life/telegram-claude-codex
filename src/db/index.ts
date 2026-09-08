import type { Database } from "bun:sqlite";
import type { ProviderId } from "../agent/types";
import { getDb } from "./client";
import {
  type ComposeKey,
  type ComposeMessage,
  makeComposeOps,
} from "./compose";
import { makeSessionOps } from "./sessions";
import { makeSettingsOps } from "./settings";
import { makeThreadOps, type ThreadKey } from "./threads";

export {
  closeDb,
  DATA_DIR,
  DB_FILE,
  getDb,
  openDb,
  quarantineDb,
} from "./client";
export type { ComposeKey, ComposeMessage, ComposeType } from "./compose";
export { COMPOSE_TYPES, makeComposeOps } from "./compose";
export { runLegacyImport } from "./legacy-import";
export { LATEST_VERSION, runMigrations, schemaVersion } from "./migrations";
export { DEFAULT_PROVIDER, isProviderId } from "./provider-id";
export { makeSessionOps } from "./sessions";
export { makeSettingsOps, SETTING_KEYS } from "./settings";
export type { ThreadEntry, ThreadKey, ThreadRecord } from "./threads";
export { makeThreadOps } from "./threads";

const buildOps = (db: Database) => ({
  compose: makeComposeOps(db),
  sessions: makeSessionOps(db),
  settings: makeSettingsOps(db),
  threads: makeThreadOps(db),
});

// Statements are prepared once per handle and dropped with it, so a test that
// closes the singleton and reopens elsewhere never reuses stale queries.
const cache = new WeakMap<Database, ReturnType<typeof buildOps>>();

/** Ops bound to the process-wide db, prepared on first use. */
const ops = () => {
  const db = getDb();
  const cached = cache.get(db);
  if (cached) {
    return cached;
  }
  const built = buildOps(db);
  cache.set(db, built);
  return built;
};

/** The topic's pinned project/provider/session, or undefined when unused. */
export const getThread = (key: ThreadKey) => ops().threads.get(key);

/** Pin a topic to a project and provider; the session survives an unchanged pin. */
export const pinThread = (
  entry: ThreadKey & { projectPath: string; provider: ProviderId }
) => ops().threads.pin(entry);

/** Record the session a topic continues on; false when the topic has no row. */
export const setThreadSession = (entry: ThreadKey & { sessionId: string }) =>
  ops().threads.setSession(entry);

/** Forget the topic's session but keep its project pin. */
export const clearThreadSession = (key: ThreadKey) => {
  ops().threads.clearSession(key);
};

/** Every topic of a chat, most recently used first. */
export const listThreads = (chatId: number) => ops().threads.list(chatId);

/** Drop a topic entirely. */
export const dropThread = (key: ThreadKey) => {
  ops().threads.drop(key);
};

/** Session id to resume for a project outside a topic. */
export const getStoredSession = (project: string, provider: ProviderId) =>
  ops().sessions.get(project, provider);

/** Record a project's session id for a provider. */
export const setStoredSession = (entry: {
  project: string;
  provider: ProviderId;
  sessionId: string;
}) => {
  ops().sessions.set(entry);
};

/** Forget a project's session so the next prompt starts fresh. */
export const clearStoredSession = (project: string, provider: ProviderId) => {
  ops().sessions.clear(project, provider);
};

/** How many projects hold a session for this provider. */
export const countStoredSessions = (provider: ProviderId) =>
  ops().sessions.count(provider);

/** Stored setting value, or undefined when the key was never set. */
export const getSetting = (key: string) => ops().settings.get(key);

/** Write (or overwrite) one setting. */
export const setSetting = (key: string, value: string) => {
  ops().settings.set(key, value);
};

/** Append one message to a compose buffer. */
export const appendCompose = (entry: ComposeKey & ComposeMessage) => {
  ops().compose.append(entry);
};

/** Buffered messages in arrival order. */
export const listCompose = (key: ComposeKey) => ops().compose.list(key);

/** How many messages a compose buffer holds. */
export const countCompose = (key: ComposeKey) => ops().compose.count(key);

/** Drop a compose buffer; returns how many messages were discarded. */
export const clearCompose = (key: ComposeKey) => ops().compose.clear(key);

/** Active project (only while it still exists), provider, models and efforts. */
export const loadBotState = () => ops().settings.loadBotState();

/** Remember the project new prompts run in. */
export const saveActiveProject = (path: string) => {
  ops().settings.saveActiveProject(path);
};

/** Remember which agent CLI new prompts go to. */
export const saveActiveProvider = (provider: ProviderId) => {
  ops().settings.saveActiveProvider(provider);
};

/** Remember the model chosen for one provider. */
export const saveModel = (provider: ProviderId, model: string) => {
  ops().settings.saveModel(provider, model);
};

/** Remember the reasoning-effort level chosen for one provider. */
export const saveEffort = (provider: ProviderId, effort: string) => {
  ops().settings.saveEffort(provider, effort);
};

/** Raw stored verbosity, or undefined when the user never chose one. */
export const getVerbositySetting = () => ops().settings.getVerbositySetting();

/** Persist the chosen verbosity level. */
export const setVerbositySetting = (value: string) => {
  ops().settings.setVerbositySetting(value);
};
