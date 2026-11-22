import { Context, Effect, Layer, Option, Schema } from "effect";

import { scheduleIssue } from "./cron";
import type { Schedule } from "./cron";
import { SettingsRepo } from "./settings";
import { TasksRepo } from "./tasks";
import type {
  TaskAuthor,
  TaskDraft,
  TaskEntry,
  TaskPatch,
  TaskSessionMode,
} from "./tasks";

/**
 * The rules every door that writes a recurring task obeys: the `/tasks`
 * screens, the tasks CLI a run drives and the HTTP API. A door parses its own
 * input and words a refusal its own way; what may be written, and as whom,
 * is decided here once.
 */

/**
 * Who a write is made as: the tier that set what the task does and the
 * user behind it. A stored task's writer may lack both (written before
 * authors were kept), which is not the owner's.
 */
export interface TaskWriter {
  readonly author?: TaskAuthor;
  readonly authorUserId?: number | null;
}

/** The writer stamped on a write: always a tier, the id null when unknown. */
export interface TaskStampInput {
  readonly author: TaskAuthor;
  readonly authorUserId: number | null;
}

/**
 * Which chats a route task may be bound to.
 *
 * - `runnable`: the writer's own private chat or the workspace, the only
 *   places a fire has the writer's chat access to run on (`routeTarget` in
 *   the app refuses any other at every fire). The chat's door and the API.
 * - `notForeignPrivate`: refuses only another user's private chat. The
 *   tasks CLI's check, kept as it was.
 */
export type RouteRule =
  | { readonly kind: "runnable"; readonly ownerId: number }
  | { readonly kind: "notForeignPrivate" };

/** Every reason a task write is refused. */
export const TASK_REFUSALS = [
  /** No task with that id. */
  "missing",
  /** The schedule's timezone is unknown (`schedule` says which). */
  "scheduleZone",
  /** The schedule never fires (`schedule` says which). */
  "scheduleNever",
  /** A route task without a chat to run in. */
  "routeNeedsChat",
  /** An edit that clears the chat of a task that stays a route task. */
  "routeChatCleared",
  /** A route task whose writer has no user id to run as. */
  "routeNeedsWriter",
  /** A route task bound to another user's private chat. */
  "routeForeignPrivate",
  /** A route task bound to a chat its writer cannot run in. */
  "routeNotRunnable",
  /** Gating or ungating someone else's script without rewriting it. */
  "gateNotYours",
  /** Turning a gated script back into a plain one without a new script. */
  "ungateNeedsPayload",
  /** A session reset together with a new mode. */
  "resetWithMode",
  /** A session reset of a task that keeps no conversation. */
  "resetNeedsMode",
] as const;

export type TaskRefusalReason = (typeof TASK_REFUSALS)[number];

/** A task write the rules refuse. */
// oxlint-disable-next-line unicorn/throw-new-error -- a class factory, not a throw
export class TaskRefused extends Schema.TaggedError<TaskRefused>()(
  "TaskRefused",
  {
    reason: Schema.Literals(TASK_REFUSALS),
    schedule: Schema.optional(
      Schema.Struct({ cron: Schema.String, tz: Schema.String })
    ),
  }
) {}

/** A new task as a door hands it over: everything but its stamp. */
export type NewTask = Omit<TaskDraft, "author" | "authorUserId">;

/**
 * An edit as a door hands it over. An absent field is left alone; `chatId`
 * null clears the chat and its topic, `threadId` null only the topic;
 * `sessionMode` null asks for a fresh conversation at every fire; a run
 * choice null follows the writer's defaults again.
 */
export interface TaskEdit {
  readonly chatId?: number | null;
  readonly cron?: string;
  readonly effortLevel?: string | null;
  readonly enabled?: boolean;
  readonly modelTier?: string | null;
  readonly payload?: string;
  readonly project?: string;
  readonly provider?: string | null;
  readonly raw?: boolean;
  readonly resetSession?: boolean;
  readonly sessionMode?: TaskSessionMode | null;
  readonly threadId?: number | null;
  readonly title?: string;
  readonly tz?: string;
  readonly type?: TaskEntry["type"];
}

/** The run choices a task may carry of its own, and its routed picks. */
export type RunChoicePatch = Pick<
  TaskPatch,
  "effortLevel" | "modelTier" | "pickEffort" | "pickModel" | "provider"
>;

const refused = (reason: TaskRefusalReason) => new TaskRefused({ reason });

