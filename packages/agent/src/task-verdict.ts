import { noul } from "@typesafe-ai/sdk";
import type { SystemOneResult } from "@typesafe-ai/sdk";
import { Effect, Option } from "effect";

import { askJev, JEV_MODEL } from "./typesafe";

/**
 * Did a recurring task actually do its work? A prompt task that says "could not
 * log in to the mailbox, the token expired" is stored and delivered as a success today,
 * because nothing reads the prose. This asks Jev for the probability that the
 * answer reports real work, and the caller turns a low one into one notice.
 * Notify only: no status, retry or delivery depends on it.
 */

/** Per attempt. A task answer is long, so it gets more room than the address judge. */
const TASK_VERDICT_TIMEOUT_MS = 4000;

/** Total budget, one retry included. Runs after the report is delivered. */
const TASK_VERDICT_BUDGET_MS = 8000;

/**
 * Below this the answer is treated as "the work did not happen". Measured on
 * Russian reports: real results, "nothing new" and partial answers scored
 * 0.85 and up, every prose failure and refusal scored 0.03 or less. The bar
 * sits low in that gap — silence is the safe answer.
 */
export const TASK_INCOMPLETE_BELOW = 0.2;

/** State stays far inside the 32k limit; a report can be long. */
const FIELD_CAP = 4000;

/** The answer as the owner received it, against the instruction it came from. */
export interface TaskVerdictArgs {
  answer: string;
  instruction: string;
  title: string;
}

const buildTaskState = ({ answer, instruction, title }: TaskVerdictArgs) => ({
  answer: answer.slice(0, FIELD_CAP),
  task: { instruction: instruction.slice(0, FIELD_CAP), title },
});

const INSTRUCTIONS =
  "Does `answer` show that the work described in `task.instruction` was actually carried out?";

const YES = [
  "The answer reports the result of the work: data, findings, what was done, or a summary of what was checked.",
  "An answer that checked and correctly reports nothing to report — no new mail, no changes, an empty list, nothing happened — is still completed work.",
  "Partial results count when the answer does not say the work failed.",
];

const NO = [
  "The answer says the work could not be done: no access, an expired or invalid token, a login required, a missing file or missing input, a site or tool unavailable.",
  "The answer refuses, asks the user to do something first, or asks for confirmation instead of doing the work.",
  "The answer only describes what it would do, or reports an internal error, instead of reporting a result.",
];

/** The one question code reads. */
const taskQuestions = () => ({
  work_completed: noul(INSTRUCTIONS, { false: NO, true: YES }),
});

/** The request as it is sent, so a calibration script measures this question. */
export const taskVerdictRequest = (args: TaskVerdictArgs) => ({
  model: JEV_MODEL,
  questions: taskQuestions(),
  state: buildTaskState(args),
});

const verdictOf = (
  result: SystemOneResult<ReturnType<typeof taskQuestions>>
) => {
  const probability = result.answers.work_completed.noul;
  return {
    completed: probability >= TASK_INCOMPLETE_BELOW,
    inputTokens: result.usage.input_tokens,
    model: result.model,
    probability,
  };
};

/** What the judge reports when it answered at all. */
export type TaskVerdict = ReturnType<typeof verdictOf>;

/** `Option.none` means no key or no answer in budget: say nothing. */
export const judgeTaskCompleted = (args: TaskVerdictArgs) =>
  args.answer.trim().length === 0
    ? Effect.succeed(Option.none<TaskVerdict>())
    : Effect.map(
        askJev(taskVerdictRequest(args), {
          budgetMs: TASK_VERDICT_BUDGET_MS,
          retries: 1,
          span: "judge.task-completed",
          timeoutMs: TASK_VERDICT_TIMEOUT_MS,
        }),
        Option.map(verdictOf)
      );
