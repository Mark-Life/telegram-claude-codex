import type { TaskSessionMode } from "@workspace/db";
import { InlineKeyboard } from "grammy";

import { accessOf } from "../access/context";
import type { BotContext } from "../access/context";
import { canManageTasks, isOwner } from "../access/tier";
import type { TaskEntry } from "../db";
import {
  createTask,
  deleteTask,
  getTask,
  listTasks,
  resetTaskSession,
  setTaskEnabled,
  setTaskRunChoice,
  setTaskSessionMode,
} from "../db/bridge";
import { t } from "../i18n";
import type { TaskSchedulerHandle } from "../tasks";
import {
  describeTask,
  parseTaskDraft,
  scheduleProblem,
  taskAddUsage,
} from "../tasks/format";
import { scheduledRunKey } from "../tasks/prompt-run";
import { applyRouteReset } from "../tasks/route-run";
import { tgBestEffort } from "../telegram/bridge";
import { routeOf } from "../telegram/route";
import { isWaiting } from "./agent-bridge";
import type { HandlerDeps } from "./deps";
import {
  parseTaskPickField,
  readTaskPickView,
  renderTaskPick,
  renderTaskPicker,
  TASK_PICK_RE,
  taskPickPatch,
} from "./task-model";
import type { SessionChoice } from "./task-session";
import {
  parseSessionChoice,
  renderTaskSession,
  storedMode,
  TASK_SESSION_RE,
} from "./task-session";

/**
 * Recurring tasks from the chat. The owner and executors share this registry:
 * executors have the same operational VPS access, while access management
 * itself remains owner-only.
 */

export const TASK_RUN_RE = /^taskrun:(?<value>\d+)$/u;
export const TASK_FLIP_RE = /^taskflip:(?<value>\d+)$/u;
export const TASK_DELETE_RE = /^taskdel:(?<value>\d+)$/u;
export const TASK_STOP_RE = /^taskstop:(?<value>\d+)$/u;

/**
 * Whether a task runs a model whose choice is its own: a prompt task, unless
 * it runs in its chat's conversation, whose own choice applies; and a gated
 * script with its own conversation, for the model it wakes.
 */
const hasModelChoice = (task: TaskEntry) =>
  task.type === "prompt"
    ? task.sessionMode !== "route"
    : task.sessionMode === "own";

/**
 * Whether a task's fire runs the model in a slot of its own that Stop
 * reaches, and may wait there on background work: the same tasks that have
 * a model of their own. One in its chat's conversation has that chat's
 * /stop.
 */
const hasStop = hasModelChoice;

/**
 * Buttons for one task: pause or resume it, run it now, stop its running
 * fire, or drop it; which conversation it keeps; and, when it has a model of
 * its own, what it runs on.
 */
const taskButtons = (task: TaskEntry) => {
  const keyboard = new InlineKeyboard()
    .text(
      task.enabled ? t().tasks.buttons.pause : t().tasks.buttons.resume,
      `taskflip:${task.id}`
    )
    .text(t().tasks.buttons.run, `taskrun:${task.id}`);
  if (hasStop(task)) {
    keyboard.text(t().tasks.buttons.stop, `taskstop:${task.id}`);
  }
  keyboard.text(t().tasks.buttons.delete, `taskdel:${task.id}`).row();
  if (hasModelChoice(task)) {
    keyboard.text(t().tasks.buttons.model, `taskpick:${task.id}`);
  }
  return keyboard.text(t().tasks.buttons.session, `tasksess:${task.id}`);
};

/**
 * Who a write from this chat is made as: the presser, at their tier. The
 * rules themselves live in `TaskService`.
 */
const writerOf = (ctx: BotContext) =>
  ({
    author: isOwner(accessOf(ctx).tier) ? "owner" : "executor",
    authorUserId: ctx.from?.id ?? null,
  }) as const;

/**
 * Draw over the pressed message; a double tap's "not modified" is dropped,
 * as `/settings` drops it.
 */
