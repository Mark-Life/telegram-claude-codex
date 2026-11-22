import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";

import { NotFound } from "../errors";
import { ApiAuth } from "../middleware";
import { IsoTime } from "./shared";

/** One API key as the API shows it: never its secret. */
export const ApiKeySchema = Schema.Struct({
  createdAt: IsoTime,
  createdVia: Schema.Literals(["cli", "telegram"]).annotate({
    description: "Where the key was made: the /apikeys command or the CLI.",
  }),
  hint: Schema.String.annotate({
    description:
      "The key's visible start, `pab_<id>…`; the secret is never shown again.",
  }),
  id: Schema.String.annotate({ description: "The key's public id." }),
  lastUsedAt: Schema.optionalKey(IsoTime),
  name: Schema.String,
  telegramUserId: Schema.Int.annotate({
    description: "The Telegram user the key acts as.",
  }),
}).annotate({ identifier: "ApiKey" });

export type ApiKey = typeof ApiKeySchema.Type;

export const ApiKeyList = Schema.Struct({
  keys: Schema.Array(ApiKeySchema),
}).annotate({ identifier: "ApiKeyList" });

const KeyIdParams = {
  keyId: Schema.String.check(Schema.isPattern(/^[a-z2-7]{12}$/u)).annotate({
    description: "The key's public id, as `keys.list` shows it.",
  }),
};

/**
 * The caller's live API keys, and revoking one. Keys are made only in
 * Telegram (/apikeys) or by the bot's CLI, never here, so a leaked key cannot
 * mint more.
 */
export const KeysGroup = HttpApiGroup.make("keys")
  .add(
    HttpApiEndpoint.get("list", "/v1/keys", {
      success: ApiKeyList,
    }).annotateMerge(
      OpenApi.annotations({
        description:
          "List live API keys.\n\nThe keys of the user this key acts as; the owner sees every key. Revoked keys are left out.",
        identifier: "keys.list",
        summary: "List live API keys",
      })
    ),
    HttpApiEndpoint.post("revoke", "/v1/keys/:keyId/revoke", {
      error: NotFound,
      params: KeyIdParams,
      success: ApiKeySchema,
    }).annotateMerge(
      OpenApi.annotations({
        description:
          "Revoke an API key.\n\nThe key stops working at once, the one making this call included. Only your own keys, or any key for the owner. Answers the revoked key, or `NotFound` when there is no such live key you may see.",
        identifier: "keys.revoke",
        summary: "Revoke an API key",
      })
    )
  )
  .middleware(ApiAuth)
  .annotateMerge(
    OpenApi.annotations({
      description:
        "API keys of the user the key acts as. New keys are made in Telegram with /apikeys.",
      title: "keys",
    })
  );
