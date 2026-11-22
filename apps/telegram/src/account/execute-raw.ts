import type { tl } from "@mtcute/bun";
import type { AccountActionPayload } from "@workspace/db";
import { Effect } from "effect";

import { TelegramAccountError } from "../telegram/telegram-account";
import type { TelegramAccountHandle } from "../telegram/telegram-account";
import type { Executed } from "./execute-write";
import { buildCall } from "./raw-params";
import { verdictOf } from "./raw-policy";
import type { RawIndex } from "./raw-schema";

/**
 * A confirmed raw write, carried out. The method is looked up and classed
 * again first: a layer change or a policy edit since the run asked may have
 * made it something the owner never agreed to, so anything that is no longer
 * a `write` fails. The stored parameters are checked again and built into
 * the call, each peer resolved now from the id the owner was shown.
 */
export const executeRaw = (input: {
  readonly account: TelegramAccountHandle;
  readonly index: Effect.Effect<RawIndex, TelegramAccountError>;
  readonly payload: Extract<AccountActionPayload, { kind: "raw" }>;
}) =>
  Effect.gen(function* () {
    const { account, payload } = input;
    const label = `raw:${payload.method}`;
    const index = yield* input.index;
    const entry = index.methods.get(payload.method);
    if (entry === undefined || verdictOf(entry).class !== "write") {
      return yield* new TelegramAccountError({
        cause: undefined,
        method: label,
        reason: "rpc",
        rpc: "RAW_POLICY_CHANGED",
      });
    }
    const call = yield* buildCall({
      account,
      entry,
      index,
      params: payload.params,
    }).pipe(
      Effect.catchTag("BadInput", (error) =>
        Effect.fail(
          new TelegramAccountError({
            cause: error,
            method: label,
            reason: "rpc",
            rpc: "RAW_PARAMS_INVALID",
          })
        )
      )
    );
    yield* account.use(label, async (client) => {
      await client.call<tl.RpcMethod>(call);
    });
    const executed: Executed = { messageIds: [] };
    return executed;
  });
