import path from "node:path";

import {
  Config,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Result,
} from "effect";

import { DATA_DIR } from "./paths";
import "./load-root-env";

const MAX_CONCURRENT_RUNS_DEFAULT = 4;
/**
 * Runs parked on background work at once, apart from the working limit: a
 * parked Claude CLI idles at about 150-250 MB, and the turns its work starts
 * later run on this permit too.
 */
const MAX_BACKGROUND_RUNS_DEFAULT = 20;

/**
 * The model tiers the router picks between, weakest first. The order is what
 * "one tier up" and "the nearest available tier" mean, so it ranks capability,
 * not price. Lives here so `CODEX_TIER_MODELS` is validated at boot.
 */
export const MODEL_TIERS = ["luna", "terra", "sol", "astra"] as const;

export type ModelTier = (typeof MODEL_TIERS)[number];

export type TierModels = Partial<Record<ModelTier, string>>;

/** Whether `name` is one of the router's tiers. */
export const isModelTier = (name: string | undefined): name is ModelTier =>
  MODEL_TIERS.some((tier) => tier === name);

/**
 * Parses a provider's tier map (`luna=gpt-6-luna,terra=gpt-5.6-terra`) into a
 * tier-to-slug map; `envName` is the variable it came from, named in every
 * failure. Fails on an unknown or repeated tier, a pair without `=` or an
 * empty side. A tier left out is simply absent. Blank input => none.
 */
export const parseTierModels = (
  raw: string | undefined,
  envName = "CODEX_TIER_MODELS"
) => {
  if (raw === undefined || raw.trim().length === 0) {
    return Result.succeed(Option.none<TierModels>());
  }
  const models: TierModels = {};
  for (const pair of raw.split(",")) {
    const [name = "", slug = "", ...rest] = pair
      .split("=")
      .map((part) => part.trim());
    if (rest.length > 0 || name.length === 0 || slug.length === 0) {
      return Result.fail(`${envName}: malformed pair "${pair.trim()}"`);
    }
    if (!isModelTier(name)) {
      return Result.fail(
        `${envName}: unknown tier "${name}", expected one of ${MODEL_TIERS.join(", ")}`
      );
    }
    if (models[name] !== undefined) {
      return Result.fail(`${envName}: tier "${name}" given twice`);
    }
    models[name] = slug;
  }
  return Result.succeed(Option.some(models));
};

/** The zone reminders are read in when `DEFAULT_TZ` is unset. */
export const DEFAULT_TZ_FALLBACK = "Europe/Sofia";

/**
 * Parses `DEFAULT_TZ`: an IANA zone this runtime knows. Blank => the fallback.
 * `Intl.DateTimeFormat` throws on a zone it does not know.
 */
export const parseDefaultTz = (raw: string | undefined) => {
  const tz = raw?.trim() ?? "";
  if (tz.length === 0) {
    return Result.succeed(DEFAULT_TZ_FALLBACK);
  }
  const unknown = Result.fail(`DEFAULT_TZ: unknown IANA timezone "${tz}"`);
  try {
    return Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions()
      .timeZone.length > 0
      ? Result.succeed(tz)
      : unknown;
  } catch {
    return unknown;
  }
};

/** How account writes from a run reach Telegram: after a button, or at once. */
export const ACCOUNT_WRITE_MODES = ["confirm", "direct"] as const;

export type AccountWriteMode = (typeof ACCOUNT_WRITE_MODES)[number];

/**
 * Parses `TELEGRAM_ACCOUNT_WRITES`. Blank => `confirm`, the safe side: every
 * send, forward, edit and delete waits for the owner's button.
 */
export const parseAccountWrites = (raw: string | undefined) => {
  const mode = raw?.trim() ?? "";
  if (mode.length === 0) {
    return Result.succeed<AccountWriteMode>("confirm");
  }
  const known = ACCOUNT_WRITE_MODES.find((candidate) => candidate === mode);
  return known === undefined
    ? Result.fail(
        `TELEGRAM_ACCOUNT_WRITES: expected confirm or direct, got "${mode}"`
      )
    : Result.succeed(known);
};

/** Which Executor generation a script task is replayed on. */
export const EXECUTOR_VERSIONS = ["v1", "v2"] as const;

export type ExecutorVersion = (typeof EXECUTOR_VERSIONS)[number];

/** The host cloud Executor v2 serves its MCP endpoint from. */
const EXECUTOR_V2_HOST = "mcp.executor.sh";

