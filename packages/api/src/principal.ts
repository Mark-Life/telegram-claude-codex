import { Context, Schema } from "effect";

/** The tiers that may hold an API key: the owner and an executor. */
export const KeyHolderTier = Schema.Literals(["owner", "executor"]).annotate({
  description:
    "The holder's access tier, read on every request: `owner` (the bot's owner) or `executor` (works like the owner in their own private chat).",
});

/**
 * Who a request acts as. Every way into the API (today an API key) resolves
 * to one of these, and handlers see only this, never the key itself.
 */
export const PrincipalSchema = Schema.Struct({
  keyId: Schema.String.annotate({ description: "The public id of the key." }),
  keyName: Schema.String.annotate({ description: "The key's name." }),
  telegramUserId: Schema.Int.annotate({
    description: "The Telegram user the key acts as.",
  }),
  tier: KeyHolderTier,
}).annotate({ identifier: "Principal" });

export type Principal = typeof PrincipalSchema.Type;

/** The principal of the request being handled; provided by `ApiAuth`. */
export class CurrentPrincipal extends Context.Service<
  CurrentPrincipal,
  Principal
>()("@workspace/api/CurrentPrincipal") {}
