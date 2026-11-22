import { Effect, Option, Predicate, Schema } from "effect";

import { AnyResult, openAppServer } from "./codex-app-server";
import type { AppServer } from "./codex-app-server";
import { vendoredCodexBin } from "./codex-sandbox";
import { logOutside } from "./log-sink";
import { minimalEnv } from "./run-env";
import type { ProviderUsage, UsageWindow } from "./types";
import { untilAborted } from "./until-aborted";

/**
 * The Codex subscription's allowance, as Codex's own `/status` reads it:
 * `codex app-server` over stdio, asked which account it holds
 * (`account/read`, answered locally) and that account's rate limits
 * (`account/rateLimits/read`). No turn runs. The CLI holds the token in
 * `auth.json` and refreshes it, so the bot never reads that file.
 */

/** A field the app server sends as null or leaves out when it has no value. */
const Maybe = <S extends Schema.Top>(schema: S) =>
  Schema.optional(Schema.NullOr(schema));

const LimitWindow = Schema.Struct({
  resetsAt: Maybe(Schema.Number),
  usedPercent: Schema.Number,
  windowDurationMins: Maybe(Schema.Number),
});

const LimitBucket = Schema.Struct({
  limitId: Maybe(Schema.String),
  limitName: Maybe(Schema.String),
  planType: Maybe(Schema.String),
  primary: Maybe(LimitWindow),
  rateLimitReachedType: Maybe(Schema.String),
  secondary: Maybe(LimitWindow),
});

type Bucket = typeof LimitBucket.Type;

const RateLimitsAnswer = Schema.Struct({
  ordinaryUsageAllowed: Maybe(Schema.Boolean),
  rateLimits: LimitBucket,
  // Each extra bucket is decoded on its own: one the bot cannot read is
  // dropped rather than losing the account's own windows with it.
  rateLimitsByLimitId: Maybe(Schema.Record(Schema.String, Schema.Unknown)),
});

/** `account/read`: which login the CLI holds, if any. */
const AccountAnswer = Schema.Struct({
  account: Schema.NullOr(Schema.Struct({ type: Schema.String })),
});

const decodeRateLimits = Schema.decodeUnknownOption(RateLimitsAnswer);
const decodeBucket = Schema.decodeUnknownOption(LimitBucket);
const decodeAccount = Schema.decodeUnknownOption(AccountAnswer);

const SECONDS_TO_MS = 1000;

/**
 * The plans the chat names, as OpenAI names them; a billing variant reads
 * as its family. Any other plan id (`unknown`, one added later) is left
 * unnamed rather than shown raw.
 */
const PLAN_NAMES = new Map([
  ["business", "Business"],
  ["edu", "Edu"],
  ["edu_plus", "Edu Plus"],
  ["edu_pro", "Edu Pro"],
  ["ent26", "Enterprise"],
  ["enterprise", "Enterprise"],
  ["enterprise_cbp_automation", "Enterprise"],
  ["enterprise_cbp_usage_based", "Enterprise"],
  ["free", "Free"],
  ["go", "Go"],
  ["plus", "Plus"],
  ["pro", "Pro"],
  ["prolite", "Pro Lite"],
  ["self_serve_business_prolite", "Business"],
  ["self_serve_business_usage_based", "Business"],
  ["team", "Team"],
]);

const toWindow = (
  raw: typeof LimitWindow.Type,
  scope: string | undefined
): UsageWindow => {
  const window: UsageWindow = { usedPercent: raw.usedPercent };
  if (Predicate.isNotNullish(raw.windowDurationMins)) {
    window.minutes = raw.windowDurationMins;
  }
  // A date `Intl` can format; anything past its range reads as no date.
  const resetsAt = (raw.resetsAt ?? Number.NaN) * SECONDS_TO_MS;
  if (!Number.isNaN(new Date(resetsAt).getTime())) {
    window.resetsAt = resetsAt;
  }
  if (scope !== undefined) {
    window.scope = scope;
  }
  return window;
};

const windowsOf = (bucket: Bucket, scope?: string) =>
  [bucket.primary, bucket.secondary].flatMap((raw) =>
    Predicate.isNotNullish(raw) ? [toWindow(raw, scope)] : []
  );

/**
 * The limits answer as the chat shows it. Pure. `rateLimits` is the
 * account's own bucket; every other bucket in `rateLimitsByLimitId` (a model
 * metered apart) follows under its name. A bucket with no name is left out:
 * its windows would read as the account's own.
 */