/**
 * Parses `EXECUTOR_VERSION`. An explicit value wins; blank => `v2` when the
 * MCP url is on cloud v2's host, else `v1`, which is what every install ran
 * before v2 existed.
 */
export const parseExecutorVersion = (
  raw: string | undefined,
  mcpUrl: string | undefined
) => {
  const version = raw?.trim() ?? "";
  if (version.length === 0) {
    const host =
      mcpUrl !== undefined && URL.canParse(mcpUrl)
        ? new URL(mcpUrl).hostname
        : undefined;
    return Result.succeed<ExecutorVersion>(
      host === EXECUTOR_V2_HOST ? "v2" : "v1"
    );
  }
  const known = EXECUTOR_VERSIONS.find((candidate) => candidate === version);
  return known === undefined
    ? Result.fail(`EXECUTOR_VERSION: expected v1 or v2, got "${version}"`)
    : Result.succeed(known);
};

/**
 * The owner's own Telegram account (MTProto), from `TELEGRAM_API_ID` and
 * `TELEGRAM_API_HASH` (my.telegram.org). Both absent => the feature is off and
 * nothing about the bot changes; only one of them is a typo and stops the boot.
 */
const loadTelegramAccount = Effect.gen(function* loadTelegramAccount() {
  const apiId = Option.filter(
    yield* Config.option(Config.String("TELEGRAM_API_ID")),
    (id) => id.trim().length > 0
  );
  const apiHash = Option.filter(
    yield* Config.option(Config.Redacted("TELEGRAM_API_HASH")),
    (secret) => Redacted.value(secret).trim().length > 0
  );
  if (Option.isNone(apiId) && Option.isNone(apiHash)) {
    return Option.none();
  }
  if (Option.isNone(apiId) || Option.isNone(apiHash)) {
    return yield* Effect.die(
      "TELEGRAM_API_ID and TELEGRAM_API_HASH must be set together"
    );
  }
  const id = Number(apiId.value.trim());
  if (!Number.isSafeInteger(id) || id <= 0) {
    return yield* Effect.die("TELEGRAM_API_ID must be a positive integer");
  }
  const writes = parseAccountWrites(
    Option.getOrUndefined(
      yield* Config.option(Config.String("TELEGRAM_ACCOUNT_WRITES"))
    )
  );
  if (Result.isFailure(writes)) {
    return yield* Effect.die(writes.failure);
  }
  // Port of the loopback MCP server runs reach the account through; 0 lets
  // the OS pick a free one at boot, which is all a run ever needs.
  const mcpPort = yield* Config.Int("TELEGRAM_ACCOUNT_MCP_PORT").pipe(
    Config.withDefault(0)
  );
  return Option.some({
    apiHash: apiHash.value,
    apiId: id,
    mcpPort,
    writes: writes.success,
  });
});

/** The loopback port the HTTP API listens on when `API_PORT` is unset. */
const API_PORT_DEFAULT = 8787;
const PORT_MAX = 65_535;

/**
 * Parses `API_PUBLIC_URL`: the absolute http(s) URL clients reach the API at,
 * without a trailing slash. Blank => none, and the OpenAPI document names the
 * loopback address instead.
 */
export const parseApiPublicUrl = (raw: string | undefined) => {
  const url = raw?.trim().replace(/\/+$/u, "") ?? "";
  if (url.length === 0) {
    return Result.succeed(Option.none<string>());
  }
  const parsed = URL.canParse(url) ? new URL(url) : undefined;
  return parsed !== undefined &&
    (parsed.protocol === "https:" || parsed.protocol === "http:")
    ? Result.succeed(Option.some(url))
    : Result.fail(`API_PUBLIC_URL: expected an http(s) URL, got "${url}"`);
};

/**
 * The HTTP API, from `API_ENABLED` (on with true/yes/on/1/y, off with
 * false/no/off/0/n or unset, any other value fails the boot), `API_PORT` and
 * `API_PUBLIC_URL`. Off => none and nothing listens. It always binds
 * 127.0.0.1: the public side is a reverse proxy's job.
 */
