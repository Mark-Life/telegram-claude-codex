#!/usr/bin/env bun

// Recurring-task management for codex runs: the owner says "make this a daily
// digest" and the agent saves the work here. It writes through `TaskService`,
// the rules the bot's /tasks screens and the HTTP API share, so every door
// agrees; the bot picks a change made here up on its next reload tick. Owner and executor runs are pointed at
// `skills/bot-tasks/SKILL.md`, which documents it (see run-prompt.ts).
//
// `--chat` decides delivery: a task without one is silent and reports only its
// failures to the owner; `--chat none` on update turns a task silent.
//
// `--session` decides which conversation the fires keep: `fresh` (the default)
// starts a new one each fire, `own` keeps one of the task's own, `route` runs
// in the conversation of the task's chat and topic. `--reset-session` starts
// a kept one over: at the next fire for `own`, as soon as the chat is idle for
// `route`, which the bot applies on its next reload tick.

import {
  checkSchedule,
  describeScheduleIssue,
  isTaskSessionMode,
  isTaskType,
  TASK_SESSION_MODES,
  TaskService,
  taskStampFromEnv,
} from "@workspace/db";
import type {
  RouteRule,
  TaskEntry,
  TaskRefusalReason,
  TaskRefused,
} from "@workspace/db";
import { Console, Effect, Option } from "effect";

import {
  isModelTier,
  isRoutedEffort,
  MODEL_TIERS,
  PROVIDER_IDS,
  ROUTED_EFFORTS,
} from "../src/types";
import {
  COMMAND_INDEX,
  hasFlag,
  orRefuse,
  readFlag,
  refuse,
  runDbCli,
} from "./lib/db-cli";

const USAGE = [
  "Usage:",
  "  tasks-cli.ts list",
  "  tasks-cli.ts add --title <t> --cron '<m h dom mon dow>' --tz <IANA> --type <prompt|script> --payload <text> [--project <dir>] [--chat <id>] [--thread <id>] [--raw] [--disabled] [--provider <p>] [--model <tier>] [--effort <level>] [--session <fresh|own|route>]",
  "  tasks-cli.ts update --id <id> [--title <t>] [--cron <c>] [--tz <z>] [--payload <p>] [--project <dir>] [--chat <id|none>] [--thread <id|none>] [--enabled <true|false>] [--raw <true|false>] [--provider <p|auto>] [--model <tier|auto>] [--effort <level|auto>] [--session <fresh|own|route>] [--reset-session]",
  "",
  "Without --chat a task is silent: its output is dropped and only failures reach the owner.",
  "--chat none clears the chat and topic; --thread none clears only the topic.",
  `A prompt task runs on its writer's /settings defaults. --provider (${PROVIDER_IDS.join(", ")}), --model (${MODEL_TIERS.join(", ")}) and --effort (${ROUTED_EFFORTS.join(", ")}) set its own; auto follows the defaults again.`,
  "--session own keeps one conversation of the task's own across fires; --session route runs each fire in the conversation of --chat (and --thread), which must be the writer's own private chat or the workspace. --reset-session starts a kept conversation over.",
  "On a script task a mode makes it a gate: its output becomes the model's instruction and the model's answer the report. --session fresh on a gated script needs a --payload that works without taskState.",
  "  tasks-cli.ts delete --id <id>",
].join("\n");

/**
 * Who this run works for, as the bot told it: the tier and user id only in a
 * run that holds the owner's Telegram account, so a task written from any
 * other run never runs with that account.
 */
const stamp = taskStampFromEnv(process.env);

/** A required flag, or a refusal naming it. */
const required = (argv: readonly string[], flag: string) => {
  const value = readFlag(argv, flag);
  return value === undefined
    ? refuse(`${flag} is required.\n\n${USAGE}`)
    : Effect.succeed(value);
};

/** The target task id, validated. */
const readId = (argv: readonly string[]) => {
  const raw = readFlag(argv, "--id");
  const parsed = Number(raw);
  return raw !== undefined && Number.isSafeInteger(parsed) && parsed > 0
    ? Effect.succeed(parsed)
    : refuse("--id must be a task id");
};

/** An optional safe integer route id; none when the flag is absent. */
const readRouteId = (argv: readonly string[], flag: string) => {
  const raw = readFlag(argv, flag);
  if (raw === undefined) {
    return Effect.succeedNone;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed)
    ? Effect.succeedSome(parsed)
    : refuse(`${flag} must be a safe integer`);
};

/** A route id on update: `none` clears it, absent leaves it alone. */
const readRouteEdit = Effect.fn(function* readRouteEdit(
  argv: readonly string[],
  flag: string
) {
  if (readFlag(argv, flag) === "none") {
    return null;
  }
  return Option.getOrUndefined(yield* readRouteId(argv, flag));
});

