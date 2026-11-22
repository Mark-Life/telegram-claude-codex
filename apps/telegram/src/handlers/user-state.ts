import { getCapabilities } from "@workspace/agent";
import type { ProviderId } from "@workspace/agent/types";
import type { Context } from "grammy";

import type { ComposeMessage } from "../db";
import {
  appendCompose,
  clearCompose,
  getThread,
  listCompose,
} from "../db/bridge";
import { loadPersistedState } from "../state";
import { requireRoute, routeKey } from "../telegram/route";
import type { Route } from "../telegram/route";
import { projectPathOr } from "../work-dir";
import { isRunning } from "./agent-bridge";
import type { PromptRouting } from "./deps";

export type { ComposeMessage } from "../db";

export interface QueuedMessage {
  /**
   * Set while the message is steered into a run: resolves true once it
   * carries the steered reaction, which a requeue takes back.
   */
  acknowledged?: Promise<boolean>;
  ctx: Context;
  prompt: string;
  /** What the router should read, when the sender knew more than the prompt. */
  routing?: PromptRouting;
}

export interface PendingPlan {
  planPath: string;
  projectPath: string;
  /** The provider the plan was written on; its session lives there. */
  provider: ProviderId;
  sessionId?: string;
}

export interface ReminderPageContext {
  ids: number[];
  page: number;
  shownAt: number;
}

/** Who is talking, and in which chat and forum topic. */
export interface StateKey extends Route {
  userId: number;
}

/**
 * Everything one conversation holds. It is scoped to (user, chat, topic), so
 * two topics queue, compose and run independently. The key fields make it a
 * `RunKey`, so a state can be handed straight to the run registry. It holds no
 * provider: that is resolved per run and per command (`route-provider.ts`),
 * because a cached one would outlive a `/provider` in the topic.
 */
export interface UserState extends StateKey {
  activeProject: string;
  composeMessages?: ComposeMessage[];
  composeStatusMessageId?: number;
  /**
   * A run-and-drain loop owns this conversation. Set synchronously before the
   * first await of a run, so two messages arriving in one polling batch queue
   * behind each other instead of both passing the "is a run active?" check.
   */
  draining: boolean;
  /** Stable visible ordinal -> reminder id mapping from the latest list page. */
  lastReminderPage?: ReminderPageContext;
  /** Messages held aside while compaction owns the process slot. */
  parkedQueue?: QueuedMessage[];
  pendingPlan?: PendingPlan;
  queue: QueuedMessage[];
  queueStatusMessageId?: number;
  /**
   * Messages the running run took while it worked (steering). Those it never
   * answered go back ahead of the queue when it ends.
   */
  steered: QueuedMessage[];
  /** Bumped by `cancelPendingStart`; see there. */
  resets?: number;
  /**
   * When this conversation was last reached through `stateFor`. Only the idle
   * sweep reads it: a map keyed by (user, chat, topic) would otherwise grow for
   * the life of the process, one entry per topic anyone ever wrote in.
   */
  touchedAt: number;
  /**
   * The last run here was routed but kept no pick (`provisional`): the words
   * that follow must be routed, so they queue rather than steer. `document`
   * keeps the document floor for them. Read only on the provider and project
   * it was set on; `/new` drops it.
   */
  unpicked?: { document: boolean; project: string; provider: ProviderId };
}

/**
 * Make a run still getting ready here give up: `startPromptRun` waits on PDF
 * text before the run is registered, so `/stop`, `/new`, `/compact` and a
 * plan's fresh session would find nothing to stop and the run would start
 * after them.
 */
export const cancelPendingStart = (state: UserState) => {
  state.resets = (state.resets ?? 0) + 1;
};

export const HISTORY_PAGE_SIZE = 5;
export const MAX_COMPOSE_MESSAGES = 50;

const states = new Map<string, UserState>();
/**
 * Loads in flight, one per conversation. Two updates for one conversation
 * that both miss `states` must share one read: the second `states.set` would
 * otherwise replace the object a handler already holds, and its queue and
 * compose buffer with it.
 */
const loading = new Map<string, Promise<UserState>>();

/** Map key for one conversation: the user plus the route they wrote from. */
export const stateKeyOf = (key: StateKey) => `${key.userId}:${routeKey(key)}`;

/** Seed a conversation state from disk and the db, unless one landed first. */
const loadState = async (id: string, key: StateKey): Promise<UserState> => {
  const persisted = loadPersistedState();
  const pinned =
    key.threadId === null
      ? undefined
      : await getThread({ chatId: key.chatId, threadId: key.threadId });
  const buffered = await listCompose({
    threadId: key.threadId,
    userId: key.userId,
  });
  // Re-checked after the awaits: whatever reached the map first is the state.
  const raced = states.get(id);
  if (raced) {
    raced.touchedAt = Date.now();
    return raced;
  }
  const state: UserState = {
    activeProject: projectPathOr(
      pinned?.projectPath ?? persisted?.activeProject ?? ""
    ),
    chatId: key.chatId,
    composeMessages: buffered.length > 0 ? buffered : undefined,
    draining: false,
    queue: [],
    steered: [],
    threadId: key.threadId,
    touchedAt: Date.now(),
    userId: key.userId,
  };
  states.set(id, state);
  return state;
};

/**
 * Get or create the state for one conversation, seeded from disk. A topic reads
 * its pinned project from the threads table, so a restart keeps each topic on
 * its own project; everything else falls back to the global persisted state.
 * `WORK_DIR`, when set, overrules all of it — there is one directory then. A
 * compose draft is read back from the db, so a restart mid-compose keeps the
 * buffer; `composeStatusMessageId` is not persisted, so the status message is
 * re-sent on the next buffered message.
 */
