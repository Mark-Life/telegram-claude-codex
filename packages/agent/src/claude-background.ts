import type {
  SDKMessage,
  SDKUserMessage,
  StopHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { Option, Schema } from "effect";

import type { FollowUps } from "./follow-ups";
import type { BackgroundPending, RunContext } from "./types";

const MS_PER_MINUTE = 60_000;
const IDLE_CAP_MINUTES = 70;

/**
 * How long a run parked on wake-ups alone waits for its next turn. A wake-up
 * fires at most an hour and a minute after it was set (the CLI clamps it to
 * 3600 s and rounds up to the minute), so one always comes in time.
 */
const IDLE_CAP_MS = IDLE_CAP_MINUTES * MS_PER_MINUTE;

/**
 * A `Workflow` call's result that started a local run: what relaunches it
 * after the CLI is gone. Only this result carries the run id and the script;
 * no frame and no hook does.
 */
const decodeWorkflowLaunch = Schema.decodeUnknownOption(
  Schema.Struct({
    runId: Schema.String,
    scriptPath: Schema.String,
    status: Schema.Literal("async_launched"),
    taskId: Schema.String,
    workflowName: Schema.optional(Schema.String),
  })
);

/**
 * A `ScheduleWakeup` call's result: when the wake-up fires, as an instant.
 * The CLI's own cron for it is a local-time minute, so this is the one to keep.
 */
const decodeWakeup = Schema.decodeUnknownOption(
  Schema.Struct({
    clampedDelaySeconds: Schema.Number,
    scheduledFor: Schema.Number,
    stopped: Schema.optional(Schema.Boolean),
  })
);

/**
 * What a result with nothing queued does to a run that waits: it parks, it
 * closes because nothing is pending or no slot is free, or, past a shutdown
 * with work pending, the restart cuts it (`cut`) as it would a parked run.
 */
export type Settle = "closed" | "cut" | "parked";

/** Why a run stopped waiting before its work reported. */
export type WaitEnd = "expired" | "full";

/**
 * A run that stays open past its last result while work it started in the
 * background is pending, so the CLI runs that work's report (a wake-up, a
 * Monitor event, a finished command or workflow) as one more turn. A parked
 * run moves to a waiting slot (`RunContext.waitSlot`); with none free it
 * does not park.
 *
 * Background tasks are waited for as long as they run: a dynamic workflow
 * may take days, and the CLI ends a Monitor or a background command at its
 * own deadline. A run waiting on wake-ups alone has an idle cap. A Monitor or
 * a wake-up the model sets again each time keeps the run going until `/stop`.
 * When the cap runs out, or no slot is free, the inbox closes and the CLI
 * winds down by itself: a wake-up is dropped, background work gets the CLI's
 * own ten minutes, still reporting if it finishes within them.
 *
 * What is pending comes from the `Stop` hook, which fires right before each
 * result and is the only report of pending wake-ups (`session_crons`). Tasks
 * the CLI marks ambient, like live-update watchers, are not work.
 */
export const backgroundWait = (
  followUps: FollowUps,
  waitSlot: RunContext["waitSlot"]
) => {
  let tasks = false;
  let wakeups = false;
  let ambient = new Set<string>();
  let idle: ReturnType<typeof setTimeout> | undefined;
  let ended: WaitEnd | undefined;
  /** Workflows this CLI launched and has not reported, by task id. */
  const workflows = new Map<string, BackgroundPending["workflows"][number]>();
  let wakeupAt: number | undefined;
  let pending: BackgroundPending = { tasks: [], workflows: [] };
  const expire = () => {
    ended = "expired";
    followUps.close();
  };
  /** A main-thread tool result: a workflow launched, a wake-up set. */
  const toolResult = (message: SDKUserMessage) => {
    const result = message.tool_use_result;
    const launch = Option.getOrUndefined(decodeWorkflowLaunch(result));
    if (launch !== undefined) {
      workflows.set(launch.taskId, {
        name: launch.workflowName ?? "",
        runId: launch.runId,
        scriptPath: launch.scriptPath,
      });
      return;
    }
    const wakeup = Option.getOrUndefined(decodeWakeup(result));
    if (wakeup !== undefined) {
      wakeupAt = wakeup.stopped === true ? undefined : wakeup.scheduledFor;
    }
  };
  return {
    dispose: () => {
      clearTimeout(idle);
    },
    /** Why the run stopped waiting early, if it did. */
    ended: () => ended,
    /**
     * Read one frame: the ambient tasks, the workflows and wake-ups set, and
     * a turn starting on a parked run. True when the run works again.
     */
    frame: (message: SDKMessage) => {
      if (message.type === "user" && message.parent_tool_use_id === null) {
        toolResult(message);
      }
      if (message.type !== "system") {
        return false;
      }
      if (message.subtype === "background_tasks_changed") {
        ambient = new Set(
          message.tasks
            .filter((task) => task.ambient === true)
            .map((task) => task.task_id)
        );
      }
      if (message.subtype === "task_notification") {
        workflows.delete(message.task_id);
      }
      if (message.subtype !== "init" || !followUps.waiting()) {
        return false;
      }
      followUps.resume();
      clearTimeout(idle);
      return true;
    },
    /** The main thread's `Stop` hook: what is still pending. */
    onStop: (stop: StopHookInput) => {
      const live = (stop.background_tasks ?? []).filter(
        (task) => !ambient.has(task.id)
      );
      const wakeup = (stop.session_crons ?? []).find((cron) => !cron.recurring);
      tasks = live.length > 0;
      wakeups = (stop.session_crons ?? []).length > 0;
      const launched = [...workflows.values()];
      // A workflow this run can relaunch is listed as one, not as a task.
      const others = live.filter(
        (task) =>
          task.type !== "workflow" ||
          !launched.some((workflow) => workflow.name === task.name)
      );
      const base: BackgroundPending = {
        tasks: others.map((task) => ({
          description: task.description,
          type: task.type,
        })),
        workflows: launched,
      };
      pending =
        wakeup === undefined || wakeupAt === undefined
          ? base
          : {
              ...base,
              wakeup: { prompt: wakeup.prompt, scheduledFor: wakeupAt },
            };
    },
    /**
     * At a result with nothing queued: park the run when work is pending.
     * It closes when nothing is, the hook never said, the inbox is closed or
     * no waiting slot is free; a shutdown that closed it cuts it instead.
     */
    park: (): Settle => {
      const waitsOnTasks = tasks;
      const waits = tasks || wakeups;
      tasks = false;
      wakeups = false;
      if (!waits) {
        return "closed";
      }
      if (followUps.closed()) {
        return followUps.shuttingDown() ? "cut" : "closed";
      }
      if (!waitSlot()) {
        ended = "full";
        return "closed";
      }
      followUps.park();
      clearTimeout(idle);
      if (!waitsOnTasks) {
        idle = setTimeout(expire, IDLE_CAP_MS);
      }
      return "parked";
    },
    /** What the run waits on, as the last `Stop` hook said. */
    pending: () => pending,
  };
};

/**
 * What a run resumed after the bot restarted is told: the CLI that held its
 * background work is gone, so each workflow is relaunched from its journal
 * (agents that finished come back from its cache) and each other task is
 * started again only if it is still needed. A wake-up due by `now` brings
 * its own prompt, the turn the CLI would have run; one still ahead is set
 * again for the time it had left.
 */
export const continuationPrompt = (pending: BackgroundPending, now: number) => {
  const work = [
    ...pending.workflows.map(
      (workflow) =>
        `- Workflow ${JSON.stringify(workflow.name)}: relaunch it with Workflow({scriptPath: ${JSON.stringify(workflow.scriptPath)}, resumeFromRunId: ${JSON.stringify(workflow.runId)}}).`
    ),
    ...pending.tasks.map(
      (task) =>
        `- ${task.type}: ${task.description}. Start it again only if it is still needed.`
    ),
  ];
  const parts = [
    "The bot restarted while this conversation waited on its background work, and that work stopped with it.",
  ];
  if (work.length > 0) {
    parts.push(
      `Pick it up again:\n${work.join("\n")}\nThen carry on as you would have once it reported.`
    );
  }
  const { wakeup } = pending;
  if (wakeup !== undefined) {
    const left = Math.ceil((wakeup.scheduledFor - now) / MS_PER_MINUTE);
    parts.push(
      left <= 0
        ? `Your ScheduleWakeup could not fire in the old session. It was due ${-left} minute(s) ago; check that what it was for still holds before acting on it. Its prompt was:\n\n${wakeup.prompt}`
        : `Your ScheduleWakeup was lost too. It was due in ${left} minute(s); set it again for that time if you still need it. Its prompt was:\n\n${wakeup.prompt}`
    );
  }
  return parts.join("\n\n");
};
