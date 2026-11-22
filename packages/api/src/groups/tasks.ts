import { Schema } from "effect";
import {
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from "effect/http-api";

import { Forbidden, InvalidInput, NotFound } from "../errors";
import { ApiAuth } from "../middleware";
import { IsoTime, pathId } from "./shared";

/**
 * Recurring tasks, the same registry as /tasks in Telegram and the bot's
 * tasks CLI, under the same rules. The owner and executors share it.
 */

/** The providers a prompt task may run on, as the bot names them. */
export const TASK_PROVIDERS = ["codex", "claude", "pi"] as const;

/** The model tiers a prompt task may pick, weakest first. */
export const TASK_MODEL_TIERS = ["luna", "terra", "sol", "astra"] as const;

/** The efforts a prompt task may pick, lightest first. */
export const TASK_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

export const TaskType = Schema.Literals(["prompt", "script"]).annotate({
  description:
    "`prompt`: the payload is a prompt the agent runs at every fire (costs tokens). `script`: the payload is Executor code replayed at every fire (cheap, deterministic).",
});

export const TaskSessionMode = Schema.Literals([
  "fresh",
  "own",
  "route",
]).annotate({
  description:
    "Which conversation the fires keep. `fresh`: a new one at every fire. `own`: one conversation of the task's own across fires. `route`: each fire runs in the conversation of the task's chat and topic, which must be your own private chat with the bot or the workspace. On a script task `own` or `route` makes it a gate: its output becomes the model's instruction.",
});

const TaskProvider = Schema.Literals(TASK_PROVIDERS).annotate({
  description: "The provider a prompt task runs on.",
});

const TaskModelTier = Schema.Literals(TASK_MODEL_TIERS).annotate({
  description: "The model tier a prompt task runs on, weakest first.",
});

const TaskEffort = Schema.Literals(TASK_EFFORTS).annotate({
  description: "The reasoning effort a prompt task runs with, lightest first.",
});

const ChatId = Schema.Int.annotate({
  description:
    "The Telegram chat that gets the task's results: your own user id for your private chat with the bot, or a group's id such as the workspace's. Without one the task is silent and only its failures reach the owner.",
});

const ThreadId = Schema.Int.annotate({
  description: "A forum topic inside `chatId`; the chat itself when absent.",
});

const Cron = Schema.String.annotate({
  description:
    "A standard 5-field cron expression (`minute hour day-of-month month day-of-week`), read in `tz`.",
  examples: ["0 9 * * 1-5"],
});

const Tz = Schema.String.annotate({
  description: "The IANA timezone the cron expression is read in.",
  examples: ["Europe/Berlin"],
});

const PAYLOAD_DESCRIPTION =
  "What the task does: the prompt of a `prompt` task, the Executor program source of a `script` task.";

const TITLE_DESCRIPTION = "A short name for the task.";

/** What a new or edited task must say: never empty. */
const Payload = Schema.NonEmptyString.annotate({
  description: PAYLOAD_DESCRIPTION,
});

const Title = Schema.NonEmptyString.annotate({
  description: TITLE_DESCRIPTION,
});

const Project = Schema.String.annotate({
  description:
    "The directory a prompt task runs in; the bot's projects directory when absent.",
});

/** One recurring task as the API shows it. */
export const TaskSchema = Schema.Struct({
  author: Schema.optionalKey(
    Schema.Literals(["owner", "executor"]).annotate({
      description:
        "The tier that last set what the task does or where it reports; absent on old tasks.",
    })
  ),
  authorUserId: Schema.optionalKey(
    Schema.Int.annotate({
      description: "The Telegram user who last set what the task does.",
    })
  ),
  chatId: Schema.optionalKey(ChatId),
  createdAt: IsoTime,
  cron: Cron,
  effortLevel: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "The task's own effort; absent follows its writer's /settings default.",
    })
  ),
  enabled: Schema.Boolean.annotate({
    description: "Whether the task fires; `false` is paused.",
  }),
  id: Schema.Int.annotate({ description: "The task's id." }),
  lastRunAt: Schema.optionalKey(IsoTime),
  lastStatus: Schema.optionalKey(
    Schema.Literals(["ok", "error", "paused"]).annotate({
      description:
        "How the last fire ended; `paused` means Executor waits for an approval.",
    })
  ),
  modelTier: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "The task's own model tier; absent follows its writer's /settings default.",
    })
  ),
  nextRunAt: Schema.optionalKey(
    IsoTime.annotate({
      description: "When the task fires next; absent while it is paused.",
    })
  ),
  // Shown as stored: the other doors (the CLI, /tasks) may have kept an
  // empty one, and one such row must not break the whole list.
  payload: Schema.String.annotate({ description: PAYLOAD_DESCRIPTION }),
  project: Schema.optionalKey(Project),
  provider: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "The task's own provider; absent follows its writer's /settings default.",
    })
  ),
  raw: Schema.Boolean.annotate({
    description:
      "A script task's output is sent unchanged instead of prettified first.",
  }),
  sessionMode: TaskSessionMode,
  sessionResetPending: Schema.Boolean.annotate({
    description:
      "A `route` task's conversation will start over once nothing runs in its chat.",
  }),
  threadId: Schema.optionalKey(ThreadId),
  title: Schema.String.annotate({ description: TITLE_DESCRIPTION }),
  type: TaskType,
  tz: Tz,
}).annotate({ identifier: "Task" });

