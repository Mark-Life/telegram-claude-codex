import { Context, Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { persistence } from "./errors";

/**
 * Row the day's global counter lives in. Telegram never issues user id 0, so
 * the global tally shares the per-user table without a column of its own.
 */
export const GLOBAL_QUOTA_USER_ID = 0;

/**
 * The UTC day a quota is counted against, as `YYYY-MM-DD`.
 *
 * Budgets that must not share a tally prefix this key with their own scope
 * (`private:2026-09-12`), so one table carries several budgets without a column
 * of its own. The bare date is the group budget, which was here first.
 */
export const dayKey = (at: number = Date.now()) =>
  new Date(at).toISOString().slice(0, "YYYY-MM-DD".length);

/** One request against the day's budget: per-user first, then the global cap. */
export interface QuotaRequest {
  day: string;
  globalLimit: number;
  userId: number;
  userLimit: number;
}

/**
 * Outcome of a quota request. `scope` says which budget ran out, so the caller
 * can tell the user whether they personally hit the limit or the bot did.
 */
export type QuotaVerdict =
  | { ok: false; scope: "global" | "user" }
  | { ok: true; used: number };

/** One counter: a budget's day key and the user it belongs to (0 is everyone). */
export interface QuotaKey {
  readonly day: string;
  readonly userId: number;
}

const QuotaKeySchema = Schema.Struct({
  day: Schema.String,
  userId: Schema.Int,
});
const UsedRow = Schema.Struct({ used: Schema.Int });

const refused = (scope: "global" | "user"): QuotaVerdict => ({
  ok: false,
  scope,
});
const granted = (used: number): QuotaVerdict => ({ ok: true, used });

const make = Effect.gen(function* makeQuotaRepo() {
  const sql = yield* SqlClient.SqlClient;

  const selectUsed = SqlSchema.findOneOption({
    Request: QuotaKeySchema,
    Result: UsedRow,
    execute: (key) =>
      sql`SELECT used FROM run_quota
          WHERE user_id = ${key.userId} AND day = ${key.day}`,
  });
  const bump = SqlSchema.void({
    Request: QuotaKeySchema,
    execute: (key) =>
      sql`INSERT INTO run_quota (user_id, day, used)
          VALUES (${key.userId}, ${key.day}, 1)
          ON CONFLICT(user_id, day) DO UPDATE SET used = run_quota.used + 1`,
  });
  const remove = SqlSchema.void({
    Request: QuotaKeySchema,
    execute: (key) =>
      sql`DELETE FROM run_quota
          WHERE user_id = ${key.userId} AND day = ${key.day}`,
  });

  /** How much of a day's budget one counter has spent; 0 without a row. */
  const spent = Effect.fnUntraced(function* spent(key: QuotaKey) {
    const row = yield* selectUsed(key);
    return Option.match(row, {
      onNone: () => 0,
      onSome: (found) => found.used,
    });
  });

  /** How much of a day's budget one counter has spent. */
  const used = Effect.fn("QuotaRepo.used")(function* used(key: QuotaKey) {
    return yield* spent(key);
  }, persistence("QuotaRepo.used"));

  /**
   * Take one run from the day's budget, or report which limit refused it.
   * Nothing is counted when the request is refused, so a blocked user does not
   * spend the global budget. One transaction keeps the per-user and global
   * tallies in step.
   */
  const consume = Effect.fn("QuotaRepo.consume")(function* consume(
    request: QuotaRequest
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* take() {
        const mine = yield* spent({ day: request.day, userId: request.userId });
        if (mine >= request.userLimit) {
          return refused("user");
        }
        const everyone = yield* spent({
          day: request.day,
          userId: GLOBAL_QUOTA_USER_ID,
        });
        if (everyone >= request.globalLimit) {
          return refused("global");
        }
        yield* bump({ day: request.day, userId: request.userId });
        yield* bump({ day: request.day, userId: GLOBAL_QUOTA_USER_ID });
        return granted(mine + 1);
      })
    );
  }, persistence("QuotaRepo.consume"));

  /** Give one counter its whole budget back (owner override, tests). */
  const reset = Effect.fn("QuotaRepo.reset")(function* reset(key: QuotaKey) {
    yield* remove(key);
  }, persistence("QuotaRepo.reset"));

  return { consume, reset, used } as const;
});

/**
 * Daily run counters (`run_quota`). Counting in the db (not in memory) keeps a
 * restart from handing everyone a fresh budget.
 *
 * Transactions live only inside repositories. Never run the bridge, Telegram
 * or an agent inside `withTransaction`: the transaction holds the client's only
 * permit, so it would stall every other query in the process.
 */
export class QuotaRepo extends Context.Service<
  QuotaRepo,
  Effect.Success<typeof make>
>()("@workspace/db/QuotaRepo") {
  static readonly layer = Layer.effect(QuotaRepo, make);
}
