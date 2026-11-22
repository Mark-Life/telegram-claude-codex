import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";

import { Conflict, Forbidden, Unavailable } from "../errors";
import { ApiAuth } from "../middleware";

/** Telegram's limit on one message's text. */
export const NOTIFY_MAX_CHARS = 4096;

export const NotifyTarget = Schema.Literals(["me", "workspace"]).annotate({
  description:
    "`me`: your own private chat with the bot. `workspace`: the owner's workspace group, in the topic it was set from (owner only).",
});

export const NotifyRequest = Schema.Struct({
  text: Schema.String.check(
    Schema.isNonEmpty(),
    // Telegram refuses a text of only whitespace as empty.
    Schema.isPattern(/\S/u, { message: "`text` cannot be empty." }),
    Schema.isMaxLength(NOTIFY_MAX_CHARS)
  ).annotate({
    description:
      "The message, sent as plain text with link previews off. Up to 4096 characters, not only whitespace.",
  }),
  to: Schema.optionalKey(
    NotifyTarget.annotate({ description: "Where it goes; `me` when absent." })
  ),
}).annotate({ identifier: "NotifyRequest" });

export const NotifySent = Schema.Struct({
  chatId: Schema.Int.annotate({ description: "The chat it landed in." }),
  messageId: Schema.Int.annotate({ description: "The message's id there." }),
  threadId: Schema.optionalKey(
    Schema.Int.annotate({ description: "The topic it landed in, if any." })
  ),
}).annotate({ identifier: "NotifySent" });

export const NotifyGroup = HttpApiGroup.make("notify")
  .add(
    HttpApiEndpoint.post("send", "/v1/notify", {
      error: [Conflict, Forbidden, Unavailable],
      payload: NotifyRequest,
      success: NotifySent,
    }).annotateMerge(
      OpenApi.annotations({
        description:
          "Send a Telegram message from the bot.\n\nTo your own private chat with the bot, or (owner only) to the workspace. Plain text, link previews off; the bot does not read or answer it. `Conflict` when the bot cannot write there (no workspace set, or you never started the bot); `Unavailable` when Telegram failed.",
        identifier: "notify.send",
        summary: "Send a Telegram message from the bot",
      })
    )
  )
  .middleware(ApiAuth)
  .annotateMerge(
    OpenApi.annotations({
      description:
        "Messages from the bot to you or the workspace, without running the agent.",
      title: "notify",
    })
  );
