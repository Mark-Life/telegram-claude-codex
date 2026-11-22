import {
  isTaskSessionMode,
  isTaskType,
  nextRunAt,
  scheduleIssue,
} from "@workspace/db";
import type { NewTask, Schedule, TaskEntry } from "@workspace/db";

import { t } from "../i18n";
import { escapeHtml } from "../telegram/format";

/**
 * The `/task add` form and the `/tasks` list view. Both are pure text work, so
 * the whole grammar of a task command is testable without a chat.
 */

/** Separates the header fields from the payload in a `/task add` body. */
const PAYLOAD_SEPARATOR = "---";

/** How to write a `/task add` form, in the language in use. */
export const taskAddUsage = () =>
  t().tasks.addUsage(PAYLOAD_SEPARATOR).join("\n");

/**
 * A parsed form, or the first thing wrong with it. The form carries no route:
 * the handler knows the chat it was typed in, and `silent` says to skip it.
 */
export type TaskParseResult =
  | { draft: NewTask; ok: true; silent: boolean }
  | { ok: false; problem: string };

/** Split `key: value` header lines from the payload below the separator. */
const splitForm = (body: string) => {
  const lines = body.split("\n");
  const cut = lines.findIndex((line) => line.trim() === PAYLOAD_SEPARATOR);
  return cut === -1
    ? { header: lines, payload: "" }
    : { header: lines.slice(0, cut), payload: lines.slice(cut + 1).join("\n") };
};

/** Read the header lines into a field map; anything unparsable is ignored. */
const readFields = (lines: readonly string[]) => {
  const fields = new Map<string, string>();
  for (const line of lines) {
    const at = line.indexOf(":");
    if (at > 0) {
      fields.set(
        line.slice(0, at).trim().toLowerCase(),
        line.slice(at + 1).trim()
      );
    }
  }
  return fields;
};

/** A header flag; absent means the default the store applies. */
const readFlag = (raw: string | undefined) =>
  raw === undefined ? undefined : raw === "true" || raw === "1";

/**
 * What is wrong with a schedule, said plainly: the same check `TaskService`
 * makes (`scheduleIssue`), in the chat's wording.
 */
export const scheduleProblem = (schedule: Schedule) => {
  const issue = scheduleIssue(schedule);
  if (issue === "zone") {
    return t().tasks.form.badZone(schedule.tz);
  }
  return issue === "never"
    ? t().tasks.form.neverRuns(schedule.cron)
    : undefined;
};

/**
 * Parse a `/task add` body into a draft. Every refusal names what to fix, since
 * the owner is typing this into a phone.
 */
export const parseTaskDraft = (body: string): TaskParseResult => {
  const { header, payload } = splitForm(body);
  const fields = readFields(header);
  const title = fields.get("title") ?? "";
  const cron = fields.get("cron") ?? "";
  const tz = fields.get("tz") ?? "";
  const type = fields.get("type") ?? "";
  if (title.length === 0 || cron.length === 0 || tz.length === 0) {
    return { ok: false, problem: t().tasks.form.missingFields };
  }
  if (!isTaskType(type)) {
    return { ok: false, problem: t().tasks.form.badType };
  }
  if (payload.trim().length === 0) {
    return {
      ok: false,
      problem: t().tasks.form.noPayload(PAYLOAD_SEPARATOR),
    };
  }
  const problem = scheduleProblem({ cron, tz });
  if (problem !== undefined) {
    return { ok: false, problem };
  }
  // `fresh` is what no mode means; anything else must be a mode.
  const session = fields.get("session") ?? "fresh";
  const sessionMode = isTaskSessionMode(session) ? session : undefined;
  if (sessionMode === undefined && session !== "fresh") {
    return { ok: false, problem: t().tasks.form.badSession };
  }
  const silent = readFlag(fields.get("silent")) === true;
  if (sessionMode === "route" && silent) {
    return { ok: false, problem: t().tasks.form.routeNeedsChat };
  }
  return {
    draft: {
      cron,
      enabled: readFlag(fields.get("enabled")),
      payload: payload.trim(),
      project: fields.get("project"),
      raw: readFlag(fields.get("raw")),
      sessionMode,
      title,
      type,
      tz,
    },
    ok: true,
    silent,
  };
};

/** When a task next fires, in its own timezone, or "never" if it cannot. */
export const describeNextRun = (task: TaskEntry, from?: Date) => {
  const next = nextRunAt(task, from);
  return next === null
    ? t().tasks.list.never
    : next.toLocaleString(t().dateLocale, {
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        month: "short",
        timeZone: task.tz,
      });
};

/** The last fire, as one short phrase. */
const describeLastRun = (task: TaskEntry) =>
  task.lastStatus === undefined || task.lastRunAt === undefined
    ? t().tasks.list.neverRan
    : t().tasks.list.lastRun({
        date: new Date(task.lastRunAt).toLocaleDateString(t().dateLocale, {
          day: "numeric",
          month: "short",
          timeZone: task.tz,
        }),
        status: t().tasks.list.status[task.lastStatus],
      });

/**
 * Which conversation a task keeps, as one line; none for a fresh task, the
 * default.
 */
const describeSession = (task: TaskEntry) => {
  if (task.sessionMode === undefined) {
    return [];
  }
  const { list } = t().tasks;
  return [
    [
      list.mode[task.sessionMode],
      ...(task.sessionMode === "own" && task.sessionId !== undefined
        ? [list.sessionKept]
        : []),
      ...(task.sessionReset === true ? [list.resetPending] : []),
    ].join(" · "),
  ];
};

/** One task as a Telegram HTML block. */
export const describeTask = (task: TaskEntry, from?: Date) =>
  [
    `<b>#${task.id} ${escapeHtml(task.title)}</b>`,
    `${task.type} · <code>${escapeHtml(task.cron)}</code> ${escapeHtml(task.tz)}`,
    ...describeSession(task),
    task.enabled
      ? `${t().tasks.list.next(escapeHtml(describeNextRun(task, from)))} · ${describeLastRun(task)}`
      : `${t().tasks.list.paused} · ${describeLastRun(task)}`,
  ].join("\n");
