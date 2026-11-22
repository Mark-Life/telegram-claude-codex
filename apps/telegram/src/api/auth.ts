import {
  ApiAuth,
  CurrentPrincipal,
  Forbidden,
  RateLimited,
  Unauthorized,
} from "@workspace/api";
import type { Principal } from "@workspace/api";
import { ApiKeyService } from "@workspace/db";
import type { ApiKeyRejected, Tier } from "@workspace/db";
import { AppConfig } from "@workspace/env/bot";
import {
  Clock,
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Predicate,
  Redacted,
  Result,
  Schema,
} from "effect";
import { HttpApiError, OpenApi } from "effect/http-api";
import type { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type { unhandled } from "effect/Types";

import { Observability } from "../observability";
import { recordApiEvent } from "./ledger";
import { bucketsOf, FAILED_AUTH_RATE, KEY_RATES } from "./limits";
import type { RequestClass } from "./limits";

const BEARER_RE = /^Bearer\s+(?<token>\S+)\s*$/iu;

/** Where loopback connections come from: the reverse proxy, or this host. */
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const TOO_MANY_REQUESTS = 429;

/** The key a request carries: `Authorization: Bearer` first, then `x-api-key`. */
const tokenOf = (headers: Readonly<Record<string, string | undefined>>) => {
  const bearer = BEARER_RE.exec(headers.authorization ?? "")?.groups?.token;
  const key = bearer ?? headers["x-api-key"]?.trim();
  return key === undefined || key.length === 0 ? undefined : key;
};

/**
 * The client's address. The API binds loopback, so behind a reverse proxy
 * (`API_PUBLIC_URL` set) every peer is the proxy: then the rightmost
 * `X-Forwarded-For` entry, the one the proxy appended, is the client. The
 * leftmost is the client's own claim and is never read. Without a proxy the
 * header is anyone's to send, so only the peer counts.
 */
const clientOf = (request: HttpServerRequest, behindProxy: boolean) => {
  const peer = Option.getOrElse(request.remoteAddress, () => "unknown");
  if (!(behindProxy && LOOPBACK.has(peer))) {
    return peer;
  }
  const hops = (request.headers["x-forwarded-for"] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return hops.at(-1) ?? peer;
};

/**
 * Rejections that look like guessing: no key of ours, or a wrong secret. A
 * revoked key or a holder who lost their tier is a real key, sent by
 * someone who had it, so it costs the address nothing.
 */
const GUESSES: ReadonlySet<ApiKeyRejected["reason"]> = new Set([
  "malformed",
  "unknown",
]);

/** The parts of a request a schema decodes; the rest are the response's. */
const REQUEST_PARTS: ReadonlySet<HttpApiError.HttpApiSchemaError["kind"]> =
  new Set(["Headers", "Params", "Payload", "Query"]);

/** Whether a schema failure is the caller's (the request), not the server's. */
export const isRequestPart = (kind: HttpApiError.HttpApiSchemaError["kind"]) =>
  REQUEST_PARTS.has(kind);

/**
 * A read or a write, by method. An agent run is a write here too: its own
 * hourly budget is spent where a run really starts (`AgentRuns.submit`), so
 * a refusal or a replay costs it nothing.
 */
const classOf = (endpoint: HttpApiEndpoint.Top): RequestClass =>
  endpoint.method === "GET" ? "read" : "mutation";

/** The operationId the OpenAPI document gives an endpoint. */
export const operationOf = (
  endpoint: HttpApiEndpoint.Top,
  group: HttpApiGroup.Top
) =>
  Option.getOrElse(
    Context.getOption(endpoint.annotations, OpenApi.Identifier),
    () => `${group.identifier}.${endpoint.identifier}`
  );

/** The holder of the key is no longer the owner or an executor. */
const lostAccess = () =>
  new Forbidden({
    message:
      "The holder of this API key no longer has owner or executor access, so the key does nothing.",
  });

/** What a key rejection tells the caller; the log keeps the reason. */
const rejectionOf = (error: ApiKeyRejected) => {
  if (error.reason === "tier") {
    return lostAccess();
  }
  return new Unauthorized({
    message:
      error.reason === "revoked"
        ? "This API key was revoked."
        : "This API key is not valid.",
  });
};

/** Whether a tier is one a key may act as. */
const isKeyHolder = (tier: Tier): tier is Principal["tier"] =>
  tier === "owner" || tier === "executor";

/** How one request's key resolved, kept so a second scheme reads the same. */
type Resolution = Data.TaggedEnum<{
  Failed: { readonly error: Forbidden | Unauthorized };
  Limited: { readonly retryAfterSec: number };
  Resolved: { readonly principal: Principal };
}>;

const { Failed, Limited, Resolved, $match } = Data.taggedEnum<Resolution>();

const encodeRateLimited = Schema.encodeSync(RateLimited);

/** A 429 with `Retry-After`, its body exactly what `RateLimited` declares. */
const limitedResponse = (retryAfterSec: number, message: string) =>
  HttpServerResponse.jsonUnsafe(
    encodeRateLimited(new RateLimited({ message, retryAfterSec })),
    {
      headers: { "retry-after": String(retryAfterSec) },
      status: TOO_MANY_REQUESTS,
    }
  );

const NO_KEY = new Unauthorized({
  message:
    "Send an API key as `Authorization: Bearer <key>` or `x-api-key: <key>`. Make one in Telegram with /apikeys.",
});

const make = Effect.gen(function* makeApiAuth() {
  const keys = yield* ApiKeyService;
  const { allowedUserId, api } = yield* AppConfig;
  const behindProxy = Option.exists(api, (config) =>
    Option.isSome(config.publicUrl)
  );
  const observability = yield* Observability;
  const failedAuth = bucketsOf(FAILED_AUTH_RATE);
  const perKey = {
    mutation: bucketsOf(KEY_RATES.mutation),
    read: bucketsOf(KEY_RATES.read),
  } as const;
  /**
   * Both declared schemes run this middleware in turn until one succeeds; a
   * request is resolved once, so a bad key is counted once and the caller
   * reads the first scheme's answer.
   */
  const resolved = new WeakMap<object, Resolution>();

  const resolve = Effect.fn("ApiAuth.resolve")(function* (
    request: HttpServerRequest
  ) {
    // A valid key always goes through: the failed-auth bucket is read only
    // once the key failed, so guesses from a shared address (every caller
    // without a proxy is the one loopback peer) never lock a real key out.
    const token = tokenOf(request.headers);
    if (token === undefined) {
      return Failed({ error: NO_KEY });
    }
    const checked = yield* keys
      .authenticate({ ownerId: allowedUserId, token: Redacted.make(token) })
      .pipe(
        // A storage failure is the server's, never the caller's: a 500.
        Effect.catchTag("PersistenceError", (error) => Effect.die(error)),
        Effect.result
      );
    if (Result.isFailure(checked)) {
      const { reason } = checked.failure;
      const client = clientOf(request, behindProxy);
      const now = yield* Clock.currentTimeMillis;
      const waiting = GUESSES.has(reason)
        ? failedAuth.take(client, now)
        : failedAuth.peek(client, now);
      yield* Effect.logWarning("api key rejected").pipe(
        Effect.annotateLogs({ client, reason })
      );
      return waiting === undefined
        ? Failed({ error: rejectionOf(checked.failure) })
        : Limited({ retryAfterSec: waiting });
    }
    const { key, tier } = checked.success;
    // `authenticate` lets only these two through; this narrows the type.
    if (!isKeyHolder(tier)) {
      return Failed({ error: lostAccess() });
    }
    return Resolved({
      principal: {
        keyId: key.id,
        keyName: key.name,
        telegramUserId: key.userId,
        tier,
      },
    });
  });

  /** Run the endpoint as `principal`, within its key's budget, audited. */
  const admit = Effect.fn("ApiAuth.admit")(function* (
    httpEffect: Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      unhandled,
      CurrentPrincipal
    >,
    principal: Principal,
    options: {
      readonly endpoint: HttpApiEndpoint.Top;
      readonly group: HttpApiGroup.Top;
    }
  ) {
    const requestClass = classOf(options.endpoint);
    const now = yield* Clock.currentTimeMillis;
    const wait = perKey[requestClass].take(principal.keyId, now);
    if (wait !== undefined) {
      return limitedResponse(
        wait,
        `Too many ${requestClass === "read" ? "reads" : "writes"} with this API key.`
      );
    }
    const handled = httpEffect.pipe(
      Effect.provideService(CurrentPrincipal, principal)
    );
    if (requestClass === "read") {
      return yield* handled;
    }
    // A write or a run is audited: who, which operation, how it ended.
    const audit = (status: string) =>
      recordApiEvent({
        action: "request",
        actor: "api",
        byUserId: principal.telegramUserId,
        holderId: principal.telegramUserId,
        keyId: principal.keyId,
        op: operationOf(options.endpoint, options.group),
        status,
      }).pipe(Effect.provideService(Observability, observability));
    return yield* handled.pipe(
      Effect.tap((response) => audit(String(response.status))),
      // A security middleware sees the endpoint's failure wrapped once
      // (`HandlerError` in HttpApiBuilder), with the typed error inside.
      Effect.tapError((error) => {
        const inner = Predicate.hasProperty(error, "error")
          ? error.error
          : error;
        if (HttpApiError.HttpApiSchemaError.is(inner)) {
          // `InputErrors` turns it into `InvalidInput` outside, or into a
          // 500 when the response, not the request, failed its schema.
          return audit(isRequestPart(inner.kind) ? "InvalidInput" : "500");
        }
        const tag =
          Predicate.hasProperty(inner, "_tag") && Predicate.isString(inner._tag)
            ? inner._tag
            : "error";
        return audit(tag);
      })
    );
  });

  const middleware = Effect.fn("ApiAuth")(function* (
    httpEffect: Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      unhandled,
      CurrentPrincipal
    >,
    options: {
      readonly endpoint: HttpApiEndpoint.Top;
      readonly group: HttpApiGroup.Top;
    }
  ) {
    const request = yield* HttpServerRequest;
    const resolution =
      resolved.get(request.source) ?? (yield* resolve(request));
    resolved.set(request.source, resolution);
    return yield* $match(resolution, {
      Failed: ({ error }) => Effect.fail(error),
      Limited: ({ retryAfterSec }) =>
        Effect.succeed(
          limitedResponse(
            retryAfterSec,
            "Too many failed API keys from this address."
          )
        ),
      Resolved: ({ principal }) => admit(httpEffect, principal, options),
    });
  });

  return ApiAuth.of({ apiKey: middleware, bearer: middleware });
});

/** `ApiAuth` over the bot's own keys, tiers and ledger. */
export const ApiAuthLive = Layer.effect(ApiAuth, make);
