import {
  isRestartCut,
  SKIP_OUTPUT,
  TASK_FAILED_PREFIX,
} from "@workspace/agent";
import type { ExecutionOutcome } from "@workspace/agent";
import type { TaskEntry, TaskStatus } from "@workspace/db";
import { Option, Schema } from "effect";

import { t } from "../i18n";
import { withDetail } from "../telegram/errors";
import type { RouteRunEnd } from "./route-run";
import { TaskRunEndSchema } from "./run-failed";
import type { TaskRunEnd } from "./run-failed";

/**
 * What one fire of a task produces: the outcome to store and the message to
 * send the owner. Everything here is pure over its dependencies — the agent,
 * Executor and the formatting pass all arrive as functions — so the whole
 * decision table is testable without a network.
 */
export interface TaskOutcome {
  /**
   * The fire never happened: the task was deleted, paused or rebound while
   * it waited for its conversation, or the bot is stopping. Or it is not
   * over: the restart cut it while it waited on background work, and it
   * resumes after boot; or it was stopped as its task was deleted. Nothing
   * is recorded or sent.
   */
  abandoned?: true;
  /**
   * What a prompt run answered, before the title was prepended. Set only when
   * that answer became the report, which is what the success judge reads.
   */
  answer?: string;
  /** A gated script's fire: its prompt is no instruction the judge can read. */
  gated?: true;
  /**
   * The run happened in the task's chat conversation, which already shows
   * its answer or its error: nothing is sent and no judge runs.
   */
  inRoute?: true;
  /**
   * A failure a retry would not mend: the run was stopped by hand, or its
   * background work found no waiting slot or ran past the idle cap.
   */
  noRetry?: true;
  /**
   * An abandoned fire whose task, still wanted, was retyped or rebound while
   * it waited: it is fired again as the task now stands.
   */
  rebound?: true;
  /** Why an attempt failed or was abandoned, for the log. */
  reason?: string;
  /** The JSON state a gated script returned, to store once the fire is ok. */
  scriptState?: string;
  status: TaskStatus;
  text: string;
}

/** The three things a fire can need. */
export interface RunnerDeps {
  /** Replay a script task's code through Executor. */
  execute: (task: TaskEntry) => Promise<ExecutionOutcome>;
  /** One cheap pass over raw output; undefined means "send it as it is". */
  prettify: (args: {
    result: string;
    title: string;
  }) => Promise<string | undefined>;
  /**
   * Run a fresh or `own` task's prompt through the agent, the payload or a
   * gated script's prompt, and hand back its final turn's message, once any
   * background work it waited on reported. A run that left no report rejects
   * with `TaskRunFailed`, whose `end` says why.
   */
  runPrompt: (task: TaskEntry, prompt?: string) => Promise<string>;
  /** Fire a `route` task's prompt into its chat's conversation. */
  runRoute: (task: TaskEntry, prompt?: string) => Promise<RouteRunEnd>;
  /**
   * A Stop, delete or pause that reached the fire before its prompt run was
   * registered: a gated `own` script's fire reads it once its script is back.
   */
  stopped?: () => Extract<TaskRunEnd, "replaced" | "stopped"> | undefined;
}

/** Indentation of a structured result rendered as JSON. */
const JSON_INDENT = 2;

/**
 * Exact script output that records a successful run without notifying, or,
 * for a gated script, without a model run: the bot's one `SKIP_OUTPUT`,
 * which an API run under `agent` delivery answers too.
 */
export const TASK_SKIP_OUTPUT = SKIP_OUTPUT;

/** The longest prompt a gated script may hand its model run. */
const GATED_PROMPT_MAX_CHARS = 100_000;

/** The largest state a gated script may keep for its next fire, as JSON. */
const SCRIPT_STATE_MAX_CHARS = 65_536;

/** What the next fire wraps the state in: `const taskState = …;\n`. */
const STATE_WRAPPER_CHARS = "const taskState = ;\n".length;

/**
 * Room for the state in the next fire's code. An Executor with a code limit
 * (v2) also has to fit the wrapper and the payload in it.
 */
