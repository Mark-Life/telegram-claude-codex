import {
  boundTaskPrompt,
  continuationPrompt,
  decodeProviderId,
  getProvider,
  isModelTier,
  isRoutedEffort,
  narrowAccess,
  runKeyOf,
  silentTaskPrompt,
  stopAgent,
  taskWaitPrompt,
} from "@workspace/agent";
import type {
  InterruptReason,
  ProviderId,
  SessionPick,
} from "@workspace/agent";
import type { AgentEvent, RunKey } from "@workspace/agent/types";
import type { BackgroundRun, TaskEntry, TaskRunWrite } from "@workspace/db";
import { Effect, Option } from "effect";
import type { Tracer } from "effect";

import { scheduledAccessFor, taskHoldsAccount } from "../access/run-access";
import { resolveTier } from "../access/tier";
import {
  countContinuation,
  getBackgroundRun,
  getTask,
  getUser,
  putBackgroundRun,
  removeBackgroundRun,
  updateTask,
} from "../db/bridge";
import { effectiveProviders } from "../handlers/agent-bridge";
import { providerChoiceOf, readUserSettings } from "../handlers/chat-defaults";
import { logRejection, logUnlessTelegram } from "../handlers/helpers";
import { taskRunFor } from "../handlers/model-route";
import type { RoutedRun } from "../handlers/model-route";
import { startProviderOf } from "../handlers/route-provider";
import { sendToNotifyRoute } from "../handlers/workspace";
import { t } from "../i18n";
import { logInfo } from "../log";
import { loadPersona } from "../persona";
import {
  isRestarting,
  MAX_CONTINUATIONS,
  resumable,
} from "../runs/continuation";
import type { TaskSurface } from "../runs/continuation";
import { runHeadless, runnableProvider } from "../runs/headless-run";
import type { RunEnding } from "../runs/headless-run";
import { namedModel } from "../session-history";
import { discardKeptSession, noteKeptSession } from "./kept-sessions";
import { TaskRunFailed } from "./run-failed";
import type { TaskRunEnd } from "./run-failed";

/**
 * A scheduled run occupies a slot of its own: a forum topic id is always
 * positive, so a negative one derived from the task id can never collide with a
 * conversation the owner is having. Without it a task firing mid-chat would
 * interrupt the owner's own run, which shares the single-flight slot per route.
 */
export const scheduledRunKey = (input: {
  chatId: number;
  ownerId: number;
  taskId: number;
}): RunKey => ({
  chatId: input.chatId,
  threadId: -input.taskId,
  userId: input.ownerId,
});

/** What a parked run reported: what it waits on, and in which session. */
type Parked = Extract<AgentEvent, { kind: "background"; state: "waiting" }>;

/** What a fire ran on, filled in as the run reports it. */
export type TaskRan = {
  -readonly [
    K in "effort" | "model" | "provider" | "sessionId"
  ]?: TaskRunWrite[K];
};

/** Note what the run reports about itself; the model it names wins. */
const noteRan = (ran: TaskRan) => (event: AgentEvent) =>
  Effect.sync(() => {
    if (
      event.kind === "session_init" ||
      event.kind === "result" ||
      (event.kind === "background" &&
        event.state === "waiting" &&
        event.sessionId.length > 0)
    ) {
      ran.sessionId = event.sessionId;
    }
    if (event.kind === "context" && event.model !== undefined) {
      ran.model = event.model;
    }
  });

/** Whom a task works for: its writer, else the owner (a task from before writers were recorded). */
const writerOf = (task: TaskEntry, ownerId: number) =>
  task.authorUserId ?? ownerId;

/**
 * The provider a task is meant for: its own choice, else the one its
 * writer's new conversations start on (`/settings`), read now, so a changed
 * default reaches every task that follows it. A chosen provider stays the
 * one meant while it is down: the fire falls back (`runnableProvider`) and
 * leaves the pick routed for it alone.
 */
export const intendedProvider = async (task: TaskEntry, ownerId: number) => {
  const own = Option.getOrUndefined(decodeProviderId(task.provider));
  if (own !== undefined) {
    return own;
  }
  const writerId = writerOf(task, ownerId);
  const choice = providerChoiceOf(await readUserSettings(writerId));
  if (choice.kind === "chosen") {
    return choice.provider;
  }
  // No choice of the writer's: the detected default, which stays fixed until
  // a login, moves to one that can run, so the task still routes and keeps.
  return runnableProvider(
    await startProviderOf({
      choice,
      detected: effectiveProviders().default,
      owner: writerId === ownerId,
    })
  );
};

