import { AppConfig } from "@workspace/env/bot";
import {
  Context,
  Duration,
  Effect,
  Layer,
  Redacted,
  Schedule,
  Schema,
} from "effect";
import { GrammyError, HttpError } from "grammy";
import type { Api, Bot } from "grammy";

import type { BotContext } from "../access/context";
import { createBot } from "./create-bot";
import { threadOpts } from "./route";
import type { Route } from "./route";

/**
 * The failure every outbound Telegram call fails with. `method` is the call's
 * label ("editMessageText"), `reason` the class a caller may match on; the
 * Telegram description is kept for the log, never for matching.
 *
 * - `RateLimited` — 429; `retryAfter` is Telegram's `parameters.retry_after` (s)
 * - `NotModified` — 400 "message is not modified": the edit was a no-op
 * - `BadRequest` — any other 400 (message gone, chat not found, bad markup)
 * - `Forbidden` — 403: blocked by the user, kicked from the chat
 * - `NotFound` — 404
 * - `Other` — any other Telegram error code (401, 409, 5xx)
 * - `Network` — the HTTP call itself failed (grammy `HttpError`)
 * - `Unknown` — anything else thrown inside the call
 */
// oxlint-disable-next-line unicorn/throw-new-error -- a class factory, not a throw
export class TelegramBotError extends Schema.TaggedError<TelegramBotError>()(
  "TelegramBotError",
  {
    cause: Schema.Defect(),
    code: Schema.optional(Schema.Number),
    description: Schema.String,
    method: Schema.String,
    reason: Schema.Literals([
      "RateLimited",
      "NotModified",
      "BadRequest",
      "Forbidden",
      "NotFound",
      "Other",
      "Network",
      "Unknown",
    ]),
    retryAfter: Schema.optional(Schema.Number),
  }
) {
  override get message() {
    return `${this.method} failed (${this.reason})`;
  }
}

export type TelegramBotReason = TelegramBotError["reason"];

const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY_REQUESTS = 429;
const NOT_MODIFIED_TEXT = "message is not modified";

const reasonOfCode = (code: number, description: string): TelegramBotReason => {
  switch (code) {
    case HTTP_TOO_MANY_REQUESTS: {
      return "RateLimited";
    }
    case HTTP_BAD_REQUEST: {
      return description.includes(NOT_MODIFIED_TEXT)
        ? "NotModified"
        : "BadRequest";
    }
    case HTTP_FORBIDDEN: {
      return "Forbidden";
    }
    case HTTP_NOT_FOUND: {
      return "NotFound";
    }
    default: {
      return "Other";
    }
  }
};

/** Classify whatever a grammy call threw as one `TelegramBotError`. */
const toTelegramBotError = (method: string, cause: unknown) => {
  if (cause instanceof GrammyError) {
    return new TelegramBotError({
      cause,
      code: cause.error_code,
      description: cause.description,
      method,
      reason: reasonOfCode(cause.error_code, cause.description),
      retryAfter: cause.parameters.retry_after,
    });
  }
  if (cause instanceof HttpError) {
    return new TelegramBotError({
      cause,
      description: cause.message,
      method,
      reason: "Network",
    });
  }
  return new TelegramBotError({
    cause,
    description: cause instanceof Error ? cause.message : String(cause),
    method,
    reason: "Unknown",
  });
};

const RATE_LIMIT_RETRIES = 3;
/** A wait longer than this is a flood ban, not a hiccup: fail instead. */
const RATE_LIMIT_MAX_WAIT_SECONDS = 60;
const NETWORK_RETRIES = 2;
const NETWORK_BASE_DELAY_MS = 500;
const NETWORK_BACKOFF_FACTOR = 2;

/** Which failures a call may retry; see `UseOptions.retry`. */
export type RetryPolicy = "all" | "rateLimit" | false;

/**
 * How long to wait before retry number `attempt` (1-based), or undefined when
 * this failure is not worth another attempt. A 429 waits exactly what Telegram
 * asked for; a network failure backs off 0.5s, 1s, but only under "all"; every
 * other 4xx is final.
 */
