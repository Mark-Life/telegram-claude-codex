import { Config, Context, Effect, Layer, Option, Redacted } from "effect";
import {
  DEFAULT_CLAUDE_SETTINGS,
  mergeClaudeSettings,
  parseClaudeSettings,
} from "./agent/claude-settings";

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

  // Cloud Executor (executor.sh): the org-scoped MCP endpoint plus an API key
  // minted in its dashboard. Both optional — when either is absent, agent runs
  // get no Executor MCP server wired (see buildExecutorMcpServers). The key is
  // a secret => redacted. Blank strings are treated as absent.
  const executorMcpUrl = Option.filter(
    yield* Config.option(Config.string("EXECUTOR_MCP_URL")),
    (url) => url.trim().length > 0
  );
  const executorApiKey = Option.filter(
    yield* Config.option(Config.redacted("EXECUTOR_API_KEY")),
    (secret) => Redacted.value(secret).trim().length > 0
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

  // Wide-event ledger path (one JSON line per run); overridable via TG_LOG_FILE.
  const eventLogPath = yield* Config.string("TG_LOG_FILE").pipe(
    Config.withDefault(".data/events.jsonl")
  );

  // Claude Agent SDK settings passed to every run. Defaults harden the headless
  // agent (see DEFAULT_CLAUDE_SETTINGS); CLAUDE_SETTINGS_JSON overlays a JSON
  // override and dies at boot on malformed JSON (fail-fast parity).
  const claudeSettingsJson = yield* Config.option(
    Config.string("CLAUDE_SETTINGS_JSON")
  );
  const claudeSettings = yield* Option.match(claudeSettingsJson, {
    onNone: () => Effect.succeed(DEFAULT_CLAUDE_SETTINGS),
    onSome: (json) =>
      Effect.gen(function* () {
        try {
          return mergeClaudeSettings(
            DEFAULT_CLAUDE_SETTINGS,
            parseClaudeSettings(json)
          );
        } catch {
          return yield* Effect.die("CLAUDE_SETTINGS_JSON must be valid JSON");
        }
      }),
  });

  return {
    botToken,
    allowedUserId,
    groqApiKey,
    projectsDir,
    anthropicApiKey,
    executorMcpUrl,
    executorApiKey,
    draftIntervalMs,
    splitAt,
    runTimeoutMs,
    maxConcurrentRuns,
    eventLogPath,
    claudeSettings,
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
