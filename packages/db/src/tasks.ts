import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { persistence } from "./errors";
import { Millis, OptionalFromNull, RowId } from "./schema";

/**
 * What a fired task does: run a stored prompt through the agent (judgment work,
 * costs tokens) or replay stored code through Executor (deterministic, cheap).
 */
export const TASK_TYPES = ["prompt", "script"] as const;

export type TaskType = (typeof TASK_TYPES)[number];

/**
 * Which conversation a task's fires keep. Absent (NULL) is a fresh session
 * per fire. `own` keeps one session of the task's own across fires; `route`
 * runs each fire in the conversation of the task's chat and topic, so a human
 * there continues it.
 */
export const TASK_SESSION_MODES = ["own", "route"] as const;

export type TaskSessionMode = (typeof TASK_SESSION_MODES)[number];

/** Narrow a session mode a caller typed. */
export const isTaskSessionMode = (value: string): value is TaskSessionMode =>
  TASK_SESSION_MODES.some((mode) => mode === value);

/** How the last fire ended; `paused` means Executor is waiting for approval. */
export const TASK_STATUSES = ["error", "ok", "paused"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Which tier last set what a task does or where it reports. Whether the task
 * runs with the owner's Telegram account is decided at each fire from this and
 * `authorUserId` (see `taskHoldsAccount` in the app).
 */
export const TASK_AUTHORS = ["executor", "owner"] as const;

export type TaskAuthor = (typeof TASK_AUTHORS)[number];

/**
 * The env vars a run's shell carries so the tasks CLI can stamp the author:
 * the tier and the user id of the person the run works for, set only in a run
 * that holds the owner's account itself. Any other run stamps `executor` with
 * no id, which never runs with the account.
 */
export const TASK_AUTHOR_ENV = "BOT_TASK_AUTHOR";
export const TASK_AUTHOR_ID_ENV = "BOT_TASK_AUTHOR_ID";

/** Who a task a run writes is stamped with: the tier and the user behind it. */
export interface TaskStamp {
  /**
   * The HTTP API run (`api_runs` row) the run serves, when an API key
   * started it: an account write it asks for then names that key in the
   * owner's confirmation. Never part of a task's stamp or a CLI's env.
   */
  readonly apiRunId?: number;
  readonly author: TaskAuthor;
  readonly userId: number;
}

/**
 * Read the stamp a CLI was started with. An unknown tier is not the owner; an
 * id that is not a positive safe integer is no id at all.
 */
export const taskStampFromEnv = (env: Record<string, string | undefined>) => {
  const id = Number(env[TASK_AUTHOR_ID_ENV]);
  const author: TaskAuthor =
    env[TASK_AUTHOR_ENV] === "owner" ? "owner" : "executor";
  return {
    author,
    authorUserId: Number.isSafeInteger(id) && id > 0 ? id : null,
  };
};

/** One recurring task, as the store hands it back. */
export const TaskEntrySchema = Schema.Struct({
  /** Absent on a task written before authors were kept: not the owner's. */
  author: OptionalFromNull(Schema.Literals(TASK_AUTHORS)),
  /**
   * The user who last set what the task does. Absent on a task written before
   * ids were kept, or by a run without the owner's account.
   */
  authorUserId: OptionalFromNull(Schema.Int),
  /**
   * Telegram chat that receives the result. Absent means a silent task: its
   * output is dropped and only a failure reaches the owner.
   */
  chatId: OptionalFromNull(Schema.Int),
  createdAt: Millis,
  /** Standard 5-field cron expression, read in `tz`. */
  cron: Schema.String,
  /**
   * The task's own effort, a level of the router's scale; absent follows the
   * writer's `/settings` default.
   */
  effortLevel: OptionalFromNull(Schema.String),
  enabled: Schema.BooleanFromBit,
  id: RowId,
  lastRunAt: OptionalFromNull(Millis),
  lastStatus: OptionalFromNull(Schema.Literals(TASK_STATUSES)),
  /**
   * The task's own model, a router tier; absent follows the writer's
   * `/settings` default.
   */
  modelTier: OptionalFromNull(Schema.String),
  /** Prompt text for a `prompt` task, Executor program source for a `script` one. */
  payload: Schema.String,
  /**
   * The routed reasoning effort, in `pickProvider`'s terms. Set only when a
   * fire left the effort to the router and spent a judgment on the payload;
   * a payload edit or a new choice clears it, so new work is routed again.
   */
  pickEffort: OptionalFromNull(Schema.String),
  /** The routed model slug, in `pickProvider`'s terms; set as `pickEffort` is. */
  pickModel: OptionalFromNull(Schema.String),
  /** The provider `pickModel` and `pickEffort` were routed for. */
  pickProvider: OptionalFromNull(Schema.String),
  /** Directory a prompt task runs in; the default projects dir when absent. */
  project: OptionalFromNull(Schema.String),
  /**
   * The provider a prompt task runs on; absent follows the writer's
   * `/settings` default provider, read at every fire.
   */
  provider: OptionalFromNull(Schema.String),
  /** Send a script's output unchanged instead of prettifying it first. */
  raw: Schema.BooleanFromBit,
  /**
   * The JSON a gated script last returned as its `state`, handed to its next
   * fire as `taskState`. Cleared by a new payload or type.
   */
  scriptState: OptionalFromNull(Schema.String),
  /**
   * The session an `own` task resumes, on `sessionProvider`. Cleared when the
   * provider, project, type, mode or writer changes, so the next fire starts
   * fresh.
   */
  sessionId: OptionalFromNull(Schema.String),
  /** Which conversation the fires keep; absent is a fresh session per fire. */
  sessionMode: OptionalFromNull(Schema.Literals(TASK_SESSION_MODES)),
  /** The provider `sessionId` belongs to. */
  sessionProvider: OptionalFromNull(Schema.String),
  /**
   * A pending request to start a `route` task's conversation over, applied by
   * the bot once the conversation is idle. Cleared when the route or the mode
   * changes.
   */
  sessionReset: OptionalFromNull(Schema.BooleanFromBit),
  /** Telegram topic inside `chatId`; the main chat when absent. */
  threadId: OptionalFromNull(Schema.Int),
  title: Schema.String,
  type: Schema.Literals(TASK_TYPES),
  /** IANA timezone the cron expression is read in. */
  tz: Schema.String,
});

export type TaskEntry = typeof TaskEntrySchema.Type;

/** What creating a task needs; the rest of the row has defaults. */
export type TaskDraft = Pick<
  TaskEntry,
  "cron" | "payload" | "title" | "tz" | "type"
> &
  Partial<
    Pick<
      TaskEntry,
      | "author"
      | "authorUserId"
      | "chatId"
      | "effortLevel"
      | "enabled"
      | "modelTier"
      | "project"
      | "provider"
      | "raw"
      | "sessionMode"
      | "threadId"
    >
  >;

/** How many fires `task_runs` keeps per task, newest first. */
const TASK_RUNS_KEPT = 50;

/**
 * One fire of a task, as `/history`'s Tasks view lists it. What it ran on is
 * absent for a script task, and for a fire from before runs were logged.
 */
const TaskRunSchema = Schema.Struct({
  effort: OptionalFromNull(Schema.String),
  finishedAt: Millis,
  id: RowId,
  model: OptionalFromNull(Schema.String),
  provider: OptionalFromNull(Schema.String),
  /**
   * The session the fire reported. A fresh fire's outlives it only on Codex;
   * an `own` or `route` fire's is the one the next fire resumes.
   */
  sessionId: OptionalFromNull(Schema.String),
  startedAt: Millis,
  status: Schema.Literals(TASK_STATUSES),
  taskId: RowId,
  /** The task's title now. */
  title: Schema.String,
});

export type TaskRun = typeof TaskRunSchema.Type;

/** How one fire ended and what it ran on, as the scheduler reports it. */
export type TaskRunWrite = Omit<TaskRun, "id" | "title">;

const TaskRunRow = TaskRunSchema.pipe(
  Schema.encodeKeys({
    finishedAt: "finished_at",
    sessionId: "session_id",
    startedAt: "started_at",
    taskId: "task_id",
  })
);

const { id: _id, title: _title, ...runFields } = TaskRunSchema.fields;

/** What `recordRun` binds: the run without its row id and the task's title. */
const TaskRunInsert = Schema.Struct(runFields);

const RunPage = Schema.Struct({ limit: Schema.Int, offset: Schema.Int });

const Count = Schema.Struct({ n: Schema.Int });

/**
 * A partial edit. An absent field is left alone; the route can be cleared,
 * with null, which turns the task silent, and so can the author's id.
 */
export type TaskPatch = Partial<
  Omit<
    TaskEntry,
    | "authorUserId"
    | "chatId"
    | "createdAt"
    | "effortLevel"
    | "id"
    | "modelTier"
    | "pickEffort"
    | "pickModel"
    | "provider"
    | "scriptState"
    | "sessionId"
    | "sessionMode"
    | "sessionProvider"
    | "sessionReset"
    | "threadId"
  >
> & {
  authorUserId?: number | null;
  chatId?: number | null;
  effortLevel?: string | null;
  modelTier?: string | null;
  pickEffort?: string | null;
  pickModel?: string | null;
  provider?: string | null;
  scriptState?: string | null;
  sessionId?: string | null;
  sessionMode?: TaskSessionMode | null;
  sessionProvider?: string | null;
  sessionReset?: boolean | null;
  threadId?: number | null;
};

type Bind = number | string | null;

/** Narrow a stored task type; an unknown value reads as no row at all. */
export const isTaskType = (value: string): value is TaskType =>
  TASK_TYPES.some((type) => type === value);

/** Narrow a stored run status; anything else reads as never run. */
export const isTaskStatus = (value: string): value is TaskStatus =>
  TASK_STATUSES.some((status) => status === value);

/** SQLite has no boolean; a flag is stored as 0 or 1, and null clears it. */
const flag = (value: boolean | null | undefined) =>
  value === undefined || value === null ? value : Number(value);

/** `TaskEntry` as the table stores it. */
const TaskRowSchema = TaskEntrySchema.pipe(
  Schema.encodeKeys({
    authorUserId: "author_user_id",
    chatId: "chat_id",
    createdAt: "created_at",
    effortLevel: "effort_level",
    lastRunAt: "last_run_at",
    lastStatus: "last_status",
    modelTier: "model_tier",
    pickEffort: "pick_effort",
    pickModel: "pick_model",
    pickProvider: "pick_provider",
    scriptState: "script_state",
    sessionId: "session_id",
    sessionMode: "session_mode",
    sessionProvider: "session_provider",
    sessionReset: "session_reset",
    threadId: "thread_id",
  })
);

/**
 * What `create` binds: flags as bits, an absent route or project as NULL. The
 * draft's `undefined` never reaches `bun:sqlite`.
 */
const TaskInsert = Schema.Struct({
  author: Schema.NullOr(Schema.Literals(TASK_AUTHORS)),
  authorUserId: Schema.NullOr(Schema.Int),
  chatId: Schema.NullOr(Schema.Int),
  createdAt: Millis,
  cron: Schema.String,
  effortLevel: Schema.NullOr(Schema.String),
  enabled: Schema.BooleanFromBit,
  modelTier: Schema.NullOr(Schema.String),
  payload: Schema.String,
  project: Schema.NullOr(Schema.String),
  provider: Schema.NullOr(Schema.String),
  raw: Schema.BooleanFromBit,
  sessionMode: Schema.NullOr(Schema.Literals(TASK_SESSION_MODES)),
  threadId: Schema.NullOr(Schema.Int),
  title: Schema.String,
  type: Schema.Literals(TASK_TYPES),
  tz: Schema.String,
});

const DroppedId = Schema.Struct({ id: RowId });

/**
 * The columns an edit drops because they hang on what it changed. Only a real
 * change counts, so repeating a stored value keeps what hangs on it. A session
 * kept on another provider, project, type or mode, or for another writer (a
 * session holds what its writer could reach, so a task stamped to someone else
 * must not resume it on their powers), is not the one the next fire should
 * resume. A new script or type keeps no old script state. A reset asked for
 * one chat, topic or mode says nothing about another. An edit that stores any
 * of these itself wins, as with the routed pick.
 */
const droppedBindings = (patch: TaskPatch, stored: TaskEntry | undefined) => {
  const changed = (field: keyof TaskPatch & keyof TaskEntry) =>
    patch[field] !== undefined &&
    (stored === undefined || (patch[field] ?? undefined) !== stored[field]);
  const newMode = changed("sessionMode");
  const newType = changed("type");
  const rebound =
    newMode ||
    newType ||
    changed("author") ||
    changed("authorUserId") ||
    changed("provider") ||
    changed("project");
  const rerouted = newMode || changed("chatId") || changed("threadId");
  return [
    ...(rebound ? ["session_id", "session_provider"] : []),
    ...(newType || changed("payload") ? ["script_state"] : []),
    ...(rerouted ? ["session_reset"] : []),
  ];
};

/**
 * The columns an edit may touch, as the record `sql.update` renders. Column
 * names come from here, never from the caller. `undefined` is skipped; `null`
 * clears.
 */
const patchColumns = (patch: TaskPatch, stored: TaskEntry | undefined) => {
  const columns: Record<string, Bind> = {};
  const put = (column: string, value: Bind | undefined) => {
    if (value !== undefined) {
      columns[column] = value;
    }
  };
  put("author", patch.author);
  put("author_user_id", patch.authorUserId);
  put("title", patch.title);
  put("chat_id", patch.chatId);
  put("thread_id", patch.threadId);
  put("cron", patch.cron);
  put("tz", patch.tz);
  put("type", patch.type);
  put("payload", patch.payload);
  put("project", patch.project);
  put("enabled", flag(patch.enabled));
  put("raw", flag(patch.raw));
  put("last_run_at", patch.lastRunAt);
  put("last_status", patch.lastStatus);
  put("provider", patch.provider);
  put("model_tier", patch.modelTier);
  put("effort_level", patch.effortLevel);
  // A new payload is new work, and a new choice asks for another run: the
  // pick routed before says nothing about either, so it is dropped and the
  // next fire routes again. An edit that stores a pick itself wins. The old
  // `model` and `effort` columns, Codex's pick before `pick_*`, are only
  // read by an older build after a rollback, and go with a new payload.
  if (patch.payload !== undefined) {
    put("model", null);
    put("effort", null);
  }
  const replaced = [
    patch.payload,
    patch.provider,
    patch.modelTier,
    patch.effortLevel,
  ].some((value) => value !== undefined);
  if (replaced) {
    put("pick_model", null);
    put("pick_effort", null);
    put("pick_provider", null);
  }
  put("pick_model", patch.pickModel);
  put("pick_effort", patch.pickEffort);
  put("pick_provider", patch.pickProvider);
  for (const column of droppedBindings(patch, stored)) {
    put(column, null);
  }
  put("session_mode", patch.sessionMode);
  put("session_id", patch.sessionId);
  put("session_provider", patch.sessionProvider);
  put("session_reset", flag(patch.sessionReset));
  put("script_state", patch.scriptState);
  return columns;
};

const make = Effect.gen(function* makeTasksRepo() {
  const sql = yield* SqlClient.SqlClient;

  // An unknown stored status reads as never run; a row of an unknown type
  // describes work nothing can do, so it reads as absent and the scheduler
  // simply never registers it. Both filters live in the SQL so one alien row
  // cannot fail the decode of a whole list.
  const columns = sql`id, title, cron, tz, type, payload, project, enabled, raw,
    created_at, last_run_at,
    CASE WHEN last_status IN ${sql.in(TASK_STATUSES)} THEN last_status END
      AS last_status,
    chat_id, thread_id, pick_model, pick_effort, pick_provider, provider,
    model_tier, effort_level,
    CASE WHEN author IN ${sql.in(TASK_AUTHORS)} THEN author END AS author,
    author_user_id,
    CASE WHEN session_mode IN ${sql.in(TASK_SESSION_MODES)} THEN session_mode END
      AS session_mode,
    session_id, session_provider, session_reset, script_state`;
  const known = sql`type IN ${sql.in(TASK_TYPES)}`;

  const selectOne = SqlSchema.findOneOption({
    Request: RowId,
    Result: TaskRowSchema,
    execute: (id) =>
      sql`SELECT ${columns} FROM tasks WHERE id = ${id} AND ${known}`,
  });
  const selectAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: TaskRowSchema,
    execute: () =>
      sql`SELECT ${columns} FROM tasks WHERE ${known} ORDER BY id ASC`,
  });
  const selectResets = SqlSchema.findAll({
    Request: Schema.Void,
    Result: TaskRowSchema,
    execute: () =>
      sql`SELECT ${columns} FROM tasks
          WHERE session_reset = 1 AND session_mode = 'route' AND ${known}
          ORDER BY id ASC`,
  });
  const insert = SqlSchema.findOne({
    Request: TaskInsert,
    Result: TaskRowSchema,
    execute: (row) =>
      sql`INSERT INTO tasks
            (title, cron, tz, type, payload, project, enabled, raw,
             created_at, chat_id, thread_id, author, author_user_id,
             provider, model_tier, effort_level, session_mode)
          VALUES
            (${row.title}, ${row.cron}, ${row.tz}, ${row.type}, ${row.payload},
             ${row.project}, ${row.enabled}, ${row.raw}, ${row.createdAt},
             ${row.chatId}, ${row.threadId}, ${row.author},
             ${row.authorUserId}, ${row.provider}, ${row.modelTier},
             ${row.effortLevel}, ${row.sessionMode})
          RETURNING ${columns}`,
  });
  const remove = SqlSchema.findAll({
    Request: RowId,
    Result: DroppedId,
    execute: (id) => sql`DELETE FROM tasks WHERE id = ${id} RETURNING id`,
  });

  /** One task, or none when it was deleted (or is of an unknown type). */
  const get = Effect.fn("TasksRepo.get")(function* get(id: number) {
    return yield* selectOne(id);
  }, persistence("TasksRepo.get"));

  /** Every task, oldest first. */
  const list = Effect.fn("TasksRepo.list")(function* list() {
    return yield* selectAll();
  }, persistence("TasksRepo.list"));

  /** Route tasks whose conversation is waiting to start over, oldest first. */
  const listPendingResets = Effect.fn("TasksRepo.listPendingResets")(
    function* listPendingResets() {
      return yield* selectResets();
    },
    persistence("TasksRepo.listPendingResets")
  );

  /** Store a new task; enabled and prettified unless the draft says otherwise. */
  const create = Effect.fn("TasksRepo.create")(function* create(
    draft: TaskDraft
  ) {
    const createdAt = yield* Clock.currentTimeMillis;
    // RETURNING on an INSERT always yields the row; an empty result is a defect.
    return yield* insert({
      author: draft.author ?? null,
      authorUserId: draft.authorUserId ?? null,
      chatId: draft.chatId ?? null,
      createdAt,
      cron: draft.cron,
      effortLevel: draft.effortLevel ?? null,
      enabled: draft.enabled ?? true,
      modelTier: draft.modelTier ?? null,
      payload: draft.payload,
      project: draft.project ?? null,
      provider: draft.provider ?? null,
      raw: draft.raw ?? false,
      sessionMode: draft.sessionMode ?? null,
      threadId: draft.threadId ?? null,
      title: draft.title,
      type: draft.type,
      tz: draft.tz,
    }).pipe(Effect.catchTag("NoSuchElementError", Effect.die));
  }, persistence("TasksRepo.create"));

  /**
   * Apply a patch and read the row back in one transaction, so the read is of
   * the row this edit wrote. Untraced and unlabelled: `update` and `recordRun`
   * each wrap it under their own operation name.
   */
  const applyPatch = Effect.fnUntraced(function* applyPatch(
    id: number,
    patch: TaskPatch
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* edit() {
        const stored = yield* selectOne(id);
        const sets = patchColumns(patch, Option.getOrUndefined(stored));
        if (Object.keys(sets).length > 0) {
          yield* sql`UPDATE tasks SET ${sql.update(sets)} WHERE id = ${id}`;
        }
        return yield* selectOne(id);
      })
    );
  });

  /** Apply an edit; the row as it now stands, none when there is no such task. */
  const update = Effect.fn("TasksRepo.update")(function* update(
    id: number,
    patch: TaskPatch
  ) {
    return yield* applyPatch(id, patch);
  }, persistence("TasksRepo.update"));

  const insertRun = SqlSchema.void({
    Request: TaskRunInsert,
    execute: (run) =>
      sql`INSERT INTO task_runs
            (task_id, status, provider, model, effort, session_id, started_at,
             finished_at)
          VALUES
            (${run.taskId}, ${run.status}, ${run.provider}, ${run.model},
             ${run.effort}, ${run.sessionId}, ${run.startedAt},
             ${run.finishedAt})`,
  });
  // Keep the newest `TASK_RUNS_KEPT` of one task; an older one is let go.
  const trimRuns = SqlSchema.void({
    Request: RowId,
    execute: (taskId) =>
      sql`DELETE FROM task_runs WHERE task_id = ${taskId} AND id NOT IN (
            SELECT id FROM task_runs WHERE task_id = ${taskId}
            ORDER BY finished_at DESC, id DESC LIMIT ${TASK_RUNS_KEPT}
          )`,
  });
  const removeRuns = SqlSchema.void({
    Request: RowId,
    execute: (taskId) => sql`DELETE FROM task_runs WHERE task_id = ${taskId}`,
  });
  // A run whose task is gone, or of a status this build does not know, is
  // left out rather than failing the page.
  const listedRuns = sql`FROM task_runs r JOIN tasks t ON t.id = r.task_id
    WHERE r.status IN ${sql.in(TASK_STATUSES)}`;
  const selectRuns = SqlSchema.findAll({
    Request: RunPage,
    Result: TaskRunRow,
    execute: (page) =>
      sql`SELECT r.id, r.task_id, r.status, r.provider, r.model, r.effort,
            r.session_id, r.started_at, r.finished_at, t.title
          ${listedRuns}
          ORDER BY r.finished_at DESC, r.id DESC
          LIMIT ${page.limit} OFFSET ${page.offset}`,
  });
  const countRuns = SqlSchema.findOne({
    Request: Schema.Void,
    Result: Count,
    execute: () => sql`SELECT COUNT(*) AS n ${listedRuns}`,
  });

  /**
   * Log how one fire ended and what it ran on, and keep its outcome on the
   * task as the list view reads it, in one transaction. The task as it now
   * stands; none when it was deleted meanwhile, and then nothing is logged.
   */
  const recordRun = Effect.fn("TasksRepo.recordRun")(function* recordRun(
    run: TaskRunWrite
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* logRun() {
        const task = yield* applyPatch(run.taskId, {
          lastRunAt: run.finishedAt,
          lastStatus: run.status,
        });
        if (Option.isSome(task)) {
          yield* insertRun(run);
          yield* trimRuns(run.taskId);
        }
        return task;
      })
    );
  }, persistence("TasksRepo.recordRun"));

  /** Fires of every task, the latest first, each with its task's title. */
  const runs = Effect.fn("TasksRepo.runs")(function* runs(
    page: typeof RunPage.Type
  ) {
    return yield* selectRuns(page);
  }, persistence("TasksRepo.runs"));

  /** How many fires `runs` lists. */
  const runCount = Effect.fn("TasksRepo.runCount")(function* runCount() {
    const { n } = yield* countRuns().pipe(
      Effect.catchTag("NoSuchElementError", Effect.die)
    );
    return n;
  }, persistence("TasksRepo.runCount"));

  /** Forget a task and its fires; false when there was nothing to forget. */
  const drop = Effect.fn("TasksRepo.drop")(function* drop(id: number) {
    return yield* sql.withTransaction(
      Effect.gen(function* dropTask() {
        const dropped = yield* remove(id);
        yield* removeRuns(id);
        return dropped.length > 0;
      })
    );
  }, persistence("TasksRepo.drop"));

  return {
    create,
    drop,
    get,
    list,
    listPendingResets,
    recordRun,
    runCount,
    runs,
    update,
  } as const;
});

/**
 * Recurring tasks (`tasks`). The table is the single source of truth shared by
 * the bot's scheduler, its `/tasks` commands and the tasks CLI a codex run
 * drives, so nothing here caches: a change made through any door is visible
 * to the others on the next read.
 *
 * Transactions live only inside repositories. Never run the bridge, Telegram
 * or an agent inside `withTransaction`: the transaction holds the client's only
 * permit, so it would stall every other query in the process.
 */
export class TasksRepo extends Context.Service<
  TasksRepo,
  Effect.Success<typeof make>
>()("@workspace/db/TasksRepo") {
  static readonly layer = Layer.effect(TasksRepo, make);
}
