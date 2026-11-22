import {
  getProvider,
  isInstalled,
  isRunnable,
  orderedSnapshots,
} from "@workspace/agent";
import type { ProviderSnapshot } from "@workspace/agent";
import type { UsageWindow } from "@workspace/agent/types";
import { Effect } from "effect";

import { accessOf } from "../access/context";
import { isOperator } from "../access/tier";
import { t } from "../i18n";
import { readHomeTz } from "../reminders/home-tz";
import { runtime } from "../runtime";
import { tgBestEffort } from "../telegram/bridge";
import { bar, clampPercent, escapeHtml } from "../telegram/format";
import { reprobeAndWait } from "./agent-bridge";
import type { HandlerDeps } from "./deps";
import { logRejection } from "./helpers";

/**
 * `/usage`: how much of each subscription is spent, per provider installed
 * on this host. Owner and executor, the tiers whose runs bill that account;
 * private chat only, like `/settings`, because it shows that account.
 * Each provider's own CLI is asked (`AgentProvider.usage`), in parallel,
 * after the handler has answered: grammy handles one update at a time, and a
 * CLI takes about a second, after its login check.
 */

/** How long one provider's CLI may take to answer. */
const READ_TIMEOUT_MS = 15_000;

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1440;
const MINUTES_PER_WEEK = 10_080;
const MS_PER_MINUTE = 60_000;

/** Rounded down, so a window shows 100% only once it is spent. */
const percent = (value: number) => Math.floor(clampPercent(value));

/** A calendar day in `timeZone`, to tell today's reset from a later one. */
const dayKey = (at: number, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone }).format(at);

/**
 * When a window starts over, in the home zone: a time today, else a date.
 * Rounded to the nearest minute: Claude stamps a reset at :59.98, which
 * would show one week's single reset a minute apart on two lines.
 */
const resetsText = (exact: number, timeZone: string, now: number) => {
  const at = Math.round(exact / MS_PER_MINUTE) * MS_PER_MINUTE;
  const time = { hour: "2-digit", minute: "2-digit", timeZone } as const;
  const options =
    dayKey(at, timeZone) === dayKey(now, timeZone)
      ? time
      : ({ ...time, day: "numeric", month: "short" } as const);
  return t().usage.resets(
    new Intl.DateTimeFormat(t().dateLocale, options).format(at)
  );
};

/** A window's length by its largest whole unit: 300 is 5 h, 10080 a week. */
const spanName = (minutes: number | undefined) => {
  const copy = t().usage.span;
  if (
    minutes === undefined ||
    !Number.isFinite(minutes) ||
    Math.round(minutes) <= 0
  ) {
    return copy.unknown;
  }
  if (minutes % MINUTES_PER_WEEK === 0) {
    return copy.week(minutes / MINUTES_PER_WEEK);
  }
  if (minutes % MINUTES_PER_DAY === 0) {
    return copy.day(minutes / MINUTES_PER_DAY);
  }
  return minutes % MINUTES_PER_HOUR === 0
    ? copy.hour(minutes / MINUTES_PER_HOUR)
    : copy.minute(Math.round(minutes));
};

/** Telegram's limit on a message, with room for the cut mark. */
const MAX_MESSAGE_CHARS = 4000;

/** The longest model or bucket name a line shows: a message holds 4096. */
const MAX_SCOPE_CHARS = 64;

const scopeName = (scope: string) =>
  scope.length > MAX_SCOPE_CHARS
    ? `${scope.slice(0, MAX_SCOPE_CHARS - 1)}…`
    : scope;

const windowLine = (window: UsageWindow, timeZone: string, now: number) => {
  const span = spanName(window.minutes);
  const name =
    window.scope === undefined
      ? span
      : `${span}, ${escapeHtml(scopeName(window.scope))}`;
  // A window past its reset has started over: a cached answer's figure for
  // it is stale.
  const { resetsAt } = window;
  const past = resetsAt !== undefined && resetsAt <= now;
  const spent = past ? 0 : window.usedPercent;
  // The figure first and the bar after it: a screen reader reaches the
  // number without reading ten shapes.
  const used = `${t().usage.used(percent(spent))} ${bar(spent)}`;
  const reset =
    resetsAt === undefined || past
      ? ""
      : ` · ${resetsText(resetsAt, timeZone, now)}`;
  return `${name}: ${used}${reset}`;
};

/** One line per read, so a slow or failing CLI shows in the log. */
const logRead = (input: { ms: number; outcome: string; provider: string }) => {
  runtime.runFork(Effect.log("usage.read").pipe(Effect.annotateLogs(input)));
};

