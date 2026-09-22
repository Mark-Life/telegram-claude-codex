import { clearSession, getSession, setSession } from "../agent/session-store";
import {
  clearThreadSession,
  getThread,
  pinThread,
  setThreadSession,
} from "../db";
import { runtime } from "../runtime";
import { setActiveProject } from "../state";
import type { UserState } from "./user-state";

/**
 * Where a conversation's session id lives depends on the route: a forum topic
 * owns one session per topic in the `threads` table, while a private chat, a
 * plain group and the General topic keep the per-project session store. Every
 * read and write of a session id goes through this module so the two stores
 * never cross.
 */

/** The topic this state belongs to, or undefined outside a topic. */
const topicOf = (state: UserState) =>
  state.threadId === null
    ? undefined
    : { chatId: state.chatId, threadId: state.threadId };

/**
 * Pin a topic that has no row yet to the project this conversation currently
 * works on, and report whether that pin was created. A topic without a row
 * inherits the global default project, which is rarely the one the topic is
 * named after, so the caller announces the first pin: nothing else in the chat
 * names the project once the footer is off.
 */
export const pinTopicIfNew = (state: UserState) => {
  const topic = topicOf(state);
  if (!topic || getThread(topic)) {
    return false;
  }
  pinThread({
    ...topic,
    projectPath: state.activeProject,
    provider: state.activeProvider,
  });
  return true;
};

/**
 * Session id the next prompt resumes. In a topic the row is re-pinned first, so
 * a project or provider switch inside the topic drops the stored session and
 * the prompt starts a fresh conversation there.
 */
export const resolveSessionId = async (state: UserState) => {
  const topic = topicOf(state);
  if (!topic) {
    return await runtime.runPromise(
      getSession(state.activeProject, state.activeProvider)
    );
  }
  return pinThread({
    ...topic,
    projectPath: state.activeProject,
    provider: state.activeProvider,
  })?.sessionId;
};

/**
 * Continue this conversation on `sessionId` (resumed history, an approved plan,
 * a finished compaction).
 */
export const adoptSession = async (state: UserState, sessionId: string) => {
  const topic = topicOf(state);
  if (!topic) {
    await runtime.runPromise(
      setSession({
        project: state.activeProject,
        provider: state.activeProvider,
        sessionId,
      })
    );
    return;
  }
  pinThread({
    ...topic,
    projectPath: state.activeProject,
    provider: state.activeProvider,
  });
  setThreadSession({ ...topic, sessionId });
};

/**
 * Record the session a finished run ended on. Only topics need it: outside one,
 * `runAgent` already taps every session id into the per-project store.
 */
export const rememberRunSession = (state: UserState, sessionId: string) => {
  const topic = topicOf(state);
  if (topic) {
    setThreadSession({ ...topic, sessionId });
  }
};

/** Drop this conversation's session so the next prompt starts fresh (`/new`). */
export const forgetSession = async (state: UserState) => {
  const topic = topicOf(state);
  if (topic) {
    clearThreadSession(topic);
    return;
  }
  await runtime.runPromise(
    clearSession(state.activeProject, state.activeProvider)
  );
};

/**
 * Switch the project this conversation works on. The choice is persisted as the
 * global default (what a new conversation starts on) and, in a topic, pinned to
 * the topic — which starts a fresh session there when the project or the
 * provider changed. Re-pinning the current project is how a provider switch
 * reaches the topic row.
 */
export const setRouteProject = (state: UserState, projectPath: string) => {
  setActiveProject(state, projectPath);
  const topic = topicOf(state);
  if (topic) {
    pinThread({
      ...topic,
      projectPath,
      provider: state.activeProvider,
    });
  }
};
