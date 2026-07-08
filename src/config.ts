import { Config, Context, Effect, Layer, Option, Redacted } from "effect";

/**
 * Reads and validates all application configuration from the environment.
 *
 * Required secrets (BOT_TOKEN, GROQ_API_KEY) and ALLOWED_USER_ID fail the
 * layer build when missing or malformed, so misconfiguration surfaces at boot
 * rather than at first use — parity with the old inline process.exit checks.
 */
const load = Effect.gen(function* () {
  const botToken = yield* Config.redacted("BOT_TOKEN");
  if (Redacted.value(botToken).length === 0) {
    yield* Effect.die("BOT_TOKEN must not be empty");
  }

  const allowedUserId = yield* Config.int("ALLOWED_USER_ID");
  if (Number.isNaN(allowedUserId)) {
    yield* Effect.die("ALLOWED_USER_ID must be a number");
  }

  const groqApiKey = yield* Config.redacted("GROQ_API_KEY");

  const projectsDir = yield* Config.string("PROJECTS_DIR").pipe(
    Config.withDefault("/home/agent/projects")
  );

  // Optional API-key fallback: only Some when present and non-empty, so
  // subscription auth stays the default (Option.none => use local login).
  const anthropicApiKey = Option.filter(
    yield* Config.option(Config.redacted("ANTHROPIC_API_KEY")),
    (secret) => Redacted.value(secret).length > 0
  );

  // Tunables previously hard-coded across the codebase.
  const draftIntervalMs = yield* Config.int("DRAFT_INTERVAL_MS").pipe(
    Config.withDefault(300)
  );
  const splitAt = yield* Config.int("SPLIT_AT").pipe(Config.withDefault(4000));

  // Run timeout is OFF by default (operator removed the old 10-min cap).
  // Option.none => unbounded; set RUN_TIMEOUT_MS to opt back into a cap.
  const runTimeoutMs = yield* Config.option(Config.int("RUN_TIMEOUT_MS"));

  const maxConcurrentRuns = yield* Config.int("MAX_CONCURRENT_RUNS").pipe(
    Config.withDefault(4)
  );

  return {
    botToken,
    allowedUserId,
    groqApiKey,
    projectsDir,
    anthropicApiKey,
    draftIntervalMs,
    splitAt,
    runTimeoutMs,
    maxConcurrentRuns,
  } as const;
});

/**
 * AppConfig service: validated, typed, redacted application configuration.
 * Provide `AppConfig.layer` at the composition root; yield `AppConfig`
 * downstream to read the resolved values.
 */
export class AppConfig extends Context.Service<
  AppConfig,
  Effect.Success<typeof load>
>()("@tg/AppConfig") {
  static readonly layer = Layer.effect(AppConfig, load);
}
