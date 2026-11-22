import { Schema } from "effect";

/**
 * Every failure the API answers with: `{_tag, message}` plus a status code,
 * so a client (and Executor, which passes the body through as the tool's
 * error) can branch on `_tag` and show `message` as it is.
 */

// oxlint-disable unicorn/throw-new-error -- class factories, not throws

/** No usable API key: missing, malformed, unknown or revoked. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  {
    description:
      "The request carries no valid API key. Send it as `Authorization: Bearer <key>` or `x-api-key: <key>`.",
    httpApiStatus: 401,
  }
) {}

/** The key is valid, but its holder may not do this. */
export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  { message: Schema.String },
  {
    description:
      "The key is valid but its holder may not do this, for example a key whose holder lost their access.",
    httpApiStatus: 403,
  }
) {}

/** Nothing by that id that this key may see. */
export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { message: Schema.String },
  {
    description: "Nothing with that id exists that this key may see.",
    httpApiStatus: 404,
  }
) {}

/** The request did not match the schema of the endpoint. */
export class InvalidInput extends Schema.TaggedError<InvalidInput>()(
  "InvalidInput",
  { message: Schema.String },
  {
    description:
      "The path, query, headers or body did not match the endpoint's schema. `message` says what was wrong.",
    httpApiStatus: 422,
  }
) {}

/** Too many requests; try again after `retryAfterSec` seconds. */
export class RateLimited extends Schema.TaggedError<RateLimited>()(
  "RateLimited",
  { message: Schema.String, retryAfterSec: Schema.Int },
  {
    description:
      "Too many requests for this key, or too many failed keys from this address. Wait `retryAfterSec` seconds (also sent as `Retry-After`).",
    httpApiStatus: 429,
  }
) {}

/** The request is valid, but the bot's state does not allow it now. */
export class Conflict extends Schema.TaggedError<Conflict>()(
  "Conflict",
  { message: Schema.String },
  {
    description:
      "The request is well-formed, but the bot's current state does not allow it, for example a notice to the workspace while none is set. `message` says what to change.",
    httpApiStatus: 409,
  }
) {}

/** Telegram, or something else the bot depends on, did not answer. */
export class Unavailable extends Schema.TaggedError<Unavailable>()(
  "Unavailable",
  {
    message: Schema.String,
    retryAfterSec: Schema.optionalKey(Schema.Int),
  },
  {
    description:
      "Something the bot depends on (usually Telegram) failed or did not answer, or every agent run slot is busy. Nothing was done; try again later, after `retryAfterSec` seconds when it is given (also sent as `Retry-After`).",
    httpApiStatus: 503,
  }
) {}

/** The request body is larger than the API reads. */
export class PayloadTooLarge extends Schema.TaggedError<PayloadTooLarge>()(
  "PayloadTooLarge",
  { message: Schema.String },
  {
    description:
      "The request body is larger than the API reads: about 940 KiB, enough for a `runs.create` at its longest prompt and input in any JSON encoding. Nothing was done; send less.",
    httpApiStatus: 413,
  }
) {}