const retryDelay = (
  policy: Exclude<RetryPolicy, false>,
  error: TelegramBotError,
  attempt: number
): Duration.Duration | undefined => {
  if (error.reason === "RateLimited") {
    const seconds = error.retryAfter ?? 1;
    return attempt <= RATE_LIMIT_RETRIES &&
      seconds <= RATE_LIMIT_MAX_WAIT_SECONDS
      ? Duration.seconds(seconds)
      : undefined;
  }
  const retriable =
    policy === "all" &&
    error.reason === "Network" &&
    attempt <= NETWORK_RETRIES;
  return retriable
    ? Duration.millis(
        NETWORK_BASE_DELAY_MS * NETWORK_BACKOFF_FACTOR ** (attempt - 1)
      )
    : undefined;
};

const retrySchedule = (policy: Exclude<RetryPolicy, false>) =>
  Schedule.forever.pipe(
    Schedule.setInputType<TelegramBotError>(),
    Schedule.while(
      ({ attempt, input }) => retryDelay(policy, input, attempt) !== undefined
    ),
    Schedule.modifyDelay(({ attempt, input }) =>
      Effect.succeed(retryDelay(policy, input, attempt) ?? Duration.zero)
    )
  );

const RATE_LIMIT_ONLY = retrySchedule("rateLimit");
const RATE_LIMIT_AND_NETWORK = retrySchedule("all");

/** The one log line of a call that failed for good, retries spent. */
const logFailure = (error: TelegramBotError, level: "debug" | "warn") =>
  (level === "debug"
    ? Effect.logDebug("telegram call failed")
    : Effect.logWarning("telegram call failed")
  ).pipe(
    Effect.annotateLogs({
      code: error.code,
      description: error.description,
      label: error.method,
      reason: error.reason,
    })
  );

/** Per-call switches for `use`. */
export interface UseOptions {
  /**
   * Log level of a final failure. "warn" by default; "debug" for a call whose
   * failure is expected or cosmetic (typing, drafts, superseded edits).
   */
  readonly logLevel?: "debug" | "warn";
  /**
   * Which failures are retried. Default "rateLimit": a 429 is retried after
   * Telegram's `retry_after`, since Telegram rejected the call unapplied. "all"
   * also retries a network failure, which may have hit Telegram after it ran
   * the call — only for an idempotent call (a read, an edit, a delete,
   * setMyCommands), never a send or a create. false for an ephemeral call a
   * later one supersedes (typing, drafts, stream edits) and for a call awaited
   * on grammy's update path, where every wait stalls polling for every chat.
   */
  readonly retry?: RetryPolicy;
}

/** The third parameter of a Bot API method: its body or its extra fields. */
type ThirdParam<F> = F extends (
  a: never,
  b: never,
  c: infer C,
  ...rest: never[]
) => infer _Result
  ? C
  : never;

/** Extra `sendMessage` fields; the topic always comes from the route. */
export type SendMessageOther = Omit<
  NonNullable<ThirdParam<Api["sendMessage"]>>,
  "message_thread_id"
>;
/** A rich message body, as `sendRichMessage` takes it. */
export type RichMessage = Parameters<Api["sendRichMessage"]>[1];
/** Extra `sendRichMessage` fields; the topic always comes from the route. */
export type SendRichOther = Omit<
  NonNullable<ThirdParam<Api["sendRichMessage"]>>,
  "message_thread_id"
>;
/** A rich draft body, as `sendRichMessageDraft` takes it. */
export type RichDraft = ThirdParam<Api["sendRichMessageDraft"]>;

/**
 * Builds the grammy bot and wraps its lifecycle as a scoped resource: acquire
 * yields the built bot, release calls bot.stop(). Because the layer runs this
 * effect in its own scope, runtime.dispose() tears the bot down
 * deterministically — exactly once.
 *
 * Handler registration and startup (bot.start + onStart orchestration) stay
 * imperative in index.ts; the service owns construction, teardown and every
 * outbound call, not wiring or polling.
 */