/** A `--flag true|false` tri-state: undefined when the flag is absent. */
const readBool = (argv: readonly string[], flag: string) => {
  const raw = readFlag(argv, flag);
  return raw === undefined ? undefined : raw === "true" || raw === "1";
};

/** The `--type` flag, validated; none when it is not being set. */
const readType = (argv: readonly string[]) => {
  const raw = readFlag(argv, "--type") ?? "";
  if (raw.length === 0) {
    return Effect.succeedNone;
  }
  return isTaskType(raw)
    ? Effect.succeedSome(raw)
    : refuse("--type must be one of: prompt, script");
};

/** The session mode that stores nothing: a new session at every fire. */
const FRESH = "fresh";

/**
 * The `--session` flag: undefined when absent, null for `fresh`, else a mode
 * the store keeps.
 */
const readSessionMode = (argv: readonly string[]) => {
  const raw = readFlag(argv, "--session");
  if (raw === undefined) {
    return Effect.succeed(raw);
  }
  if (raw === FRESH) {
    return Effect.succeed(null);
  }
  return isTaskSessionMode(raw)
    ? Effect.succeed(raw)
    : refuse(
        `--session must be one of: ${[FRESH, ...TASK_SESSION_MODES].join(", ")}`
      );
};

/**
 * How `TaskService` refusals read here: in flags, since an agent reads them
 * to fix its next call. Every reason has its sentence; the chat words the
 * same reasons its own way.
 */
const REFUSALS: Record<
  Exclude<TaskRefusalReason, "missing" | "scheduleNever" | "scheduleZone">,
  string
> = {
  gateNotYours:
    "--session on this script changes whether its output becomes the model's instruction, and only its writer or the owner may change that: ask from the writer's or the owner's run, or give a new --payload together.",
  resetNeedsMode:
    "--reset-session needs a task that keeps its conversation: this one starts fresh at every fire.",
  resetWithMode:
    "--reset-session goes alone: a new --session starts over by itself.",
  routeChatCleared:
    "--chat none would leave a route task without its chat: set --session fresh or own first, or together.",
  routeForeignPrivate:
    "--session route runs in the writer's own private chat or the workspace: this --chat is another user's private chat.",
  routeNeedsChat:
    "--session route needs --chat: the task runs in that chat's conversation.",
  routeNeedsWriter:
    "--session route needs a task stamped with its writer's user id, and this run carries none: ask from a run that has the requester's id, or keep --session fresh or own.",
  routeNotRunnable:
    "--session route runs in the writer's own private chat or the workspace.",
  ungateNeedsPayload:
    "--session fresh turns a gated script back into a plain one: it no longer gets taskState and its output is sent as is. Give a script that works without a gate in --payload together.",
};

/** A `TaskService` refusal as this CLI's stderr line. */
const refusal = (id?: number) => (error: TaskRefused) => {
  if (error.reason === "missing") {
    return refuse(`No task ${id}.`);
  }
  if (error.reason === "scheduleZone" || error.reason === "scheduleNever") {
    const schedule = error.schedule ?? { cron: "", tz: "" };
    return refuse(
      describeScheduleIssue({
        issue: error.reason === "scheduleZone" ? "zone" : "never",
        schedule,
      })
    );
  }
  return refuse(REFUSALS[error.reason]);
};

/**
 * Which chats a route task may be bound to from here: only another user's
 * private chat is refused, as this CLI always did.
 */
const ROUTE_RULE: RouteRule = { kind: "notForeignPrivate" };

/** What `auto` clears a run choice back to: following the writer's defaults. */
const AUTO = "auto";

/**
 * One run choice (`--provider`, `--model`, `--effort`): undefined when the
 * flag is absent, null for `auto`, else a value `valid` accepts.
 */
const readChoice = (
  argv: readonly string[],
  flag: string,
  allowed: readonly string[],
  valid: (raw: string) => boolean
) => {
  const raw = readFlag(argv, flag);
  const ok = raw === undefined || raw === AUTO || valid(raw);
  return ok
    ? Effect.succeed(raw === AUTO ? null : raw)
    : refuse(`${flag} must be one of: ${[...allowed, AUTO].join(", ")}`);
};

/** The three run choices a prompt task can carry, validated. */
const readRunChoice = Effect.fn(function* readRunChoice(
  argv: readonly string[]
) {
  return {
    effortLevel: yield* readChoice(
      argv,
      "--effort",
      ROUTED_EFFORTS,
      isRoutedEffort
    ),
    modelTier: yield* readChoice(argv, "--model", MODEL_TIERS, isModelTier),
    provider: yield* readChoice(argv, "--provider", PROVIDER_IDS, (raw) =>
      PROVIDER_IDS.some((id) => id === raw)
    ),
  };
});

