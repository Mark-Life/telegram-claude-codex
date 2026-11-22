import {
  continuationPrompt,
  runKeyOf,
  stopWaitingRuns,
} from "@workspace/agent";
import { decodeProviderId } from "@workspace/agent/registry";
import type { AgentEvent, ProviderId } from "@workspace/agent/types";
import { BackgroundRunsRepo } from "@workspace/db";
import type { BackgroundRun } from "@workspace/db";
import { Effect, Option } from "effect";

import type { AccessInfo } from "../access/context";
import { runAccessFor } from "../access/run-access";
import { resolveTier } from "../access/tier";
import type { Surface } from "../access/tier";
import {
  countContinuation,
  getBackgroundRun,
  getUser,
  listBackgroundRuns,
  putBackgroundRun,
  removeBackgroundRun,
} from "../db/bridge";
import type { RunOrigin, RunPipeline } from "../handlers/deps";
import { logRejection, logUnlessTelegram } from "../handlers/helpers";
import { routeProvider, runnableNow } from "../handlers/route-provider";
import { routeView, storedSessionId } from "../handlers/session-routing";
import { stateFor } from "../handlers/user-state";
import type { UserState } from "../handlers/user-state";
import { workspaceChatId } from "../handlers/workspace";
import { t } from "../i18n";
import { logInfo } from "../log";
import { sendTo } from "../telegram/bridge";

/**
 * A conversation parked on background work outlives the bot's restart: each
 * park is recorded (`background_runs`), a shutdown stops the parked runs at
 * once and keeps their rows, and the boot resumes them. A workflow is
 * relaunched from its journal and other background work is restarted if the
 * model still needs it, at once; a wake-up alone waits on a bot timer and
 * resumes the session when it was due, with no CLI held meanwhile. A
 * prompt task's fire parks the same way, on a row of its own surface
 * (`isTaskSurface`); the task scheduler resumes those, through the same
 * queue (`scheduleResume`).
 */

/** Resumes in a row with no message from the user between them. */
export const MAX_CONTINUATIONS = 3;

const MS_PER_MINUTE = 60_000;
const SETTLE_TIMEOUT_MINUTES = 5;
/** How long a boot resume may hold up the next before it parks or ends. */
const SETTLE_TIMEOUT_MS = SETTLE_TIMEOUT_MINUTES * MS_PER_MINUTE;

/** Set once a shutdown began: no wake-up timer starts a run any more. */
let restarting = false;

/** Whether a shutdown began, so a park now is one the restart cuts. */
export const isRestarting = () => restarting;

/**
 * Resumes run one at a time, each once the one before parked or ended, so
 * they never take every working slot: the boot's and every due wake-up's.
 */
let queue = Promise.resolve();

/** What a parked run reported: what it waits on, and in which session. */
type Parked = Omit<
  Extract<AgentEvent, { kind: "background"; state: "waiting" }>,
  "kind"
>;

/**
 * How a prompt task's park row is marked: `task` for a fresh fire, `task-own`
 * for one in the task's own session. A row is resumed only in the mode it
 * was written in.
 */
export type TaskSurface = "task" | "task-own";

/** Whether a park row is a prompt task's, not a conversation's. */
export const isTaskSurface = (surface: string): surface is TaskSurface =>
  surface === "task" || surface === "task-own";

/**
 * Nothing in this slot is left to resume: its run ended, or the user stopped
 * it. A run the restart cut keeps its row; its caller does not call this.
 */
export const forgetPark = (
  key: Pick<UserState, "chatId" | "threadId" | "userId">
) => {
  removeBackgroundRun(runKeyOf(key)).catch(
    logRejection("Parked run record not removed")
  );
};

/** Whether a park left anything a restart could pick up again. */
export const resumable = (pending: BackgroundRun["pending"]) =>
  pending.workflows.length > 0 ||
  pending.tasks.length > 0 ||
  pending.wakeup !== undefined;

