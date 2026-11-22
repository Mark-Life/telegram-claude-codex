import { isValidSchedule } from "@workspace/db";
import type { TaskEntry } from "@workspace/db";
import { Cron } from "croner";

/**
 * The cron loop. It lives in the bot process, which is already long-running, so
 * a task fires without any external scheduler.
 *
 * Two doors write the `tasks` table: the bot's own commands, which call
 * `reload` straight after the write, and the tasks CLI a codex run drives,
 * which cannot. So the task feature's loop also calls `refresh` every
 * `RELOAD_INTERVAL_MS`, which re-registers only when the set of schedules
 * changed. A poll, not an fs watch: the db is a WAL file whose mtime says
 * little, and a minute of lag on a recurring task nobody is watching costs
 * nothing.
 */

/** How often a change made outside the bot (the CLI) is picked up. */
export const RELOAD_INTERVAL_MS = 60_000;

/**
 * Tasks the loop can actually register: enabled, with a schedule croner
 * accepts. A row with a broken schedule is skipped rather than crashing the
 * loop — the CLI and `/task add` both validate, so it can only come from a hand
 * edit.
 */
export const schedulable = (tasks: readonly TaskEntry[]) =>
  tasks.filter((task) => task.enabled && isValidSchedule(task));

/**
 * Fingerprint of the registered set, read in the order the store hands rows
 * back (by id). Only what decides *when* a task fires is in it — a payload edit
 * changes the next run's work, not its timing, and the job re-reads the task
 * when it fires anyway.
 */
export const scheduleSignature = (tasks: readonly TaskEntry[]) =>
  schedulable(tasks)
    .map((task) => `${task.id}:${task.cron}:${task.tz}`)
    .join("|");

/** What the loop needs: the tasks to register, and what to do when one fires. */
export interface SchedulerDeps {
  /**
   * Run one task, by id. By id and not by value, so a fire always works from
   * the stored task rather than from the snapshot taken at registration.
   */
  fire: (taskId: number) => Promise<void>;
  list: () => Promise<readonly TaskEntry[]>;
}

/**
 * Build the cron jobs. Nothing is registered until `reload` runs, so
 * constructing one in a test costs no timers.
 */
export const createScheduler = ({ fire, list }: SchedulerDeps) => {
  const jobs = new Map<number, Cron>();
  let signature = "";
  let stopped = false;
  // `reload` and `refresh` run one at a time, in call order: a slow read of the
  // table must not land after a newer one and register the older set of jobs.
  let queue: Promise<unknown> = Promise.resolve();

  const serialized = async <T>(work: () => Promise<T>) => {
    const result = queue.then(work);
    // The chain only orders the calls; each caller sees its own failure.
    queue = Promise.allSettled([result]);
    return await result;
  };

  const clearJobs = () => {
    for (const job of jobs.values()) {
      job.stop();
    }
    jobs.clear();
  };

  /**
   * Replace the registered jobs with this set. Synchronous, and a no-op once
   * `stop` ran: a read that was in flight at shutdown must not bring the loop
   * back.
   */
  const register = (tasks: readonly TaskEntry[]) => {
    if (stopped) {
      return;
    }
    signature = scheduleSignature(tasks);
    clearJobs();
    for (const task of schedulable(tasks)) {
      jobs.set(
        task.id,
        // `protect` skips a fire while the previous one is still running, so a
        // slow daily task can never pile up on itself.
        new Cron(
          task.cron,
          { catch: true, protect: true, timezone: task.tz },
          async () => {
            await fire(task.id);
          }
        )
      );
    }
  };

  /** Re-register every task from the store; returns how many jobs are live. */
  const reload = async () =>
    await serialized(async () => {
      register(await list());
      return jobs.size;
    });

  /** Re-register only if the schedules changed; the periodic tick's job. */
  const refresh = async () =>
    await serialized(async () => {
      const tasks = await list();
      if (scheduleSignature(tasks) !== signature) {
        register(tasks);
      }
      return jobs.size;
    });

  /** Stop every job for good (shutdown). */
  const stop = () => {
    stopped = true;
    clearJobs();
  };

  /** Ids of the tasks currently registered. */
  const jobIds = () => [...jobs.keys()];

  /** When a registered task fires next; null when it is not registered. */
  const nextRun = (taskId: number) => jobs.get(taskId)?.nextRun() ?? null;

  return { fire, jobIds, nextRun, refresh, reload, stop } as const;
};

/** The running cron loop, as the handlers and the entrypoint see it. */
export type TaskScheduler = ReturnType<typeof createScheduler>;
