import type { Context } from "grammy";
import { clearSessionCache, getCapabilities } from "../agent";
import { listProviders } from "../agent/registry";
import type { ProviderId } from "../agent/types";
import {
  appendCompose,
  type ComposeMessage,
  clearCompose,
  getThread,
  listCompose,
} from "../db";
import { loadPersistedState } from "../state";
import { type Route, requireRoute, routeKey } from "../telegram/route";

export type { ComposeMessage } from "../db";

export interface QueuedMessage {
  ctx: Context;
  prompt: string;
}

export interface PendingPlan {
  planPath: string;
  projectPath: string;
  sessionId?: string;
}

/** Who is talking, and in which chat and forum topic. */
export interface StateKey extends Route {
  userId: number;
}

/**
 * Everything one conversation holds. It is scoped to (user, chat, topic), so
 * two topics queue, compose and run independently. The key fields make it a
 * `RunKey`, so a state can be handed straight to the run registry.
 */
export interface UserState extends StateKey {
  activeProject: string;
  activeProvider: ProviderId;
  composeMessages?: ComposeMessage[];
  composeStatusMessageId?: number;
  efforts: Partial<Record<ProviderId, string>>;
  models: Partial<Record<ProviderId, string>>;
  pendingPlan?: PendingPlan;
  queue: QueuedMessage[];
  queueStatusMessageId?: number;
}

export const HISTORY_PAGE_SIZE = 5;
export const PROJECT_PAGE_SIZE = 20;
export const MAX_COMPOSE_MESSAGES = 50;

const states = new Map<string, UserState>();

/** Map key for one conversation: the user plus the route they wrote from. */
export const stateKeyOf = (key: StateKey) => `${key.userId}:${routeKey(key)}`;

/**
 * Get or create the state for one conversation, seeded from disk. A topic reads
 * its pinned project and provider from the threads table, so a restart keeps
 * each topic on its own; everything else falls back to the global persisted
 * state. A compose draft is read back from the db, so a restart mid-compose
 * keeps the buffer; `composeStatusMessageId` is not persisted, so the status
 * message is re-sent on the next buffered message.
 */
export const stateFor = (key: StateKey): UserState => {
  const id = stateKeyOf(key);
  const existing = states.get(id);
  if (existing) {
    return existing;
  }
  const persisted = loadPersistedState();
  const pinned =
    key.threadId === null
      ? undefined
      : getThread({ chatId: key.chatId, threadId: key.threadId });
  const buffered = listCompose({
    chatId: key.chatId,
    threadId: key.threadId,
    userId: key.userId,
  });
  const state: UserState = {
    activeProject: pinned?.projectPath ?? persisted.activeProject,
    activeProvider: pinned?.provider ?? persisted.activeProvider,
    chatId: key.chatId,
    composeMessages: buffered.length > 0 ? buffered : undefined,
    efforts: persisted.efforts,
    models: persisted.models,
    queue: [],
    threadId: key.threadId,
    userId: key.userId,
  };
  states.set(id, state);
  return state;
};

/** State for the conversation an update belongs to. */
export const getState = (ctx: Context) => {
  const userId = ctx.from?.id;
  if (userId === undefined) {
    throw new Error("No user context");
  }
  return stateFor({ ...requireRoute(ctx), userId });
};

/** Open a compose buffer. An empty draft has no rows yet, so it stays in memory. */
export const startCompose = (state: UserState) => {
  state.composeMessages = [];
};

/**
 * Buffer one compose message. The db row is written first — it is the source of
 * truth — and the in-memory array mirrors it for the handlers.
 */
export const addComposeMessage = (
  state: UserState,
  message: ComposeMessage
) => {
  appendCompose({
    ...message,
    chatId: state.chatId,
    threadId: state.threadId,
    userId: state.userId,
  });
  const messages = state.composeMessages ?? [];
  messages.push(message);
  state.composeMessages = messages;
};

/**
 * Discard the compose buffer in the db and in memory. The only way a buffer
 * goes away: /send, /cancel, /stop, /new or a project switch — never a timer.
 */
export const clearComposeMessages = (state: UserState) => {
  clearCompose({
    chatId: state.chatId,
    threadId: state.threadId,
    userId: state.userId,
  });
  state.composeMessages = undefined;
};

/** Resolve the active provider's display name (falls back to its id) */
export const activeProviderName = (state: UserState) =>
  listProviders().find((p) => p.id === state.activeProvider)?.displayName ??
  state.activeProvider;

/** Whether the active provider supports plan mode (gates all plan UI). */
const planModeEnabled = (state: UserState) =>
  getCapabilities(state.activeProvider).planMode;

/** Active pending plan, or undefined when the provider lacks plan mode. */
export const activePendingPlan = (state: UserState) =>
  planModeEnabled(state) ? state.pendingPlan : undefined;

const BYTES_PER_MB = 1_048_576;

/**
 * Drop session caches and log memory usage. Compose buffers are durable and are
 * never evicted here: a draft only ends when the user ends it.
 */
export const cleanupStaleState = () => {
  for (const provider of listProviders()) {
    clearSessionCache(provider.id);
  }
  const mem = process.memoryUsage();
  console.log(
    `[cleanup] rss=${(mem.rss / BYTES_PER_MB).toFixed(1)}MB heap=${(mem.heapUsed / BYTES_PER_MB).toFixed(1)}MB`
  );
};
