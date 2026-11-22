import {
  clearSession,
  getSession,
  getSessionPick,
  setSession,
  setSessionPick,
} from "@workspace/agent";
import type { SessionPick } from "@workspace/agent";
import type { ProviderId } from "@workspace/agent/types";
import type { PersistenceError } from "@workspace/db";
import { Effect, Option } from "effect";

import {
  adoptThreadSession,
  clearThreadSession,
  getThread,
  logPersistenceError,
  pinThread,
} from "../db/bridge";
import { ThreadsRepo } from "../db/threads";
import { runtime } from "../runtime";
import { setActiveProject } from "../state";
import { projectPathOr } from "../work-dir";
import type { UserState } from "./user-state";

/**
 * Where a conversation's session id lives depends on the route: a forum topic
 * owns one session per topic in the `threads` table, while a private chat, a
 * plain group and the General topic keep the per-directory `sessions` table
 * (`SessionStore`). Every read and write of a session id goes through this
 * module so the two stores never cross.
 */

/**
 * One conversation as a single provider sees it. A conversation carries no
 * provider of its own: each run and each command resolves it for its route
 * (`route-provider.ts`), and a run keeps the one it started with, so a late
 * write from a run `/provider` stopped never lands on the new provider's row.
 */
export interface RouteState extends Pick<
  UserState,
  "activeProject" | "chatId" | "threadId" | "userId"
> {
  readonly activeProvider: ProviderId;
}

/**
 * `state` on `provider`. The project is read through, so a project switch
 * made after the view was taken is still seen.
 */
export const routeView = (state: UserState, provider: ProviderId) => ({
  get activeProject() {
    return state.activeProject;
  },
  activeProvider: provider,
  chatId: state.chatId,
  threadId: state.threadId,
  userId: state.userId,
});

/**
 * The directory one run actually works in. A sandboxed run works in its own
 * scratch dir, not in the conversation's project, so its session is kept per
 * scratch dir: it must neither resume the project's session (the owner's, with
 * `WORK_DIR` set every project collapses onto it) nor write over the topic row,
 * which belongs to everyone posting in that topic.
 */
export interface RunDir {
  projectPath: string;
  scratch: boolean;
}

/** The directory the conversation itself is pointed at. */
const dirOf = (
  state: Pick<UserState, "activeProject">,
  run?: RunDir
): RunDir => ({
  projectPath: run?.projectPath ?? state.activeProject,
  scratch: run?.scratch ?? false,
});

/** The topic this state belongs to, or undefined outside a topic or in scratch. */
const topicOf = (
  state: Pick<UserState, "activeProject" | "chatId" | "threadId">,
  dir?: RunDir
) =>
  state.threadId === null || dirOf(state, dir).scratch
    ? undefined
    : { chatId: state.chatId, threadId: state.threadId };

/** One threads-repo op, its failure logged once like the bridge does. */
const threads = <A>(
  f: (repo: ThreadsRepo["Service"]) => Effect.Effect<A, PersistenceError>
) => ThreadsRepo.use(f).pipe(Effect.tapError(logPersistenceError));

/**
 * Session id the next prompt resumes, from the directory the run works in. In a
 * topic the row is re-pinned first, so a project switch inside the topic drops
 * the stored session and the prompt starts a fresh conversation there. A row
 * already moved to another provider is left alone and the run starts fresh.
 */
export const sessionIdFor = Effect.fn("sessionIdFor")(function* (
  state: RouteState,
  run?: RunDir
) {
  const dir = dirOf(state, run);
  const topic = topicOf(state, dir);
  if (!topic) {
    return yield* getSession(dir.projectPath, state.activeProvider);
  }
  const pinned = yield* threads((repo) =>
    repo.pinForRun({
      ...topic,
      projectPath: dir.projectPath,
      provider: state.activeProvider,
    })
  );
  return Option.getOrUndefined(pinned)?.sessionId;
});

/**
 * The session the conversation's next run on `state`'s provider would resume,
 * from the directory the run works in, read without the re-pin
 * `sessionIdFor` makes.
 */
export const storedSessionId = async (state: RouteState, run?: RunDir) => {
  const dir = dirOf(state, run);
  const topic = topicOf(state, dir);
  if (!topic) {
    return await runtime.runPromise(
      getSession(dir.projectPath, state.activeProvider)
    );
  }
  const row = await getThread(topic);
  return row?.provider === state.activeProvider ? row.sessionId : undefined;
};

/** `sessionIdFor` for a grammy closure. */
export const resolveSessionId = async (state: RouteState, run?: RunDir) =>
  await runtime.runPromise(sessionIdFor(state, run));

/**
 * Continue this conversation on `sessionId` (resumed history, an approved plan,
 * a finished compaction).
 */
