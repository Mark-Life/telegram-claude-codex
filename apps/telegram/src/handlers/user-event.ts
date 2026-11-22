import { hostname } from "node:os";

import { Effect } from "effect";

import { Observability, UserEvent } from "../observability";
import { runtime } from "../runtime";
import { APP_VERSION } from "./run-event";

/** Fields of an access mutation the caller actually decides. */
export type UserMutation = Pick<
  UserEvent,
  "action" | "addedBy" | "targetUserId" | "tier" | "username"
>;

/**
 * Write one access mutation to the wide-event ledger: who changed whose tier,
 * to what, and when. Best-effort like every other record — an audit line must
 * never be the reason a command fails.
 */
export const recordUserMutation = async (mutation: UserMutation) => {
  try {
    const event = new UserEvent({
      ...mutation,
      actor: "telegram",
      host: hostname(),
      ts: new Date().toISOString(),
      version: APP_VERSION,
    });
    await runtime.runPromise(
      Effect.flatMap(Observability, (o) => o.recordUser(event))
    );
  } catch {
    // swallow: the ledger is best-effort and must never break a command
  }
};