/**
 * One provider's block: its plan and windows, or why there are none. A
 * provider whose CLI cannot run now is not asked; its status says why. A
 * ready one with no `usage` (pi) says the bot does not read its limits.
 */
const providerBlock = async (snapshot: ProviderSnapshot, timeZone: string) => {
  const copy = t().usage;
  const { displayName, usage: read } = getProvider(snapshot.id);
  const name = `<b>${escapeHtml(displayName)}</b>`;
  // With nothing to ask, only a checked login is worth a line of its own.
  const usable =
    read === undefined
      ? snapshot.status === "ready"
      : isRunnable(snapshot.status);
  if (snapshot.bin === undefined || !usable) {
    return `${name} — ${t().provider.menu.notReady[snapshot.status]}`;
  }
  if (read === undefined) {
    return `${name} — ${copy.noLimits}`;
  }
  const started = Date.now();
  const usage = await read(snapshot.bin, AbortSignal.timeout(READ_TIMEOUT_MS));
  logRead({
    ms: Date.now() - started,
    outcome: usage === undefined ? "unread" : "read",
    provider: snapshot.id,
  });
  // A login check that timed out (`unknown`) may hide a logout, which the
  // CLI answers as a login with no limits: that says nothing either way.
  const unchecked =
    snapshot.status === "unknown" &&
    usage !== undefined &&
    usage.windows.length === 0 &&
    !usage.limitReached;
  if (usage === undefined || unchecked) {
    return `${name} — ${copy.noReading}`;
  }
  const title =
    usage.plan === undefined ? name : `${name} · ${escapeHtml(usage.plan)}`;
  // A workspace out of credits reports a reached limit with no windows.
  if (usage.windows.length === 0) {
    return [
      title,
      usage.limitReached ? copy.limitReached : copy.noWindows,
    ].join("\n");
  }
  const now = Date.now();
  return [
    title,
    ...usage.windows.map((window) => windowLine(window, timeZone, now)),
    ...(usage.limitReached ? [copy.limitReached] : []),
  ].join("\n");
};

/**
 * The text cut to whole lines that fit one message. Every tag opens and
 * closes on its own line, so the cut never leaves HTML open.
 */
const fitMessage = (text: string) => {
  if (text.length <= MAX_MESSAGE_CHARS) {
    return text;
  }
  const kept: string[] = [];
  let length = 0;
  for (const line of text.split("\n")) {
    if (length + line.length + 1 > MAX_MESSAGE_CHARS) {
      break;
    }
    kept.push(line);
    length += line.length + 1;
  }
  return [...kept, "…"].join("\n");
};

/**
 * Ask every installed provider that can report usage, in parallel, and draw
 * the answers as one message; one with no `usage` gets a line saying so. The
 * login checks run again first (at most once a minute per provider): the
 * boot snapshot does not see a logout, and a logged-out CLI answers a usage
 * read as a login with no limits.
 */
const usageText = async (defaultTz: string) => {
  const { snapshots } = await reprobeAndWait();
  const reporting = orderedSnapshots(snapshots).filter(isInstalled);
  if (reporting.length === 0) {
    return t().usage.noProviders;
  }
  const timeZone = await readHomeTz(defaultTz);
  const blocks = await Promise.all(
    reporting.map(async (snapshot) => await providerBlock(snapshot, timeZone))
  );
  return fitMessage(blocks.join("\n\n"));
};

export const registerUsageHandlers = ({
  bot,
  defaultTz,
  pendingWork,
}: HandlerDeps) => {
  bot.command("usage", async (ctx) => {
    if (!isOperator(accessOf(ctx).tier)) {
      await ctx.reply(t().notForYou);
      return;
    }
    if (ctx.chat.type !== "private") {
      await ctx.reply(t().usage.privateOnly);
      return;
    }
    const placeholder = await ctx.reply(t().usage.reading);
    const fill = async () => {
      // The message never stays at the placeholder: a failure to draw it
      // says so in one sentence and goes to the log.
      let text: string;
      try {
        text = await usageText(defaultTz);
      } catch (error) {
        logRejection("usage text")(error);
        text = t().tryAgain;
      }
      await tgBestEffort(
        "editMessageText",
        async (api) =>
          await api.editMessageText(
            placeholder.chat.id,
            placeholder.message_id,
            text,
            { parse_mode: "HTML" }
          ),
        // Warn, not debug: a lost edit leaves the owner at the placeholder.
        { logLevel: "warn", retry: "all" }
      );
    };
    pendingWork.track(fill()).catch(logRejection("usage read"));
  });
};
