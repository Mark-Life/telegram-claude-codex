import type { SettingChange, SettingKey } from "./db";
import { getSetting } from "./db/bridge";
import { parseLanguage, switchLanguage } from "./i18n";
import { logError } from "./log";

/**
 * Every on/off switch `/settings` shows, in menu order; its label and hint are
 * locale copy (`settings.toggles`). A new one is one more key here, in
 * `SETTING_KEYS` and in each locale. An unset switch reads as on, so one added
 * later never changes a running bot until the owner presses it. `steer` and
 * `mark_read` are the ones whose on is new behaviour, on purpose: steering
 * and marking what the bot read are the defaults. The account layer reads
 * `mark_read` on its own, from `SettingsRepo`.
 */
export const TOGGLE_KEYS = [
  "guests",
  "mark_read",
  "steer",
  "voice_transcript",
] as const satisfies readonly SettingKey[];

export type ToggleKey = (typeof TOGGLE_KEYS)[number];

export const isToggleKey = (key: string): key is ToggleKey =>
  TOGGLE_KEYS.some((known) => known === key);

/**
 * Keys only `SettingsService` writes, read through the cache below. A key
 * something else writes (`verbosity`, which a dev may set in the table, the
 * workspace, `account_writes`, which the account layer reads on its own)
 * stays out.
 */
export const CACHED_KEYS = [
  ...TOGGLE_KEYS,
  "default_tz",
  "group_runs_per_day",
  "group_runs_per_user",
  "helper_format_effort",
  "helper_format_model",
  "helper_format_pi_model",
  "helper_format_provider",
  "helper_judge_effort",
  "helper_judge_model",
  "helper_judge_pi_model",
  "helper_judge_provider",
  "helper_title_effort",
  "helper_title_model",
  "helper_title_pi_model",
  "helper_title_provider",
  "light_effort",
  "light_model",
  "light_pi_model",
  "light_provider",
  "max_concurrent_runs",
  "private_runs_per_day",
  "private_runs_per_user",
] as const satisfies readonly SettingKey[];

export type CachedKey = (typeof CACHED_KEYS)[number];

/**
 * Last value read or written per key, `undefined` for a key with no row. The
 * bot's `SettingsService` is the only writer of these keys and reports every
 * write (`noteWritten`), so no read ever goes stale.
 */
const cache = new Map<CachedKey, string | undefined>();

/** The stored value of a key, or undefined; a failed read rejects, uncached. */
export const readCached = async (key: CachedKey) => {
  if (cache.has(key)) {
    return cache.get(key);
  }
  const stored = await getSetting(key);
  cache.set(key, stored);
  return stored;
};

const isCachedKey = (key: SettingKey): key is CachedKey =>
  CACHED_KEYS.some((known) => known === key);

/**
 * Keep the cache in step with rows written elsewhere in the process
 * (`SettingsService`); a null value is a forgotten key.
 */
export const noteWritten = (changes: readonly SettingChange[]) => {
  for (const { key, value } of changes) {
    if (isCachedKey(key)) {
      cache.set(key, value ?? undefined);
    }
  }
};

/** `off` is the only stored value that turns a switch off. */
const parseToggle = (raw: string | undefined) => raw !== "off";

/** Whether a switch is on. A failed read rejects and is not cached. */
export const readToggle = async (key: ToggleKey) =>
  parseToggle(await readCached(key));

/**
 * Read the stored language into the i18n module once, at boot. A failed read
 * keeps the default rather than holding the bot back.
 */
export const loadLanguage = async () => {
  try {
    switchLanguage(parseLanguage(await getSetting("bot_language")));
  } catch (error) {
    logError("Language read failed, keeping the default", error);
  }
};
