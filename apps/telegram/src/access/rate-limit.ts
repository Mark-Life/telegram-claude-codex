import { readCached } from "../bot-settings";
import { dayKey } from "../db";
import type { QuotaRequest, QuotaVerdict, SettingKey } from "../db";
import { consumeRunQuota } from "../db/bridge";
import { t } from "../i18n";
import { isOperator } from "./tier";
import type { Tier } from "./tier";

/**
 * How much of the bot a group may spend in a day. Group runs are cheap but not
 * free, and the bot answers strangers there, so both a per-person and a
 * house-wide budget apply. The owner is exempt: their own runs are the point.
 */
export const GROUP_RUNS_PER_USER_PER_DAY = 30;
export const GROUP_RUNS_PER_DAY = 100;

/**
 * How much of the bot one person may spend in a day outside a group. The bot is
 * open to strangers on purpose, so this budget is generous and its job is to
 * make runaway usage visible, not to keep people out: the milestones below tell
 * the owner who is spending it long before the limit bites. The house cap is
 * high enough that one busy day by a dozen strangers still fits.
 */
export const PRIVATE_RUNS_PER_USER_PER_DAY = 30;
export const PRIVATE_RUNS_PER_DAY = 500;

/** The four budgets the owner can change in `/settings`, in menu order. */
export const LIMIT_KEYS = [
  "private_runs_per_user",
  "private_runs_per_day",
  "group_runs_per_user",
  "group_runs_per_day",
] as const satisfies readonly SettingKey[];

export type LimitKey = (typeof LIMIT_KEYS)[number];

export const isLimitKey = (key: string): key is LimitKey =>
  LIMIT_KEYS.some((known) => known === key);

/**
 * Per budget: the value an unset key means, and the presets a press cycles
 * through. Each ladder holds its default, and no limit follows the last one.
 */
/* oxlint-disable eslint/no-magic-numbers -- the ladders are menu data */
export const DAILY_LIMITS = {
  group_runs_per_day: {
    fallback: GROUP_RUNS_PER_DAY,
    presets: [50, 100, 300],
  },
  group_runs_per_user: {
    fallback: GROUP_RUNS_PER_USER_PER_DAY,
    presets: [10, 30, 100],
  },
  private_runs_per_day: {
    fallback: PRIVATE_RUNS_PER_DAY,
    presets: [100, 500, 2000],
  },
  private_runs_per_user: {
    fallback: PRIVATE_RUNS_PER_USER_PER_DAY,
    presets: [10, 30, 100],
  },
} as const satisfies Record<
  LimitKey,
  { fallback: number; presets: readonly number[] }
>;
/* oxlint-enable eslint/no-magic-numbers */

/** The stored value that lifts a budget. */
export const NO_LIMIT = "off";

/** A budget with no limit; every count stays under it. */
const UNLIMITED = Number.POSITIVE_INFINITY;

/** Every value a budget may be set to, its presets then no limit. */
export const limitLadder = (key: LimitKey) => [
  ...DAILY_LIMITS[key].presets,
  UNLIMITED,
];

/** A stored budget: a positive count, `off`, or anything else as unset. */
export const parseLimit = (key: LimitKey, raw: string | undefined) => {
  if (raw === NO_LIMIT) {
    return UNLIMITED;
  }
  const count = Number(raw);
  return raw !== undefined && Number.isSafeInteger(count) && count > 0
    ? count
    : DAILY_LIMITS[key].fallback;
};

/** A budget as `/settings` writes it. */
export const formatLimit = (limit: number) =>
  Number.isFinite(limit) ? String(limit) : NO_LIMIT;

/** Whether a budget has a limit at all. */
export const isLimited = (limit: number) => Number.isFinite(limit);

/**
 * One budget as stored now. A failed read keeps the default, the budget the
 * bot ran with before the owner could change it.
 */
export const readLimit = async (key: LimitKey) => {
  try {
    return parseLimit(key, await readCached(key));
  } catch {
    return DAILY_LIMITS[key].fallback;
  }
};

/** A surface's two budgets as stored now. */
export const readLimits = async (surface: "group" | "private") => {
  const [user, total] =
    surface === "group"
      ? await Promise.all([
          readLimit("group_runs_per_user"),
          readLimit("group_runs_per_day"),
        ])
      : await Promise.all([
          readLimit("private_runs_per_user"),
          readLimit("private_runs_per_day"),
        ]);
  return { total, user };
};

export type DailyLimits = Awaited<ReturnType<typeof readLimits>>;

/** Half a budget, the first point worth telling the owner about. */
const HALFWAY = 2;

/** A tier that spends no budget, so its verdict carries no count. */
const EXEMPT = { ok: true, used: 0 } as const satisfies QuotaVerdict;

/**
 * Take one group run from today's budgets. Nothing is counted when a limit
 * refuses the run, so a blocked user does not eat the house budget.
 */
export const takeGroupRun = async (input: {
  consume?: (request: QuotaRequest) => Promise<QuotaVerdict>;
  limits: DailyLimits;
  now?: number;
  tier: Tier;
  userId: number;
}): Promise<QuotaVerdict> => {
  if (input.tier === "owner") {
    return EXEMPT;
  }
  const consume = input.consume ?? consumeRunQuota;
  return await consume({
    day: dayKey(input.now),
    globalLimit: input.limits.total,
    userId: input.userId,
    userLimit: input.limits.user,
  });
};

/**
 * Take one private-chat run from today's budgets. Counted on a day key of its
 * own, so a busy group day never spends what a private conversation has left.
 * Owner and executor are exempt: their runs are the point of the bot.
 */
export const takePrivateRun = async (input: {
  consume?: (request: QuotaRequest) => Promise<QuotaVerdict>;
  limits: DailyLimits;
  now?: number;
  tier: Tier;
  userId: number;
}): Promise<QuotaVerdict> => {
  if (isOperator(input.tier)) {
    return EXEMPT;
  }
  const consume = input.consume ?? consumeRunQuota;
  return await consume({
    day: `private:${dayKey(input.now)}`,
    globalLimit: input.limits.total,
    userId: input.userId,
    userLimit: input.limits.user,
  });
};

/**
 * The point in a stranger's day the owner is told about, if this run is one:
 * half the per-person budget in force now, and all of it. Counting from the db
 * means each milestone is reached exactly once a day, so no separate record of
 * what has already been sent is needed. Only guests are reported: a member is
 * someone the owner already knows. A budget with no limit has no milestones.
 */
export const privateUsageMilestone = (input: {
  limit: number;
  tier: Tier;
  used: number;
}) => {
  const watched = input.tier === "guest" && isLimited(input.limit);
  if (watched && input.used === input.limit) {
    return "spent" as const;
  }
  return watched && input.used === Math.ceil(input.limit / HALFWAY)
    ? ("half" as const)
    : undefined;
};

/** What a user is told when a group budget refuses their run. */
export const quotaRefusalText = (input: {
  scope: "global" | "user";
  userLimit: number;
}) =>
  input.scope === "user"
    ? t().quota.userSpent(input.userLimit)
    : t().quota.groupsSpent;

/** What a user is told when their private-chat budget refuses a run. */
export const privateQuotaRefusalText = (input: {
  scope: "global" | "user";
  userLimit: number;
}) =>
  input.scope === "user"
    ? t().quota.userSpent(input.userLimit)
    : t().quota.allSpent;
