import { Cron } from "croner";

/**
 * Schedule validation, shared by everything that writes the `tasks` table: the
 * bot's `/task add`, the tasks CLI a codex run drives, and the scheduler, which
 * skips a row it cannot register. One parser for all three means a schedule the
 * CLI accepted is a schedule the bot will actually run.
 */

/** One stored schedule: a cron expression and the zone it is read in. */
export interface Schedule {
  cron: string;
  tz: string;
}

/** Whether a timezone is an IANA name this runtime knows. */
export const isValidTimeZone = (tz: string) => {
  try {
    return (
      Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone
        .length > 0
    );
  } catch {
    return false;
  }
};

/**
 * When a schedule next fires, or null when it never does — an unparseable
 * expression, an unknown zone, or a date that cannot occur (Feb 30).
 */
export const nextRunAt = (schedule: Schedule, from?: Date) => {
  try {
    return new Cron(schedule.cron, {
      paused: true,
      timezone: schedule.tz,
    }).nextRun(from ?? null);
  } catch {
    return null;
  }
};

/** Whether a schedule is one the scheduler can register. */
export const isValidSchedule = (schedule: Schedule) =>
  isValidTimeZone(schedule.tz) && nextRunAt(schedule) !== null;

/**
 * What is wrong with a schedule, as a kind each door words its own way:
 * `zone` an unknown timezone, `never` an expression that never fires;
 * undefined when nothing is.
 */
export const scheduleIssue = (schedule: Schedule) => {
  if (!isValidTimeZone(schedule.tz)) {
    return "zone" as const;
  }
  return nextRunAt(schedule) === null ? ("never" as const) : undefined;
};

export type ScheduleIssue = NonNullable<ReturnType<typeof scheduleIssue>>;

/** A schedule issue in the CLI's English. */
export const describeScheduleIssue = (input: {
  issue: ScheduleIssue;
  schedule: Schedule;
}) =>
  input.issue === "zone"
    ? `Unknown timezone: ${input.schedule.tz}. Use an IANA name like Europe/Berlin.`
    : `Cron expression never runs: ${input.schedule.cron}`;

/** What is wrong with a schedule, or undefined when nothing is. */
export const validateSchedule = (schedule: Schedule) => {
  const issue = scheduleIssue(schedule);
  return issue === undefined
    ? undefined
    : describeScheduleIssue({ issue, schedule });
};