/**
 * The routed pick stored on the row, when it was routed for `provider`:
 * the model as that provider can still run it (a slug it has since dropped
 * moves to its tier's current one), else none and the half is routed again.
 */
const cachedPick = (task: TaskEntry, provider: ProviderId): SessionPick => {
  if (task.pickProvider !== provider) {
    return {};
  }
  return {
    effort: task.pickEffort,
    model:
      task.pickModel === undefined
        ? undefined
        : getProvider(provider).resolveStored(task.pickModel),
  };
};

/**
 * What this task fires on. The task's own model and effort (`/tasks`,
 * `tasks-cli`) win; an unset half follows its writer's defaults, read at
 * every fire. A half left to the router is decided once — on the first fire
 * after the task was written, its payload or choice was edited, or its
 * provider changed — and stored on the row with the provider it was routed
 * for; later fires on that provider read it back and spend no judgment. A
 * fire that fell back to another provider stores nothing, so the row keeps
 * the pick its own provider runs.
 */
const modelForTask = async (
  task: TaskEntry,
  input: {
    intended: ProviderId;
    ownerId: number;
    prompt: string;
    provider: ProviderId;
  }
): Promise<RoutedRun> => {
  const { provider } = input;
  const keep = provider === input.intended;
  const { pick, routed } = await taskRunFor({
    cached: cachedPick(task, provider),
    choice: {
      effort: isRoutedEffort(task.effortLevel) ? task.effortLevel : undefined,
      tier: isModelTier(task.modelTier) ? task.modelTier : undefined,
    },
    keep,
    request: {
      input: { kind: "scheduled_task", message: input.prompt },
      provider,
      userId: writerOf(task, input.ownerId),
    },
  });
  if (routed !== undefined && keep) {
    await updateTask(task.id, {
      pickEffort: routed.effort ?? null,
      pickModel: routed.model ?? null,
      pickProvider: provider,
    });
  }
  return pick;
};

/**
 * The access a fire runs with and the stamp a task it writes gets. The
 * writer's tier is read now, at every fire, so a task an executor wrote loses
 * the owner's account the moment that executor is revoked or demoted, and
 * never runs with owner-only helpers.
 */
const taskAccess = async (
  task: TaskEntry,
  ownerId: number,
  keepSession: boolean
) => {
  const writerId = task.authorUserId;
  const stored = writerId === undefined ? undefined : await getUser(writerId);
  const writer =
    writerId === undefined
      ? undefined
      : resolveTier({ ownerId, stored: stored?.tier, userId: writerId });
  const holds = taskHoldsAccount({ author: task.author, writer });
  return {
    access: scheduledAccessFor({
      author: task.author,
      holdsAccount: holds,
      keepSession,
      writer,
    }),
    taskAuthor: holds
      ? { author: task.author ?? "executor", userId: writerId ?? ownerId }
      : undefined,
  };
};

/** The session an `own` task holds, as this fire last stored or read it. */
type StoredSession = {
  -readonly [K in "sessionId" | "sessionProvider"]: TaskEntry[K];
};

/**
 * Keep the session an `own` fire ran on, for the next fire to resume: as it
 * parks, so a crash meanwhile still finds its park in the task's session,
 * and after every fire, a failed one included, when it reported one other
 * than the stored, and only while the task still stands as the fire read it
 * (a reset, a new provider, project, type, mode or writer meanwhile wins).
 */
const keepOwnSession = async (input: {
  provider: ProviderId;
  ran: TaskRan;
  stored: StoredSession;
  task: TaskEntry;
}) => {
  const { provider, ran, stored, task } = input;
  if (ran.sessionId === undefined || ran.sessionId === stored.sessionId) {
    return;
  }
  const latest = await getTask(task.id);
  if (
    latest?.sessionMode !== "own" ||
    latest.sessionId !== stored.sessionId ||
    latest.sessionProvider !== stored.sessionProvider ||
    latest.provider !== task.provider ||
    latest.project !== task.project ||
    latest.type !== task.type ||
    latest.author !== task.author ||
    latest.authorUserId !== task.authorUserId
  ) {
    return;
  }
  await updateTask(task.id, {
    sessionId: ran.sessionId,
    sessionProvider: provider,
  });
  stored.sessionId = ran.sessionId;
  stored.sessionProvider = provider;
};

