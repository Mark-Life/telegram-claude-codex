/**
 * `work`, or a rejection with the signal's reason as soon as `signal`
 * aborts, whichever comes first. For work that does not end on abort by
 * itself: a control request the Claude SDK keeps pending, a pipe a wrapper
 * script's child keeps open after the wrapper was killed. `Promise.race`
 * subscribes to both, so the loser's later rejection is never an unhandled
 * one.
 */
export const untilAborted = async <T>(
  signal: AbortSignal,
  work: Promise<T>
): Promise<T> => {
  const aborted = Promise.withResolvers<never>();
  const abort = () => {
    aborted.reject(signal.reason);
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) {
    abort();
  }
  try {
    return await Promise.race([work, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
};
