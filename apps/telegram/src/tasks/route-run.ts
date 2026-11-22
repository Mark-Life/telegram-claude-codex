import { setTimeout as sleep } from "node:timers/promises";

import { boundTaskPrompt } from "@workspace/agent";
import { routeWriterId } from "@workspace/db";
import type { TaskEntry } from "@workspace/db";

import type { AccessInfo } from "../access/context";
import { runAccessFor } from "../access/run-access";
import { resolveTier } from "../access/tier";
import type { Surface } from "../access/tier";
import { getTask, getUser, updateTask } from "../db/bridge";
import { isRouteRunning, isRunning } from "../handlers/agent-bridge";
import type { RunDone, RunOrigin, RunPipeline } from "../handlers/deps";
import { routeProvider } from "../handlers/route-provider";
import {
  forgetSession,
  routeView,
  setRouteProject,
} from "../handlers/session-routing";
import {
  activePendingPlan,
  routeDraining,
  stateFor,
} from "../handlers/user-state";
import type { UserState } from "../handlers/user-state";
import { workspaceChatId } from "../handlers/workspace";
import { logInfo } from "../log";
import { sendTo } from "../telegram/bridge";
import type { Route } from "../telegram/route";
import { TaskRunFailed } from "./run-failed";

/**
 * A `route` task fires into the conversation of its chat and topic, as if
 * its writer had sent the instruction there: the answer streams into the
 * chat, the topic's session, provider and pick apply, and a human message
 * afterwards continues it. It goes through `RunPipeline.resume`, the door a
 * run with no update behind it takes, and never interrupts anyone: while the
 * conversation is busy the fire waits.
 */

/** How often a fire waiting on a busy conversation looks again. */
const TASK_BUSY_POLL_MS = 15_000;

/** Where a route task runs and as whom, read at every attempt. */
interface RouteTarget {
  access: AccessInfo;
  route: Route;
  state: UserState;
}

/**
 * The conversation a route task runs in, on its writer's chat access there
 * now (a revoked writer is refused), or why it cannot run. Only the writer's
 * own private chat or the workspace: a run in any other chat would have
 * nobody's chat access to run on.
 */
const routeTarget = async (
  task: TaskEntry,
  ownerId: number
): Promise<{ refusal: string } | { target: RouteTarget }> => {
  if (task.chatId === undefined) {
    return { refusal: "route mode needs a chat" };
  }
  // Whom it runs as: the user it is stamped with; with no id, the owner
  // unless the stamp is `executor`, which is refused rather than run with
  // the owner's powers.
  const writer = routeWriterId(task, ownerId);
  if (writer === undefined) {
    return { refusal: "route mode needs a task stamped with its writer's id" };
  }
  let surface: Surface | undefined;
  if (task.chatId === writer) {
    surface = "private";
  } else if (task.chatId === (await workspaceChatId())) {
    surface = "workspace";
  }
  if (surface === undefined) {
    return {
      refusal: "route mode needs the writer's private chat or the workspace",
    };
  }
  const stored = await getUser(writer);
  const access: AccessInfo = {
    surface,
    tier: resolveTier({ ownerId, stored: stored?.tier, userId: writer }),
  };
  if (!runAccessFor(access).agent.persistSession) {
    return { refusal: "the writer's access there keeps no conversation" };
  }
  const route = { chatId: task.chatId, threadId: task.threadId ?? null };
  const state = await stateFor({ ...route, userId: writer });
  return { target: { access, route, state } };
};

/**
 * Whether anything runs in the conversation: the writer's own run (its
 * light slot included), anyone's run in the same chat and topic, whose
 * session is shared, or anyone's drain or compaction there.
 */
const routeRunning = ({ route, state }: RouteTarget) =>
  isRunning(state) || isRouteRunning(route) || routeDraining(route);

/**
 * Whether a fire must wait: something runs there, or a plan waits for the
 * writer's answer, which a fire's run would take over.
 */
const routeBusy = (target: RouteTarget) =>
  routeRunning(target) || activePendingPlan(target.state) !== undefined;

/**
 * Start a route task's conversation over, as `/new` does there, once nothing
 * runs in it: never by stopping a run. A plan waiting for an answer is
 * dropped, as `/new` drops it. In a private chat or the workspace's General
 * topic, that is the per-project session of the conversation's project. A
 * task that can no longer run there drops the request. Answers which of the
 * three it was.
 */
export const applyRouteReset = async (
  task: TaskEntry,
  ownerId: number
): Promise<"busy" | "done" | "refused"> => {
  const resolved = await routeTarget(task, ownerId);
  if ("refusal" in resolved) {
    logInfo(
      `[tasks] task ${task.id}: session reset dropped: ${resolved.refusal}`
    );
    await updateTask(task.id, { sessionReset: null });
    return "refused";
  }
  const { target } = resolved;
  if (routeRunning(target)) {
    return "busy";
  }
  const { state } = target;
  const { provider } = await routeProvider({ access: target.access, state });
  // A run that started during the await resumes the old session and would
  // write it back over the reset: look again right before it, keeping the
  // flag for the next pass.
  if (routeRunning(target)) {
    return "busy";
  }
  await forgetSession(routeView(state, provider));
  state.unpicked = undefined;
  state.pendingPlan = undefined;
  await updateTask(task.id, { sessionReset: null });
  logInfo(`[tasks] task ${task.id}: route session reset`);
  return "done";
};

