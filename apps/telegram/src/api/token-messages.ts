import { ApiKeyService, TOKEN_MESSAGE_MINUTES } from "@workspace/db";
import { Clock, Effect, Schedule } from "effect";

import { TelegramBot } from "../telegram/telegram-bot";

/**
 * A new key's token reaches its holder once, in a DM (from `/apikeys` or the
 * apikeys CLI), and the bot deletes that DM after a while, so the token does
 * not sit in the chat history. The DM is noted on the key's row, so a
 * restart, or a CLI that has long exited, still gets it deleted.
 */

const MINUTE_MS = 60_000;
const SWEEP_INTERVAL_MS = MINUTE_MS;

/**
 * Failures that mean the DM cannot be deleted at all (gone already, too old
 * for the Bot API, the chat blocked the bot): forget it rather than retry.
 */
const GONE = new Set(["BadRequest", "Forbidden", "NotFound"]);

/** Delete every token DM that is due: old enough, or its key revoked. */
const sweepOnce = Effect.gen(function* () {
  const keys = yield* ApiKeyService;
  const bot = yield* TelegramBot;
  const now = yield* Clock.currentTimeMillis;
  const due = yield* keys.tokenMessagesDue(
    now - TOKEN_MESSAGE_MINUTES * MINUTE_MS
  );
  for (const message of due) {
    const deleted = yield* bot
      .use(
        "deleteMessage",
        async (api) =>
          await api.deleteMessage(message.chatId, message.messageId),
        { logLevel: "debug", retry: "all" }
      )
      .pipe(
        Effect.as(true),
        Effect.catchTag("TelegramBotError", (error) =>
          Effect.succeed(GONE.has(error.reason))
        )
      );
    if (deleted) {
      yield* keys.forgetTokenMessage(message.id);
    }
  }
}).pipe(
  Effect.catch((error) => Effect.logWarning("Token DM sweep failed", error)),
  Effect.withSpan("ApiKeys.sweepTokenMessages")
);

/** Sweep every minute until the caller's scope closes. */
export const startTokenMessageSweep = sweepOnce.pipe(
  Effect.repeat(Schedule.fixed(SWEEP_INTERVAL_MS)),
  Effect.forkScoped,
  Effect.asVoid
);
