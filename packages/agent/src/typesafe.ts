import { TypeSafeClient } from "@typesafe-ai/sdk";
import type {
  Questions,
  SystemOneRequest,
  SystemOneResult,
} from "@typesafe-ai/sdk";
import { AppConfig } from "@workspace/env/bot";
import { Context, Duration, Effect, Layer, Option, Redacted } from "effect";

/**
 * The one TypeSafe client in the process. Every judgment the bot makes on Jev
 * goes through `ask`, which never fails: no key, bad config, an API error or a
 * spent budget all answer `Option.none`, and each caller decides what that
 * means for its own feature.
 */

/** Pinned: every threshold in this package was measured on this version. */
export const JEV_MODEL = "jev-1.13.0";

/** What one caller spends: per attempt, in total, and how many tries. */
export interface AskOptions {
  budgetMs: number;
  /** Retries after the first attempt; `0` when the budget has no room. */
  retries: number;
  span: string;
  timeoutMs: number;
}

/** Client default; every call overrides it with its own per-attempt budget. */
const DEFAULT_TIMEOUT_MS = 2500;

const NO_KEY_NOTE =
  "TYPESAFE_API_KEY unset — every thread runs on the fallback model, the address judge uses the helper pass, the task and reminder judgments are skipped";

const buildClient = (apiKey: Option.Option<string>) =>
  Option.match(apiKey, {
    onNone: () =>
      Effect.as(Effect.logInfo(NO_KEY_NOTE), Option.none<TypeSafeClient>()),
    onSome: (key) =>
      // The constructor validates the key and the runtime, and throws; a
      // throw here arrives as a defect, which catchCause also covers.
      Effect.sync(
        () =>
          new TypeSafeClient({
            apiKey: key,
            defaultModel: JEV_MODEL,
            retry: { maxRetries: 1 },
            timeout: DEFAULT_TIMEOUT_MS,
          })
      ).pipe(
        Effect.map(Option.some),
        Effect.catchCause((cause) =>
          Effect.as(
            Effect.logWarning("TypeSafe client unusable", cause),
            Option.none<TypeSafeClient>()
          )
        )
      ),
  });

const make = Effect.gen(function* make() {
  const cfg = yield* AppConfig;
  const client = yield* buildClient(
    Option.map(cfg.typesafeApiKey, Redacted.value)
  );

  const ask = <const Q extends Questions>(
    request: SystemOneRequest<Q>,
    options: AskOptions
  ) =>
    Option.match(client, {
      onNone: () => Effect.succeed(Option.none<SystemOneResult<Q>>()),
      onSome: (jev) =>
        Effect.tryPromise(
          // The signal is the hard stop: it cancels the attempt in flight and
          // any retry still pending, which an Effect timeout alone does not.
          async (signal) =>
            await jev.systemOne(request, {
              retry: { maxRetries: options.retries },
              signal,
              timeout: options.timeoutMs,
            })
        ).pipe(
          Effect.timeout(Duration.millis(options.budgetMs)),
          Effect.map(Option.some),
          Effect.withSpan(options.span),
          Effect.catchCause((cause) =>
            Effect.as(
              Effect.logWarning("TypeSafe call failed", cause),
              Option.none<SystemOneResult<Q>>()
            )
          )
        ),
    });

  return { ask } as const;
});

/**
 * TypeSafeAi: the Jev client as an Effect resource — key from AppConfig, one
 * span per call, and an answer that is always optional.
 */
export class TypeSafeAi extends Context.Service<
  TypeSafeAi,
  Effect.Success<typeof make>
>()("@workspace/TypeSafeAi") {
  static readonly layer = Layer.effect(TypeSafeAi, make);
}

/** Effect accessor — run it through the app's ManagedRuntime. */
export const askJev = <const Q extends Questions>(
  request: SystemOneRequest<Q>,
  options: AskOptions
) => Effect.flatMap(TypeSafeAi, (ts) => ts.ask(request, options));
