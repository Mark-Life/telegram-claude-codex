import { judgeReminderIntent } from "@workspace/agent";
import { Effect, Option } from "effect";

import { runtime } from "../runtime";
import { recordJudgment } from "./judge-event";

/**
 * Promise-facing bridge to the reminder-intent judge. It is asked only where
 * the keyword scan found nothing, and any failure answers false, so the scan
 * decides alone whenever this cannot.
 */

const judge = (input: { text: string; userId: number }) =>
  Effect.gen(function* judgeIntent() {
    const [elapsed, verdict] = yield* Effect.timed(
      judgeReminderIntent(input.text)
    );
    if (Option.isNone(verdict)) {
      return false;
    }
    yield* recordJudgment({
      chatKind: null,
      decision: verdict.value.wanted,
      elapsed,
      inputTokens: verdict.value.inputTokens,
      kind: "reminder_intent",
      model: verdict.value.model,
      probability: verdict.value.probability,
      subjectId: null,
      userId: input.userId,
      via: "typesafe",
    });
    return verdict.value.wanted;
  });

/** Whether the message asks for a reminder the keyword scan did not name. */
export const asksForReminder = async (input: {
  text: string;
  userId: number;
}) => {
  try {
    return await runtime.runPromise(judge(input));
  } catch {
    // swallow: the judge never fails, so this is the runtime going away
    return false;
  }
};
