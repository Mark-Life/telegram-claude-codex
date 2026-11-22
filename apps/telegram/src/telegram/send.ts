import { Effect } from "effect";

import type { Route } from "./route";
import { TelegramBot } from "./telegram-bot";
import type { TelegramBotError } from "./telegram-bot";

/** A rich message body: model text as raw markdown, or bot chrome as Telegram HTML */
export type RichInput = { markdown: string } | { html: string };

/** Everything a persisted send needs: what to send and where it lands. */
export interface SendArgs {
  input: RichInput;
  /** Plain-text fallback used when the rich send fails. */
  plain?: string;
  route: Route;
}

/**
 * For a stream send whose failure must not stop the stream: TelegramBot already
 * logged it once with its label and reason, so the failure is dropped here.
 */
export const dropTelegramFailure = <A, R>(
  self: Effect.Effect<A, TelegramBotError, R>
) => self.pipe(Effect.catchTag("TelegramBotError", () => Effect.void));

/**
 * Persist a rich message, falling back to plain text only when Telegram
 * rejected the rich one as a bad request (its markup). A rate limit, a network
 * failure or a ban would hit the plain send the same way — and a network
 * failure may already have delivered the rich one — so those fail with the
 * rich send's `TelegramBotError` as is.
 */
export const sendRichSafe = ({ input, plain, route }: SendArgs) =>
  Effect.gen(function* () {
    const bot = yield* TelegramBot;
    return yield* bot.sendRichTo(route, input).pipe(
      Effect.catchIf(
        (error) => error.reason === "BadRequest",
        () => {
          const fallback =
            plain ?? ("markdown" in input ? input.markdown : input.html);
          return bot.sendTo(route, fallback || "...");
        }
      )
    );
  });