/** One task as a single tab-separated line, for an agent to read back. */
const describe = (task: TaskEntry) =>
  [
    task.id,
    task.enabled ? "enabled" : "paused",
    task.type,
    `"${task.cron}" ${task.tz}`,
    task.title,
    task.chatId === undefined
      ? "silent"
      : `chat ${task.chatId}${task.threadId === undefined ? "" : ` thread ${task.threadId}`}`,
    task.lastStatus ?? "never run",
    [task.provider, task.modelTier, task.effortLevel]
      .map((value) => value ?? AUTO)
      .join(" "),
    task.sessionMode ?? FRESH,
    [
      `session ${task.sessionId ?? "none"}`,
      ...(task.sessionReset === true ? ["reset pending"] : []),
    ].join(" "),
  ].join("\t");

const list = Effect.gen(function* list() {
  const tasks = yield* TaskService;
  const rows = yield* tasks.list();
  yield* Console.log(
    rows.length === 0 ? "No recurring tasks." : rows.map(describe).join("\n")
  );
});

const add = Effect.fn(function* add(argv: readonly string[]) {
  const tasks = yield* TaskService;
  const requested = yield* readType(argv);
  const type = yield* orRefuse(`--type is required.\n\n${USAGE}`)(requested);
  const schedule = {
    cron: yield* required(argv, "--cron"),
    tz: yield* required(argv, "--tz"),
  };
  yield* checkSchedule(schedule).pipe(
    Effect.catchTag("TaskRefused", refusal())
  );
  const choice = yield* readRunChoice(argv);
  const sessionMode = (yield* readSessionMode(argv)) ?? undefined;
  const chatId = Option.getOrUndefined(yield* readRouteId(argv, "--chat"));
  const created = yield* tasks
    .create({
      draft: {
        ...schedule,
        chatId,
        effortLevel: choice.effortLevel ?? undefined,
        enabled: !hasFlag(argv, "--disabled"),
        modelTier: choice.modelTier ?? undefined,
        payload: yield* required(argv, "--payload"),
        project: readFlag(argv, "--project"),
        provider: choice.provider ?? undefined,
        raw: hasFlag(argv, "--raw"),
        sessionMode,
        threadId: Option.getOrUndefined(yield* readRouteId(argv, "--thread")),
        title: yield* required(argv, "--title"),
        type,
      },
      rule: ROUTE_RULE,
      writer: stamp,
    })
    .pipe(Effect.catchTag("TaskRefused", refusal()));
  yield* Console.log(
    `Task ${created.id} "${created.title}" scheduled: ${created.cron} ${created.tz} (${created.type}).`
  );
});

const update = Effect.fn(function* update(argv: readonly string[]) {
  const tasks = yield* TaskService;
  const id = yield* readId(argv);
  // The service checks again; asked first, a wrong id is the answer even
  // when other flags are wrong too.
  yield* tasks.get(id).pipe(Effect.flatMap(orRefuse(`No task ${id}.`)));
  const chatId = yield* readRouteEdit(argv, "--chat");
  // A topic cannot outlive its chat, so clearing the chat clears both.
  let threadId: number | null | undefined = null;
  if (chatId !== null) {
    threadId = yield* readRouteEdit(argv, "--thread");
  }
  const sessionMode = yield* readSessionMode(argv);
  const type = Option.getOrUndefined(yield* readType(argv));
  const updated = yield* tasks
    .update({
      edit: {
        ...(yield* readRunChoice(argv)),
        chatId,
        cron: readFlag(argv, "--cron"),
        enabled: readBool(argv, "--enabled"),
        payload: readFlag(argv, "--payload"),
        project: readFlag(argv, "--project"),
        raw: readBool(argv, "--raw"),
        resetSession: hasFlag(argv, "--reset-session"),
        sessionMode,
        threadId,
        title: readFlag(argv, "--title"),
        type,
        tz: readFlag(argv, "--tz"),
      },
      id,
      rule: ROUTE_RULE,
      writer: stamp,
    })
    .pipe(Effect.catchTag("TaskRefused", refusal(id)));
  yield* Console.log(`Task ${id} updated: ${describe(updated)}`);
});

const drop = Effect.fn(function* drop(argv: readonly string[]) {
  const tasks = yield* TaskService;
  const id = yield* readId(argv);
  const removed = yield* tasks.remove(id);
  yield* Console.log(removed ? `Deleted task ${id}.` : `No task ${id}.`);
});

/** One CLI invocation; `argv` is the full `process.argv`. */
export const main = Effect.fn("tasks-cli")(function* main(
  argv: readonly string[]
) {
  switch (argv[COMMAND_INDEX] ?? "") {
    case "list": {
      return yield* list;
    }
    case "add": {
      return yield* add(argv);
    }
    case "update": {
      return yield* update(argv);
    }
    case "delete": {
      return yield* drop(argv);
    }
    default: {
      return yield* refuse(USAGE);
    }
  }
});

if (import.meta.main) {
  runDbCli(main(process.argv));
}