/**
 * Record a park, so a restart can resume the conversation. Only a run that
 * holds a session and waits on something it can pick up again is kept. The
 * resume count holds only while the user said nothing to this run. A failed
 * write is logged; the run waits on.
 */
export const recordPark = async (input: {
  origin: RunOrigin;
  parked: Parked;
  projectPath: string;
  provider: ProviderId;
  state: UserState;
}) => {
  const { origin, parked, state } = input;
  if (parked.sessionId.length === 0 || !resumable(parked.pending)) {
    forgetPark(state);
    return;
  }
  await putBackgroundRun({
    chatId: state.chatId,
    continuations: state.steered.length > 0 ? 0 : origin.continuation,
    pending: parked.pending,
    projectPath: input.projectPath,
    provider: input.provider,
    runKey: runKeyOf(state),
    sessionId: parked.sessionId,
    // A run still working when the shutdown began parks only to be cut.
    stopCause: restarting ? "restart" : undefined,
    surface: origin.access.surface,
    threadId: state.threadId ?? undefined,
    userId: state.userId,
  }).catch(logRejection("Parked run not recorded"));
};

/**
 * The first step of a shutdown: every recorded conversation was cut by this
 * restart, not a crash, and every parked run stops now rather than after the
 * CLI's own ten minutes. A run still working finishes its turn, and is cut
 * the same way when work is still pending at its last result.
 */
export const prepareRestart = Effect.gen(function* () {
  restarting = true;
  yield* BackgroundRunsRepo.use((repo) => repo.markRestart()).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Parked runs not marked for the restart", error)
    )
  );
  const stopped = yield* stopWaitingRuns;
  if (stopped > 0) {
    yield* Effect.log(`Stopped ${stopped} parked run(s) for the restart`);
  }
});

/**
 * Where the row's conversation answers now: the surface it was recorded on,
 * while that still holds (a workspace forum the owner moved is gone).
 */
const surfaceNow = async (row: BackgroundRun): Promise<Surface | undefined> => {
  if (row.surface === "private") {
    return "private";
  }
  if (row.surface === "workspace" && row.chatId === (await workspaceChatId())) {
    return "workspace";
  }
  return undefined;
};

/**
 * Why a recorded conversation is not resumed, checked in order; none when
 * it is.
 */
const refusal = async (input: {
  access: AccessInfo;
  provider: ProviderId;
  row: BackgroundRun;
  state: UserState;
}) => {
  const { access, provider, row, state } = input;
  const checks: readonly [string, () => Promise<boolean> | boolean][] = [
    [
      "too many continuations in a row",
      () => row.continuations >= MAX_CONTINUATIONS,
    ],
    [
      "no full access",
      () => runAccessFor(access).agent.sandbox !== "danger-full-access",
    ],
    ["provider not ready", () => !runnableNow(provider)],
    [
      "route on another provider",
      async () => {
        const route = await routeProvider({ access, state });
        return route.provider !== provider;
      },
    ],
    [
      "route on another session",
      async () =>
        state.activeProject !== row.projectPath ||
        (await storedSessionId(routeView(state, provider))) !== row.sessionId,
    ],
  ];
  for (const [reason, fails] of checks) {
    // oxlint-disable-next-line no-await-in-loop -- in order, the first one wins
    if (await fails()) {
      return Option.some(reason);
    }
  }
  return Option.none<string>();
};

/** What a resume that started nothing answers: the queue moves on at once. */
export const NOTHING_STARTED = { settled: Promise.resolve() };

/** One recorded conversation, ready to resume: who, where, and its prompt. */
interface Resumable {
  origin: RunOrigin;
  row: BackgroundRun;
  state: UserState;
}

/**
 * Start the resumed run, counted first so a crash in it still counts.
 * Answers what settles once the run parked or ended, at once when it did
 * not start.
 */
