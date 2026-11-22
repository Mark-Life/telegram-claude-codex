import { judgeTaskCompleted } from "@workspace/agent";
import type { TaskEntry } from "@workspace/db";
import { Effect, Option } from "effect";
import type { Tracer } from "effect";

import { underParent } from "../handlers/agent-bridge";
import { recordJudgment } from "../handlers/judge-event";
import { sendToNotifyRoute } from "../handlers/workspace";
import { t } from "../i18n";
import { logWarning } from "../log";
import { runtime } from "../runtime";
import { TelegramBotError } from "../telegram/bridge";

/**
 * The success verdict on a delivered recurring report. It only ever adds one
 * notice: the stored status, the retry and the delivery are decided before this
 * runs and are never revisited, so a wrong verdict costs a message and nothing
 * more.
 */

/** A silent task's answer was never seen, so the notice carries the head of it. */
const ANSWER_CAP = 500;

const headOf = (answer: string) =>
  answer.length > ANSWER_CAP ? `${answer.slice(0, ANSWER_CAP)}…` : answer;

const notice = (title: string) => t().tasks.verdictNotice(title);

const judge = (input: { answer: string; ownerId: number; task: TaskEntry }) =>
  Effect.gen(function* judgeTask() {
    const [elapsed, verdict] = yield* Effect.timed(
      judgeTaskCompleted({
        answer: input.answer,
        instruction: input.task.payload,
        title: input.task.title,
      })
    );
    if (Option.isNone(verdict)) {
      return false;
    }
    yield* recordJudgment({
      chatKind: null,
      decision: verdict.value.completed,
      elapsed,
      inputTokens: verdict.value.inputTokens,
      kind: "task_success",
      model: verdict.value.model,
      probability: verdict.value.probability,
      subjectId: input.task.id,
      userId: input.ownerId,
      via: "typesafe",
    });
    return !verdict.value.completed;
  });

/**
 * Notify only, and never throws: a report that says the work could not be done
 * reaches the owner as one plain sentence on the notify route.
 */
export const checkTaskCompleted = async (input: {
  answer: string;
  ownerId: number;
  /** The fire's span, so the judgment joins its trace. */
  parent?: Tracer.AnySpan;
  silent: boolean;
  task: TaskEntry;
}) => {
  let failed = false;
  try {
    failed = await runtime.runPromise(underParent(input.parent)(judge(input)));
  } catch {
    // swallow: the judge never fails, so this is the runtime going away
    return;
  }
  if (!failed) {
    return;
  }
  const head = notice(input.task.title);
  try {
    await sendToNotifyRoute({
      ownerId: input.ownerId,
      text: input.silent ? `${head}\n\n${headOf(input.answer)}` : head,
    });
  } catch (error) {
    // A send that failed for good was already logged by TelegramBot; only a
    // failed read of the notify route is new here.
    if (!(error instanceof TelegramBotError)) {
      logWarning("Task verdict notice not sent", error);
    }
  }
};
