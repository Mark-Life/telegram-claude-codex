import type { ProviderId, RoutedEffort } from "@workspace/agent/types";
import {
  BotApi,
  CurrentPrincipal,
  Forbidden,
  InvalidInput,
  NotFound,
} from "@workspace/api";
import type { Principal, Task, TaskCreate, TaskUpdate } from "@workspace/api";
import { describeScheduleIssue, TaskService } from "@workspace/db";
import type {
  NewTask,
  TaskEdit,
  TaskEntry,
  TaskRefusalReason,
  TaskRefused,
  TaskSessionMode,
} from "@workspace/db";
import { AppConfig } from "@workspace/env/bot";
import type { ModelTier } from "@workspace/env/bot";
import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { canManageTasks } from "../access/tier";
import { logRejection } from "../handlers/helpers";
import type { TaskSchedulerHandle } from "../tasks";
import { applyRouteReset } from "../tasks/route-run";
import { field, isoOf, operatorOnly, optionalIso } from "./views";

/**
 * Recurring tasks over HTTP: a door over `TaskService`, as /tasks and the
 * tasks CLI are, with the chat door's rules (a route task only in the
 * writer's own private chat or the workspace) and its in-process scheduler
 * reload after every write.
 */

/** The session mode the API calls `fresh`: none stored. */
const FRESH = "fresh";

/** A task as the API shows it, with when it fires next. */
export const taskView = (task: TaskEntry, nextRun: Date | null): Task => ({
  ...field("author", task.author),
  ...field("authorUserId", task.authorUserId),
  ...field("chatId", task.chatId),
  createdAt: isoOf(task.createdAt),
  cron: task.cron,
  ...field("effortLevel", task.effortLevel),
  enabled: task.enabled,
  id: task.id,
  ...field("lastRunAt", optionalIso(task.lastRunAt)),
  ...field("lastStatus", task.lastStatus),
  ...field("modelTier", task.modelTier),
  ...field(
    "nextRunAt",
    task.enabled && nextRun !== null ? nextRun.toISOString() : undefined
  ),
  payload: task.payload,
  ...field("project", task.project),
  ...field("provider", task.provider),
  raw: task.raw,
  sessionMode: task.sessionMode ?? FRESH,
  sessionResetPending: task.sessionReset === true,
  ...field("threadId", task.threadId),
  title: task.title,
  type: task.type,
  tz: task.tz,
});

/** `fresh` is no stored mode; the others are stored as they are. */
const storedMode = (mode: Task["sessionMode"]): TaskSessionMode | null =>
  mode === FRESH ? null : mode;

/**
 * How a refusal reads over HTTP: in the request's own field names, since a
 * program (or the model behind it) reads it to fix its next call.
 */
const REFUSALS: Record<
  Exclude<TaskRefusalReason, "missing" | "scheduleNever" | "scheduleZone">,
  string
> = {
  gateNotYours:
    "`sessionMode` on this script changes whether its output becomes the model's instruction, and only its writer or the owner may change that. Send a new `payload` together, or ask its writer or the owner.",
  resetNeedsMode:
    "`resetSession` needs a task that keeps its conversation: this one starts fresh at every fire.",
  resetWithMode:
    "`resetSession` goes alone: a new `sessionMode` starts over by itself.",
  routeChatCleared:
    "`chatId: null` would leave a route task without its chat: set `sessionMode` to `fresh` or `own` first, or together.",
  routeForeignPrivate:
    "A `route` task runs in your own private chat with the bot or the workspace: this `chatId` is another user's private chat.",
  routeNeedsChat:
    "`sessionMode: route` needs a `chatId`: the task runs in that chat's conversation.",
  routeNeedsWriter:
    "A `route` task needs a writer with a Telegram user id to run as.",
  routeNotRunnable:
    "A `route` task runs in your own private chat with the bot (`chatId` = your Telegram user id, see `me.get`) or the workspace.",
  ungateNeedsPayload:
    "`sessionMode: fresh` turns a gated script back into a plain one: it no longer gets taskState and its output is sent as is. Send a script that works without a gate in `payload` together.",
};

/** A refusal other than `missing` as the API's typed error. */
const refusedAs = (
  error: TaskRefused
): Effect.Effect<never, Forbidden | InvalidInput> => {
  if (error.reason === "missing") {
    // Only a write to an existing task can miss it; `refusal` answers that.
    return Effect.die(error);
  }
  if (error.reason === "scheduleZone" || error.reason === "scheduleNever") {
    return Effect.fail(
      new InvalidInput({
        message: describeScheduleIssue({
          issue: error.reason === "scheduleZone" ? "zone" : "never",
          schedule: error.schedule ?? { cron: "", tz: "" },
        }),
      })
    );
  }
  const message = REFUSALS[error.reason];
  return Effect.fail(
    error.reason === "gateNotYours"
      ? new Forbidden({ message })
      : new InvalidInput({ message })
  );
};

const missing = (id: number) => new NotFound({ message: `No task ${id}.` });

/** A refusal of a write to task `id`, `missing` included. */
const refusal =
  (id: number) =>
  (
    error: TaskRefused
  ): Effect.Effect<never, Forbidden | InvalidInput | NotFound> =>
    error.reason === "missing" ? Effect.fail(missing(id)) : refusedAs(error);

/** Who a write over HTTP is made as: the key's holder, at their tier. */
const writerOf = (principal: Principal) =>
  ({
    author: principal.tier,
    authorUserId: principal.telegramUserId,
  }) as const;