const start = async (
  pipeline: RunPipeline,
  { origin, row, state }: Resumable
) => {
  await countContinuation(row.runKey);
  // A shutdown that began meanwhile keeps the row for the next boot; a
  // `/stop` meanwhile dropped it, and nothing starts.
  const counted = await getBackgroundRun(row.runKey);
  if (restarting || counted === undefined) {
    return NOTHING_STARTED;
  }
  const settled = Promise.withResolvers<undefined>();
  const started = pipeline.resume(
    {
      ...origin,
      continuation: row.continuations + 1,
      onSettle: () => {
        settled.resolve();
      },
    },
    continuationPrompt(row.pending, Date.now()),
    state
  );
  logInfo(
    `[continuation] ${started ? "resumed" : "user run wins"} run_key=${row.runKey} continuation=${row.continuations + 1} cause=${row.stopCause ?? "crash"}`
  );
  return started ? { settled: settled.promise } : NOTHING_STARTED;
};

/** The row as a conversation the bot may resume, or why it may not. */
const resumableOf = async (
  row: BackgroundRun,
  ownerId: number
): Promise<{ reason: string } | { resumable: Resumable }> => {
  if (!resumable(row.pending)) {
    return { reason: "nothing pending" };
  }
  const provider = Option.getOrUndefined(decodeProviderId(row.provider));
  const surface = await surfaceNow(row);
  if (provider === undefined || surface === undefined) {
    return { reason: "route gone" };
  }
  const stored = await getUser(row.userId);
  const access: AccessInfo = {
    surface,
    tier: resolveTier({ ownerId, stored: stored?.tier, userId: row.userId }),
  };
  const route = { chatId: row.chatId, threadId: row.threadId ?? null };
  const state = await stateFor({ ...route, userId: row.userId });
  const refused = await refusal({ access, provider, row, state });
  if (Option.isSome(refused)) {
    return { reason: refused.value };
  }
  const origin: RunOrigin = {
    access,
    continuation: row.continuations,
    reply: async (text) => {
      await sendTo(route, text);
    },
    route,
  };
  return { resumable: { origin, row, state } };
};

/**
 * Refusals the chat is told of: the user did not cause them. A conversation
 * the user moved on from (`/new`, `/history`, `/provider`) is dropped quietly.
 */
const TOLD = new Set([
  "no full access",
  "provider not ready",
  "too many continuations in a row",
]);

/**
 * Forget a row that will not resume. Its chat was told at the restart that
 * the bot would try, so it is told the work did not go on.
 */
const refuse = async (row: BackgroundRun, reason: string) => {
  logInfo(`[continuation] not resumed run_key=${row.runKey} reason=${reason}`);
  await removeBackgroundRun(row.runKey);
  if (TOLD.has(reason)) {
    await sendTo(
      { chatId: row.chatId, threadId: row.threadId ?? null },
      t().status.restartNotResumed
    ).catch(logUnlessTelegram("Not-resumed notice not sent"));
  }
};

/**
 * Resume one recorded conversation now, as the boot decided it earlier.
 * Every check runs again first: `/new`, `/history`, `/provider` or a lost
 * login meanwhile wins.
 */
const attempt = async (input: {
  ownerId: number;
  pipeline: RunPipeline;
  row: BackgroundRun;
}) => {
  const verdict = await resumableOf(input.row, input.ownerId);
  if ("reason" in verdict) {
    await refuse(input.row, verdict.reason);
    return NOTHING_STARTED;
  }
  return await start(input.pipeline, verdict.resumable);
};

/**
 * What a user's own run on this slot carries along when it starts before the
 * slot's resume ran (a wake-up still on its timer, a resume still queued):
 * the message wins the slot, so it takes the pending work with it rather
 * than drop it at its end. Only on the session the work was cut in.
 */
