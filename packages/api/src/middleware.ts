import { HttpApiMiddleware, HttpApiSecurity, OpenApi } from "effect/http-api";

import {
  Forbidden,
  InvalidInput,
  PayloadTooLarge,
  RateLimited,
  Unauthorized,
} from "./errors";
import type { CurrentPrincipal } from "./principal";

/** `Authorization: Bearer pab_…`, the scheme most clients send by default. */
const bearer = HttpApiSecurity.bearer.pipe(
  HttpApiSecurity.annotate(
    OpenApi.Description,
    "An API key from the bot's /apikeys command, as `Authorization: Bearer pab_…`."
  )
);

/** `x-api-key: pab_…`, for clients that cannot set `Authorization`. */
const apiKey = HttpApiSecurity.apiKey({ key: "x-api-key" }).pipe(
  HttpApiSecurity.annotate(
    OpenApi.Description,
    "The same API key, as an `x-api-key` header."
  )
);

/**
 * Resolves a request's API key into the `CurrentPrincipal` it acts as, and
 * rate-limits it. Attached to every group except the public ones.
 */
export class ApiAuth extends HttpApiMiddleware.Service<
  ApiAuth,
  { provides: CurrentPrincipal }
>()("@workspace/api/ApiAuth", {
  error: [Unauthorized, Forbidden, RateLimited],
  security: { apiKey, bearer },
}) {}

/**
 * Turns a request that fails its schema into `InvalidInput` (422). A body
 * over `REQUEST_BODY_MAX_BYTES` is `PayloadTooLarge` (413), answered by the
 * server before any endpoint; it is declared here so every endpoint lists it.
 */
export class InputErrors extends HttpApiMiddleware.Service<InputErrors>()(
  "@workspace/api/InputErrors",
  { error: [InvalidInput, PayloadTooLarge] }
) {}
