import { Effect } from "effect";

import { logOutside } from "./log-sink";

/** Fork one log line tagged as Claude's; for code outside an Effect. */
export const claudeLog = (effect: Effect.Effect<void>) => {
  logOutside(effect.pipe(Effect.annotateLogs({ provider: "claude" })));
};