export type Task = typeof TaskSchema.Type;

export const TaskList = Schema.Struct({
  tasks: Schema.Array(TaskSchema),
}).annotate({ identifier: "TaskList" });

/** A new task. */
export const TaskCreate = Schema.Struct({
  chatId: Schema.optionalKey(ChatId),
  cron: Cron,
  effortLevel: Schema.optionalKey(TaskEffort),
  enabled: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "`false` makes the task paused from the start.",
    })
  ),
  modelTier: Schema.optionalKey(TaskModelTier),
  payload: Payload,
  project: Schema.optionalKey(Project),
  provider: Schema.optionalKey(TaskProvider),
  raw: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Send a script task's output unchanged.",
    })
  ),
  sessionMode: Schema.optionalKey(TaskSessionMode),
  threadId: Schema.optionalKey(ThreadId),
  title: Title,
  type: TaskType,
  tz: Tz,
}).annotate({ identifier: "TaskCreate" });

/** An edit of a task: an absent field is left alone. */
export const TaskUpdate = Schema.Struct({
  chatId: Schema.optionalKey(
    Schema.NullOr(ChatId).annotate({
      description:
        "Where results go; `null` makes the task silent and clears its topic too.",
    })
  ),
  cron: Schema.optionalKey(Cron),
  effortLevel: Schema.optionalKey(
    Schema.NullOr(TaskEffort).annotate({
      description: "`null` follows the writer's /settings default again.",
    })
  ),
  enabled: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "`false` pauses the task, `true` resumes it.",
    })
  ),
  modelTier: Schema.optionalKey(
    Schema.NullOr(TaskModelTier).annotate({
      description: "`null` follows the writer's /settings default again.",
    })
  ),
  payload: Schema.optionalKey(Payload),
  project: Schema.optionalKey(Project),
  provider: Schema.optionalKey(
    Schema.NullOr(TaskProvider).annotate({
      description: "`null` follows the writer's /settings default again.",
    })
  ),
  raw: Schema.optionalKey(Schema.Boolean),
  resetSession: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "`true` starts the kept conversation of an `own` or `route` task over. Not together with a new `sessionMode`.",
    })
  ),
  sessionMode: Schema.optionalKey(TaskSessionMode),
  threadId: Schema.optionalKey(
    Schema.NullOr(ThreadId).annotate({
      description: "`null` clears only the topic.",
    })
  ),
  title: Schema.optionalKey(Title),
  type: Schema.optionalKey(TaskType),
  tz: Schema.optionalKey(Tz),
}).annotate({ identifier: "TaskUpdate" });

