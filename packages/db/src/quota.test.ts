import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { dayKey, GLOBAL_QUOTA_USER_ID, QuotaRepo } from "./quota";
import type { QuotaRequest } from "./quota";
import { makeTestDb } from "./testing";

const DAY = "2026-09-06";
const USER_ID = 222;
const REQUEST = {
  day: DAY,
  globalLimit: 100,
  userId: USER_ID,
  userLimit: 3,
} as const satisfies QuotaRequest;

/** Run `body` against the repo on one open of the file. */
const withRepo = <A, E>(
  body: (repo: QuotaRepo["Service"]) => Effect.Effect<A, E>
) => QuotaRepo.use(body).pipe(Effect.provide(QuotaRepo.layer));

describe("dayKey", () => {
  test("is the UTC calendar day", () => {
    expect(dayKey(Date.UTC(2026, 8, 6, 23, 30))).toBe("2026-09-06");
    expect(dayKey(Date.UTC(2026, 8, 7, 0, 30))).toBe("2026-09-07");
  });
});

describe("QuotaRepo", () => {
  test("counts up to the per-user limit, then refuses", async () => {
    const db = makeTestDb();
    try {
      const verdicts = await db.run(
        withRepo((repo) =>
          Effect.all([
            repo.consume(REQUEST),
            repo.consume(REQUEST),
            repo.consume(REQUEST),
            repo.consume(REQUEST),
          ])
        )
      );
      expect(verdicts).toEqual([
        { ok: true, used: 1 },
        { ok: true, used: 2 },
        { ok: true, used: 3 },
        { ok: false, scope: "user" },
      ]);
    } finally {
      db.cleanup();
    }
  });

  test("a refused request spends nothing, the global budget included", async () => {
    const db = makeTestDb();
    try {
      const everyone = await db.run(
        withRepo((repo) =>
          Effect.gen(function* spendTwice() {
            yield* repo.consume({ ...REQUEST, userLimit: 1 });
            yield* repo.consume({ ...REQUEST, userLimit: 1 });
            return yield* repo.used({ day: DAY, userId: GLOBAL_QUOTA_USER_ID });
          })
        )
      );
      expect(everyone).toBe(1);
    } finally {
      db.cleanup();
    }
  });

  test("the global cap refuses a user who still has budget", async () => {
    const db = makeTestDb();
    try {
      const outcome = await db.run(
        withRepo((repo) =>
          Effect.gen(function* hitGlobalCap() {
            yield* repo.consume({ ...REQUEST, globalLimit: 1, userId: 1 });
            const verdict = yield* repo.consume({ ...REQUEST, globalLimit: 1 });
            const mine = yield* repo.used({ day: DAY, userId: USER_ID });
            return { mine, verdict };
          })
        )
      );
      expect(outcome).toEqual({
        mine: 0,
        verdict: { ok: false, scope: "global" },
      });
    } finally {
      db.cleanup();
    }
  });

  test("each user has their own budget", async () => {
    const db = makeTestDb();
    try {
      const other = await db.run(
        withRepo((repo) =>
          Effect.gen(function* spendAsTwoUsers() {
            yield* repo.consume({ ...REQUEST, userLimit: 1 });
            return yield* repo.consume({
              ...REQUEST,
              userId: 333,
              userLimit: 1,
            });
          })
        )
      );
      expect(other).toEqual({ ok: true, used: 1 });
    } finally {
      db.cleanup();
    }
  });

  test("a new day starts over, and counts survive a reopen", async () => {
    const db = makeTestDb();
    try {
      await db.run(
        withRepo((repo) => repo.consume({ ...REQUEST, userLimit: 1 }))
      );

      const reopened = await db.run(
        withRepo((repo) =>
          Effect.all({
            nextDay: repo.consume({
              ...REQUEST,
              day: "2026-09-07",
              userLimit: 1,
            }),
            sameDay: repo.consume({ ...REQUEST, userLimit: 1 }),
          })
        )
      );
      expect(reopened).toEqual({
        nextDay: { ok: true, used: 1 },
        sameDay: { ok: false, scope: "user" },
      });
    } finally {
      db.cleanup();
    }
  });

  test("reset gives a counter its budget back", async () => {
    const db = makeTestDb();
    try {
      const mine = await db.run(
        withRepo((repo) =>
          Effect.gen(function* spendThenReset() {
            yield* repo.consume({ ...REQUEST, userLimit: 1 });
            yield* repo.reset({ day: DAY, userId: USER_ID });
            return yield* repo.used({ day: DAY, userId: USER_ID });
          })
        )
      );
      expect(mine).toBe(0);
    } finally {
      db.cleanup();
    }
  });
});