/** Where a task's fire parks: its own run slot's row in `background_runs`. */
const taskParkKey = (
  task: Pick<TaskEntry, "id">,
  deps: { chatId: number; ownerId: number }
) => runKeyOf(scheduledRunKey({ ...deps, taskId: task.id }));

/** The surface a park row is written with: which session the fire ran in. */
const parkModeOf = (keeps: boolean): TaskSurface =>
  keeps ? "task-own" : "task";

/**
 * What the owner is told of a park row no fire continues: the cause in
 * their words (`tasks.run.notResumed`), read when it is sent. A reset or a
 * mode switch, where the owner moved the task on themselves, is told
 * nothing (`undefined`).
 */
type NotResumedNotice = (() => string) | undefined;

/** One check a park row must pass, with what the owner is told if not. */
interface ParkCheck {
  fails: boolean;
  notice: NotResumedNotice;
  reason: string;
}

const notResumed = () => t().tasks.run.notResumed;
const changed = () => notResumed().changed;

/** Where a fire runs: the owner's slot, and the projects it defaults to. */
interface TaskFireDeps {
  chatId: number;
  ownerId: number;
  projectsDir: string;
}

/** What a fire runs as, which a park row must still match. */
interface TaskParkRun {
  fullAccess: boolean;
  /** The provider the task is meant for, before any fallback. */
  intended: ProviderId;
  keeps: boolean;
  provider: ProviderId;
}

/** What a fire finds in its slot: work to continue, a stale row, or none. */
type TaskPark =
  | { kind: "none" }
  | {
      kind: "invalid";
      notice: NotResumedNotice;
      reason: string;
      row: BackgroundRun;
    }
  | { kind: "resume"; row: BackgroundRun };

/**
 * The parked fire this one continues: a prompt task's row, written in the
 * same mode, on the same provider, project and (for an `own` task) session,
 * still on full access, short of `MAX_CONTINUATIONS` and with work left.
 * A row that fails a check is stale, with the first reason and what the
 * owner is told of it.
 */
const parkedFor = async (
  task: TaskEntry,
  deps: TaskFireDeps,
  run: TaskParkRun
): Promise<TaskPark> => {
  const row = await getBackgroundRun(taskParkKey(task, deps));
  if (row === undefined) {
    return { kind: "none" };
  }
  const checks: readonly ParkCheck[] = [
    {
      fails: task.type !== "prompt",
      notice: changed,
      reason: "not a prompt task",
    },
    {
      fails: task.sessionMode === "route",
      notice: changed,
      reason: "runs in its chat",
    },
    {
      fails: row.continuations >= MAX_CONTINUATIONS,
      notice: () => notResumed().cap,
      reason: "too many continuations in a row",
    },
    // The provider it was parked on is down or logged out: a fallback.
    {
      fails: row.provider === run.intended && run.provider !== run.intended,
      notice: () =>
        notResumed().providerDown(getProvider(run.intended).displayName),
      reason: "provider not ready",
    },
    // The task's provider, or the /settings default it follows, changed.
    {
      fails: row.provider !== run.provider,
      notice: () =>
        notResumed().provider(getProvider(run.provider).displayName),
      reason: "provider changed",
    },
    {
      fails: row.projectPath !== (task.project ?? deps.projectsDir),
      notice: changed,
      reason: "project changed",
    },
    {
      fails:
        row.surface !== parkModeOf(run.keeps) ||
        (run.keeps && row.sessionId !== task.sessionId),
      notice: undefined,
      reason: "mode or session changed",
    },
    {
      fails: !run.fullAccess,
      notice: () => notResumed().access,
      reason: "no full access",
    },
    {
      fails: !resumable(row.pending),
      notice: () => notResumed().nothing,
      reason: "nothing pending",
    },
  ];
  const failed = checks.find((check) => check.fails);
  return failed === undefined
    ? { kind: "resume", row }
    : { kind: "invalid", notice: failed.notice, reason: failed.reason, row };
};

/**
 * Who waits for a task's fire to park or end: the boot's resume, which
 * holds up the next one until then.
 */
const settleWaiters = new Map<number, (() => void)[]>();

/** Resolves once the task's running fire parked or ended. */
export const whenTaskSettles = async (taskId: number) => {
  const settled = Promise.withResolvers<undefined>();
  settleWaiters.set(taskId, [
    ...(settleWaiters.get(taskId) ?? []),
    () => {
      settled.resolve();
    },
  ]);
  await settled.promise;
};

const resolveSettled = (taskId: number) => {
  const waiters = settleWaiters.get(taskId);
  settleWaiters.delete(taskId);
  for (const resolve of waiters ?? []) {
    resolve();
  }
};