/**
 * Whether a writer leaves a route task with no one to run as: an `executor`
 * stamp with no id (`routeWriterId` finds no one).
 */
const lacksWriter = (writer: TaskWriter) =>
  writer.author === "executor" && (writer.authorUserId ?? null) === null;

/**
 * Whom a route task written by `writer` runs as: its user id; with none, the
 * owner unless the stamp is `executor`, which runs as no one.
 */
export const routeWriterId = (writer: TaskWriter, ownerId: number) => {
  if (writer.authorUserId !== undefined && writer.authorUserId !== null) {
    return writer.authorUserId;
  }
  return writer.author === "executor" ? undefined : ownerId;
};

/**
 * Whether `actor` may make a script a gate or a gate a plain script without
 * rewriting it: the owner, or the script's own writer. A gate's output, often
 * text a third party wrote, becomes the model's instruction on the writer's
 * powers.
 */
const mayRegate = (actor: TaskStampInput, task: TaskEntry) =>
  actor.author === "owner" ||
  (actor.authorUserId !== null && actor.authorUserId === task.authorUserId);

/** Whether a mode change turns a script into a gate or a gate back. */
const regates = (task: TaskEntry, mode: TaskSessionMode | null) =>
  task.type === "script" &&
  (mode === null) !== (task.sessionMode === undefined);

/**
 * The patch that starts a kept conversation over: an `own` task forgets its
 * session at once; a `route` task's conversation lives in the bot, which
 * starts it over once nothing runs there.
 */
const restartPatch = (mode: TaskSessionMode): TaskPatch =>
  mode === "route"
    ? { sessionReset: true }
    : { sessionId: null, sessionProvider: null };

/** Refuse a schedule the scheduler could not register. */
export const checkSchedule = (
  schedule: Schedule
): Effect.Effect<void, TaskRefused> => {
  const issue = scheduleIssue(schedule);
  if (issue === undefined) {
    return Effect.void;
  }
  return Effect.fail(
    new TaskRefused({
      reason: issue === "zone" ? "scheduleZone" : "scheduleNever",
      schedule: { cron: schedule.cron, tz: schedule.tz },
    })
  );
};

/** The chat a task ends up with after an edit of `chatId`. */
const chatOf = (before: TaskEntry, chatId: number | null | undefined) =>
  chatId === undefined ? before.chatId : (chatId ?? undefined);

/**
 * A `sessionMode` edit: `sessionMode` is what the patch stores (undefined
 * when unchanged), `mode` the mode the task ends up with. Only a real change
 * rebinds: repeating the mode a task already has keeps its conversation.
 */
const modeEdit = (
  before: TaskEntry,
  requested: TaskSessionMode | null | undefined
) => {
  const sessionMode =
    (requested ?? undefined) === before.sessionMode ? undefined : requested;
  const mode =
    sessionMode === undefined ? before.sessionMode : (sessionMode ?? undefined);
  return { mode, sessionMode };
};

/**
 * The first rule an edit's shape breaks, whoever makes it: a route task left
 * without a chat, a gate turned back into a plain script with no new
 * script, a reset that comes with a new mode or has nothing to reset.
 */
const editProblem = (input: {
  readonly before: TaskEntry;
  readonly edit: TaskEdit;
  readonly mode: TaskSessionMode | undefined;
  readonly sessionMode: TaskSessionMode | null | undefined;
}): Option.Option<TaskRefusalReason> => {
  const { before, edit, mode, sessionMode } = input;
  if (mode === "route" && chatOf(before, edit.chatId) === undefined) {
    return Option.some(
      edit.chatId === null ? "routeChatCleared" : "routeNeedsChat"
    );
  }
  if (
    sessionMode === null &&
    (edit.type ?? before.type) === "script" &&
    edit.payload === undefined
  ) {
    return Option.some("ungateNeedsPayload");
  }
  if (edit.resetSession === true && sessionMode !== undefined) {
    return Option.some("resetWithMode");
  }
  return edit.resetSession === true && mode === undefined
    ? Option.some("resetNeedsMode")
    : Option.none();
};

/**
 * The patch an edit writes. A topic cannot outlive its chat, so clearing
 * the chat clears both; a reset starts the kept conversation over.
 */