const draftOf = (payload: typeof TaskCreate.Type): NewTask => ({
  chatId: payload.chatId,
  cron: payload.cron,
  // The contract's names are the bot's own, checked here at compile time.
  effortLevel: payload.effortLevel satisfies RoutedEffort | undefined,
  enabled: payload.enabled ?? true,
  modelTier: payload.modelTier satisfies ModelTier | undefined,
  payload: payload.payload,
  project: payload.project,
  provider: payload.provider satisfies ProviderId | undefined,
  raw: payload.raw ?? false,
  sessionMode:
    payload.sessionMode === undefined
      ? undefined
      : (storedMode(payload.sessionMode) ?? undefined),
  threadId: payload.threadId,
  title: payload.title,
  type: payload.type,
  tz: payload.tz,
});

const editOf = (payload: typeof TaskUpdate.Type): TaskEdit => ({
  chatId: payload.chatId,
  cron: payload.cron,
  effortLevel: payload.effortLevel satisfies RoutedEffort | null | undefined,
  enabled: payload.enabled,
  modelTier: payload.modelTier satisfies ModelTier | null | undefined,
  payload: payload.payload,
  project: payload.project,
  provider: payload.provider satisfies ProviderId | null | undefined,
  raw: payload.raw,
  resetSession: payload.resetSession,
  sessionMode:
    payload.sessionMode === undefined
      ? undefined
      : storedMode(payload.sessionMode),
  // A topic cannot outlive its chat: clearing the chat clears both.
  threadId: payload.chatId === null ? null : payload.threadId,
  title: payload.title,
  type: payload.type,
  tz: payload.tz,
});

/** The tasks group over the bot's one scheduler. */
export const tasksLive = (scheduler: TaskSchedulerHandle) =>
  HttpApiBuilder.group(
    BotApi,
    "tasks",
    Effect.fnUntraced(function* (handlers) {
      const tasks = yield* TaskService;
      const { allowedUserId: ownerId } = yield* AppConfig;
      const rule = { kind: "runnable", ownerId } as const;

      const view = (task: TaskEntry) =>
        taskView(task, scheduler.nextRun(task.id));

      /**
       * Register the new state at once, as /tasks does; a failure is logged
       * and the minute's re-read picks the write up anyway.
       */
      const reload = Effect.tryPromise(scheduler.reload).pipe(
        Effect.catch((error) =>
          Effect.logWarning("task scheduler reload after an API write", error)
        ),
        Effect.asVoid
      );

      /** The principal, if their tier manages tasks. */
      const operator = Effect.gen(function* () {
        const principal = yield* CurrentPrincipal;
        yield* operatorOnly(canManageTasks(principal.tier), "recurring tasks");
        return principal;
      });

      const existing = (id: number) =>
        tasks.get(id).pipe(
          Effect.orDie,
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(missing(id)),
              onSome: Effect.succeed,
            })
          )
        );

      return handlers
        .handle("list", () =>
          Effect.gen(function* () {
            yield* operator;
            const rows = yield* tasks.list().pipe(Effect.orDie);
            return { tasks: rows.map(view) };
          })
        )
        .handle("get", ({ params }) =>
          Effect.gen(function* () {
            yield* operator;
            return view(yield* existing(Number(params.taskId)));
          })
        )
        .handle("create", ({ payload }) =>
          Effect.gen(function* () {
            const principal = yield* operator;
            const created = yield* tasks
              .create({
                draft: draftOf(payload),
                rule,
                writer: writerOf(principal),
              })
              .pipe(
                Effect.catchTag("TaskRefused", refusedAs),
                Effect.catchTag("PersistenceError", Effect.die)
              );
            yield* reload;
            return view(created);
          })
        )
        .handle("update", ({ params, payload }) =>
          Effect.gen(function* () {
            const principal = yield* operator;
            const id = Number(params.taskId);
            const updated = yield* tasks
              .update({
                edit: editOf(payload),
                id,
                rule,
                writer: writerOf(principal),
              })
              .pipe(
                Effect.catchTag("TaskRefused", refusal(id)),
                Effect.catchTag("PersistenceError", Effect.die)
              );
            yield* reload;
            // A route task starts over as soon as nothing runs in its chat,
            // as the Беседа screen's reset does; the minute's pass retries.
            if (
              updated.sessionReset === true &&
              updated.sessionMode === "route"
            ) {
              yield* Effect.promise(async () => {
                await applyRouteReset(updated, ownerId).catch(
                  logRejection(`task ${id}: session reset failed`)
                );
              });
            }
            return view(yield* existing(id));
          })
        )
        .handle("delete", ({ params }) =>
          Effect.gen(function* () {
            yield* operator;
            const id = Number(params.taskId);
            yield* existing(id);
            // A fire starting, running or waiting goes with its task, quietly.
            yield* Effect.promise(
              async () => await scheduler.stopTask(id, "replaced")
            );
            const removed = yield* tasks.remove(id).pipe(Effect.orDie);
            yield* reload;
            if (!removed) {
              yield* missing(id);
            }
          })
        )
        .handle("runNow", ({ params }) =>
          Effect.gen(function* () {
            yield* operator;
            const task = yield* existing(Number(params.taskId));
            const ticket = scheduler.fire(task.id, { force: true });
            return { admitted: ticket.admitted };
          })
        );
    })
  );