/**
 * Forget a task's park row no fire continues. A fresh fire's Claude
 * transcript, kept only so the row could be continued, goes with it; an
 * `own` row's session is the task's own and stays.
 */
const dropTaskPark = async (row: BackgroundRun) => {
  await removeBackgroundRun(row.runKey);
  if (row.surface === "task" && row.provider === "claude") {
    await discardKeptSession(row.sessionId);
  }
};

/** Why the owner ended a task's fire: Stop, or the task deleted or paused. */
export type TaskStop = Extract<InterruptReason, "replaced" | "stopped">;

/** What a fire is asked for: see `runTaskPrompt`. */
interface TaskFireAsk {
  prompt?: string;
  /** Called once the run is registered, where a Stop reaches it. */
  registered?: () => void;
  resumes?: BackgroundRun["updatedAt"];
  /** A Stop, delete or pause that came before the run was registered. */
  stopped?: () => TaskStop | undefined;
}

/**
 * Forget the park row of a task's fire, if it has one, so no fire
 * continues it. Answers whether there was one.
 */
export const forgetTaskPark = async (
  task: Pick<TaskEntry, "id">,
  deps: { chatId: number; ownerId: number }
) => {
  const row = await getBackgroundRun(taskParkKey(task, deps));
  if (row !== undefined) {
    await dropTaskPark(row);
  }
  return row !== undefined;
};

/**
 * What a fire of the task runs as: the provider (its own, else a fallback),
 * the access, and whether it keeps the task's session and runs on full
 * access, which a park row must still match.
 */
const fireSetup = async (task: TaskEntry, ownerId: number) => {
  const intended = await intendedProvider(task, ownerId);
  const provider = runnableProvider(intended);
  // A fire on a fallback runs fresh and keeps no session, as with the routed
  // pick: the stored session stays for the provider the task is meant for.
  const meant = task.sessionMode === "own" && provider === intended;
  const access = await taskAccess(task, ownerId, meant);
  const narrowed = narrowAccess(
    access.access,
    getProvider(provider).capabilities
  );
  return {
    access,
    fullAccess: narrowed.sandbox === "danger-full-access",
    intended,
    // A view the provider keeps no session in (an in-view sandbox) leaves
    // nothing to resume, so nothing is stored.
    keeps: meant && narrowed.persistSession,
    provider,
  };
};

/**
 * The park the fire continues, or none: a stale row is dropped, and the
 * owner is told unless they moved the task on themselves. A failed read
 * runs the fire fresh.
 */
const continuedPark = async (
  task: TaskEntry,
  deps: TaskFireDeps,
  run: TaskParkRun
) => {
  let found: TaskPark = { kind: "none" };
  try {
    found = await parkedFor(task, deps, run);
  } catch (error) {
    logRejection(`task ${task.id}: parked fire not read`)(error);
  }
  if (found.kind === "invalid") {
    logInfo(
      `[continuation] task ${task.id} not resumed reason=${found.reason}`
    );
    await dropTaskPark(found.row).catch(
      logRejection(`task ${task.id}: parked fire not removed`)
    );
    if (found.notice !== undefined) {
      await sendToNotifyRoute({
        ownerId: deps.ownerId,
        text: `${task.title}\n\n${found.notice()}`,
      }).catch(
        logUnlessTelegram(`task ${task.id}: not-resumed notice not sent`)
      );
    }
  }
  return found.kind === "resume" ? found.row : undefined;
};

/**
 * Whether a fire the boot queued still continues its task's cut fire: the
 * row it was queued for stands unchanged (a Stop, or a fire of the task
 * meanwhile, wins) and passes every check a fire runs on it. A stale row is
 * dropped as a fire drops it, and nothing fires: the task runs at its next
 * fire. A failed read fires nothing either.
 */
export const resumesPark = async (
  task: TaskEntry,
  deps: TaskFireDeps,
  updatedAt: BackgroundRun["updatedAt"]
) => {
  try {
    const row = await getBackgroundRun(taskParkKey(task, deps));
    if (row?.updatedAt !== updatedAt) {
      return false;
    }
    const setup = await fireSetup(task, deps.ownerId);
    return (await continuedPark(task, deps, setup)) !== undefined;
  } catch (error) {
    logRejection(`task ${task.id}: parked fire not checked`)(error);
    return false;
  }
};

/**
 * What a fresh fire is told: the payload, or a gated script's prompt, framed
 * for an `own` task, after the rules a silent task and one that may wait on
 * background work (`waits`) need. A resumed fire's session holds them.
 */
