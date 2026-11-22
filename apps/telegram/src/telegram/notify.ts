import { SettingsRepo } from "@workspace/db";
import { Context, Effect, Layer, Option, Schema } from "effect";

import type { Route } from "./route";
import { TelegramBot } from "./telegram-bot";
import type { SendMessageOther } from "./telegram-bot";

/**
 * Unprompted messages to a target: a silent task's failure, a quota notice,
 * a boot notice, and later the HTTP API's `notify`. A sender names the
 * target; this one place decides where it lands and what happens when a
 * topic is gone.
 */

/**
 * Where a notice goes.
 *
 * - `user`: that user's private chat with the bot.
 * - `workspace`: the workspace, in the topic the owner set it from;
 *   refused with `NoWorkspace` when none is set.
 * - `notify`: the owner's notify route, the workspace once set, else the
 *   owner's private chat.
 */
export type NotifyTarget =
  | { readonly kind: "notify"; readonly ownerId: number }
  | { readonly kind: "user"; readonly userId: number }
  | { readonly kind: "workspace" };

/** A `workspace` notice while the owner has set no workspace. */
// oxlint-disable-next-line unicorn/throw-new-error -- a class factory, not a throw
export class NoWorkspace extends Schema.TaggedError<NoWorkspace>()(
  "NoWorkspace",
  {}
) {}

const makeNotify = Effect.gen(function* makeNotify() {
  const bot = yield* TelegramBot;
  const settings = yield* SettingsRepo;

  /** The route a target resolves to now; none for an unset workspace. */
  const routeOf = Effect.fn("NotifyService.routeOf")(function* routeOf(
    target: NotifyTarget
  ) {
    if (target.kind === "user") {
      const route: Route = { chatId: target.userId, threadId: null };
      return Option.some(route);
    }
    const workspace = yield* settings.workspace();
    if (target.kind === "workspace" || Option.isSome(workspace)) {
      return Option.map(workspace, (found): Route => ({
        chatId: found.chatId,
        threadId: found.threadId,
      }));
    }
    const owner: Route = { chatId: target.ownerId, threadId: null };
    return Option.some(owner);
  });

  /**
   * Send one notice to `target`. When its topic is gone (Telegram answers a
   * bad request or not found) it lands in the chat itself rather than
   * nowhere. Any other failure (a rate limit, a network failure, a ban) would
   * hit the chat the same way, so it fails as is; the TelegramBot service has
   * logged it once.
   */
  const send = Effect.fn("NotifyService.send")(function* send(input: {
    readonly opts?: SendMessageOther;
    readonly target: NotifyTarget;
    readonly text: string;
  }) {
    const found = yield* routeOf(input.target);
    if (Option.isNone(found)) {
      return yield* new NoWorkspace();
    }
    const route = found.value;
    return yield* bot.sendTo(route, input.text, input.opts).pipe(
      Effect.catchTag("TelegramBotError", (error) => {
        const topicGone =
          error.reason === "BadRequest" || error.reason === "NotFound";
        if (route.threadId === null || !topicGone) {
          return Effect.fail(error);
        }
        return Effect.logWarning(
          "Workspace topic delivery failed, using the chat"
        ).pipe(
          Effect.andThen(
            bot.sendTo(
              { chatId: route.chatId, threadId: null },
              input.text,
              input.opts
            )
          )
        );
      })
    );
  });

  return { routeOf, send } as const;
});

/**
 * Notices to a target rather than to a known chat: the notify route
 * (`sendToNotifyRoute`), and later the HTTP API's `notify`. Chat replies stay
 * on grammy's context; a delivery to a stored chat and topic goes straight
 * to `TelegramBot`.
 */
export class NotifyService extends Context.Service<
  NotifyService,
  Effect.Success<typeof makeNotify>
>()("@workspace/telegram/NotifyService") {
  static readonly layer = Layer.effect(NotifyService, makeNotify);
}
