import {
  formatForTelegram,
  readExecutorTarget,
  runExecutorScript,
} from "@workspace/agent";
import type { BackgroundRun, TaskEntry } from "@workspace/db";
import { Effect, FiberMap, Option, Schedule } from "effect";
import type { Tracer } from "effect";

import { ensureScratchDir } from "../access/scratch";
import {
  getTask,
  listBackgroundRuns,
  listPendingTaskResets,
  listTasks,
  recordTaskRun,
  updateTask,
} from "../db/bridge";
import { isWaiting, stopRun } from "../handlers/agent-bridge";
import type { HandlerDeps, RunPipeline } from "../handlers/deps";
import { logRejection } from "../handlers/helpers";
import { helperFor } from "../handlers/light-defaults";
import { sendToNotifyRoute } from "../handlers/workspace";
import { t } from "../i18n";
import { logInfo, logWarning } from "../log";
import {
  isTaskSurface,
  NOTHING_STARTED,
  scheduleResume,
} from "../runs/continuation";
import { runtime } from "../runtime";
import { safeSendRichMessage, TelegramBotError } from "../telegram/bridge";
import { withDetail } from "../telegram/errors";
import { splitText } from "../telegram/format";
import { sweepKeptSessions } from "./kept-sessions";
import {
  forgetTaskPark,
  resumesPark,
  runTaskPrompt,
  scheduledRunKey,
  whenTaskSettles,
} from "./prompt-run";
import type { TaskRan, TaskStop } from "./prompt-run";
import { applyRouteReset, runInRoute } from "./route-run";
import type { RouteRunEnd } from "./route-run";
import { fireTask } from "./runner";
import type { RunnerDeps, TaskOutcome } from "./runner";
import { RELOAD_INTERVAL_MS, createScheduler } from "./scheduler";
import { checkTaskCompleted } from "./verdict";

export type { TaskOutcome } from "./runner";
export type { TaskScheduler } from "./scheduler";
export {
  RELOAD_INTERVAL_MS,
  schedulable,
  scheduleSignature,
} from "./scheduler";

/**
 * How one fire was asked for: the "run now" button, the delayed retry, or
 * the boot's continuation of a fire the restart cut (`resumes`, its park
 * row's `updatedAt`).
 */
export interface FireOptions {
  force?: boolean;
  resumes?: BackgroundRun["updatedAt"];
  retry?: boolean;
}

/**
 * What asking for a fire did: `queued` it behind the task's running fire, if
 * any, or `coalesced` it into a fire of the task that is already waiting
 * and will do the same work. `done` settles once that fire ended.
 */
export interface FireTicket {
  admitted: "coalesced" | "queued";
  done: Promise<void>;
}

/**
 * A fire's options as it runs; `force` can still turn on while it waits,
 * and `resumes` goes once a fire of any other kind joins it. A fire that
 * only `resumes` runs only while that park row stands and may be continued.
 * `starting` holds from the fire's start until its prompt run is
 * registered, where the registry's stop cannot reach it yet; `stop` is a
 * Stop, delete or pause that came while it waited or started, which ends it
 * before its run.
 */
interface FireRequest {
  force: boolean;
  resumes?: BackgroundRun["updatedAt"];
  retry: boolean;
  starting: boolean;
  stop?: TaskStop;
}

/** One delayed recovery attempt for a failed recurring task. */
const MILLISECONDS_PER_MINUTE = 60_000;
const TASK_RETRY_DELAY_MINUTES = 7;
export const TASK_RETRY_DELAY_MS =
  TASK_RETRY_DELAY_MINUTES * MILLISECONDS_PER_MINUTE;

/**
 * Composition root of the recurring-task feature: the cron loop, the ways a
 * task can run (a script through Executor, a prompt in a fresh or its own
 * session, or in its chat's conversation through the run pipeline, and a
 * gated script that does one of the last two only when it hands back a
 * prompt), and the one place its result is delivered. Fires of one task run
 * one after another, and at most one waits. Everything it needs from the
 * outside world (Executor, the agent, the pipeline, the formatting pass, the
 * chat) is bound here, so `runner.ts` and `scheduler.ts` stay testable on
 * their own.
 */