/** One poll's wait, cut short by a shutdown. */
const pause = async (stopping: AbortSignal) => {
  try {
    await sleep(TASK_BUSY_POLL_MS, "poll", { signal: stopping });
  } catch (error) {
    if (!stopping.aborted) {
      throw error;
    }
  }
};

/**
 * How a fire into a conversation ended. `rebound` marks a fire given up
 * because the task, still wanted, was retyped or rebound meanwhile: the
 * caller fires it again as it now stands.
 */
export type RouteRunEnd = { abandoned: string; rebound?: true } | RunDone;

/**
 * Whether the task is still there and still enabled (unless run by hand).
 */
const stillWanted = (
  latest: TaskEntry | undefined,
  force: boolean
): latest is TaskEntry => latest !== undefined && (latest.enabled || force);

/**
 * Whether the task still fires the way this fire read it: of the same type
 * (the path that fires it was picked by type) and bound to the same chat and
 * topic.
 */
const sameBinding = (first: TaskEntry, latest: TaskEntry) =>
  latest.type === first.type &&
  latest.sessionMode === "route" &&
  latest.chatId === first.chatId &&
  latest.threadId === first.threadId;

/**
 * Fire a route task into its conversation and wait for the run to end. Each
 * attempt reads the task and the conversation again (a state held across a
 * wait could be evicted and split in two), and while the conversation is
 * busy it sleeps `TASK_BUSY_POLL_MS`, cut short by `stopping`. The last check
 * and the start are one synchronous step, so no message slips between.
 * `prompt` is a gated script's prompt; absent, the task's payload as it now
 * stands. `forced` is read at every attempt: a "run now" press that joined
 * the waiting fire makes it run a paused task too. A refusal throws
 * `TaskRunFailed`; a task deleted, paused, retyped or rebound meanwhile, or
 * a shutdown, abandons the fire (a retyped or rebound one as `rebound`).
 */
export const runInRoute = async (input: {
  forced: () => boolean;
  onStarted: () => void;
  ownerId: number;
  pipeline: RunPipeline;
  projectsDir: string;
  prompt?: string;
  stopping: AbortSignal;
  task: TaskEntry;
}): Promise<RouteRunEnd> => {
  const { pipeline, task: first } = input;
  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- each attempt reads the task again
    const task = await getTask(first.id);
    if (!stillWanted(task, input.forced())) {
      return { abandoned: "task deleted or paused while waiting" };
    }
    if (!sameBinding(first, task)) {
      return {
        abandoned: "task retyped or rebound while waiting",
        rebound: true,
      };
    }
    if (input.stopping.aborted) {
      return { abandoned: "bot stopping while route busy" };
    }
    // oxlint-disable-next-line no-await-in-loop -- one attempt at a time
    const resolved = await routeTarget(task, input.ownerId);
    if ("refusal" in resolved) {
      throw new TaskRunFailed({ message: resolved.refusal });
    }
    const { target } = resolved;
    if (input.stopping.aborted) {
      return { abandoned: "bot stopping while route busy" };
    }
    if (routeBusy(target)) {
      // oxlint-disable-next-line no-await-in-loop -- the wait is the point
      await pause(input.stopping);
      continue;
    }
    // The work that needs an await comes first; the conversation is checked
    // again after it, in the same step as the start.
    if (task.sessionReset === true) {
      // oxlint-disable-next-line no-await-in-loop -- applied before this fire's run
      await applyRouteReset(task, input.ownerId);
    }
    const { state } = target;
    if (!state.activeProject && runAccessFor(target.access).scratch === false) {
      // oxlint-disable-next-line no-await-in-loop -- as a human's first message does
      const { provider } = await routeProvider({
        access: target.access,
        state,
      });
      // oxlint-disable-next-line no-await-in-loop -- once, before the start
      await setRouteProject(state, input.projectsDir, provider);
    }
    if (input.stopping.aborted) {
      return { abandoned: "bot stopping while route busy" };
    }
    if (routeBusy(target)) {
      continue;
    }
    const done = Promise.withResolvers<RunDone>();
    const origin: RunOrigin = {
      access: target.access,
      continuation: 0,
      onDone: done.resolve,
      reply: async (text) => {
        await sendTo(target.route, text);
      },
      route: target.route,
    };
    const prompt = boundTaskPrompt({
      prompt: input.prompt ?? task.payload,
      title: task.title,
    });
    if (!pipeline.resume(origin, prompt, state)) {
      continue;
    }
    input.onStarted();
    logInfo(
      `[tasks] task ${task.id}: fired into chat_id=${target.route.chatId} thread_id=${target.route.threadId ?? "main"} user_id=${state.userId}`
    );
    // oxlint-disable-next-line no-await-in-loop -- the loop ends here
    return await done.promise;
  }
};