const redraw = async (
  ctx: BotContext,
  text: string,
  keyboard: InlineKeyboard
) => {
  await tgBestEffort(
    "editMessageText",
    async () =>
      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      }),
    { retry: false }
  );
};

/** The id a callback carries, or undefined when it is not one. */
const callbackId = (ctx: BotContext) => {
  const parsed = Number(ctx.match?.[1] ?? "");
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

/** Operational-tier guard; members and guests are told it does not exist. */
const taskManagerOnly = async (ctx: BotContext) => {
  if (canManageTasks(accessOf(ctx).tier)) {
    return true;
  }
  await ctx.reply(t().notForYou);
  return false;
};

/** Same guard for a button press, which answers the query instead. */
const taskManagerOnlyCallback = async (ctx: BotContext) => {
  if (canManageTasks(accessOf(ctx).tier)) {
    return true;
  }
  await ctx.answerCallbackQuery({ text: t().notForYou });
  return false;
};

/** The whole list, one message per task so each carries its own buttons. */
const sendTaskList = async (ctx: BotContext) => {
  const tasks = await listTasks();
  if (tasks.length === 0) {
    await ctx.reply(`${t().tasks.empty}\n\n${taskAddUsage()}`, {
      parse_mode: "HTML",
    });
    return;
  }
  await ctx.reply(`<b>${t().tasks.title(tasks.length)}</b>`, {
    parse_mode: "HTML",
  });
  for (const task of tasks) {
    // oxlint-disable-next-line no-await-in-loop -- one message per task, in list order
    await ctx.reply(describeTask(task), {
      parse_mode: "HTML",
      reply_markup: taskButtons(task),
    });
  }
};

export const registerTaskHandlers = (
  { bot, ownerId }: HandlerDeps,
  scheduler: TaskSchedulerHandle
) => {
  /** The slot a task's fire runs in. */
  const slotOf = (taskId: number) =>
    scheduledRunKey({ chatId: ownerId, ownerId, taskId });

  bot.command("tasks", async (ctx) => {
    if (await taskManagerOnly(ctx)) {
      await sendTaskList(ctx);
    }
  });

  bot.command("task", async (ctx) => {
    if (!(await taskManagerOnly(ctx))) {
      return;
    }
    const body = ctx.match.trim();
    const [word = ""] = body.split(/\s+/u);
    if (word !== "add") {
      await ctx.reply(`${t().tasks.commandHint}\n\n${taskAddUsage()}`, {
        parse_mode: "HTML",
      });
      return;
    }
    const parsed = parseTaskDraft(body.slice(word.length));
    if (!parsed.ok) {
      await ctx.reply(`${parsed.problem}\n\n${taskAddUsage()}`, {
        parse_mode: "HTML",
      });
      return;
    }
    // Results come back where the task was set up, unless it was asked to be
    // silent. A route task runs in this chat, which must be the writer's own
    // private chat or the workspace.
    const route = parsed.silent ? null : routeOf(ctx);
    const outcome = await createTask({
      draft: {
        ...parsed.draft,
        chatId: route?.chatId,
        threadId: route?.threadId ?? undefined,
      },
      rule: { kind: "runnable", ownerId },
      writer: writerOf(ctx),
    });
    if (
      outcome.refused === "scheduleZone" ||
      outcome.refused === "scheduleNever"
    ) {
      // The form's own check words a schedule problem first; this is the
      // service agreeing.
      await ctx.reply(
        `${scheduleProblem(parsed.draft) ?? ""}\n\n${taskAddUsage()}`,
        { parse_mode: "HTML" }
      );
      return;
    }
    if (outcome.refused !== undefined) {
      await ctx.reply(t().tasks.session.badRoute);
      return;
    }
    const created = outcome.task;
    await scheduler.reload();
    await ctx.reply(describeTask(created), {
      parse_mode: "HTML",
      reply_markup: taskButtons(created),
    });
  });

  bot.callbackQuery(TASK_FLIP_RE, async (ctx) => {
    if (!(await taskManagerOnlyCallback(ctx))) {
      return;
    }
    const id = callbackId(ctx);
    const task = id === undefined ? undefined : await getTask(id);
    if (!task) {
      await ctx.answerCallbackQuery({ text: t().tasks.toast.missing });
      return;
    }
    const updated = await setTaskEnabled({
      enabled: !task.enabled,
      id: task.id,
    });
    await scheduler.reload();
    await ctx.answerCallbackQuery({
      text:
        updated?.enabled === true
          ? t().tasks.toast.resumed
          : t().tasks.toast.paused,
    });
    if (updated) {
      await ctx.editMessageText(describeTask(updated), {
        parse_mode: "HTML",
        reply_markup: taskButtons(updated),
      });
    }
  });

  bot.callbackQuery(TASK_DELETE_RE, async (ctx) => {
    if (!(await taskManagerOnlyCallback(ctx))) {
      return;
    }
    const id = callbackId(ctx);
    if (id !== undefined) {
      // A fire still starting, running or waiting on background work goes
      // with its task, quietly; so do one queued, a retry, and one the
      // restart cut.
      await scheduler.stopTask(id, "replaced");
    }
    const removed = id !== undefined && (await deleteTask(id));
    await scheduler.reload();
    await ctx.answerCallbackQuery({
      text: removed ? t().tasks.toast.deleted : t().tasks.toast.missing,
    });
    if (removed) {
      await ctx.editMessageText(`<s>${t().tasks.deleted(id)}</s>`, {
        parse_mode: "HTML",
      });
    }
  });

  // What a prompt task runs on: its screen, a picker, a press, the way back.
  bot.callbackQuery(TASK_PICK_RE, async (ctx) => {
    if (!(await taskManagerOnlyCallback(ctx))) {
      return;
    }
    const groups = TASK_PICK_RE.exec(ctx.callbackQuery.data)?.groups;
    const task = await getTask(Number(groups?.id));
    if (task === undefined || !hasModelChoice(task)) {
      await ctx.answerCallbackQuery({ text: t().tasks.toast.missing });
      return;
    }
    if (groups?.field === "back") {
      await ctx.answerCallbackQuery();
      await redraw(ctx, describeTask(task), taskButtons(task));
      return;
    }
    const field = parseTaskPickField(groups?.field);
    const view = await readTaskPickView(task, ownerId);
    if (field !== undefined && groups?.value === undefined) {
      await ctx.answerCallbackQuery();
      const picker = renderTaskPicker(field, view);
      await redraw(ctx, picker.text, picker.keyboard);
      return;
    }
    let shown = view;
    if (field !== undefined && groups?.value !== undefined) {
      const press = taskPickPatch({ field, value: groups.value, view });
      // A press on the value already chosen writes nothing, so it keeps the
      // routed pick.
      let updated: TaskEntry | undefined = task;
      if (press?.patch !== undefined) {
        updated = await setTaskRunChoice({ id: task.id, patch: press.patch });
      }
      if (press === undefined || updated === undefined) {
        await ctx.answerCallbackQuery({ text: t().noSuchOption });
        return;
      }
      shown = await readTaskPickView(updated, ownerId);
    }
    await ctx.answerCallbackQuery();
    const screen = renderTaskPick(shown);
    await redraw(ctx, screen.text, screen.keyboard);
  });

  bot.callbackQuery(TASK_RUN_RE, async (ctx) => {
    if (!(await taskManagerOnlyCallback(ctx))) {
      return;
    }
    const id = callbackId(ctx);
    const task = id === undefined ? undefined : await getTask(id);
    if (task === undefined) {
      await ctx.answerCallbackQuery({ text: t().tasks.toast.missing });
      return;
    }
    // A run can take minutes; the result arrives as its own message. A task
    // that keeps a conversation may wait for it to be free.
    const ticket = scheduler.fire(task.id, { force: true });
    let toast = t().tasks.toast.running;
    if (ticket.admitted === "coalesced") {
      toast = t().tasks.toast.alreadyQueued;
    } else if (isWaiting(slotOf(task.id))) {
      toast = t().tasks.toast.waitingBackground;
    } else if (task.sessionMode !== undefined) {
      toast = t().tasks.toast.runningBound;
    }
    await ctx.answerCallbackQuery({ text: toast });
  });

  // Stop a task's fire: the one starting, running or waiting on background
  // work, one queued behind it, its armed retry, and one the restart cut,
  // which then is not continued. Nothing is sent; the next tick fires.
  bot.callbackQuery(TASK_STOP_RE, async (ctx) => {
    if (!(await taskManagerOnlyCallback(ctx))) {
      return;
    }
    const id = callbackId(ctx);
    if (id === undefined) {
      await ctx.answerCallbackQuery({ text: t().tasks.toast.missing });
      return;
    }
    const stopped = await scheduler.stopTask(id, "stopped");
    await ctx.answerCallbackQuery({
      text: stopped ? t().tasks.toast.stopped : t().tasks.toast.notRunning,
    });
  });

  /** «Начать заново»: the toast it ends with. */
  const resetSession = async (task: TaskEntry, mode: TaskSessionMode) => {
    const reset = await resetTaskSession({ id: task.id, mode });
    if (reset.kind === "cleared") {
      return t().tasks.session.resetDone;
    }
    if (reset.pending === undefined) {
      return t().tasks.toast.missing;
    }
    const applied = await applyRouteReset(reset.pending, ownerId);
    if (applied === "refused") {
      return t().tasks.session.badRoute;
    }
    return applied === "done"
      ? t().tasks.session.resetDone
      : t().tasks.toast.sessionReset;
  };

  /**
   * A press on a mode, through `TaskService`: refused for a route the task's
   * writer cannot run in, else stored. The task stays its writer's: a mode
   * changes which conversation it keeps, not what it asks for, so a press
   * never moves someone else's payload onto the presser's powers. Making a
   * script a gate, or a plain one again, does change what it does, so only
   * the writer or the owner may press that.
   */
  const pressMode = async (
    ctx: BotContext,
    task: TaskEntry,
    choice: SessionChoice
  ): Promise<{ refusal: string } | { refusal?: never; shown: TaskEntry }> => {
    const pressed = await setTaskSessionMode({
      actor: writerOf(ctx),
      mode: storedMode(choice),
      ownerId,
      task,
    });
    if (pressed.refused === undefined) {
      return { shown: pressed.task };
    }
    if (pressed.refused === "gateNotYours") {
      return { refusal: t().tasks.session.gateNotYours };
    }
    return {
      refusal:
        pressed.refused === "routeNeedsChat"
          ? t().tasks.session.routeNeedsChat
          : t().tasks.session.badRoute,
    };
  };

  // Which conversation a task keeps: its screen, a press, a reset, back.
  bot.callbackQuery(TASK_SESSION_RE, async (ctx) => {
    if (!(await taskManagerOnlyCallback(ctx))) {
      return;
    }
    const groups = TASK_SESSION_RE.exec(ctx.callbackQuery.data)?.groups;
    const task = await getTask(Number(groups?.id));
    if (task === undefined) {
      await ctx.answerCallbackQuery({ text: t().tasks.toast.missing });
      return;
    }
    const value = groups?.value;
    if (value === "back") {
      await ctx.answerCallbackQuery();
      await redraw(ctx, describeTask(task), taskButtons(task));
      return;
    }
    let shown = task;
    let toast: string | undefined;
    if (value === "reset") {
      if (task.sessionMode === undefined) {
        await ctx.answerCallbackQuery({ text: t().noSuchOption });
        return;
      }
      toast = await resetSession(task, task.sessionMode);
      shown = (await getTask(task.id)) ?? task;
    }
    const choice = parseSessionChoice(value);
    if (choice !== undefined) {
      const pressed = await pressMode(ctx, task, choice);
      if (pressed.refusal !== undefined) {
        await ctx.answerCallbackQuery({ text: pressed.refusal });
        return;
      }
      ({ shown } = pressed);
      toast = t().tasks.toast.modeSet;
    }
    await ctx.answerCallbackQuery(toast === undefined ? {} : { text: toast });
    const screen = renderTaskSession(shown);
    await redraw(ctx, screen.text, screen.keyboard);
  });
};