/**
 * The state a gated script kept last time, as JSON: parsed and written
 * again, so nothing but JSON reaches the code. A row that does not parse (a
 * hand edit) reads as none.
 */
const scriptStateJson = (task: TaskEntry) => {
  if (task.scriptState === undefined) {
    return "null";
  }
  try {
    return JSON.stringify(JSON.parse(task.scriptState));
  } catch {
    logWarning(`task ${task.id}: stored script state is not JSON; using null`);
    return "null";
  }
};

/**
 * The code Executor runs: the payload, and for a gated script (one that
 * keeps a conversation) the state it returned last time ahead of it, as
 * `taskState`.
 */
const scriptCode = (task: TaskEntry) =>
  task.sessionMode === undefined
    ? task.payload
    : `const taskState = ${scriptStateJson(task)};\n${task.payload}`;

/** Replay a script task's code, or say why Executor could not be reached. */
const executeScript = async (task: TaskEntry) => {
  const target = await runtime.runPromise(readExecutorTarget);
  if (target === undefined) {
    return {
      kind: "failed" as const,
      message:
        "Executor is not configured (EXECUTOR_MCP_URL, EXECUTOR_API_KEY)",
    };
  }
  return await runExecutorScript({ code: scriptCode(task), target });
};

/**
 * Keep what a gated script returned as its state, once its fire went well
 * (a failed one runs the script again on the old state at its retry), and
 * only while the task runs the same code.
 */
const keepScriptState = async (input: {
  latest: TaskEntry | undefined;
  outcome: TaskOutcome;
  task: TaskEntry;
}) => {
  const { latest, outcome, task } = input;
  if (
    outcome.scriptState === undefined ||
    outcome.status !== "ok" ||
    latest?.payload !== task.payload ||
    latest.type !== task.type
  ) {
    return;
  }
  await updateTask(task.id, { scriptState: outcome.scriptState });
};

/**
 * Build the scheduler with everything wired: script tasks go to Executor,
 * prompt tasks go through the run registry or, for a route task, the run
 * pipeline, and everything not shown in a chat's conversation is delivered
 * to the task's chat or the topic the bot uses for unprompted messages (the
 * owner's workspace once set). Pending retries are fibers keyed by task id in
 * the calling scope; nothing is registered or polled until `start`.
 */