const make = Effect.gen(function* make() {
  const cfg = yield* AppConfig;
  const { bot, botId } = createBot({ token: Redacted.value(cfg.botToken) });

  yield* Effect.acquireRelease(Effect.succeed(bot), () =>
    // bot.stop() throws if the bot was never started; ignore that edge.
    Effect.promise(async () => {
      await bot.stop().catch(() => {
        // Bot was never started; nothing to stop.
      });
    })
  );

  const use = <A>(
    label: string,
    fn: (api: Api) => Promise<A>,
    opts: UseOptions = {}
  ): Effect.Effect<A, TelegramBotError> => {
    const call = Effect.tryPromise({
      catch: (cause) => toTelegramBotError(label, cause),
      try: async () => await fn(bot.api),
    });
    const policy = opts.retry ?? "rateLimit";
    const schedule =
      policy === "all" ? RATE_LIMIT_AND_NETWORK : RATE_LIMIT_ONLY;
    return (policy === false ? call : call.pipe(Effect.retry(schedule))).pipe(
      Effect.tapError((error) => logFailure(error, opts.logLevel ?? "warn")),
      Effect.withSpan(`TelegramBot.${label}`, {
        attributes: { "telegram.method": label },
      })
    );
  };

  const sendTo = (route: Route, text: string, other?: SendMessageOther) =>
    use(
      "sendMessage",
      async (api) =>
        await api.sendMessage(route.chatId, text, {
          ...other,
          ...threadOpts(route),
        })
    );

  const sendRichTo = (
    route: Route,
    input: RichMessage,
    other?: SendRichOther
  ) =>
    use(
      "sendRichMessage",
      async (api) =>
        await api.sendRichMessage(route.chatId, input, {
          ...other,
          ...threadOpts(route),
        })
    );

  /** A draft is superseded by the next one: never retried, logged at debug. */
  const sendRichDraftTo = (route: Route, draftId: number, input: RichDraft) =>
    use(
      "sendRichMessageDraft",
      async (api) =>
        await api.sendRichMessageDraft(
          route.chatId,
          draftId,
          input,
          threadOpts(route)
        ),
      { logLevel: "debug", retry: false }
    );

  return {
    api: bot.api,
    bot,
    botId,
    sendRichDraftTo,
    sendRichTo,
    sendTo,
    use,
  };
});

/** The bot plus every outbound call, as exposed by TelegramBot. */
export interface TelegramBotHandle {
  /** Raw API, for code that must hand it to grammy itself; calls go through `use`. */
  readonly api: Api;
  readonly bot: Bot<BotContext>;
  readonly botId: number;
  readonly sendRichDraftTo: (
    route: Route,
    draftId: number,
    input: RichDraft
  ) => Effect.Effect<true, TelegramBotError>;
  readonly sendRichTo: (
    route: Route,
    input: RichMessage,
    other?: SendRichOther
  ) => Effect.Effect<
    Awaited<ReturnType<Api["sendRichMessage"]>>,
    TelegramBotError
  >;
  readonly sendTo: (
    route: Route,
    text: string,
    other?: SendMessageOther
  ) => Effect.Effect<Awaited<ReturnType<Api["sendMessage"]>>, TelegramBotError>;
  readonly use: <A>(
    label: string,
    fn: (api: Api) => Promise<A>,
    opts?: UseOptions
  ) => Effect.Effect<A, TelegramBotError>;
}

/**
 * TelegramBot: the grammy bot and every outbound Bot API call as one runtime
 * resource. Named for the Bot API; an MTProto account client would be a
 * separate service with its own errors. Effect v4 has no Layer.scoped —
 * Layer.effect runs `make` in the layer scope, so the acquireRelease finalizer
 * fires on runtime.dispose().
 */
export class TelegramBot extends Context.Service<
  TelegramBot,
  TelegramBotHandle
>()("@workspace/TelegramBot") {
  static readonly layer = Layer.effect(TelegramBot, make);
}