const editPatch = (input: {
  readonly edit: TaskEdit;
  readonly mode: TaskSessionMode | undefined;
  readonly sessionMode: TaskSessionMode | null | undefined;
}) => {
  const { edit, mode } = input;
  const patch: TaskPatch = {
    chatId: edit.chatId,
    cron: edit.cron,
    effortLevel: edit.effortLevel,
    enabled: edit.enabled,
    modelTier: edit.modelTier,
    payload: edit.payload,
    project: edit.project,
    provider: edit.provider,
    raw: edit.raw,
    sessionMode: input.sessionMode,
    threadId: edit.chatId === null ? null : edit.threadId,
    title: edit.title,
    type: edit.type,
    tz: edit.tz,
  };
  if (edit.resetSession === true && mode !== undefined) {
    return { ...restartPatch(mode), ...patch };
  }
  return patch;
};

const makeService = Effect.gen(function* makeTaskService() {
  const tasks = yield* TasksRepo;
  const settings = yield* SettingsRepo;

  /** The task, or `missing`. */
  const existing = (id: number) =>
    tasks.get(id).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(refused("missing")),
          onSome: Effect.succeed,
        })
      )
    );

  /**
   * Why `rule` does not allow a route task in `chatId` for `writer`; none
   * when it does. A task that is not a route task, or has no chat, passes.
   */
  const routeChatProblem = Effect.fn("TaskService.routeChatProblem")(
    function* routeChatProblem(input: {
      readonly chatId: number | undefined;
      readonly mode: TaskSessionMode | undefined;
      readonly rule: RouteRule;
      readonly writer: TaskWriter;
    }) {
      const { chatId, rule, writer } = input;
      if (input.mode !== "route" || chatId === undefined) {
        return Option.none<TaskRefusalReason>();
      }
      if (rule.kind === "notForeignPrivate") {
        const writerId = writer.authorUserId ?? null;
        // A private chat's id is its user's id; a writer with no id here
        // (an owner stamp without one) is not checked.
        const foreign = chatId > 0 && writerId !== null && chatId !== writerId;
        return foreign
          ? Option.some<TaskRefusalReason>("routeForeignPrivate")
          : Option.none<TaskRefusalReason>();
      }
      const writerId = routeWriterId(writer, rule.ownerId);
      if (writerId !== undefined && chatId === writerId) {
        return Option.none<TaskRefusalReason>();
      }
      const workspace = yield* settings.workspace();
      const inWorkspace = Option.exists(
        workspace,
        (found) => found.chatId === chatId
      );
      return writerId !== undefined && inWorkspace
        ? Option.none<TaskRefusalReason>()
        : Option.some<TaskRefusalReason>("routeNotRunnable");
    }
  );

  /** Refuse a route task bound to a chat `rule` does not allow. */
  const checkRouteChat = Effect.fn("TaskService.checkRouteChat")(
    function* checkRouteChat(input: Parameters<typeof routeChatProblem>[0]) {
      const problem = yield* routeChatProblem(input);
      if (Option.isSome(problem)) {
        yield* refused(problem.value);
      }
    }
  );

  /**
   * Create a task stamped with `writer`. A route task needs a chat, a writer
   * to run as and a chat `rule` allows; the schedule must fire.
   */
  const create = Effect.fn("TaskService.create")(function* create(input: {
    readonly draft: NewTask;
    readonly rule: RouteRule;
    readonly writer: TaskStampInput;
  }) {
    const { draft, writer } = input;
    yield* checkSchedule(draft);
    if (draft.sessionMode === "route" && draft.chatId === undefined) {
      return yield* refused("routeNeedsChat");
    }
    if (draft.sessionMode === "route" && lacksWriter(writer)) {
      return yield* refused("routeNeedsWriter");
    }
    yield* checkRouteChat({
      chatId: draft.chatId,
      mode: draft.sessionMode,
      rule: input.rule,
      writer,
    });
    return yield* tasks.create({
      ...draft,
      author: writer.author,
      authorUserId: writer.authorUserId ?? undefined,
    });
  });

  /**
   * Edit a task. Changing what it does or where it reports (payload, type,
   * project, chat, topic) makes it `writer`'s work and restamps it; a pause,
   * a rename, a new schedule, run choice or session mode leaves its writer
   * alone, except that only its writer or the owner may gate or ungate a
   * script that way. Repeating the mode a task already has keeps its
   * conversation. Answers the task as it now stands.
   */
  const update = Effect.fn("TaskService.update")(function* update(input: {
    readonly edit: TaskEdit;
    readonly id: number;
    readonly rule: RouteRule;
    readonly writer: TaskStampInput;
  }) {
    const { edit, writer: actor } = input;
    const before = yield* existing(input.id);
    const { mode, sessionMode } = modeEdit(before, edit.sessionMode);
    const problem = editProblem({ before, edit, mode, sessionMode });
    if (Option.isSome(problem)) {
      return yield* refused(problem.value);
    }
    const patch = editPatch({ edit, mode, sessionMode });
    const rewrites = [
      patch.payload,
      patch.type,
      patch.project,
      patch.chatId,
      patch.threadId,
    ].some((value) => value !== undefined);
    if (
      !rewrites &&
      sessionMode !== undefined &&
      regates(before, sessionMode) &&
      !mayRegate(actor, before)
    ) {
      return yield* refused("gateNotYours");
    }
    const writer: TaskWriter = rewrites ? actor : before;
    if (mode === "route" && lacksWriter(writer)) {
      return yield* refused("routeNeedsWriter");
    }
    yield* checkRouteChat({
      chatId: chatOf(before, edit.chatId),
      mode,
      rule: input.rule,
      writer,
    });
    yield* checkSchedule({
      cron: patch.cron ?? before.cron,
      tz: patch.tz ?? before.tz,
    });
    const after = yield* tasks.update(
      input.id,
      rewrites
        ? { ...patch, author: actor.author, authorUserId: actor.authorUserId }
        : patch
    );
    return Option.getOrElse(after, () => before);
  });

  /**
   * Set which conversation a task keeps. The task stays its writer's: a mode
   * changes which conversation it keeps, not what it asks for. Only its
   * writer or the owner may gate or ungate a script; a route needs a chat
   * its writer may run in. Pressing the mode it has changes nothing.
   */
  const setSessionMode = Effect.fn("TaskService.setSessionMode")(
    function* setSessionMode(input: {
      readonly actor: TaskStampInput;
      readonly mode: TaskSessionMode | null;
      readonly ownerId: number;
      readonly task: TaskEntry;
    }) {
      const { mode, task } = input;
      if (regates(task, mode) && !mayRegate(input.actor, task)) {
        return yield* refused("gateNotYours");
      }
      if (mode === "route") {
        if (task.chatId === undefined) {
          return yield* refused("routeNeedsChat");
        }
        if (lacksWriter(task)) {
          return yield* refused("routeNeedsWriter");
        }
        yield* checkRouteChat({
          chatId: task.chatId,
          mode,
          rule: { kind: "runnable", ownerId: input.ownerId },
          writer: task,
        });
      }
      if (mode === (task.sessionMode ?? null)) {
        return task;
      }
      const updated = yield* tasks.update(task.id, { sessionMode: mode });
      return Option.getOrElse(updated, () => task);
    }
  );

  /**
   * Start a kept conversation over: at once for an `own` task (answers
   * `cleared`); a `route` task is flagged (answers the flagged task, none
   * when it is gone) for the bot to start over once nothing runs there.
   */
  const resetSession = Effect.fn("TaskService.resetSession")(
    function* resetSession(input: {
      readonly id: number;
      readonly mode: TaskSessionMode;
    }) {
      if (input.mode === "own") {
        yield* tasks.update(input.id, restartPatch("own"));
        return { kind: "cleared" } as const;
      }
      const pending = yield* tasks.update(input.id, restartPatch("route"));
      return { kind: "flagged", pending } as const;
    }
  );

  /** Pause or resume a task; none when it is gone. */
  const setEnabled = Effect.fn("TaskService.setEnabled")(
    function* setEnabled(input: {
      readonly enabled: boolean;
      readonly id: number;
    }) {
      return yield* tasks.update(input.id, { enabled: input.enabled });
    }
  );

  /** Set what a task runs on; none when it is gone. */
  const setRunChoice = Effect.fn("TaskService.setRunChoice")(
    function* setRunChoice(input: {
      readonly id: number;
      readonly patch: RunChoicePatch;
    }) {
      return yield* tasks.update(input.id, input.patch);
    }
  );

  return {
    create,
    get: tasks.get,
    list: tasks.list,
    remove: tasks.drop,
    resetSession,
    setEnabled,
    setRunChoice,
    setSessionMode,
    update,
  } as const;
});

/**
 * The one way to write recurring tasks. The `/tasks` screens, the tasks CLI
 * and the HTTP API are thin doors over it; the scheduler's own bookkeeping
 * (fires, sessions, gate state) stays on `TasksRepo`.
 */
export class TaskService extends Context.Service<
  TaskService,
  Effect.Success<typeof makeService>
>()("@workspace/db/TaskService") {
  static readonly layer = Layer.effect(TaskService, makeService);
}