const parseCodexUsage = (
  answer: typeof RateLimitsAnswer.Type
): ProviderUsage => {
  const main = answer.rateLimits;
  const others = Object.entries(answer.rateLimitsByLimitId ?? {}).flatMap(
    ([key, raw]) =>
      Option.toArray(decodeBucket(raw)).flatMap((bucket) =>
        key === main.limitId ||
        (Predicate.isNotNullish(main.limitId) &&
          bucket.limitId === main.limitId) ||
        Predicate.isNullish(bucket.limitName)
          ? []
          : windowsOf(bucket, bucket.limitName)
      )
  );
  const usage: ProviderUsage = {
    limitReached:
      answer.ordinaryUsageAllowed === false ||
      Predicate.isNotNullish(main.rateLimitReachedType),
    windows: [...windowsOf(main), ...others],
  };
  const plan = PLAN_NAMES.get(main.planType ?? "");
  if (plan !== undefined) {
    usage.plan = plan;
  }
  return usage;
};

/**
 * What `account/read` said: no login, a ChatGPT plan, another login (an API
 * key), or an answer this build cannot read, which leaves it to the limits.
 */
type Login = "none" | "other" | "plan" | "unread";

const loginOf = (answer: Option.Option<typeof AccountAnswer.Type>): Login =>
  Option.match(answer, {
    onNone: () => "unread",
    onSome: ({ account }) => {
      if (account === null) {
        return "none";
      }
      return account.type === "chatgpt" ? "plan" : "other";
    },
  });

/**
 * The app server with plugins and apps off: with them on it syncs the
 * plugin catalogue over git at every start and leaves a temp dir behind in
 * `$CODEX_HOME/.tmp`. `-c` rather than `--disable`, which fails on a flag
 * an older or newer CLI does not know.
 */
const SERVER_ARGS = [
  "app-server",
  "-c",
  "features.plugins=false",
  "-c",
  "features.apps=false",
];

/**
 * Ask in turn: the limits only once `account/read` names a ChatGPT plan, so
 * a logout reads as one rather than as the limits' refusal. Throws why
 * there is no reading, for the log.
 */
const ask = async (server: AppServer): Promise<ProviderUsage> => {
  await server.request(
    "initialize",
    {
      capabilities: null,
      clientInfo: { name: "owner-telegram-bot", title: null, version: "1" },
    },
    AnyResult
  );
  server.notify("initialized");
  const login = loginOf(
    decodeAccount(await server.request("account/read", {}, Schema.Unknown))
  );
  if (login === "none") {
    throw new Error("no account");
  }
  if (login === "other") {
    // A login with no plan behind it (an API key): nothing to report.
    return { limitReached: false, windows: [] };
  }
  const limits = await server.request(
    "account/rateLimits/read",
    { excludeResetCreditDetails: true },
    Schema.Unknown
  );
  return parseCodexUsage(
    Option.getOrThrowWith(
      decodeRateLimits(limits),
      () => new Error("unreadable limits")
    )
  );
};

/**
 * Ask and read the answers. The deadline is raced rather than left to the
 * server: a `codex` that is a wrapper script dies on the kill while the
 * server it started may keep stdout open. The close is not waited for.
 */
const readUsage = async (bin: string, signal: AbortSignal) => {
  const server = openAppServer({
    args: SERVER_ARGS,
    bin,
    env: minimalEnv("codex"),
  });
  try {
    return await untilAborted(signal, ask(server));
  } finally {
    void server.close();
  }
};

/**
 * `AgentProvider.usage` for Codex: start the app server, ask, stop it. The
 * binary runs use is preferred over `bin`, the host's `codex`, which may
 * speak an older protocol; both read the same `CODEX_HOME`. Never rejects;
 * `signal` kills a server that hangs, which ends the read with nothing. Why
 * a read told nothing goes to the log; the chat says it in one sentence.
 */
export const codexUsage = async (
  bin: string,
  signal: AbortSignal
): Promise<ProviderUsage | undefined> => {
  try {
    return await readUsage(vendoredCodexBin() ?? bin, signal);
  } catch (error) {
    logOutside(
      Effect.logWarning("codex.usage read failed", {
        error: error instanceof Error ? error.message : String(error),
      }).pipe(Effect.annotateLogs({ provider: "codex" }))
    );
    return undefined;
  }
};
