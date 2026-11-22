import {
  ApiKeyService,
  ApiKeysRepo,
  BackgroundRunsRepo,
  BusinessMemoryRepo,
  ComposeRepo,
  GroupMemoryRepo,
  GroupsRepo,
  QuotaRepo,
  ReminderService,
  RemindersRepo,
  SessionContextRepo,
  SessionHistoryRepo,
  SettingsRepo,
  TaskService,
  TasksRepo,
  TopicsRepo,
  UsersRepo,
} from "@workspace/db";
import type {
  ApiKeyOrigin,
  BackgroundRunWrite,
  BusinessChat,
  BusinessMemoryMessage,
  BusinessMessageKey,
  ComposeKey,
  ComposeMessage,
  DbRepos,
  GroupChatSeen,
  GroupEntry,
  GroupMemoryMessage,
  PersistenceError,
  PreviousReason,
  QuotaRequest,
  NewTask,
  ReminderEntry,
  ReminderListFilter,
  ReminderTopic,
  RouteRule,
  RunChoicePatch,
  SessionHistoryKey,
  SettingChange,
  SettingKey,
  TaskEntry,
  TaskPatch,
  TaskRefusalReason,
  TaskRefused,
  TaskRunWrite,
  TaskSessionMode,
  TaskStampInput,
  TokenMessage,
  TopicTitleSource,
  TranscriptStatus,
  UserGrant,
} from "@workspace/db";
import { Effect, Option, Schema } from "effect";
import { isSqlError } from "effect/sql/SqlError";

import { runtime } from "../runtime";
import { ThreadsRepo } from "./threads";
import type { ThreadKey, ThreadPick, ThreadRecord } from "./threads";

/**
 * The cause of a `PersistenceError` as one log-safe line. A SQL failure gives
 * its class and the driver's text (SQLite names the constraint or the syntax
 * error, never a bound value); a decode failure gives the issue's path and
 * what was expected, never the rejected value, since a Business row is private
 * correspondence.
 */
const describeCause = (cause: unknown) => {
  if (Schema.isSchemaError(cause)) {
    return cause.message;
  }
  if (isSqlError(cause)) {
    // The reason's own message is the driver's generic line ("Failed to
    // execute statement"); the SQLite text ("no such table: tasks") is on its cause.
    const { reason } = cause;
    const driverText =
      reason.cause instanceof Error ? reason.cause.message : undefined;
    const text = [reason.message, driverText]
      .filter((part) => part !== undefined && part.length > 0)
      .join(": ");
    return `${reason._tag}: ${text}`;
  }
  return cause instanceof Error
    ? `${cause.name}: ${cause.message}`
    : String(cause);
};

/**
 * The single place a repository failure is logged. `PersistenceError.message`
 * is only "<operation> failed (<reason>)" by design, and most handlers let a
 * rejection fall through to `bot.catch`, which prints that message alone; the
 * SQLite text and the decode issue would otherwise never reach the journal.
 */
export const logPersistenceError = (error: PersistenceError) =>
  Effect.logError("db op failed").pipe(
    Effect.annotateLogs({
      detail: describeCause(error.cause),
      operation: error.operation,
      reason: error.reason,
    })
  );

/**
 * The db ops as Promises, for handlers that are still grammy closures. Same
 * names and return shapes as the old sync ops — `Option` becomes
 * `T | undefined` — so a call site changes only by an `await`. A failure
 * rejects with the `PersistenceError` itself, the way a sync throw did.
 *
 * Only the ops some handler calls are here; the group-memory write and search
 * ops that only the MCP server uses are not. The composites
 * (`applySettings`, `adoptThreadSession`) replace pairs of writes that were
 * atomic only because they were sync.
 *
 * Every import of this module is a crossing into the runtime; step 6 turns the
 * handlers into Effects that call the repositories directly and deletes it.
 * `runtime.runSync` is never used: it throws while a transaction holds the
 * client.
 */
const runDb = async <A>(
  effect: Effect.Effect<A, PersistenceError, DbRepos.Services | ThreadsRepo>
): Promise<A> =>
  await runtime.runPromise(effect.pipe(Effect.tapError(logPersistenceError)));

