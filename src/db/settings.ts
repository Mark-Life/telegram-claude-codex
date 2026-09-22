import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { ProviderId } from "../agent/types";
import { DEFAULT_PROVIDER, isProviderId } from "./provider-id";

/**
 * Settings the bot itself writes. Keys stay strings at the boundary (a caller
 * may store its own), but every key this module owns is listed here so the key
 * space is readable in one place.
 */
export const SETTING_KEYS = {
  activeProject: "active_project",
  activeProvider: "active_provider",
  efforts: "efforts",
  legacyImportDone: "legacy_import_done",
  models: "models",
  verbosity: "verbosity",
} as const;

/** Per-provider selection map (model id or effort id, keyed by provider). */
type ProviderChoices = Partial<Record<ProviderId, string>>;

/** Keep only string-valued known-provider keys from an untrusted choices map. */
const coerceChoices = (raw: unknown): ProviderChoices => {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const out: ProviderChoices = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isProviderId(key) && typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
};

/** Parse a stored choices JSON blob; anything unreadable reads as empty. */
const parseChoices = (raw: string | undefined): ProviderChoices => {
  if (!raw) {
    return {};
  }
  try {
    return coerceChoices(JSON.parse(raw));
  } catch {
    return {};
  }
};

/**
 * Key/value settings ops bound to a db handle, plus the typed bot-state
 * helpers layered on top of them. Values are text; the per-provider model and
 * effort maps live under one JSON value each so a provider added later needs no
 * migration. Every read is total — a missing or corrupt value degrades to the
 * code default rather than throwing.
 */
export const makeSettingsOps = (db: Database) => {
  const select = db.query<{ value: string }, { $key: string }>(
    "SELECT value FROM settings WHERE key = $key"
  );
  const upsert = db.query<
    undefined,
    { $key: string; $updatedAt: number; $value: string }
  >(
    `INSERT INTO settings (key, value, updated_at) VALUES ($key, $value, $updatedAt)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );
  const remove = db.query<undefined, { $key: string }>(
    "DELETE FROM settings WHERE key = $key"
  );

  /** Stored value, or undefined when the key was never set. */
  const get = (key: string) => select.get({ $key: key })?.value;

  /** Write (or overwrite) one setting. */
  const set = (key: string, value: string) => {
    upsert.run({ $key: key, $updatedAt: Date.now(), $value: value });
  };

  /** Forget one setting, back to its code default. */
  const unset = (key: string) => {
    remove.run({ $key: key });
  };

  const setChoice = (
    key: string,
    provider: ProviderId,
    value: string | undefined
  ) => {
    const choices = parseChoices(get(key));
    if (value === undefined) {
      delete choices[provider];
    } else {
      choices[provider] = value;
    }
    set(key, JSON.stringify(choices));
  };

  /**
   * The bot's persisted selection. `activeProject` is only handed back while
   * the directory still exists, so a deleted project never becomes a cwd.
   */
  const loadBotState = () => {
    const project = get(SETTING_KEYS.activeProject);
    const provider = get(SETTING_KEYS.activeProvider);
    return {
      activeProject: project && existsSync(project) ? project : "",
      activeProvider: isProviderId(provider) ? provider : DEFAULT_PROVIDER,
      efforts: parseChoices(get(SETTING_KEYS.efforts)),
      models: parseChoices(get(SETTING_KEYS.models)),
    };
  };

  /** Remember the project new prompts run in. */
  const saveActiveProject = (path: string) => {
    set(SETTING_KEYS.activeProject, path);
  };

  /** Remember which agent CLI new prompts go to. */
  const saveActiveProvider = (provider: ProviderId) => {
    set(SETTING_KEYS.activeProvider, provider);
  };

  /** Remember the model chosen for one provider. */
  const saveModel = (provider: ProviderId, model: string) => {
    setChoice(SETTING_KEYS.models, provider, model);
  };

  /** Remember the reasoning-effort level chosen for one provider. */
  const saveEffort = (provider: ProviderId, effort: string) => {
    setChoice(SETTING_KEYS.efforts, provider, effort);
  };

  /** Raw stored verbosity, or undefined when the user never chose one. */
  const getVerbositySetting = () => get(SETTING_KEYS.verbosity);

  /** Persist the chosen verbosity level. */
  const setVerbositySetting = (value: string) => {
    set(SETTING_KEYS.verbosity, value);
  };

  return {
    get,
    getVerbositySetting,
    loadBotState,
    saveActiveProject,
    saveActiveProvider,
    saveEffort,
    saveModel,
    set,
    setVerbositySetting,
    unset,
  } as const;
};