export const stateFor = async (key: StateKey): Promise<UserState> => {
  const id = stateKeyOf(key);
  const existing = states.get(id);
  if (existing) {
    existing.touchedAt = Date.now();
    return existing;
  }
  const inFlight = loading.get(id);
  if (inFlight) {
    return await inFlight;
  }
  const load = loadState(id, key).finally(() => {
    loading.delete(id);
  });
  loading.set(id, load);
  return await load;
};

/** State for the conversation an update belongs to. */
export const getState = async (ctx: Context) => {
  const userId = ctx.from?.id;
  if (userId === undefined) {
    throw new Error("No user context");
  }
  return await stateFor({ ...requireRoute(ctx), userId });
};

/** Open a compose buffer. An empty draft has no rows yet, so it stays in memory. */
export const startCompose = (state: UserState) => {
  state.composeMessages = [];
};

/** Whether a compose buffer is open. A call, so a re-read after an await is not narrowed away. */
export const isComposing = (state: UserState) =>
  state.composeMessages !== undefined;

/**
 * Buffer one compose message. The db row is written first — it is the source of
 * truth — and the in-memory array mirrors it for the handlers.
 *
 * The write is awaited, so /send or /cancel may close the buffer meanwhile (a
 * media-group flush runs from a timer, outside grammy's sequential handling).
 * A message that lands after the close is dropped, row and all: pushing it
 * would silently reopen compose mode, and the row would survive a restart.
 * Returns whether the message was buffered.
 */
export const addComposeMessage = async (
  state: UserState,
  message: ComposeMessage
) => {
  const key = { threadId: state.threadId, userId: state.userId };
  await appendCompose({ ...message, ...key });
  if (!isComposing(state)) {
    await clearCompose(key);
    return false;
  }
  const messages = state.composeMessages ?? [];
  messages.push(message);
  state.composeMessages = messages;
  return true;
};

/**
 * Discard the compose buffer in the db and in memory. The only way a buffer
 * goes away: /send, /cancel, /stop, /new or a project switch — never a timer.
 */
export const clearComposeMessages = async (state: UserState) => {
  await clearCompose({ threadId: state.threadId, userId: state.userId });
  state.composeMessages = undefined;
};

/** Active pending plan, or undefined when its provider lacks plan mode. */
export const activePendingPlan = (state: UserState) => {
  const plan = state.pendingPlan;
  return plan !== undefined && getCapabilities(plan.provider).planMode
    ? plan
    : undefined;
};

/**
 * Drop every pending plan held for a chat route, whoever's it is: in a topic
 * each writer keeps their own state, and all of them follow the topic's
 * provider.
 */
export const dropRoutePlans = (route: {
  chatId: number;
  threadId: number | null;
}) => {
  for (const state of states.values()) {
    if (state.chatId === route.chatId && state.threadId === route.threadId) {
      state.pendingPlan = undefined;
    }
  }
};

/**
 * Whether anyone's conversation in a chat route is busy without a run in its
 * slot: a drain loop between two runs, or a compaction holding the queue
 * aside. A topic's session is shared by everyone who writes there, while a
 * state is per user, so a task fired into it asks of all of them.
 */
export const routeDraining = (route: Route) => {
  for (const state of states.values()) {
    if (
      state.chatId === route.chatId &&
      state.threadId === route.threadId &&
      (state.draining || state.parkedQueue !== undefined)
    ) {
      return true;
    }
  }
  return false;
};

const BYTES_PER_MB = 1_048_576;

const MS_PER_HOUR = 3_600_000;
const STATE_IDLE_HOURS = 24;
/** How long a conversation may sit untouched before its state is dropped. */
const STATE_IDLE_MS = STATE_IDLE_HOURS * MS_PER_HOUR;

/**
 * Whether a state holds nothing that only exists in memory. A queue, a parked
 * queue, a pending plan or a live status message id would be lost on eviction;
 * a compose buffer is durable in the db but its status message id is not, so a
 * buffered draft keeps the state too. Everything else is re-read from disk by
 * `stateFor`.
 *
 * Evicting a conversation someone still holds a reference to would split it in
 * two — the next message would build a second state with `draining: false`, and
 * two drain loops would shift one queue. `draining` is raised for the whole of
 * a run and its drain, so it already covers the only long hold there is; the
 * registry is asked as well so that a future run path which forgets to raise it
 * still cannot have its conversation evicted underneath it. A run can outlive
 * any timeout here — days is normal — so neither check may be traded for age.
 */
const isEvictable = (state: UserState) =>
  !state.draining &&
  state.queue.length === 0 &&
  state.steered.length === 0 &&
  state.parkedQueue === undefined &&
  state.pendingPlan === undefined &&
  state.composeMessages === undefined &&
  state.queueStatusMessageId === undefined &&
  state.composeStatusMessageId === undefined &&
  !isRunning(state);

/**
 * Evict long-idle conversation states; answers the state count and memory
 * use left afterwards. Compose buffers are durable and never evicted here.
 */
export const cleanupStaleState = () => {
  const idleBefore = Date.now() - STATE_IDLE_MS;
  for (const [id, state] of states) {
    if (state.touchedAt < idleBefore && isEvictable(state)) {
      states.delete(id);
    }
  }
  const mem = process.memoryUsage();
  return `states=${states.size} rss=${(mem.rss / BYTES_PER_MB).toFixed(1)}MB heap=${(mem.heapUsed / BYTES_PER_MB).toFixed(1)}MB`;
};