const orUndefined = <A, E, R>(effect: Effect.Effect<Option.Option<A>, E, R>) =>
  effect.pipe(Effect.map(Option.getOrUndefined));

// ---------------------------------------------------------------------------
// Business archive

/** Register or refresh one private chat managed through Telegram Business. */
export const rememberBusinessChat = async (chat: BusinessChat) => {
  await runDb(BusinessMemoryRepo.use((repo) => repo.rememberChat(chat)));
};

/** Insert or idempotently update one archived Telegram Business message. */
export const recordBusinessMessage = async (message: BusinessMemoryMessage) => {
  await runDb(BusinessMemoryRepo.use((repo) => repo.record(message)));
};

/** Retrieve one archived Business message, including its stored voice bytes. */
export const getBusinessMessage = async (key: BusinessMessageKey) =>
  await runDb(orUndefined(BusinessMemoryRepo.use((repo) => repo.get(key))));

/** Oldest-first recent messages from one Business chat and time window. */
export const listRecentBusinessMessages = async (query: {
  businessConnectionId: string;
  chatId: number;
  from: number;
  limit: number;
}) => await runDb(BusinessMemoryRepo.use((repo) => repo.listRecent(query)));

/** Cache a voice transcription so future context and archive searches are free. */
export const setBusinessTranscript = async (input: {
  businessConnectionId: string;
  chatId: number;
  messageId: number;
  status: TranscriptStatus;
  transcript?: string;
}) => {
  await runDb(BusinessMemoryRepo.use((repo) => repo.setTranscript(input)));
};

/** Mirror Telegram deletions in the local Business archive. */
export const deleteBusinessMessages = async (input: {
  businessConnectionId: string;
  chatId: number;
  messageIds: readonly number[];
}) => await runDb(BusinessMemoryRepo.use((repo) => repo.remove(input)));

/** Drop Business messages older than the accepted retention cutoff. */
export const cleanupBusinessMessages = async (cutoff: number) =>
  await runDb(BusinessMemoryRepo.use((repo) => repo.cleanup(cutoff)));

// ---------------------------------------------------------------------------
// Compose buffers

/** Append one message to a user's durable compose buffer. */
export const appendCompose = async (entry: ComposeKey & ComposeMessage) => {
  await runDb(ComposeRepo.use((repo) => repo.append(entry)));
};

/** Buffered compose messages in arrival order. */
export const listCompose = async (key: ComposeKey) =>
  await runDb(ComposeRepo.use((repo) => repo.list(key)));

/** Discard a compose buffer; returns how many messages were dropped. */
export const clearCompose = async (key: ComposeKey) =>
  await runDb(ComposeRepo.use((repo) => repo.clear(key)));

// ---------------------------------------------------------------------------
// Settings

/** Read one persisted setting. */
export const getSetting = async (key: SettingKey) =>
  await runDb(orUndefined(SettingsRepo.use((repo) => repo.get(key))));

/** The workspace the owner set, undefined when none is. */
export const getWorkspace = async () =>
  await runDb(orUndefined(SettingsRepo.use((repo) => repo.workspace())));

/** Write one persisted setting. */
export const setSetting = async (entry: { key: SettingKey; value: string }) => {
  await runDb(SettingsRepo.use((repo) => repo.set(entry)));
};

/** Several setting writes as one transaction; a null value forgets the key. */
export const applySettings = async (changes: readonly SettingChange[]) => {
  await runDb(SettingsRepo.use((repo) => repo.apply(changes)));
};

// ---------------------------------------------------------------------------
// Conversations parked on background work

/** Record a park: what the run waits on, so a restart can resume it. */
export const putBackgroundRun = async (entry: BackgroundRunWrite) => {
  await runDb(BackgroundRunsRepo.use((repo) => repo.put(entry)));
};

/** Every parked conversation, oldest park first. */
export const listBackgroundRuns = async () =>
  await runDb(BackgroundRunsRepo.use((repo) => repo.list()));

