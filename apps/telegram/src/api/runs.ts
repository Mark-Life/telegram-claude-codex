import {
  BotApi,
  Conflict,
  CurrentPrincipal,
  NotFound,
  RateLimited,
  Unavailable,
} from "@workspace/api";
import type { Principal, Run } from "@workspace/api";
import type { ApiRunEntry } from "@workspace/db";
import { Effect, Option } from "effect";
import { absurd } from "effect/Function";
import { HttpApiBuilder } from "effect/http-api";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { AgentRuns } from "../runs/agent-runs";
import type { RunRefused } from "../runs/agent-runs";
import { field, isoOf, optionalIso } from "./views";

/**
 * Agent runs over HTTP: a door over `AgentRuns`. A run is the key's holder
 * writing to the bot in their private chat; who may read or cancel it is the
 * holder, or the owner for every run.
 */

/** A run as the API shows it, with the writes it still waits on. */
const runView = (
  run: ApiRunEntry,
  pending: readonly { readonly id: number; readonly kind: string }[]
): Run => ({
  createdAt: isoOf(run.createdAt),
  deliver: run.deliver,
  ...field("error", run.error),
  ...field("finishedAt", optionalIso(run.finishedAt)),
  ...field("model", run.model),
  ...field("pendingAccountActions", pending.length > 0 ? pending : undefined),
  profile: run.profile,
  ...field("provider", run.provider),
  ...field(
    "result",
    run.status === "succeeded"
      ? {
          ...field("costUsd", run.costUsd),
          ...field(
            "notified",
            run.notifiedChatId === undefined ||
              run.notifiedMessageId === undefined
              ? undefined
              : {
                  chatId: run.notifiedChatId,
                  messageId: run.notifiedMessageId,
                }
          ),
          text: run.resultText ?? "",
          truncated: run.resultTruncated,
        }
      : undefined
  ),
  runId: run.id,
  status: run.status,
});

/** `Retry-After` on whatever response this request ends with. */
const retryAfter = (seconds: number) =>
  HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(
      HttpServerResponse.setHeader(response, "retry-after", String(seconds))
    )
  );

/** A refusal as the caller can act on it. */
const refusedAs = (refused: RunRefused) =>
  Effect.gen(function* () {
    const wait = refused.retryAfterSec;
    if (wait !== undefined) {
      yield* retryAfter(wait);
    }
    switch (refused.reason) {
      case "idempotency": {
        return yield* new Conflict({
          message:
            "This Idempotency-Key already started a run with another request. Send a new key for a new request.",
        });
      }
      case "busy": {
        return yield* new Unavailable({
          message:
            "Every agent run slot is busy. Nothing was started; try again later.",
          retryAfterSec: wait ?? 0,
        });
      }
      case "budget": {
        return yield* new RateLimited({
          message: "Too many runs with this API key this hour.",
          retryAfterSec: wait ?? 0,
        });
      }
      case "perUser": {
        return yield* new RateLimited({
          message:
            "You already have the most runs going at once. Wait for one to end.",
          retryAfterSec: wait ?? 0,
        });
      }
      default: {
        return absurd<never>(refused.reason);
      }
    }
  });

const viewerOf = (principal: Principal) => ({
  tier: principal.tier,
  userId: principal.telegramUserId,
});

const missing = (id: number) =>
  new NotFound({ message: `No run ${id} that this key may see.` });

export const RunsLive = HttpApiBuilder.group(
  BotApi,
  "runs",
  Effect.fnUntraced(function* (handlers) {
    const runs = yield* AgentRuns;

    /** The run as the API shows it, or `NotFound`. */
    const shown = (id: number, found: Option.Option<ApiRunEntry>) =>
      Effect.gen(function* () {
        if (Option.isNone(found)) {
          return yield* missing(id);
        }
        const pending = yield* runs
          .pendingActionsOf(id)
          // The db failing is the server's, never the caller's: a 500.
          .pipe(Effect.orDie);
        return runView(found.value, pending);
      });

    return handlers
      .handle("create", ({ headers, payload }) =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          const { run } = yield* runs
            .submit({
              idempotencyKey: headers["idempotency-key"],
              request: {
                deliver: payload.deliver ?? "never",
                input: payload.input,
                profile: payload.profile ?? "full",
                prompt: payload.prompt,
              },
              requester: {
                keyId: principal.keyId,
                keyName: principal.keyName,
                tier: principal.tier,
                userId: principal.telegramUserId,
              },
            })
            .pipe(
              Effect.catchTag("RunRefused", refusedAs),
              // The db failing is the server's, never the caller's: a 500.
              Effect.catchTag("PersistenceError", Effect.die)
            );
          return { runId: run.id, status: run.status };
        })
      )
      .handle("get", ({ params, query }) =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          const id = Number(params.runId);
          const found = yield* runs
            .get({
              id,
              viewer: viewerOf(principal),
              waitSec: query.waitSec ?? 0,
            })
            .pipe(Effect.orDie);
          return yield* shown(id, found);
        })
      )
      .handle("cancel", ({ params }) =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          const id = Number(params.runId);
          const found = yield* runs
            .cancel({ id, viewer: viewerOf(principal) })
            .pipe(Effect.orDie);
          return yield* shown(id, found);
        })
      );
  })
);
