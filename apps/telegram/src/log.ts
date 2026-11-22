import { Cause, Effect } from "effect";

import { runtime } from "./runtime";

/**
 * Log lines for Promise code, written through the app runtime's loggers
 * (console, plus OTLP when configured). `error`, when given, is the cause.
 * Code already inside an Effect uses `Effect.log*` directly.
 */
const logAt =
  (log: typeof Effect.logInfo) =>
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a caught error has no domain type; this is the boundary that logs it
  (message: string, error?: unknown) => {
    runtime.runFork(
      error === undefined ? log(message) : log(message, Cause.fail(error))
    );
  };

export const logInfo = logAt(Effect.logInfo);
export const logWarning = logAt(Effect.logWarning);
export const logError = logAt(Effect.logError);