/** One run slot's parked conversation, if it still has one. */
export const getBackgroundRun = async (runKey: string) =>
  await runDb(orUndefined(BackgroundRunsRepo.use((repo) => repo.get(runKey))));

/** Forget a run slot's parked conversation. */
export const removeBackgroundRun = async (runKey: string) => {
  await runDb(BackgroundRunsRepo.use((repo) => repo.remove(runKey)));
};

/** Count one resume of a parked conversation before it starts. */
export const countContinuation = async (runKey: string) => {
  await runDb(BackgroundRunsRepo.use((repo) => repo.countContinuation(runKey)));
};

// ---------------------------------------------------------------------------
// One person's settings

// ---------------------------------------------------------------------------
// Forum topics

/** A forum topic's pinned project, provider and session. */
export const getThread = async (key: ThreadKey) =>
  await runDb(orUndefined(ThreadsRepo.use((repo) => repo.get(key))));

/** Pin a topic to a project and provider; returns the row as it now stands. */
export const pinThread = async (
  entry: ThreadKey & Pick<ThreadRecord, "projectPath" | "provider">
) => await runDb(ThreadsRepo.use((repo) => repo.pin(entry)));

/** Record the model and effort a topic runs on; an unset half clears the pick. */
export const setThreadPick = async (entry: ThreadKey & ThreadPick) =>
  await runDb(ThreadsRepo.use((repo) => repo.setPick(entry)));

/** Forget a topic's session, keeping its project pin. */
export const clearThreadSession = async (key: ThreadKey) => {
  await runDb(ThreadsRepo.use((repo) => repo.clearSession(key)));
};

/** Pin a topic and record its session as one transaction. */
export const adoptThreadSession = async (
  entry: ThreadKey &
    Pick<ThreadRecord, "projectPath" | "provider"> & { sessionId: string }
) => {
  await runDb(ThreadsRepo.use((repo) => repo.adopt(entry)));
};

/** Keep the name a topic has now, for `/history`. */
export const nameTopic = async (
  entry: ThreadKey & { source: TopicTitleSource; title: string }
) => {
  await runDb(TopicsRepo.use((repo) => repo.name(entry)));
};

// ---------------------------------------------------------------------------
// Managed users

/**
 * The tier granted to a user, or undefined when they are a guest. A row whose
 * tier this build does not know (left by a rollback) reads as a guest too, the
 * way the sync ops read it, so the owner can still repair it from chat:
 * `/grant` overwrites the row and `/revoke` deletes it. `UsersRepo.get` itself
 * stays strict for callers that want the `Decode`.
 */
export const getUser = async (userId: number) =>
  await runDb(
    orUndefined(
      UsersRepo.use((repo) => repo.get(userId)).pipe(
        Effect.catchIf(
          (error) => error.reason === "Decode",
          (error) =>
            Effect.logWarning("stored tier unknown to this build").pipe(
              Effect.annotateLogs({
                detail: describeCause(error.cause),
                userId,
              }),
              Effect.as(Option.none())
            )
        )
      )
    )
  );

/** Every managed user, oldest grant first. */
export const listUsers = async () =>
  await runDb(UsersRepo.use((repo) => repo.list()));

/** Grant (or re-grant) a tier; returns the row as it now stands. */
export const grantUser = async (entry: UserGrant) =>
  await runDb(UsersRepo.use((repo) => repo.grant(entry)));

/** Drop a user back to guest; false when they were not managed. */
export const revokeUser = async (userId: number) =>
  await runDb(UsersRepo.use((repo) => repo.revoke(userId)));

// ---------------------------------------------------------------------------
// Owner presence in groups

/** Cached answer to whether the owner is still in a group. */
export const getGroup = async (chatId: number) =>
  await runDb(orUndefined(GroupsRepo.use((repo) => repo.get(chatId))));

/** Record a fresh owner-presence check for a group. */
export const rememberGroup = async (
  entry: Pick<GroupEntry, "chatId" | "ownerPresent">
) => {
  await runDb(GroupsRepo.use((repo) => repo.remember(entry)));
};

