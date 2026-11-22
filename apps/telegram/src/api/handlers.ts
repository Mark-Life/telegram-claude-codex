import { BotApi, CurrentPrincipal, NotFound } from "@workspace/api";
import type { ApiKey } from "@workspace/api";
import { apiKeyHint, ApiKeyService } from "@workspace/db";
import type { ApiKeyEntry } from "@workspace/db";
import { AppConfig } from "@workspace/env/bot";
import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { syncAccessSnapshot } from "../access/audit";
import { Observability } from "../observability";
import { AgentRuns } from "../runs/agent-runs";
import { recordApiEvent } from "./ledger";
import { isoOf } from "./views";

/**
 * The HTTP API's handlers: thin doors over the same services the chat and
 * the CLIs use. Each reads only `CurrentPrincipal`, never the key itself.
 */

/** A stored key as the API shows it. */
export const apiKeyView = (key: ApiKeyEntry): ApiKey => {
  const view: ApiKey = {
    createdAt: isoOf(key.createdAt),
    createdVia: key.createdVia,
    hint: apiKeyHint(key.id),
    id: key.id,
    name: key.name,
    telegramUserId: key.userId,
  };
  return key.lastUsedAt === undefined
    ? view
    : { ...view, lastUsedAt: isoOf(key.lastUsedAt) };
};

export const HealthLive = HttpApiBuilder.group(BotApi, "health", (handlers) =>
  handlers.handle("get", () => Effect.succeed({ status: "ok" as const }))
);

export const MeLive = HttpApiBuilder.group(BotApi, "me", (handlers) =>
  handlers.handle("get", () =>
    Effect.gen(function* () {
      return yield* CurrentPrincipal;
    })
  )
);

export const KeysLive = HttpApiBuilder.group(
  BotApi,
  "keys",
  Effect.fnUntraced(function* (handlers) {
    const keys = yield* ApiKeyService;
    const agentRuns = yield* AgentRuns;
    const observability = yield* Observability;
    const { allowedUserId } = yield* AppConfig;
    return handlers
      .handle("list", () =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          const live = yield* keys
            .list({
              ownerId: allowedUserId,
              viewerId: principal.telegramUserId,
            })
            .pipe(Effect.orDie);
          return { keys: live.map(apiKeyView) };
        })
      )
      .handle("revoke", ({ params }) =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          const revoked = yield* keys
            .revoke({
              keyId: params.keyId,
              ownerId: allowedUserId,
              viewerId: principal.telegramUserId,
            })
            .pipe(Effect.orDie);
          if (Option.isNone(revoked)) {
            return yield* new NotFound({
              message: `No live API key ${params.keyId} that this key may revoke.`,
            });
          }
          yield* agentRuns.stopKey(revoked.value.id);
          // The bot's own write is the access watcher's new baseline.
          yield* Effect.tryPromise(syncAccessSnapshot).pipe(
            Effect.catch((error) =>
              Effect.logWarning("access snapshot not re-baselined", error)
            )
          );
          yield* recordApiEvent({
            action: "key_revoke",
            actor: "api",
            byUserId: principal.telegramUserId,
            holderId: revoked.value.userId,
            keyId: revoked.value.id,
            op: null,
            status: null,
          }).pipe(Effect.provideService(Observability, observability));
          return apiKeyView(revoked.value);
        })
      );
  })
);
