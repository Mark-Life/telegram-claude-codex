import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderId } from "../agent/types";
import { DATA_DIR } from "./client";
import { isProviderId } from "./provider-id";
import { makeSessionOps } from "./sessions";
import { makeSettingsOps, SETTING_KEYS } from "./settings";

interface LegacySession {
  project: string;
  provider: ProviderId;
  sessionId: string;
}

/** Read and parse a JSON file; a missing or corrupt file reads as undefined. */
const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as unknown;
  } catch {
    return;
  }
};

const asRecord = (value: unknown) =>
  value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Session ids inlined in the oldest `state.json`, in either shape it ever had:
 * flat `{project: id}` (claude only) or provider-nested `{claude: {project: id}}`.
 */
const sessionsFromState = (state: unknown): LegacySession[] => {
  const sessions = asRecord(asRecord(state)?.sessions);
  if (!sessions) {
    return [];
  }
  const out: LegacySession[] = [];
  for (const [key, value] of Object.entries(sessions)) {
    if (typeof value === "string") {
      out.push({ project: key, provider: "claude", sessionId: value });
      continue;
    }
    if (!isProviderId(key)) {
      continue;
    }
    for (const [project, id] of Object.entries(asRecord(value) ?? {})) {
      if (typeof id === "string") {
        out.push({ project, provider: key, sessionId: id });
      }
    }
  }
  return out;
};

/** Session ids from `sessions.json` (`{project: {provider: {sessionId}}}`). */
const sessionsFromStore = (store: unknown): LegacySession[] => {
  const byProject = asRecord(asRecord(store)?.sessions);
  if (!byProject) {
    return [];
  }
  const out: LegacySession[] = [];
  for (const [project, providers] of Object.entries(byProject)) {
    for (const [provider, record] of Object.entries(
      asRecord(providers) ?? {}
    )) {
      const sessionId = asRecord(record)?.sessionId;
      if (isProviderId(provider) && typeof sessionId === "string") {
        out.push({ project, provider, sessionId });
      }
    }
  }
  return out;
};

type SettingsOps = ReturnType<typeof makeSettingsOps>;

/** Copy the active project/provider and the model/effort maps across. */
const importState = (settings: SettingsOps, state: unknown) => {
  const record = asRecord(state);
  if (!record) {
    return false;
  }
  if (typeof record.activeProject === "string" && record.activeProject) {
    settings.saveActiveProject(record.activeProject);
  }
  if (isProviderId(record.activeProvider)) {
    settings.saveActiveProvider(record.activeProvider);
  }
  for (const [provider, model] of Object.entries(
    asRecord(record.models) ?? {}
  )) {
    if (isProviderId(provider) && typeof model === "string") {
      settings.saveModel(provider, model);
    }
  }
  for (const [provider, effort] of Object.entries(
    asRecord(record.efforts) ?? {}
  )) {
    if (isProviderId(provider) && typeof effort === "string") {
      settings.saveEffort(provider, effort);
    }
  }
  return true;
};

/**
 * One-time import of the JSON stores (`state.json`, `sessions.json`) into the
 * database, guarded by a settings flag so a second run does nothing. The files
 * are left on disk untouched — the db becomes the source of truth, the JSON
 * stays as a fallback copy. `topics.json` is deliberately ignored: topics are
 * re-pinned on first use. Nothing already in the db is overwritten.
 *
 * When neither file could be read the flag stays unset and the import is
 * retried on the next boot, so a db created before the JSON stores were put in
 * place still picks them up. Rows and flag are written in one transaction: an
 * import either lands whole or not at all.
 */
export const runLegacyImport = (db: Database, dir = DATA_DIR) => {
  const settings = makeSettingsOps(db);
  if (settings.get(SETTING_KEYS.legacyImportDone)) {
    return { imported: 0, skipped: true, state: false };
  }
  const state = readJson(join(dir, "state.json"));
  const store = readJson(join(dir, "sessions.json"));
  if (state === undefined && store === undefined) {
    return { imported: 0, skipped: true, state: false };
  }

  const sessions = makeSessionOps(db);
  return db.transaction(() => {
    let imported = 0;
    for (const entry of [
      ...sessionsFromState(state),
      ...sessionsFromStore(store),
    ]) {
      if (sessions.get(entry.project, entry.provider)) {
        continue;
      }
      sessions.set(entry);
      imported += 1;
    }

    const stateImported = importState(settings, state);
    settings.set(SETTING_KEYS.legacyImportDone, new Date().toISOString());
    return { imported, skipped: false, state: stateImported };
  })();
};