export const carriedContinuation = async (
  state: UserState,
  provider: ProviderId
) => {
  const row = await getBackgroundRun(runKeyOf(state));
  if (
    row === undefined ||
    row.provider !== provider ||
    (await storedSessionId(routeView(state, provider))) !== row.sessionId
  ) {
    return Option.none<string>();
  }
  return Option.some(continuationPrompt(row.pending, Date.now()));
};

/**
 * Wait for a resumed run to park or end, at most `SETTLE_TIMEOUT_MS`, so
 * the next resume starts only then and never takes every working slot.
 */
const settleWithin = async (settled: Promise<unknown>) => {
  const timedOut = Promise.withResolvers<undefined>();
  const timer = setTimeout(() => {
    timedOut.resolve();
  }, SETTLE_TIMEOUT_MS);
  await Promise.race([settled, timedOut.promise]);
  clearTimeout(timer);
};

/**
 * Resume one recorded row, a conversation's or a prompt task's, through the
 * one queue: at once when it waited on a workflow or a background task, else
 * once its wake-up is due, with no CLI held meanwhile. When its turn comes
 * the row is read again: a shutdown, a stop or a newer park meanwhile
 * (another `updatedAt`) wins and nothing runs. `run` starts the resume and
 * answers what settles once it parked or ended (`NOTHING_STARTED` when
 * nothing did); the queue moves on then, or after `SETTLE_TIMEOUT_MS`.
 */
export const scheduleResume = (input: {
  decided: BackgroundRun;
  run: (row: BackgroundRun) => Promise<{ settled: Promise<unknown> }>;
}) => {
  const { decided } = input;
  const enqueue = () => {
    queue = queue
      .then(async () => {
        const row = await getBackgroundRun(decided.runKey);
        if (restarting || row?.updatedAt !== decided.updatedAt) {
          return;
        }
        const { settled } = await input.run(row);
        await settleWithin(settled);
      })
      .catch(logRejection("Parked run resume failed"));
  };
  if (
    decided.pending.workflows.length > 0 ||
    decided.pending.tasks.length > 0
  ) {
    enqueue();
    return;
  }
  setTimeout(
    enqueue,
    Math.max(0, (decided.pending.wakeup?.scheduledFor ?? 0) - Date.now())
  );
};

/** Each row the boot found, decided: resumed, now or on a timer, or refused. */
const decide = async (rows: readonly BackgroundRun[], ownerId: number) => {
  const resumed: BackgroundRun[] = [];
  let refused = 0;
  for (const row of rows) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- rows are few, one at a time
      const verdict = await resumableOf(row, ownerId);
      if ("reason" in verdict) {
        refused += TOLD.has(verdict.reason) ? 1 : 0;
        // oxlint-disable-next-line no-await-in-loop -- rows are few, one at a time
        await refuse(row, verdict.reason);
      } else {
        resumed.push(row);
      }
    } catch (error) {
      logRejection("Parked run not resumed")(error);
      refused += 1;
    }
  }
  return { refused, resumed };
};

/**
 * At boot: resume every conversation a restart or a crash cut while it waited
 * on background work, one at a time, or schedule it when it waited on a
 * wake-up alone. One that may not resume is forgotten and its chat told.
 * Resolves, before any resume starts, with how many will resume and how many
 * will not; a failure is logged and counts as not.
 */
export const resumeParkedRuns = async (input: {
  ownerId: number;
  pipeline: RunPipeline;
}) => {
  let rows: readonly BackgroundRun[] = [];
  try {
    rows = await listBackgroundRuns();
  } catch (error) {
    logRejection("Parked runs not read")(error);
  }
  // A task's row is the task scheduler's to resume: read as a conversation,
  // it has no surface and would be refused, and so deleted.
  const { refused, resumed } = await decide(
    rows.filter((row) => !isTaskSurface(row.surface)),
    input.ownerId
  );
  for (const decided of resumed) {
    scheduleResume({
      decided,
      run: async (row) => await attempt({ ...input, row }),
    });
  }
  return { notResumed: refused, resumed: resumed.length };
};
