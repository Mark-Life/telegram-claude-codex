import { resizeRuns } from "@workspace/agent";

import { readCached } from "./bot-settings";
import { runtime } from "./runtime";

/**
 * How many agent runs may go at once across every conversation: the owner's
 * `max_concurrent_runs` setting, else `MAX_CONCURRENT_RUNS`. The run registry
 * is built with the env value; boot and every write hand it the one in force.
 */

/** The values a press on the `/settings` row cycles through. */
// oxlint-disable-next-line eslint/no-magic-numbers -- the ladder is menu data
export const RUN_LIMIT_PRESETS = [1, 2, 3, 5] as const;

/** A stored limit; anything but a positive count reads as unset. */
export const parseRunLimit = (raw: string | undefined) => {
  const count = Number(raw);
  return raw !== undefined && Number.isSafeInteger(count) && count > 0
    ? count
    : undefined;
};

/** The limit in force. A failed read keeps `fallback`; the bridge logged it. */
export const readRunLimit = async (fallback: number) => {
  try {
    return parseRunLimit(await readCached("max_concurrent_runs")) ?? fallback;
  } catch {
    return fallback;
  }
};

/** Hand the limit in force to the run registry, at boot. */
export const loadRunLimit = async (fallback: number) => {
  await runtime.runPromise(resizeRuns(await readRunLimit(fallback)));
};