export const TaskFired = Schema.Struct({
  admitted: Schema.Literals(["queued", "coalesced"]).annotate({
    description:
      "`queued`: a fire starts now, or right after the task's running one. `coalesced`: a fire of the task was already waiting to start and will do the same work.",
  }),
}).annotate({ identifier: "TaskFired" });

const TaskIdParams = {
  taskId: pathId("The task's id, as `tasks.list` shows it."),
};

const ownTaskNote =
  "Tasks are shared by the owner and executors, as in /tasks. A change to what a task does or where it reports (payload, type, project, chat, topic) makes it yours: it then runs with your powers.";

export const TasksGroup = HttpApiGroup.make("tasks")
  .add(
    HttpApiEndpoint.get("list", "/v1/tasks", {
      error: Forbidden,
      success: TaskList,
    }).annotateMerge(
      OpenApi.annotations({
        description:
          "List recurring tasks.\n\nEvery recurring task of the bot, paused ones included, with when each fires next.",
        identifier: "tasks.list",
        summary: "List recurring tasks",
      })
    ),
    HttpApiEndpoint.get("get", "/v1/tasks/:taskId", {
      error: [Forbidden, NotFound],
      params: TaskIdParams,
      success: TaskSchema,
    }).annotateMerge(
      OpenApi.annotations({
        description:
          "Show one recurring task.\n\n`NotFound` when there is none.",
        identifier: "tasks.get",
        summary: "Show one recurring task",
      })
    ),
    HttpApiEndpoint.post("create", "/v1/tasks", {
      error: [Forbidden, InvalidInput],
      payload: TaskCreate,
      success: TaskSchema,
    }).annotateMerge(
      OpenApi.annotations({
        description: `Create a recurring task.\n\nThe schedule must fire at least once; a \`route\` task needs a \`chatId\` that is your own private chat or the workspace. A prompt task without \`provider\`, \`modelTier\` or \`effortLevel\` follows your /settings defaults at every fire. ${ownTaskNote}`,
        identifier: "tasks.create",
        summary: "Create a recurring task",
      })
    ),
    HttpApiEndpoint.patch("update", "/v1/tasks/:taskId", {
      error: [Forbidden, InvalidInput, NotFound],
      params: TaskIdParams,
      payload: TaskUpdate,
      success: TaskSchema,
    }).annotateMerge(
      OpenApi.annotations({
        description: `Change a recurring task.\n\nOnly the fields sent change; \`enabled\` pauses or resumes it. Answers the task as it now stands. ${ownTaskNote} Only its writer or the owner may make a script a gate, or a gate a plain script, without a new payload.`,
        identifier: "tasks.update",
        summary: "Change a recurring task",
      })
    ),
    HttpApiEndpoint.delete("delete", "/v1/tasks/:taskId", {
      error: [Forbidden, NotFound],
      params: TaskIdParams,
      success: HttpApiSchema.NoContent,
    }).annotateMerge(
      OpenApi.annotations({
        description:
          "Delete a recurring task.\n\nA fire of it that is running or waiting is stopped quietly. `NotFound` when there is no such task.",
        identifier: "tasks.delete",
        summary: "Delete a recurring task",
      })
    ),
    HttpApiEndpoint.post("runNow", "/v1/tasks/:taskId/run", {
      error: [Forbidden, NotFound],
      params: TaskIdParams,
      success: TaskFired.pipe(HttpApiSchema.status("Accepted")),
    }).annotateMerge(
      OpenApi.annotations({
        description:
          "Fire a recurring task now.\n\nPaused tasks too. The fire runs in the background and reports where the task reports, as at a scheduled fire; this answers at once with how it was admitted.",
        identifier: "tasks.runNow",
        summary: "Fire a recurring task now",
      })
    )
  )
  .middleware(ApiAuth)
  .annotateMerge(
    OpenApi.annotations({
      description:
        "Recurring tasks: the same registry and rules as /tasks in Telegram. A change takes effect in the scheduler at once.",
      title: "tasks",
    })
  );
