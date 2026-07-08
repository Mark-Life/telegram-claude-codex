import { Context, Data, Effect, Layer, Redacted } from "effect";
import { createBot } from "../bot";
import { AppConfig } from "../config";

/** Tagged failure for an outbound Telegram API call (see phase 3 observability). */
export class TelegramApiError extends Data.TaggedError("TelegramApiError")<{
  readonly cause: unknown;
}> {}

/**
 * Builds the grammy bot (with all handlers registered via createBot) and wraps
 * its lifecycle as a scoped resource: acquire yields the built bot, release
 * calls bot.stop(). Because the layer runs this effect in its own scope,
 * runtime.dispose() tears the bot down deterministically — exactly once.
 *
 * Startup (bot.start + onStart orchestration) stays imperative in index.ts so
 * the startup message and command registration are unchanged; the service owns
 * construction and teardown, not polling start.
 */
const makeBot = Effect.gen(function* () {
  const cfg = yield* AppConfig;
  const bot = createBot(
    Redacted.value(cfg.botToken),
    cfg.allowedUserId,
    cfg.projectsDir
  );

  yield* Effect.acquireRelease(Effect.succeed(bot), () =>
    // bot.stop() throws if the bot was never started; ignore that edge.
    Effect.promise(() =>
      bot.stop().catch(() => {
        // Bot was never started; nothing to stop.
      })
    )
  );

  const send = (
    chatId: number,
    text: string,
    opts?: Parameters<typeof bot.api.sendMessage>[2]
  ) =>
    Effect.tryPromise({
      try: () => bot.api.sendMessage(chatId, text, opts),
      catch: (cause) => new TelegramApiError({ cause }),
    });

  return { bot, api: bot.api, send } as const;
});

/**
 * BotService: the grammy bot and its outbound API as a first-class runtime
 * resource. beta-78 has no Layer.scoped — Layer.effect runs makeBot in the
 * layer scope and discharges Scope, so the acquireRelease finalizer fires on
 * runtime.dispose().
 */
export class BotService extends Context.Service<
  BotService,
  Effect.Success<typeof makeBot>
>()("@tg/BotService") {
  static readonly layer = Layer.effect(BotService, makeBot);
}