const loadApi = Effect.gen(function* loadApi() {
  const enabled = yield* Config.Boolean("API_ENABLED").pipe(
    Config.withDefault(false)
  );
  if (!enabled) {
    return Option.none();
  }
  const port = yield* Config.Int("API_PORT").pipe(
    Config.withDefault(API_PORT_DEFAULT)
  );
  if (port <= 0 || port > PORT_MAX) {
    return yield* Effect.die(`API_PORT must be 1-${PORT_MAX}, got ${port}`);
  }
  const publicUrl = parseApiPublicUrl(
    Option.getOrUndefined(yield* Config.option(Config.String("API_PUBLIC_URL")))
  );
  if (Result.isFailure(publicUrl)) {
    return yield* Effect.die(publicUrl.failure);
  }
  return Option.some({ port, publicUrl: publicUrl.success });
});

/**
 * Reads and validates all bot configuration from the environment.
 *
 * Required secrets (BOT_TOKEN, GROQ_API_KEY) and ALLOWED_USER_ID fail the
 * layer build when missing or malformed, so misconfiguration surfaces at boot
 * rather than at first use.
 */
const load = Effect.gen(function* load() {
  const botToken = yield* Config.Redacted("BOT_TOKEN");
  if (Redacted.value(botToken).length === 0) {
    yield* Effect.die("BOT_TOKEN must not be empty");
  }

  const allowedUserId = yield* Config.Int("ALLOWED_USER_ID");
  if (Number.isNaN(allowedUserId)) {
    yield* Effect.die("ALLOWED_USER_ID must be a number");
  }

  const groqApiKey = yield* Config.Redacted("GROQ_API_KEY");

  // Where the codex CLI is, when it is not on the service's PATH. Blank => the
  // bot resolves it at boot: PATH first, then the usual user-install
  // directories. See apps/telegram/src/provider-bin.ts for why PATH is not enough.
  const codexBin = Option.filter(
    yield* Config.option(Config.String("CODEX_BIN")),
    (bin) => bin.trim().length > 0
  );

  // Which Claude Code binary runs, instead of the one the agent SDK ships
  // pinned with it. Blank => the bundled binary; a PATH `claude` only tells
  // the bot Claude is installed and logged in. An override moves with that
  // install's own updates.
  const claudeBin = Option.filter(
    yield* Config.option(Config.String("CLAUDE_BIN")),
    (bin) => bin.trim().length > 0
  );

  // Which pi runs. Blank => PATH, then the managed installer's
  // ~/.pi/agent/bin/pi and the usual user bin dirs.
  const piBin = Option.filter(
    yield* Config.option(Config.String("PI_BIN")),
    (bin) => bin.trim().length > 0
  );

  // Where bubblewrap is, when it is not on the service's PATH. Blank => PATH.
  // Found and working, it is the view every run but full access runs in.
  const bwrapBin = Option.filter(
    yield* Config.option(Config.String("BWRAP_BIN")),
    (bin) => bin.trim().length > 0
  );

  // Where socat is, when it is not on the service's PATH. Blank => PATH.
  // Found, every view gets its own network and reaches out through a proxy.
  const socatBin = Option.filter(
    yield* Config.option(Config.String("SOCAT_BIN")),
    (bin) => bin.trim().length > 0
  );

  const projectsDir = yield* Config.String("PROJECTS_DIR").pipe(
    Config.withDefault("/home/agent/projects")
  );

  // The one directory the assistant works in. When set, it replaces the
  // project picker entirely: every run happens here, user files live at the
  // root and the bot's own repo sits in `owner-telegram-bot/`. Absent => the
  // multi-project layout under PROJECTS_DIR.
  const workDir = Option.filter(
    yield* Config.option(Config.String("WORK_DIR")),
    (dir) => dir.trim().length > 0
  );

  // Cloud Executor: the org-scoped MCP endpoint (v1 executor.sh, v2
  // mcp.executor.sh) plus its key (a v1 API key, or a v2 personal access
  // token) minted in its dashboard. Both optional — when either is absent, agent runs
  // get no Executor MCP server wired. The key is a secret => redacted. Blank
  // strings are treated as absent. EXECUTOR_VERSION picks how a script task
  // is replayed: v1's REST `/api/executions` or v2's MCP `execute`.
  const executorMcpUrl = Option.filter(
    yield* Config.option(Config.String("EXECUTOR_MCP_URL")),
    (url) => url.trim().length > 0
  );
  const executorApiKey = Option.filter(
    yield* Config.option(Config.Redacted("EXECUTOR_API_KEY")),
    (secret) => Redacted.value(secret).trim().length > 0
  );
  const executorVersion = parseExecutorVersion(
    Option.getOrUndefined(
      yield* Config.option(Config.String("EXECUTOR_VERSION"))
    ),
    Option.getOrUndefined(executorMcpUrl)
  );
  if (Result.isFailure(executorVersion)) {
    return yield* Effect.die(executorVersion.failure);
  }

  // TypeSafe (typesafe.ai): the four Jev judgments run when a key is present.
  // Set per machine; absent => the model router answers Terra at medium
  // effort, the address judge falls back to the helper provider's cheap
  // one-turn pass (Codex, Claude or pi, or the owner's pick), and the task
  // and reminder judgments are skipped. Blanks are treated as absent.
  const typesafeApiKey = Option.filter(
    yield* Config.option(Config.Redacted("TYPESAFE_API_KEY")),
    (secret) => Redacted.value(secret).trim().length > 0
  );

  // ElevenLabs: text to speech for voice replies (`send-voice-to-user.ts`).
  // Absent => a run that is asked for a voice reply is told voice is not set
  // up, and `/settings` → Голосовые ответы says a key is needed. Blanks are
  // treated as absent.
  const elevenLabsApiKey = Option.filter(
    yield* Config.option(Config.Redacted("ELEVENLABS_API_KEY")),
    (secret) => Redacted.value(secret).trim().length > 0
  );

  // Codex slug per routed tier. Absent => the defaults in the agent package.
  // Parsed again at import by `@workspace/agent`; failing here stops a typo at
  // boot with a clear message.
  const tierModels = parseTierModels(
    Option.getOrUndefined(
      yield* Config.option(Config.String("CODEX_TIER_MODELS"))
    ),
    "CODEX_TIER_MODELS"
  );
  if (Result.isFailure(tierModels)) {
    yield* Effect.die(tierModels.failure);
  }
  // Claude's slug per routed tier, over the family map read from its live
  // model list. Parsed again by `@workspace/agent`, which also drops a slug
  // the account does not offer.
  const claudeTierModels = parseTierModels(
    Option.getOrUndefined(
      yield* Config.option(Config.String("CLAUDE_TIER_MODELS"))
    ),
    "CLAUDE_TIER_MODELS"
  );
  if (Result.isFailure(claudeTierModels)) {
    yield* Effect.die(claudeTierModels.failure);
  }

  // Home zone for reminders. The reminders CLI gives new reminders this zone
  // (it reads the same variable); the formatter leaves it unlabelled.
  const parsedTz = parseDefaultTz(
    Option.getOrUndefined(yield* Config.option(Config.String("DEFAULT_TZ")))
  );
  const defaultTz = Result.isFailure(parsedTz)
    ? yield* Effect.die(parsedTz.failure)
    : parsedTz.success;

  const maxConcurrentRuns = yield* Config.Int("MAX_CONCURRENT_RUNS").pipe(
    Config.withDefault(MAX_CONCURRENT_RUNS_DEFAULT)
  );
  const maxBackgroundRuns = yield* Config.Int("MAX_BACKGROUND_RUNS").pipe(
    Config.withDefault(MAX_BACKGROUND_RUNS_DEFAULT)
  );

  // Wide-event ledger path (one JSON line per run); overridable via TG_LOG_FILE.
  // Resolved against the shared repo-root `.data`, never cwd, so the ledger sits
  // beside state.json whether the bot is started by turbo or directly with bun.
  const eventLogPath = yield* Config.String("TG_LOG_FILE").pipe(
    Config.withDefault("events.jsonl"),
    Config.map((file) => path.resolve(DATA_DIR, file))
  );

  const telegramAccount = yield* loadTelegramAccount;
  const api = yield* loadApi;

  return {
    allowedUserId,
    api,
    botToken,
    bwrapBin,
    claudeBin,
    codexBin,
    defaultTz,
    elevenLabsApiKey,
    eventLogPath,
    executorApiKey,
    executorMcpUrl,
    executorVersion: executorVersion.success,
    groqApiKey,
    maxBackgroundRuns,
    maxConcurrentRuns,
    piBin,
    projectsDir,
    socatBin,
    telegramAccount,
    typesafeApiKey,
    workDir,
  } as const;
});

/**
 * AppConfig service: validated, typed, redacted bot configuration.
 * Provide `AppConfig.layer` at the composition root; yield `AppConfig`
 * downstream to read the resolved values.
 */
export class AppConfig extends Context.Service<
  AppConfig,
  Effect.Success<typeof load>
>()("@workspace/AppConfig") {
  static readonly layer = Layer.effect(AppConfig, load);
}
