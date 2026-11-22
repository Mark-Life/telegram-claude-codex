import { Schema } from "effect";

/**
 * How a fire that produced no report ended, for the outcome it becomes:
 * `error` a failed run, `busy` no working slot was free, `full` no waiting
 * slot was free for its background work, `expired` its wait ran past the
 * idle cap, `stopped` the owner pressed Stop, `replaced` the task was
 * deleted or paused, `cut` the restart cut it while it waited (it resumes at
 * boot), `gone` the boot's fire found nothing left to continue and ran
 * nothing.
 */
export const TaskRunEndSchema = Schema.Literals([
  "busy",
  "cut",
  "error",
  "expired",
  "full",
  "gone",
  "replaced",
  "stopped",
]);

export type TaskRunEnd = typeof TaskRunEndSchema.Type;

/**
 * A scheduled run ended with no report to deliver. A missing `end` is
 * `error`. Its own module, so the runner reads it without the app behind
 * `prompt-run.ts`.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- a class factory, not a throw
export class TaskRunFailed extends Schema.TaggedError<TaskRunFailed>()(
  "TaskRunFailed",
  { end: Schema.optional(TaskRunEndSchema), message: Schema.String }
) {}