export const createTaskScheduler = Effect.fnUntraced(function* (
  deps: HandlerDeps,
  pipeline: RunPipeline
) {
  const retries = yield* FiberMap.make<number>();
  // The slot every task fire runs in: the owner's, under the task's id.
  const owner = { chatId: deps.ownerId, ownerId: deps.ownerId };
  const armRetry = yield* FiberMap.runtime(retries)();
  let stopped = false;
  // Aborted by `stop`, so a fire waiting on a busy conversation wakes at
  // once rather than holding the shutdown for a poll.
  const stopping = new AbortController();

  /**
   * A task with its own chat gets everything there. A task without one is
   * silent (see `fireOnce`), so only a failure or a pause — something the
   * owner must act on — reaches the notify route, which knows the workspace
   * topic and its fallback. So does what a task's chat no longer takes (its
   * topic was deleted, the bot was removed): a deleted topic would otherwise
   * fail unseen at every fire.
   */
  const deliver = async (task: TaskEntry, outcome: TaskOutcome) => {
    let route =
      task.chatId === undefined
        ? undefined
        : { chatId: task.chatId, threadId: task.threadId ?? null };
    for (const chunk of splitText(outcome.text)) {
      if (route !== undefined) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- chunks must arrive in order
          await safeSendRichMessage({ input: { markdown: chunk }, route });
          continue;
        } catch (error) {
          const gone =
            error instanceof TelegramBotError &&
            (error.reason === "BadRequest" || error.reason === "NotFound");
          if (!gone) {
            throw error;
          }
          logWarning(
            `task ${task.id}: its chat refused the report; using the notify route`
          );
          route = undefined;
        }
      }
      // oxlint-disable-next-line no-await-in-loop -- chunks must arrive in order
      await sendToNotifyRoute({
        ownerId: deps.ownerId,
        text: chunk,
      });
    }
  };

  /** What one fire needs beside the task: see `runnerDeps`. */
  interface FireContext {
    begun: () => void;
    forced: () => boolean;
    parent: Tracer.AnySpan | undefined;
    ran: TaskRan;
    /** The fire's prompt run is registered, where a Stop reaches it. */
    registered: () => void;
    /** The park row a boot's fire continues, read as its run starts. */
    resumes: () => BackgroundRun["updatedAt"] | undefined;
    /** A Stop, delete or pause that came while the fire started. */
    stopped: () => TaskStop | undefined;
  }

  /**
   * A route task's fire, in its chat's conversation: what it ran on comes
   * from the pipeline's `onDone`.
   */
  const fireInRoute = async (
    fire: FireContext,
    task: TaskEntry,
    prompt: string | undefined
  ): Promise<RouteRunEnd> => {
    const end = await runInRoute({
      forced: fire.forced,
      onStarted: fire.begun,
      ownerId: deps.ownerId,
      pipeline,
      projectsDir: deps.projectsDir,
      prompt,
      stopping: stopping.signal,
      task,
    });
    if (!("abandoned" in end || "refused" in end)) {
      fire.ran.provider = end.provider;
      fire.ran.sessionId = end.result?.sessionId;
    }
    return end;
  };

  /**
   * `parent` is the fire's span: the run and its judgment nest under it.
   * `ran` gets what a prompt run ran on. `begun` marks the fire as no longer
   * waiting, once its run starts; until then `forced` can turn true.
   */
  const runnerDeps = (fire: FireContext): RunnerDeps => ({
    execute: executeScript,
    prettify: async (args) => {
      const { pick } = await helperFor("format");
      return await formatForTelegram({
        ...args,
        ...pick,
        workingDirectory: ensureScratchDir(deps.ownerId),
      });
    },
    // The owner's private chat, not the notify route: this id is what the run
    // is told to send generated files to, and send-file only accepts a private
    // chat. The task's text output goes to the notify route separately.
    runPrompt: async (task, prompt) =>
      await runTaskPrompt({
        deps: {
          chatId: deps.ownerId,
          ownerId: deps.ownerId,
          projectsDir: deps.projectsDir,
        },
        fire: {
          prompt,
          registered: fire.registered,
          resumes: fire.resumes(),
          stopped: fire.stopped,
        },
        parent: fire.parent,
        ran: fire.ran,
        task,
      }),
    runRoute: async (task, prompt) => await fireInRoute(fire, task, prompt),
    stopped: fire.stopped,
  });

  /**
   * What a recorded fire leads to: the retry it earns (answered true), the
   * report and its judgment. A fire into a chat's conversation sends nothing:
   * the chat already shows the answer or the error. A retry that failed there
   * too also reaches the notify route, in case nobody reads that chat. One
   * that never reached the conversation is delivered as any other report,
   * which falls back on the notify route when the chat refuses it.
   */
  const settle = Effect.fnUntraced(function* (input: {
    outcome: TaskOutcome;
    parent: Tracer.AnySpan | undefined;
    retry: boolean;
    task: TaskEntry;
  }) {
    const { outcome, parent, retry, task } = input;
    const failed = outcome.status === "error";
    if (failed && !retry && task.enabled && !outcome.noRetry) {
      return true;
    }
    if (!failed) {
      yield* FiberMap.remove(retries, task.id);
    }
    if (outcome.inRoute === true) {
      if (failed && retry) {
        yield* Effect.promise(async () => {
          await sendToNotifyRoute({
            ownerId: deps.ownerId,
            text: `${task.title}\n\n${withDetail(t().tasks.run.failed, outcome.reason)}`,
          }).catch(logRejection(`task ${task.id}: failure notice not sent`));
        });
      }
      return false;
    }
    if (outcome.text.length === 0) {
      return false;
    }
    if (task.chatId === undefined && outcome.status === "ok") {
      yield* Effect.log(`task ${task.id} is silent; output not delivered`);
      return false;
    }
    yield* Effect.promise(async () => {
      await deliver(task, outcome);
    });
    // After delivery, so the report never waits on the judge. A prompt task
    // only: a script task's payload is code, and a real failure already
    // arrives as `failed`; a gated script's prompt is not the task's
    // instruction either.
    const { answer } = outcome;
    if (answer !== undefined && outcome.status === "ok" && !outcome.gated) {
      yield* Effect.promise(async () => {
        await checkTaskCompleted({
          answer,
          ownerId: deps.ownerId,
          parent,
          silent: task.chatId === undefined,
          task,
        });
      });
    }
    return false;
  });

  /**
   * Record a fire that happened, keep a gated script's state, then deliver
   * and judge it (`settle`). Answers true when the failure earns the retry.
   */
  const recordFire = Effect.fnUntraced(function* (fired: {
    outcome: TaskOutcome;
    parent: Tracer.AnySpan | undefined;
    ran: TaskRan;
    retry: boolean;
    startedAt: number;
    task: TaskEntry;
  }) {
    const { outcome, parent, ran, retry, startedAt, task } = fired;
    const taskId = task.id;
    yield* Effect.annotateCurrentSpan({
      "task.status": outcome.status,
      "task.type": task.type,
    });
    if (outcome.reason !== undefined) {
      yield* Effect.logError(`task ${taskId} failed: ${outcome.reason}`);
    }
    const latest = yield* Effect.promise(
      async () =>
        await recordTaskRun({
          ...ran,
          finishedAt: Date.now(),
          startedAt,
          status: outcome.status,
          taskId,
        })
    );
    yield* Effect.promise(async () => {
      await keepScriptState({ latest, outcome, task }).catch(
        logRejection(`task ${taskId}: script state not stored`)
      );
    });
    return yield* settle({ outcome, parent, retry, task });
  });

  /**
   * Fire one task by id, reading it fresh: a task edited or paused since the
   * job was registered does the new thing, or nothing at all. `request.force`
   * is the "run now" button, which runs a paused task too; a press that
   * joins this fire while it waits sets it. One span per fire.
   * Answers true when the failure earns the one delayed retry. A fire
   * abandoned while it waited (or queued when the bot began to stop) records
   * nothing: restarts are routine, and the next tick runs the task. One
   * abandoned because its task was retyped or rebound fires again.
   */
  const fireOnce = Effect.fn("Task.fire")(function* (
    taskId: number,
    request: FireRequest,
    begun: () => void
  ) {
    const { force, retry } = request;
    yield* Effect.annotateCurrentSpan({
      "task.force": force,
      "task.id": taskId,
      "task.retry": retry,
    });
    const parent = Option.getOrUndefined(
      yield* Effect.option(Effect.currentSpan)
    );
    // A fire given up because its task, still wanted, was retyped or
    // rebound while it waited fires again as the task now stands: a press
    // that joined the wait is not lost, nor the tick.
    while (true) {
      if (stopped) {
        return false;
      }
      const task = yield* Effect.promise(async () => await getTask(taskId));
      if (task === undefined || !(task.enabled || request.force)) {
        // A fire the restart cut is not continued days later, once the
        // task is resumed: its next fire starts over.
        yield* Effect.promise(async () => {
          await forgetTaskPark({ id: taskId }, owner).catch(
            logRejection(`task ${taskId}: parked fire not removed`)
          );
        });
        return false;
      }
      const { resumes } = request;
      // Read again once checked: a tick, press or retry that joined the
      // fire meanwhile fires it anyway.
      if (
        resumes !== undefined &&
        !(yield* Effect.promise(
          async () =>
            await resumesPark(
              task,
              { ...owner, projectsDir: deps.projectsDir },
              resumes
            )
        )) &&
        request.resumes !== undefined
      ) {
        yield* Effect.log(`task ${taskId}: nothing left to continue`);
        return false;
      }
      // Stopped while it waited: nothing runs, nothing is recorded.
      if (request.stop !== undefined) {
        yield* Effect.log(`task ${taskId}: ${request.stop} before it began`);
        return false;
      }
      // A route fire waits for its conversation; any other starts now.
      if (task.sessionMode !== "route") {
        begun();
      }
      // A run in the task's own slot, which a Stop meanwhile must reach.
      request.starting =
        task.type === "prompt"
          ? task.sessionMode !== "route"
          : task.sessionMode === "own";
      const ran: TaskRan = {};
      const startedAt = Date.now();
      const outcome = yield* Effect.promise(async () => {
        try {
          return await fireTask(
            task,
            runnerDeps({
              begun,
              forced: () => request.force,
              parent,
              ran,
              registered: () => {
                request.starting = false;
              },
              resumes: () => request.resumes,
              stopped: () => request.stop,
            })
          );
        } finally {
          request.starting = false;
        }
      });
      if (outcome.abandoned) {
        yield* Effect.log(`task ${taskId}: ${outcome.reason ?? "abandoned"}`);
        if (outcome.rebound) {
          continue;
        }
        return false;
      }
      return yield* recordFire({
        outcome,
        parent,
        ran,
        retry,
        startedAt,
        task,
      });
    }
  });

  /**
   * Arm the one delayed retry of a failed fire, which reads the task again:
   * one that was fixed, paused or already re-run by hand in the meantime is
   * left alone. The timer only hands the retry over: once it runs it is
   * pending work, which a shutdown drains instead of cutting.
   */
  const armRetryOf = (taskId: number, again: () => Promise<void>) => {
    const retry = async () => {
      const latest = await getTask(taskId);
      if (
        latest === undefined ||
        !latest.enabled ||
        latest.lastStatus !== "error"
      ) {
        return;
      }
      await again();
    };
    armRetry(
      taskId,
      Effect.sleep(TASK_RETRY_DELAY_MS).pipe(
        Effect.andThen(
          Effect.sync(() => {
            deps.pendingWork
              .track(retry())
              .catch(logRejection(`task ${taskId} retry crashed`));
          })
        )
      ),
      { onlyIfMissing: true }
    );
  };

  // Fires of one task run one after another, never side by side: a second
  // fire would interrupt the first in its slot, or answer twice in one
  // conversation. `waiting` holds the request of each task's fire that is
  // queued and has not started its run yet; a request that joins it can
  // still force it.
  const chains = new Map<number, Promise<void>>();
  const waiting = new Map<number, FireRequest>();
  // The request of each task's fire that is running now.
  const firing = new Map<number, FireRequest>();

  /**
   * Ask for one fire, as tracked work. A fire of the task that is still
   * waiting already does the same work, so a cron tick, a "run now" press or
   * a retry meanwhile joins it rather than queueing a second; otherwise it
   * queues behind the task's running fire, if any. Answers at once which it
   * was.
   */
  const fire = (taskId: number, opts?: FireOptions): FireTicket => {
    const previous = chains.get(taskId);
    const queued = waiting.get(taskId);
    if (queued !== undefined && previous !== undefined) {
      logInfo(`task ${taskId}: a fire already waits; this one joins it`);
      // A press runs the task even if it was paused meanwhile.
      queued.force ||= opts?.force === true;
      // A tick, press or retry fires even with nothing left to continue.
      if (opts?.resumes === undefined) {
        queued.resumes = undefined;
      }
      return { admitted: "coalesced", done: previous };
    }
    const request: FireRequest = {
      force: opts?.force === true,
      resumes: opts?.resumes,
      retry: opts?.retry === true,
      starting: false,
    };
    waiting.set(taskId, request);
    const begun = () => {
      if (waiting.get(taskId) === request) {
        waiting.delete(taskId);
      }
    };
    const next = (previous ?? Promise.resolve())
      .then(async () => {
        firing.set(taskId, request);
        const retryDue = await runtime.runPromise(
          deps.pendingWork.run(fireOnce(taskId, request, begun))
        );
        if (retryDue && !stopped) {
          armRetryOf(taskId, async () => {
            await fire(taskId, { retry: true }).done;
          });
        }
      })
      .catch(logRejection(`task ${taskId} fire crashed`))
      .finally(() => {
        begun();
        if (firing.get(taskId) === request) {
          firing.delete(taskId);
        }
        if (chains.get(taskId) === next) {
          chains.delete(taskId);
        }
      });
    chains.set(taskId, next);
    return { admitted: "queued", done: next };
  };

  /**
   * Continue one fire the restart cut, through the queue the conversations'
   * resumes share (`scheduleResume`), so the boot never takes every working
   * slot. The fire continues the parked work only while its row stands and
   * may still be continued (`resumesPark`); otherwise nothing fires.
   */
  const resumeFire = (row: BackgroundRun, taskId: number) => {
    scheduleResume({
      decided: row,
      run: async () =>
        await Promise.resolve(
          stopped
            ? NOTHING_STARTED
            : {
                settled: Promise.race([
                  whenTaskSettles(taskId),
                  fire(taskId, { resumes: row.updatedAt }).done,
                ]),
              }
        ),
    });
  };

  /**
   * At boot: continue every prompt task's fire a restart or a crash cut
   * while it waited on background work, at once, or once its wake-up is due
   * when it waited on that alone. A row of a task deleted or paused since is
   * dropped quietly; one that may no longer be continued (`resumesPark`) is
   * dropped as a fire drops it, the owner told unless they moved the task
   * on, and the task runs at its next fire.
   */
  const resumeParked = async () => {
    const all = await listBackgroundRuns();
    // A fresh fire the last process died in left its transcript behind.
    await sweepKeptSessions(new Set(all.map((row) => row.sessionId))).catch(
      logRejection("leftover task sessions not deleted")
    );
    const rows = all.filter((row) => isTaskSurface(row.surface));
    const fireDeps = { ...owner, projectsDir: deps.projectsDir };
    let resumed = 0;
    for (const row of rows) {
      const taskId = -(row.threadId ?? 0);
      // oxlint-disable-next-line no-await-in-loop -- rows are few, one at a time
      const task = await getTask(taskId);
      if (task === undefined || !task.enabled) {
        // oxlint-disable-next-line no-await-in-loop -- rows are few, one at a time
        await forgetTaskPark({ id: taskId }, owner).catch(
          logRejection(`task ${taskId}: parked fire not removed`)
        );
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- rows are few, one at a time
      if (await resumesPark(task, fireDeps, row.updatedAt)) {
        resumed += 1;
        resumeFire(row, taskId);
      }
    }
    if (resumed > 0) {
      logInfo(`[continuation] resuming ${resumed} task fire(s)`);
    }
  };

  const scheduler = createScheduler({
    fire: async (taskId) => {
      await fire(taskId).done;
    },
    list: listTasks,
  });

  /**
   * End a task's running fire, or the one starting, which the registry
   * cannot reach until its run is registered: it ends before its run, or as
   * the run registers. Synchronous, so no run registers in between. Answers
   * whether there was one.
   */
  const endRunningFire = (taskId: number, reason: TaskStop) => {
    const current = firing.get(taskId);
    const starting = current?.starting === true;
    if (current !== undefined && starting) {
      current.stop ??= reason;
    }
    return stopRun(scheduledRunKey({ ...owner, taskId }), reason) || starting;
  };

  /**
   * Stop everything a task would still run (Stop, or its delete): the fire
   * running or starting (`endRunningFire`), the one queued behind it, the
   * delayed retry armed for it, and the park row a fire would continue.
   * The task's next tick fires as usual. Answers whether anything was
   * stopped.
   */
  const stopTask = async (taskId: number, reason: TaskStop) => {
    const running = endRunningFire(taskId, reason);
    const queued = waiting.get(taskId);
    if (queued !== undefined) {
      queued.stop ??= reason;
      waiting.delete(taskId);
    }
    const retried = FiberMap.hasUnsafe(retries, taskId);
    if (retried) {
      await runtime.runPromise(FiberMap.remove(retries, taskId));
    }
    const parked = await forgetTaskPark({ id: taskId }, owner);
    return running || queued !== undefined || retried || parked;
  };

  /**
   * End the fire of every task deleted or paused since it began, as the
   * /tasks Delete button does: the tasks CLI only writes the table. A
   * deleted task's fire stops whatever it does; a paused one's only while it
   * waits on background work (a turn that runs ends with its report), and
   * a fire «Run now» forced on a paused task keeps going. Their park rows
   * go too, quietly.
   */
  const endDroppedFires = async () => {
    const listed = await listTasks();
    const tasks = new Map(listed.map((task) => [task.id, task]));
    const rows = await listBackgroundRuns();
    const parked = rows
      .filter((row) => isTaskSurface(row.surface))
      .map((row) => -(row.threadId ?? 0));
    for (const taskId of new Set([...firing.keys(), ...parked])) {
      const task = tasks.get(taskId);
      const slot = scheduledRunKey({ ...owner, taskId });
      const ends =
        task === undefined ||
        (!task.enabled &&
          firing.get(taskId)?.force !== true &&
          (isWaiting(slot) || !firing.has(taskId)));
      if (!ends) {
        continue;
      }
      if (endRunningFire(taskId, "replaced")) {
        logInfo(`task ${taskId}: fire ended, the task was deleted or paused`);
      }
      // oxlint-disable-next-line no-await-in-loop -- rows are few, one at a time
      await forgetTaskPark({ id: taskId }, owner).catch(
        logRejection(`task ${taskId}: parked fire not removed`)
      );
    }
  };

  /** Re-register every task, and end the fires of the ones that went. */
  const reload = async () => {
    const count = await scheduler.reload();
    await endDroppedFires().catch(logRejection("dropped task fires not ended"));
    return count;
  };

  /**
   * Drop every cron job and pending retry, and wake every fire that waits on
   * a busy conversation, which then gives up; nothing is armed afterwards.
   */
  const stop = Effect.suspend(() => {
    stopped = true;
    stopping.abort();
    scheduler.stop();
    return FiberMap.clear(retries);
  });

  /**
   * Start over every route task's conversation a reset was asked for (the
   * CLI cannot reach the conversation), each once nothing runs there; one
   * still busy keeps its request for the next pass.
   */
  const applyResets = async () => {
    for (const task of await listPendingTaskResets()) {
      // oxlint-disable-next-line no-await-in-loop -- one conversation at a time
      await applyRouteReset(task, deps.ownerId).catch(
        logRejection(`task ${task.id}: session reset failed`)
      );
    }
  };

  /** One re-read of the table; a failure is logged and the next pass retries. */
  const refreshPass = Effect.tryPromise(async () => {
    await applyResets().catch(logRejection("task session resets not read"));
    const count = await scheduler.refresh();
    await endDroppedFires().catch(logRejection("dropped task fires not ended"));
    return count;
  }).pipe(
    Effect.catch((error) =>
      Effect.logError("task scheduler refresh failed", error)
    )
  );

  /**
   * Register every task, then re-read the table every `RELOAD_INTERVAL_MS`
   * until the calling scope closes, which also runs `stop`. Answers how many
   * jobs are live, or none when the first read failed: that is logged and the
   * next refresh registers the tasks.
   */
  const start = Effect.gen(function* () {
    yield* Effect.addFinalizer(() => stop);
    const count = yield* Effect.tryPromise(
      async () => await scheduler.reload()
    ).pipe(
      Effect.map(Option.some),
      Effect.catch((error) =>
        Effect.as(
          Effect.logError(
            "task scheduler reload failed; tasks register on the next refresh",
            error
          ),
          Option.none<number>()
        )
      )
    );
    // Not awaited: the boot goes on while the cut fires continue.
    yield* Effect.sync(() => {
      resumeParked().catch(logRejection("parked task fires not resumed"));
    });
    yield* Effect.sleep(RELOAD_INTERVAL_MS).pipe(
      Effect.andThen(
        refreshPass.pipe(Effect.repeat(Schedule.fixed(RELOAD_INTERVAL_MS)))
      ),
      Effect.forkScoped
    );
    return count;
  });

  // The wired `fire` replaces the scheduler's own so a handler can force a run.
  return {
    fire,
    jobIds: scheduler.jobIds,
    nextRun: scheduler.nextRun,
    reload,
    start,
    stopTask,
  };
});

/** The task feature, as the handlers and the entrypoint see it. */
export type TaskSchedulerHandle = Effect.Success<
  ReturnType<typeof createTaskScheduler>
>;
