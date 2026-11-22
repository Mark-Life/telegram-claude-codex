import {
  BotApi,
  Conflict,
  CurrentPrincipal,
  Forbidden,
  Unavailable,
} from "@workspace/api";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { isOwner } from "../access/tier";
import { NotifyService } from "../telegram/notify";
import type { NotifyTarget } from "../telegram/notify";
import type { TelegramBotError } from "../telegram/telegram-bot";
import { field } from "./views";

/**
 * `notify.send`: a door over `NotifyService`, the one place unprompted
 * notices land (the topic-gone fallback included). Plain text with link
 * previews off: the text comes from a program, so nothing in it is parsed as
 * markup or unfurled into a preview.
 */

/** Why Telegram refused, as the caller can act on it. */
const telegramFailure = (error: TelegramBotError) => {
  if (error.reason === "Forbidden" || error.reason === "BadRequest") {
    return new Conflict({
      message: `Telegram refused the message (${error.description}). For \`me\`, start a private chat with the bot first; for \`workspace\`, check that the bot is still in the group.`,
    });
  }
  return new Unavailable({
    message: `Telegram did not take the message (${error.reason}). Try again later.`,
  });
};

export const NotifyLive = HttpApiBuilder.group(
  BotApi,
  "notify",
  Effect.fnUntraced(function* (handlers) {
    const notify = yield* NotifyService;
    return handlers.handle("send", ({ payload }) =>
      Effect.gen(function* () {
        const principal = yield* CurrentPrincipal;
        const to = payload.to ?? "me";
        if (to === "workspace" && !isOwner(principal.tier)) {
          return yield* new Forbidden({
            message: "Only the owner sends notices to the workspace.",
          });
        }
        const target: NotifyTarget =
          to === "me"
            ? { kind: "user", userId: principal.telegramUserId }
            : { kind: "workspace" };
        const sent = yield* notify
          .send({
            opts: { link_preview_options: { is_disabled: true } },
            target,
            text: payload.text,
          })
          .pipe(
            Effect.catchTag("NoWorkspace", () =>
              Effect.fail(
                new Conflict({
                  message:
                    "No workspace is set. The owner sets one with /setworkspace in a group topic.",
                })
              )
            ),
            Effect.catchTag("TelegramBotError", (error) =>
              Effect.fail(telegramFailure(error))
            ),
            // The settings read failing is the server's, never the caller's.
            Effect.catchTag("PersistenceError", Effect.die)
          );
        return {
          chatId: sent.chat.id,
          messageId: sent.message_id,
          ...field("threadId", sent.message_thread_id),
        };
      })
    );
  })
);