const stateRoom = (
  task: TaskEntry,
  outcome: Extract<ExecutionOutcome, { kind: "ok" }>
) =>
  outcome.maxCodeChars === undefined
    ? SCRIPT_STATE_MAX_CHARS
    : Math.min(
        SCRIPT_STATE_MAX_CHARS,
        outcome.maxCodeChars - STATE_WRAPPER_CHARS - task.payload.length
      );

const messageOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/** A delivered message names its task unless the body already opens with it. */
const titled = (task: TaskEntry, body: string) =>
  body.replace(/^\*\*/u, "").startsWith(task.title)
    ? body
    : `${task.title}\n\n${body}`;

/**
 * Render one failed attempt. The scheduler decides whether to hold this text
 * for its single delayed retry or deliver it after that retry also fails.
 */
const failure = (task: TaskEntry, reason: string): TaskOutcome => ({
  reason,
  status: "error",
  text: titled(task, withDetail(t().tasks.run.failedWillRetry, reason)),
});

/** What a completed execution actually said, structured output included. */
const executionBody = (outcome: Extract<ExecutionOutcome, { kind: "ok" }>) => {
  const text = outcome.text.trim();
  if (text.length > 0) {
    return text;
  }
  return outcome.structured === undefined
    ? t().tasks.run.empty
    : JSON.stringify(outcome.structured, null, JSON_INDENT);
};

/**
 * What a paused run tells the owner: the handle to continue it with, and on
 * v2, that only Executor's MCP `resume` continues it.
 */
const pausedNotice = (
  outcome: Extract<ExecutionOutcome, { kind: "paused" }>
) => {
  const id = outcome.executionId ?? t().tasks.run.unknownId;
  if (outcome.resume === "rest") {
    return t().tasks.run.awaitingApproval(id);
  }
  return outcome.input === true
    ? t().tasks.run.awaitingMcpInput(id, outcome.asks)
    : t().tasks.run.awaitingMcpApproval(id, outcome.asks);
};

/** The owner-readable reason after the failure prefix, or undefined. */
const reportedFailure = (text: string) => {
  const trimmed = text.trim();
  return trimmed.startsWith(TASK_FAILED_PREFIX)
    ? trimmed.slice(TASK_FAILED_PREFIX.length).replace(/^[:\s]+/u, "")
    : undefined;
};

/** What a fresh or `own` run answered, as the report it becomes. */
const answered = (task: TaskEntry, text: string): TaskOutcome => {
  if (text.trim().length === 0) {
    return failure(task, "the run produced no answer");
  }
  const reason = reportedFailure(text);
  if (reason !== undefined) {
    return {
      reason: `the run reported: ${reason}`,
      status: "error",
      text: titled(task, reason.length > 0 ? reason : t().tasks.run.failed),
    };
  }
  return { answer: text, status: "ok", text: titled(task, text) };
};

/** An abandoned fire: nothing is recorded or sent. */
const abandonedFire = (reason: string): TaskOutcome => ({
  abandoned: true,
  reason,
  status: "ok",
  text: "",
});

/**
 * How a fire into the chat's conversation went. Once the run rendered, the
 * chat already shows its answer or its error, so nothing more is sent; a run
 * that never rendered is reported like any failure. A run someone stopped by
 * hand is not retried, nor one the pipeline refused, which told the chat why
 * and would refuse it again. One the restart cut is abandoned: the chat's
 * own continuation resumes it.
 */
const ranInRoute = (task: TaskEntry, ran: RouteRunEnd): TaskOutcome => {
  if ("abandoned" in ran) {
    const abandoned: TaskOutcome = {
      abandoned: true,
      reason: ran.abandoned,
      status: "ok",
      text: "",
    };
    if (ran.rebound === true) {
      abandoned.rebound = true;
    }
    return abandoned;
  }
  if ("refused" in ran) {
    return {
      ...failure(task, "the conversation refused the run"),
      inRoute: true,
      noRetry: true,
    };
  }
  const { result } = ran;
  if (result === undefined) {
    return failure(task, "the run in the chat ended before it answered");
  }
  const error = result.errorClass;
  // The conversation's own continuation resumes the work after boot.
  if (isRestartCut(error)) {
    return abandonedFire("cut by the restart; the chat resumes it");
  }
  if (error === undefined && (result.text ?? "").trim().length > 0) {
    return { inRoute: true, status: "ok", text: "" };
  }
  const failed: TaskOutcome = {
    ...failure(
      task,
      error === undefined ? "the run produced no answer" : error._tag
    ),
    inRoute: true,
  };
  if (error?._tag === "AgentInterrupted" && error.reason === "stopped") {
    failed.noRetry = true;
  }
  return failed;
};