const freshPrompt = ({
  prompt,
  task,
  waits,
}: {
  prompt: string;
  task: TaskEntry;
  waits: boolean;
}) =>
  [
    ...(waits ? [taskWaitPrompt()] : []),
    ...(task.chatId === undefined ? [silentTaskPrompt()] : []),
    task.sessionMode === "own"
      ? boundTaskPrompt({ prompt, title: task.title })
      : prompt,
  ].join("\n\n");

/**
 * Clean up after a fire. One the restart cut, or one refused a slot as it
 * resumed, keeps its park row for the next fire; any other ending leaves
 * nothing to continue, and a fresh fire's Claude session, kept only for a
 * restart to resume, is deleted. Whoever waits for the fire to settle is
 * released.
 */
const afterFire = async (input: {
  end: TaskRunEnd | undefined;
  keeps: boolean;
  /** The fire's park row (`taskParkKey`). */
  key: string;
  provider: ProviderId;
  ran: TaskRan;
  task: TaskEntry;
}) => {
  const { end, ran, task } = input;
  // Kept only for a row a later fire continues: a cut whose park wrote none
  // (a failed write, nothing resumable) has nothing to keep the session for.
  // A failed read keeps it; the boot's sweep deletes it if no row names it.
  const holds =
    task.type === "prompt" &&
    (end === "cut" || end === "busy") &&
    (await getBackgroundRun(input.key)
      .then((row) => row !== undefined)
      .catch(() => true));
  if (!holds) {
    await removeBackgroundRun(input.key).catch(
      logRejection(`task ${task.id}: parked fire not removed`)
    );
  }
  resolveSettled(task.id);
  if (
    !input.keeps &&
    !holds &&
    input.provider === "claude" &&
    ran.sessionId !== undefined
  ) {
    await discardKeptSession(ran.sessionId).catch(
      logRejection(`task ${task.id}: fresh session not discarded`)
    );
  }
};

/** Nothing ran: the park a boot's fire was queued for is gone. */
const nothingToContinue = (task: TaskEntry) => {
  resolveSettled(task.id);
  logInfo(`[continuation] task ${task.id}: its parked fire is gone`);
  return new TaskRunFailed({ end: "gone", message: "nothing to continue" });
};

/**
 * A fire stopped before its run was registered runs nothing: the ending
 * the Stop, delete or pause asked for.
 */
const haltIfStopped = (task: TaskEntry, fire: TaskFireAsk) => {
  const stop = fire.stopped?.();
  if (stop !== undefined) {
    resolveSettled(task.id);
    logInfo(`task ${task.id}: ${stop} before its run started`);
    throw new TaskRunFailed({ end: stop, message: `${stop} as it started` });
  }
};

/**
 * Run a prompt task through the same registry every chat prompt goes through,
 * so a scheduled run competes for the concurrency slots on equal terms and can
 * be stopped like any other. It runs on the owner's profile (the owner's
 * Telegram account only when `taskHoldsAccount` says so), in the task's
 * project, on the model its instruction was routed to. A silent task is told
 * how to report a failure, since nobody reads what it answers. An `own` task
 * resumes its session while it is on the provider that session belongs to,
 * else starts one, and keeps it. `fire.prompt` is a gated script's prompt,
 * else the payload. `parent` is the fire's span; `ran` gets what the fire
 * runs on, for the task's run log.
 *
 * Like a chat run, the fire waits for background work it started (Claude on
 * full access), and its last turn is the report. A prompt task's park is
 * recorded, so a fire the restart cut is continued by the next fire of the
 * task, the boot's included; a fresh fire's transcript, kept only for that,
 * is noted as it starts and dropped once the fire ended. A fire the boot
 * queued (`fire.resumes`, the row's `updatedAt`) runs only to continue that
 * row: once it is gone or another, nothing runs (`gone`). A Stop, delete or
 * pause that came while the fire started (`fire.stopped`, which the
 * registry's stop cannot reach yet) ends it before its run, or as soon as
 * the run is registered (`fire.registered`).
 */