/** Forget a group's presence cache (the bot left it). */
export const forgetGroup = async (chatId: number) => {
  await runDb(GroupsRepo.use((repo) => repo.forget(chatId)));
};

// ---------------------------------------------------------------------------
// Group memory

/** Persist one group message without mixing it with another chat. */
export const recordGroupMemory = async (message: GroupMemoryMessage) => {
  await runDb(GroupMemoryRepo.use((repo) => repo.record(message)));
};

/** Oldest-first group messages, bounded for prompt construction. */
export const listGroupMemory = async (chatId: number, limit: number) =>
  await runDb(GroupMemoryRepo.use((repo) => repo.list(chatId, limit)));

/** Curated facts for one group, most recently changed first. */
export const listGroupFacts = async (chatId: number) =>
  await runDb(GroupMemoryRepo.use((repo) => repo.listFacts(chatId)));

/** Register a Telegram group or refresh its mutable title and metadata. */
export const rememberGroupChat = async (chat: GroupChatSeen) => {
  await runDb(GroupMemoryRepo.use((repo) => repo.rememberChat(chat)));
};

/** Chat ids seen before the registry existed, used for a tiny startup backfill. */
export const listKnownGroupChatIds = async () =>
  await runDb(GroupMemoryRepo.use((repo) => repo.listKnownChatIds()));

// ---------------------------------------------------------------------------
// Daily run budgets

/** Take one group run from the day's per-user and global budgets. */
export const consumeRunQuota = async (request: QuotaRequest) =>
  await runDb(QuotaRepo.use((repo) => repo.consume(request)));

// ---------------------------------------------------------------------------
// Reminders

/** Shared reminders, ordered by their due date with undated rows last. */
export const listReminders = async (filter?: ReminderListFilter) =>
  await runDb(ReminderService.use((service) => service.list(filter)));

/** Number of shared reminders matching an optional due-date range. */
export const countReminders = async (filter?: ReminderListFilter) =>
  await runDb(ReminderService.use((service) => service.count(filter)));

/** One reminder, or undefined after it has been completed. */
export const getReminder = async (id: number) =>
  await runDb(orUndefined(ReminderService.use((service) => service.get(id))));

/**
 * Move a reminder to `dueAt` through `ReminderService`, which rearms its
 * delivery. Undefined when it is gone.
 */
export const moveReminder = async (input: { dueAt: number; id: number }) =>
  await runDb(
    orUndefined(
      ReminderService.use((service) =>
        service.update({
          due: { at: input.dueAt, kind: "instant" },
          id: input.id,
        })
      ).pipe(
        Effect.map(({ after }) => after),
        Effect.catchTag("ReminderRefused", () =>
          Effect.succeed(Option.none<ReminderEntry>())
        )
      )
    )
  );

/**
 * Complete a reminder through `ReminderService`: the row goes, then
 * `closeTopic` closes its topic, best effort. The completed reminder, or
 * undefined when there was none.
 */
export const completeReminder = async (input: {
  closeTopic: (topic: ReminderTopic) => Effect.Effect<void>;
  id: number;
}) =>
  await runDb(
    orUndefined(ReminderService.use((service) => service.complete(input)))
  );

/** Lease the due reminders so overlapping ticks cannot deliver one twice. */
export const claimDueReminders = async (input: {
  leaseUntil: number;
  limit: number;
  now: number;
  repeatBefore: number;
}) => await runDb(RemindersRepo.use((repo) => repo.claimDue(input)));

/** Mark a reminder done and drop its lease. */
export const acknowledgeReminder = async (input: { at: number; id: number }) =>
  await runDb(
    orUndefined(RemindersRepo.use((repo) => repo.acknowledge(input)))
  );

/** Give a leased reminder back so the next tick may deliver it. */
export const releaseReminderClaim = async (id: number) => {
  await runDb(RemindersRepo.use((repo) => repo.releaseClaim(id)));
};