/** A `TaskRunFailed` as it reaches the runner, read by shape. */
const decodeRunFailed = Schema.decodeUnknownOption(
  Schema.Struct({
    _tag: Schema.Literal("TaskRunFailed"),
    end: Schema.optional(TaskRunEndSchema),
  })
);

/**
 * A failure a retry would not mend, told at once: the owner stopped it (they
 * know), or its background work had no waiting slot or ran past the idle
 * cap.
 */
const failedForGood = (
  task: TaskEntry,
  reason: string,
  body?: string
): TaskOutcome => ({
  ...failure(task, reason),
  noRetry: true,
  text: body === undefined ? "" : titled(task, body),
});

/**
 * What a run that left no report becomes. A fire the restart cut resumes at
 * boot, one stopped because its task was deleted or paused is gone, and a
 * boot's fire whose park went meanwhile ran nothing: all are abandoned.
 * Anything else is a failure as before.
 */
const FAILED_RUN = {
  busy: (task, message) => failure(task, message),
  cut: () => abandonedFire("cut by the restart; resumes at boot"),
  error: (task, message) => failure(task, message),
  expired: (task) =>
    failedForGood(task, "wake-up wait expired", t().tasks.run.waitExpired),
  full: (task) =>
    failedForGood(task, "no waiting slot", t().tasks.run.noWaitSlot),
  gone: () => abandonedFire("nothing left to continue"),
  replaced: () => abandonedFire("stopped: task deleted or paused"),
  stopped: (task) => failedForGood(task, "stopped by hand"),
} satisfies Record<
  TaskRunEnd,
  (task: TaskEntry, message: string) => TaskOutcome
>;

/** Run a prompt through the agent and fold how it went into the outcome. */
const firePrompt = async (
  task: TaskEntry,
  deps: RunnerDeps,
  prompt?: string
): Promise<TaskOutcome> => {
  try {
    return task.sessionMode === "route"
      ? ranInRoute(task, await deps.runRoute(task, prompt))
      : answered(task, await deps.runPrompt(task, prompt));
  } catch (error) {
    const end = Option.getOrUndefined(decodeRunFailed(error))?.end ?? "error";
    return FAILED_RUN[end](task, messageOf(error));
  }
};

/**
 * Replay stored code through Executor and deliver the result. Unless the task
 * is marked `raw`, the output goes through one cheap formatting pass first; a
 * pass that cannot answer is not an error, it just means the raw output is
 * sent.
 */
const fireScript = async (task: TaskEntry, deps: RunnerDeps) => {
  const outcome = await deps.execute(task);
  if (outcome.kind === "failed") {
    return failure(task, outcome.message);
  }
  if (outcome.kind === "paused") {
    return {
      status: "paused" as const,
      text: titled(task, pausedNotice(outcome)),
    };
  }
  if (outcome.text.trim() === TASK_SKIP_OUTPUT) {
    return { status: "ok" as const, text: "" };
  }
  const body = executionBody(outcome);
  if (task.raw) {
    return { status: "ok" as const, text: titled(task, body) };
  }
  const pretty = await deps.prettify({ result: body, title: task.title });
  return { status: "ok" as const, text: titled(task, pretty ?? body) };
};

/**
 * The object a gated script may return: a prompt for the model (null for
 * none), a state for its next fire, or both. Any other value is no such
 * object.
 */
const GateReturn = Schema.Struct({
  prompt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  state: Schema.optionalKey(Schema.Unknown),
});

const decodeGateReturn = Schema.decodeUnknownOption(GateReturn);

/** Any returned object, to tell one with no keys. */
const decodeAnyObject = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, Schema.Unknown)
);