export const adoptSession = async (
  state: RouteState,
  sessionId: string,
  run?: RunDir
) => {
  const dir = dirOf(state, run);
  const topic = topicOf(state, dir);
  if (!topic) {
    await runtime.runPromise(
      setSession({
        project: dir.projectPath,
        provider: state.activeProvider,
        sessionId,
      })
    );
    return;
  }
  // One transaction: a run that ended on a session must never leave a pin
  // without it.
  await adoptThreadSession({
    ...topic,
    projectPath: dir.projectPath,
    provider: state.activeProvider,
    sessionId,
  });
};

/**
 * Record the session a finished run ended on, under the same key
 * `resolveSessionId` reads. Outside a topic `runAgent` already taps every
 * session id into the per-directory store, except for a scratch run inside a
 * topic: that one skips both taps, so it is written here.
 */
export const storeRunSession = Effect.fn("storeRunSession")(function* (
  state: RouteState,
  sessionId: string,
  run?: RunDir
) {
  const dir = dirOf(state, run);
  const topic = topicOf(state, dir);
  if (topic) {
    yield* threads((repo) =>
      repo.setSession({
        ...topic,
        provider: state.activeProvider,
        sessionId,
      })
    );
    return;
  }
  if (dir.scratch && state.threadId !== null) {
    yield* setSession({
      project: dir.projectPath,
      provider: state.activeProvider,
      sessionId,
    });
  }
});

/** `storeRunSession` for a grammy closure. */
export const rememberRunSession = async (
  state: RouteState,
  sessionId: string,
  run?: RunDir
) => {
  await runtime.runPromise(storeRunSession(state, sessionId, run));
};

/**
 * The model and effort this conversation runs on. Empty means it has not been
 * routed yet, which is exactly the state a brand-new topic, a `/new` and a
 * cleared override all leave behind — and the signal the router waits for.
 */
export const threadPickFor = Effect.fn("threadPickFor")(function* (
  state: RouteState,
  run?: RunDir
) {
  const dir = dirOf(state, run);
  const topic = topicOf(state, dir);
  if (!topic) {
    return yield* getSessionPick(dir.projectPath, state.activeProvider);
  }
  const row = yield* threads((repo) => repo.get(topic));
  // A row on another provider holds that provider's pick, not this one's.
  const pick: SessionPick = Option.match(row, {
    onNone: () => ({}),
    onSome: ({ effort, model, provider }) =>
      provider === state.activeProvider ? { effort, model } : {},
  });
  return pick;
});

/** `threadPickFor` for a grammy closure. */
export const resolveThreadPick = async (state: RouteState, run?: RunDir) =>
  await runtime.runPromise(threadPickFor(state, run));

/**
 * Store what this conversation runs on, under the same key
 * `resolveThreadPick` reads. Outside a topic it merges into the session
 * record, which is written before the run that will fill in its session id.
 */
export const storeThreadPick = Effect.fn("storeThreadPick")(function* (
  state: RouteState,
  pick: SessionPick,
  run?: RunDir
) {
  const dir = dirOf(state, run);
  const topic = topicOf(state, dir);
  if (topic) {
    // The row is pinned first, in the same transaction: a pick can be written
    // before the topic has ever run — `/model` on a fresh topic — and an UPDATE
    // against no row is silent.
    yield* threads((repo) =>
      repo.pinWithPick({
        ...topic,
        projectPath: dir.projectPath,
        provider: state.activeProvider,
        ...pick,
      })
    );
    return;
  }
  yield* setSessionPick({
    pick,
    project: dir.projectPath,
    provider: state.activeProvider,
  });
});

/** `storeThreadPick` for a grammy closure. */
export const rememberThreadPick = async (
  state: RouteState,
  pick: SessionPick,
  run?: RunDir
) => {
  await runtime.runPromise(storeThreadPick(state, pick, run));
};

/** Drop this conversation's session so the next prompt starts fresh (`/new`). */
export const forgetSession = async (state: RouteState) => {
  const topic = topicOf(state);
  if (topic) {
    await clearThreadSession(topic);
    return;
  }
  await runtime.runPromise(
    clearSession(state.activeProject, state.activeProvider)
  );
};

/**
 * Switch the project this conversation works on. The choice is persisted as the
 * global default (what a new conversation starts on) and, in a topic, pinned to
 * the topic — which starts a fresh session there when the project changed. The
 * topic keeps its provider; a topic with no row yet is pinned to `provider`,
 * the one its route resolves to (`route-provider.ts`). With `WORK_DIR` set
 * there is only one directory, so every switch resolves to it.
 */
export const setRouteProject = async (
  state: UserState,
  projectPath: string,
  provider: ProviderId
) => {
  const resolved = projectPathOr(projectPath);
  setActiveProject(state, resolved);
  const topic = topicOf(state);
  if (topic) {
    const row = await getThread(topic);
    await pinThread({
      ...topic,
      projectPath: resolved,
      provider: row?.provider ?? provider,
    });
  }
};
