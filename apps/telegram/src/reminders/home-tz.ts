import { readCached } from "../bot-settings";
import { resolveZone } from "./zone";

/**
 * The home zone: the one a new reminder gets when its run names none, and the
 * one reminders are listed in without a zone label. The owner's `default_tz`
 * setting, else `DEFAULT_TZ`. `reminders-cli.ts` reads the same row on its own.
 * A reminder keeps the zone it was made in.
 */

/** The home zone now. A failed read or a stored zone gone bad keeps `fallback`. */
export const readHomeTz = async (fallback: string) => {
  try {
    const stored = await readCached("default_tz");
    return stored === undefined ? fallback : (resolveZone(stored) ?? fallback);
  } catch {
    return fallback;
  }
};
