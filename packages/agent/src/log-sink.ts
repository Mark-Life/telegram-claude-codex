import { Effect } from "effect";

type LogLine = Effect.Effect<void>;

/**
 * Where a log line from code outside an Effect goes: a socket callback, a
 * child's exit. The app pins its own runtime's services at boot, so these
 * lines reach its logger, `LOG_LEVEL`, `LOG_FORMAT` and OTLP like any other.
 * Until then (tests, the CLIs) they run on Effect's default runtime.
 */
let sink = (line: LogLine) => {
  Effect.runFork(line);
};

/** Send later log lines through the services of the Effect that runs this. */
export const pinLogSink = Effect.gen(function* () {
  const services = yield* Effect.context();
  const run = Effect.runForkWith(services);
  sink = (line) => {
    run(line);
  };
});

/** Fork one log line through the pinned sink. */
export const logOutside = (line: LogLine) => {
  sink(line);
};