const isString = Schema.is(Schema.String);

/** What Executor echoes for a script that returned `null` or `{}`. */
const NOTHING_ECHOED = new Set(["{}", "null"]);

/**
 * What a gated script's run handed back: the state to keep and the prompt
 * for the model, read from `structured` before `text`, because Executor may
 * echo a returned object into `text` too. A `{state}` object without a
 * `prompt`, or with a null one, asks for no run, and so do `null` and an
 * object with no keys (JSON drops a `prompt: undefined`). Any other
 * structured value is the prompt when there is no text: a string as it is,
 * anything else as JSON.
 */
const gateOf = (outcome: Extract<ExecutionOutcome, { kind: "ok" }>) => {
  const { structured } = outcome;
  const returned = Option.getOrUndefined(decodeGateReturn(structured));
  const state =
    returned?.state === undefined ? undefined : JSON.stringify(returned.state);
  const asked = returned?.prompt;
  if (asked !== undefined && asked !== null) {
    return { prompt: asked.trim(), state };
  }
  // JSON drops a `prompt: undefined`, which leaves an object with no keys.
  const nothing =
    structured === null ||
    Option.exists(
      decodeAnyObject(structured),
      (object) => Object.keys(object).length === 0
    );
  const text = outcome.text.trim();
  if (
    state !== undefined ||
    asked === null ||
    nothing ||
    NOTHING_ECHOED.has(text)
  ) {
    return { prompt: "", state };
  }
  if (text.length > 0 || structured === undefined) {
    return { prompt: text, state };
  }
  const prompt = isString(structured)
    ? structured.trim()
    : JSON.stringify(structured);
  return { prompt, state };
};

/**
 * A gated script (a script task that keeps a conversation): Executor runs it
 * with no model, and only when it hands back a prompt does the model run on
 * it, in the task's own session or its chat's. Its output is never
 * prettified or sent as it is: the run's answer is the report. Empty output,
 * `TASK_SKIP_OUTPUT` or a state with no prompt is a quiet, successful fire.
 */
const fireGated = async (
  task: TaskEntry,
  deps: RunnerDeps
): Promise<TaskOutcome> => {
  const outcome = await deps.execute(task);
  // Stopped while its script ran (the Stop cannot reach Executor): whatever
  // the script handed back is dropped, its state with it, as a Stop during
  // the prompt run would end the fire.
  const stop = deps.stopped?.();
  if (stop !== undefined) {
    return {
      ...FAILED_RUN[stop](task),
      gated: true,
    };
  }
  if (outcome.kind === "failed") {
    return { ...failure(task, outcome.message), gated: true };
  }
  if (outcome.kind === "paused") {
    return {
      gated: true,
      status: "paused",
      text: titled(task, pausedNotice(outcome)),
    };
  }
  const { prompt, state } = gateOf(outcome);
  // `undefined` itself has no JSON; a returned `state: undefined` keeps none.
  const scriptState = state === undefined ? {} : { scriptState: state };
  const room = stateRoom(task, outcome);
  if (state !== undefined && state.length > room) {
    return {
      ...failure(
        task,
        `the script's state is over ${Math.max(room, 0)} characters`
      ),
      gated: true,
    };
  }
  if (prompt.length === 0 || prompt === TASK_SKIP_OUTPUT) {
    return { ...scriptState, gated: true, status: "ok", text: "" };
  }
  if (prompt.length > GATED_PROMPT_MAX_CHARS) {
    return {
      ...failure(
        task,
        `the script's prompt is over ${GATED_PROMPT_MAX_CHARS} characters`
      ),
      gated: true,
    };
  }
  return {
    ...(await firePrompt(task, deps, prompt)),
    ...scriptState,
    gated: true,
  };
};

/** Fire one task, whatever its type, and report what to send and to store. */
export const fireTask = async (
  task: TaskEntry,
  deps: RunnerDeps
): Promise<TaskOutcome> => {
  if (task.type === "prompt") {
    return await firePrompt(task, deps);
  }
  return task.sessionMode === undefined
    ? await fireScript(task, deps)
    : await fireGated(task, deps);
};
