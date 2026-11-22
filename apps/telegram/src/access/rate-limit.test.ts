import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { QuotaRequest, QuotaVerdict } from "../db";
import { DEFAULT_LANGUAGE, switchLanguage } from "../i18n";
import {
  GROUP_RUNS_PER_DAY,
  GROUP_RUNS_PER_USER_PER_DAY,
  quotaRefusalText,
  takeGroupRun,
} from "./rate-limit";

/** These cases check the Russian source copy. */
beforeAll(() => {
  switchLanguage("ru");
});
afterAll(() => {
  switchLanguage(DEFAULT_LANGUAGE);
});

/** The built-in group budgets, as an unset setting reads them. */
const LIMITS = {
  total: GROUP_RUNS_PER_DAY,
  user: GROUP_RUNS_PER_USER_PER_DAY,
};

/** Records what the limiter asked the store for, and answers as told. */
const recording = (verdict: QuotaVerdict) => {
  const seen: QuotaRequest[] = [];
  return {
    consume: async (request: QuotaRequest) => {
      seen.push(request);
      return await Promise.resolve(verdict);
    },
    seen,
  };
};

describe("takeGroupRun", () => {
  test("the owner spends nothing and is never refused", async () => {
    const store = recording({ ok: false, scope: "user" });
    const verdict = await takeGroupRun({
      consume: store.consume,
      limits: LIMITS,
      tier: "owner",
      userId: 111,
    });

    expect(verdict.ok).toBe(true);
    expect(store.seen).toHaveLength(0);
  });

  test("everyone else is charged against both budgets", async () => {
    const store = recording({ ok: true, used: 3 });
    await takeGroupRun({
      consume: store.consume,
      limits: LIMITS,
      tier: "member",
      userId: 222,
    });

    expect(store.seen[0]?.userId).toBe(222);
    expect(store.seen[0]?.userLimit).toBe(GROUP_RUNS_PER_USER_PER_DAY);
    expect(store.seen[0]?.globalLimit).toBe(GROUP_RUNS_PER_DAY);
    expect(store.seen[0]?.day).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });

  test("a refusal is passed through with the budget that refused", async () => {
    const store = recording({ ok: false, scope: "global" });
    const verdict = await takeGroupRun({
      consume: store.consume,
      limits: LIMITS,
      tier: "guest",
      userId: 333,
    });

    expect(verdict).toEqual({ ok: false, scope: "global" });
  });
});

describe("quotaRefusalText", () => {
  test("says whose limit it was", () => {
    expect(
      quotaRefusalText({
        scope: "user",
        userLimit: GROUP_RUNS_PER_USER_PER_DAY,
      })
    ).toContain(String(GROUP_RUNS_PER_USER_PER_DAY));
    expect(
      quotaRefusalText({
        scope: "global",
        userLimit: GROUP_RUNS_PER_USER_PER_DAY,
      })
    ).toContain("лимит");
  });
});
