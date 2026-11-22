import { describe, expect, test } from "bun:test";

import type { TaskEntry } from "@workspace/db";

import { createScheduler, schedulable, scheduleSignature } from "./scheduler";

/** A scheduler under test never actually runs anything. */
const noFire = async () => {
  await Promise.resolve();
};

/** The store stub: the scheduler reads its tasks through a Promise now. */
const listing = (tasks: () => readonly TaskEntry[]) => async () =>
  await Promise.resolve(tasks());

const task = (overrides: Partial<TaskEntry> = {}): TaskEntry => ({
  createdAt: 0,
  cron: "0 9 * * *",
  enabled: true,
  id: 1,
  payload: "do the thing",
  raw: false,
  title: "Daily",
  type: "prompt",
  tz: "Europe/Berlin",
  ...overrides,
});

describe("schedulable", () => {
  test("keeps enabled tasks with a schedule croner accepts", () => {
    const tasks = [
      task({ id: 1 }),
      task({ enabled: false, id: 2 }),
      task({ cron: "every morning", id: 3 }),
      task({ id: 4, tz: "Mars/Olympus" }),
    ];
    expect(schedulable(tasks).map((entry) => entry.id)).toEqual([1]);
  });
});

describe("scheduleSignature", () => {
  test("changes when a schedule does", () => {
    const before = scheduleSignature([task()]);
    expect(scheduleSignature([task({ cron: "0 10 * * *" })])).not.toBe(before);
    expect(scheduleSignature([task({ tz: "UTC" })])).not.toBe(before);
    expect(scheduleSignature([task(), task({ id: 2 })])).not.toBe(before);
  });

  test("ignores edits that cannot move a fire", () => {
    expect(scheduleSignature([task({ payload: "other", title: "New" })])).toBe(
      scheduleSignature([task()])
    );
  });
});

describe("createScheduler", () => {
  test("registers nothing until it is reloaded", async () => {
    const scheduler = createScheduler({
      fire: noFire,
      list: listing(() => [task()]),
    });
    expect(scheduler.jobIds()).toEqual([]);
    expect(await scheduler.reload()).toBe(1);
    expect(scheduler.jobIds()).toEqual([1]);
    scheduler.stop();
    expect(scheduler.jobIds()).toEqual([]);
  });

  test("skips paused and unschedulable tasks", async () => {
    const tasks = [
      task({ id: 1 }),
      task({ enabled: false, id: 2 }),
      task({ cron: "nope", id: 3 }),
    ];
    const scheduler = createScheduler({
      fire: noFire,
      list: listing(() => tasks),
    });
    await scheduler.reload();
    expect(scheduler.jobIds()).toEqual([1]);
    scheduler.stop();
  });

  test("a registered job reports its next run in its own timezone", async () => {
    const scheduler = createScheduler({
      fire: noFire,
      list: listing(() => [task({ cron: "0 9 * * *", tz: "UTC" })]),
    });
    await scheduler.reload();
    expect(scheduler.nextRun(1)?.getUTCHours()).toBe(9);
    expect(scheduler.nextRun(99)).toBeNull();
    scheduler.stop();
  });

  test("refresh re-registers only when the schedules changed", async () => {
    let tasks = [task()];
    const scheduler = createScheduler({
      fire: noFire,
      list: listing(() => tasks),
    });
    await scheduler.reload();
    const registered = scheduler.nextRun(1);

    tasks = [task({ payload: "edited" })];
    await scheduler.refresh();
    expect(scheduler.nextRun(1)).toEqual(registered);

    tasks = [task(), task({ id: 2, tz: "UTC" })];
    expect(await scheduler.refresh()).toBe(2);
    expect(scheduler.jobIds()).toEqual([1, 2]);
    scheduler.stop();
  });

  test("a task fires on its schedule and is run by id", async () => {
    const fired: number[] = [];
    const scheduler = createScheduler({
      fire: async (taskId) => {
        fired.push(taskId);
        await Promise.resolve();
      },
      list: listing(() => [task({ cron: "* * * * * *", id: 7 })]),
    });
    await scheduler.reload();
    await Bun.sleep(1200);
    scheduler.stop();
    expect(fired).toContain(7);
  });
});
