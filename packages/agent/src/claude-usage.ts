import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { Effect, Predicate } from "effect";

import { claudeLog } from "./claude-log";
import { withIdleSession } from "./claude-sdk";
import type { ProviderUsage, UsageWindow } from "./types";

/**
 * The Claude subscription's allowance, as Claude Code's own `/usage` reads
 * it: the SDK's usage request on a session that runs no turn. The CLI holds
 * the token and refreshes it, so the bot never reads `.credentials.json`.
 */

type RateLimits = NonNullable<SDKControlGetUsageResponse["rate_limits"]>;

type RawWindow = RateLimits["five_hour"];

const FIVE_HOURS = 300;
const WEEK = 10_080;
/** A window is spent at 100%; Claude reports no reached flag of its own. */
const FULL = 100;

/** A window the CLI reported with a figure, else nothing. */
const windowOf = (
  raw: RawWindow,
  span: { minutes: number; scope?: string }
): UsageWindow[] => {
  if (Predicate.isNullish(raw) || raw.utilization === null) {
    return [];
  }
  const window: UsageWindow = { ...span, usedPercent: raw.utilization };
  const resetsAt =
    raw.resets_at === null ? Number.NaN : Date.parse(raw.resets_at);
  if (!Number.isNaN(resetsAt)) {
    window.resetsAt = resetsAt;
  }
  return [window];
};

/**
 * The plans whose Sonnet week Claude Code shows apart from the account's;
 * a session that reports no plan keeps it too, as the CLI does.
 */
const SONNET_WEEK_PLANS = new Set(["max", "team"]);

/**
 * The windows as Claude Code's own `/usage` lists them: the five-hour and
 * weekly windows, the Sonnet week on the plans that keep one apart (on the
 * rest it is the weekly window again), then the CLI's `model_scoped` rows.
 */
const windowsOf = (limits: RateLimits, plan: string | null) => {
  const sonnet =
    plan === null || SONNET_WEEK_PLANS.has(plan)
      ? windowOf(limits.seven_day_sonnet, { minutes: WEEK, scope: "Sonnet" })
      : [];
  // Typed optional, but its neighbours are all nullable; null reads as none.
  const scoped = (limits.model_scoped ?? []).flatMap((row) =>
    windowOf(row, { minutes: WEEK, scope: row.display_name })
  );
  return [
    ...windowOf(limits.five_hour, { minutes: FIVE_HOURS }),
    ...windowOf(limits.seven_day, { minutes: WEEK }),
    ...sonnet,
    ...scoped,
  ];
};

/**
 * The plans the chat names, as Anthropic names them; any other id is left
 * unnamed rather than shown raw.
 */
const PLAN_NAMES = new Map([
  ["enterprise", "Enterprise"],
  ["max", "Max"],
  ["pro", "Pro"],
  ["team", "Team"],
]);

/**
 * The SDK's answer as the chat shows it, or undefined when the CLI could
 * not fetch it. `rate_limits_available` false is a login with no plan
 * limits (an API key, a setup token): no windows, which is an answer. Limits
 * that should be there but are null are a fetch that failed, never "nothing
 * spent"; limits whose windows all carry no figure are a plan with none.
 */
const parseClaudeUsage = (
  response: Pick<
    SDKControlGetUsageResponse,
    "rate_limits" | "rate_limits_available" | "subscription_type"
  >
): ProviderUsage | undefined => {
  if (!response.rate_limits_available) {
    return { limitReached: false, windows: [] };
  }
  if (response.rate_limits === null) {
    return undefined;
  }
  const windows = windowsOf(response.rate_limits, response.subscription_type);
  const usage: ProviderUsage = {
    // An account-wide window at 100% stops every model; a per-model one
    // stops only that model.
    // A window already past its reset (a cached answer) has started over.
    limitReached: windows.some(
      (window) =>
        window.scope === undefined &&
        window.usedPercent >= FULL &&
        (window.resetsAt === undefined || window.resetsAt > Date.now())
    ),
    windows,
  };
  const plan = PLAN_NAMES.get(response.subscription_type ?? "");
  if (plan !== undefined) {
    usage.plan = plan;
  }
  return usage;
};

const readUsage = async (signal: AbortSignal) =>
  await withIdleSession({
    signal,
    use: async (session) =>
      parseClaudeUsage(
        await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(
          {
            // Skips a scan of every local transcript; only the plan's
            // windows are read.
            skipBehaviors: true,
          }
        )
      ),
  });

/** Log a read that told nothing; the chat says it in one sentence. */
const unread = (error: string) => {
  claudeLog(Effect.logWarning("claude.usage read failed", { error }));
};

/**
 * `AgentProvider.usage` for Claude. Never rejects; the CLI is the SDK's own
 * (or `CLAUDE_BIN`), as for a run, so `bin` is not used.
 */
export const claudeUsage = async (
  _bin: string,
  signal: AbortSignal
): Promise<ProviderUsage | undefined> => {
  try {
    const usage = await readUsage(signal);
    if (usage === undefined) {
      unread("the CLI could not fetch the limits");
    }
    return usage;
  } catch (error) {
    unread(error instanceof Error ? error.message : String(error));
    return undefined;
  }
};