export const runTaskPrompt = async ({
  deps,
  fire = {},
  parent,
  ran,
  task,
}: {
  deps: TaskFireDeps;
  fire?: TaskFireAsk;
  parent: Tracer.AnySpan | undefined;
  ran: TaskRan;
  task: TaskEntry;
}) => {
  const prompt = fire.prompt ?? task.payload;
  const key = taskParkKey(task, deps);
  const { resumes } = fire;
  if (resumes !== undefined) {
    const row = await getBackgroundRun(key);
    if (row?.updatedAt !== resumes) {
      throw nothingToContinue(task);
    }
  }
  const { access, fullAccess, intended, keeps, provider } = await fireSetup(
    task,
    deps.ownerId
  );
  // Before the routing, which may take a judgment: a boot's fire that has
  // nothing left to continue spends none.
  const parked = await continuedPark(task, deps, {
    fullAccess,
    intended,
    keeps,
    provider,
  });
  if (resumes !== undefined && parked?.updatedAt !== resumes) {
    throw nothingToContinue(task);
  }
  // Before the routing, which may take a judgment.
  haltIfStopped(task, fire);
  // Routed on the task's own instruction, never on a continuation's.
  const picked = await modelForTask(task, {
    intended,
    ownerId: deps.ownerId,
    prompt,
    provider,
  });
  ran.provider = provider;
  ran.effort = picked.effort;
  const stored: StoredSession = {
    sessionId: task.sessionId,
    sessionProvider: task.sessionProvider,
  };
  const projectPath = task.project ?? deps.projectsDir;
  if (parked !== undefined) {
    await countContinuation(key);
  }
  const slot = scheduledRunKey({ ...deps, taskId: task.id });
  // A fresh fire's Claude transcript, kept only for a restart to continue.
  const notesSession = !keeps && provider === "claude" && fullAccess;
  const persona = await loadPersona();
  haltIfStopped(task, fire);
  const options = {
    ...slot,
    ...access,
    effort: picked.effort,
    model: picked.model,
    persona,
    projectDir: projectPath,
    prompt:
      parked === undefined
        ? freshPrompt({
            prompt,
            task,
            waits: provider === "claude" && fullAccess,
          })
        : continuationPrompt(parked.pending, Date.now()),
    sessionId:
      parked?.sessionId ??
      (keeps && task.sessionProvider === provider ? task.sessionId : undefined),
    waitForBackground: true,
  };
  /**
   * Once the run is registered, a Stop reaches it; one that came after the
   * last check, while it registered, stops it at once.
   */
  const registered = Effect.suspend(() => {
    const stop = fire.stopped?.();
    fire.registered?.();
    return stop === undefined
      ? Effect.void
      : Effect.asVoid(stopAgent(slot, stop));
  });
  /** Keep an `own` fire's session; losing the id costs a resume. */
  const keepSession = async () => {
    if (keeps) {
      await keepOwnSession({ provider, ran, stored, task }).catch(
        logRejection(`task ${task.id}: own session not stored`)
      );
    }
  };
  /** Record a park, so a restart can continue it; a gated fire is not. */
  const recordPark = async (event: Parked) => {
    // First, so the row is never found ahead of the session it names.
    await keepSession();
    if (task.type === "prompt") {
      await (
        event.sessionId.length === 0 || !resumable(event.pending)
          ? removeBackgroundRun(key)
          : putBackgroundRun({
              chatId: deps.chatId,
              continuations:
                parked === undefined ? 0 : parked.continuations + 1,
              pending: event.pending,
              projectPath,
              provider,
              runKey: key,
              sessionId: event.sessionId,
              // A fire still working when the shutdown began parks only to
              // be cut.
              stopCause: isRestarting() ? "restart" : undefined,
              surface: parkModeOf(keeps),
              threadId: -task.id,
              userId: deps.ownerId,
            })
      ).catch(logRejection(`task ${task.id}: parked fire not recorded`));
    }
    resolveSettled(task.id);
  };
  const ends: RunEnding = {};
  const noted = noteRan(ran);
  try {
    return await runHeadless({
      ends,
      onModel: (model) => {
        ran.model = namedModel(model);
      },
      options,
      parent,
      provider,
      registered,
      span: { attributes: { "task.id": task.id }, name: "Task.prompt" },
      tap: (event) =>
        Effect.gen(function* () {
          yield* noted(event);
          if (notesSession && event.kind === "session_init") {
            yield* Effect.promise(async () => {
              await noteKeptSession(event.sessionId).catch(
                logRejection(`task ${task.id}: session not noted`)
              );
            });
          }
          if (event.kind === "background" && event.state === "waiting") {
            yield* Effect.promise(async () => {
              await recordPark(event);
            });
          }
        }),
    });
  } finally {
    await afterFire({ end: ends.value, keeps, key, provider, ran, task });
    // Failing the fire over it would cost its answer.
    await keepSession();
  }
};
