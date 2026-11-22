import { Config, Effect, Layer, Logger, References } from "effect";

/**
 * LOG_FORMAT selects the console logger encoding.
 * Defaults to "pretty" on a TTY, "logfmt" otherwise (systemd/CI/Docker).
 */
const LOG_FORMATS = ["pretty", "logfmt", "json"] as const;

const logFormatConfig = Config.Literals(LOG_FORMATS, "LOG_FORMAT").pipe(
  Config.withDefault(process.stdout.isTTY ? "pretty" : "logfmt")
);

/**
 * LOG_LEVEL selects the minimum emitted severity. Defaults to "Info".
 * Accepts any Effect LogLevel: All|Fatal|Error|Warn|Info|Debug|Trace|None.
 */
const logLevelConfig = Config.LogLevel("LOG_LEVEL").pipe(
  Config.withDefault("Info")
);

/**
 * Resolves the console logger matching the requested LOG_FORMAT.
 * consoleJson / consoleLogFmt are values; consolePretty is a factory.
 */
const consoleLoggerFor = (format: (typeof LOG_FORMATS)[number]) => {
  if (format === "json") {
    return Logger.consoleJson;
  }
  if (format === "logfmt") {
    return Logger.consoleLogFmt;
  }
  return Logger.consolePretty();
};

/**
 * Format-switching logger layer — the sole console sink under ManagedRuntime
 * (which installs no default logger). Reads LOG_FORMAT/LOG_LEVEL from the
 * ambient env and installs the matching logger + minimum level.
 */
export const loggerLayer = Layer.unwrap(
  Effect.gen(function* loggerLayer() {
    const format = yield* logFormatConfig;
    const level = yield* logLevelConfig;
    return Layer.mergeAll(
      Logger.layer([consoleLoggerFor(format)]),
      Layer.succeed(References.MinimumLogLevel, level)
    );
  })
);