/** Record where a reminder is (or will be) delivered. */
export const setReminderDestination = async (input: {
  chatId: number;
  id: number;
  messageId?: number;
  threadId?: number;
}) =>
  await runDb(
    orUndefined(RemindersRepo.use((repo) => repo.setDestination(input)))
  );

/** Record a delivery: notified through `messageId`, lease released. */
export const markReminderNotified = async (input: {
  at: number;
  id: number;
  messageId: number;
}) =>
  await runDb(
    orUndefined(RemindersRepo.use((repo) => repo.markNotified(input)))
  );

/** The newest reminder delivered into a forum topic. */
export const getReminderByThread = async (input: {
  chatId: number;
  threadId: number;
}) =>
  await runDb(
    orUndefined(RemindersRepo.use((repo) => repo.findByThread(input)))
  );

/** The newest reminder delivered as a given message. */
export const getReminderByMessage = async (input: {
  chatId: number;
  messageId: number;
}) =>
  await runDb(
    orUndefined(RemindersRepo.use((repo) => repo.findByMessage(input)))
  );

// ---------------------------------------------------------------------------
// Recurring tasks

/** Every recurring task, oldest first. */
export const listTasks = async () =>
  await runDb(TasksRepo.use((repo) => repo.list()));

/** Route tasks whose conversation is waiting to start over. */
export const listPendingTaskResets = async () =>
  await runDb(TasksRepo.use((repo) => repo.listPendingResets()));

/** One recurring task, or undefined when it is gone. */
export const getTask = async (id: number) =>
  await runDb(orUndefined(TasksRepo.use((repo) => repo.get(id))));

/** Edit a recurring task; returns the row as it now stands. */
export const updateTask = async (id: number, patch: TaskPatch) =>
  await runDb(orUndefined(TasksRepo.use((repo) => repo.update(id, patch))));

/**
 * A `TaskService` write as a value: the task as it now stands, or the reason
 * the rules refused it.
 */
export type TaskOutcome =
  | { readonly refused: TaskRefusalReason; readonly task?: never }
  | { readonly refused?: never; readonly task: TaskEntry };

const taskOutcome = <R>(
  effect: Effect.Effect<TaskEntry, PersistenceError | TaskRefused, R>
) =>
  effect.pipe(
    Effect.map((task): TaskOutcome => ({ task })),
    Effect.catchTag("TaskRefused", (error) =>
      Effect.succeed<TaskOutcome>({ refused: error.reason })
    )
  );

/** Create a recurring task through `TaskService`'s rules. */
export const createTask = async (input: {
  draft: NewTask;
  rule: RouteRule;
  writer: TaskStampInput;
}) =>
  await runDb(taskOutcome(TaskService.use((service) => service.create(input))));

/** Set which conversation a task keeps, through `TaskService`'s rules. */
export const setTaskSessionMode = async (input: {
  actor: TaskStampInput;
  mode: TaskSessionMode | null;
  ownerId: number;
  task: TaskEntry;
}) =>
  await runDb(
    taskOutcome(TaskService.use((service) => service.setSessionMode(input)))
  );

/**
 * Start a task's kept conversation over: `cleared` for an `own` task, else
 * the flagged route task (undefined when it is gone).
 */
export const resetTaskSession = async (input: {
  id: number;
  mode: TaskSessionMode;
}) =>
  await runDb(
    TaskService.use((service) => service.resetSession(input)).pipe(
      Effect.map((reset) =>
        reset.kind === "cleared"
          ? reset
          : { kind: reset.kind, pending: Option.getOrUndefined(reset.pending) }
      )
    )
  );

/** Pause or resume a task; returns the row as it now stands. */
export const setTaskEnabled = async (input: { enabled: boolean; id: number }) =>
  await runDb(
    orUndefined(TaskService.use((service) => service.setEnabled(input)))
  );

/** Set what a task runs on; returns the row as it now stands. */
export const setTaskRunChoice = async (input: {
  id: number;
  patch: RunChoicePatch;
}) =>
  await runDb(
    orUndefined(TaskService.use((service) => service.setRunChoice(input)))
  );

/** Forget a recurring task; false when there was nothing to forget. */
export const deleteTask = async (id: number) =>
  await runDb(TaskService.use((service) => service.remove(id)));

/** Log how one fire of a task ended and what it ran on. */
export const recordTaskRun = async (run: TaskRunWrite) =>
  await runDb(orUndefined(TasksRepo.use((repo) => repo.recordRun(run))));

/** Fires of every task, the latest first. */
export const listTaskRuns = async (page: { limit: number; offset: number }) =>
  await runDb(TasksRepo.use((repo) => repo.runs(page)));

/** How many fires `listTaskRuns` lists. */
export const countTaskRuns = async () =>
  await runDb(TasksRepo.use((repo) => repo.runCount()));

// ---------------------------------------------------------------------------
// Session context

/** One session's context figure, undefined before its first answer. */
export const getSessionContext = async (key: {
  provider: string;
  sessionId: string;
}) => await runDb(orUndefined(SessionContextRepo.use((repo) => repo.get(key))));

/** Record what a compaction left of a session's context. */
export const carrySessionContext = async (request: {
  from: string;
  provider: string;
  to: string;
  usedTokens: number;
}) => {
  await runDb(SessionContextRepo.use((repo) => repo.carry(request)));
};

/** Forget a session's context figure. */
export const clearSessionContext = async (key: {
  provider: string;
  sessionId: string;
}) => {
  await runDb(SessionContextRepo.use((repo) => repo.clear(key)));
};

// ---------------------------------------------------------------------------
// Session history

/** Past sessions on `providers`, most recently used first. */
export const listHistory = async (request: {
  limit: number;
  offset: number;
  providers: readonly string[];
}) => await runDb(SessionHistoryRepo.use((repo) => repo.page(request)));

/** How many past sessions each provider has. */
export const countHistory = async (providers: readonly string[]) =>
  await runDb(SessionHistoryRepo.use((repo) => repo.counts(providers)));

/** Record that a compaction continued session `from` as `to`. */
export const succeedSession = async (request: {
  from: string;
  provider: string;
  reason: PreviousReason;
  to: string;
}) => {
  await runDb(SessionHistoryRepo.use((repo) => repo.succeed(request)));
};

/** One past session, undefined when it was never recorded. */
export const getHistoryEntry = async (key: SessionHistoryKey) =>
  await runDb(orUndefined(SessionHistoryRepo.use((repo) => repo.get(key))));

// ---------------------------------------------------------------------------
// HTTP API keys

/**
 * Issue a key to `holderId` through `ApiKeyService`, as a `Result`: a refusal
 * (the holder is not the owner or an executor, or the name does not fit) is
 * its failure; the token comes back redacted.
 */
export const issueApiKey = async (input: {
  createdBy: number;
  holderId: number;
  name: string;
  ownerId: number;
  via: ApiKeyOrigin;
}) =>
  await runDb(
    ApiKeyService.use((service) => service.issue(input)).pipe(Effect.result)
  );

/** The live keys `viewerId` may see: every key for the owner. */
export const listApiKeys = async (input: {
  ownerId: number;
  viewerId: number;
}) => await runDb(ApiKeyService.use((service) => service.list(input)));

/** Revoke a live key `viewerId` may see; undefined when there is none. */
export const revokeApiKey = async (input: {
  keyId: string;
  ownerId: number;
  viewerId: number;
}) =>
  await runDb(
    orUndefined(ApiKeyService.use((service) => service.revoke(input)))
  );

/** Remember the DM that carried a token, so the sweep deletes it. */
export const noteApiTokenMessage = async (message: TokenMessage) => {
  await runDb(
    ApiKeyService.use((service) => service.noteTokenMessage(message))
  );
};

/** Every key, revoked ones too: what the access watcher compares. */
export const listAllApiKeys = async () =>
  await runDb(ApiKeysRepo.use((repo) => repo.list()));

/** Every key id with a short prefix of its stored hash, for the watcher. */
export const listApiKeyFingerprints = async () =>
  await runDb(ApiKeysRepo.use((repo) => repo.fingerprints()));
