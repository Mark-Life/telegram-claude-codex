import { noul } from "@typesafe-ai/sdk";
import type { SystemOneResult } from "@typesafe-ai/sdk";
import { Effect, Option } from "effect";

import { askJev, JEV_MODEL } from "./typesafe";

/**
 * Does this message ask for a reminder? A keyword scan catches the word itself
 * and misses everything else — "set it for 15:00 so I don't forget" leaves the
 * run without the reminders CLI, so it answers in chat and stores nothing.
 * This runs only where the scan missed, and a false yes costs a few lines of
 * prompt.
 */

/** Per attempt. This sits inline, before the run is even registered. */
const REMINDER_INTENT_TIMEOUT_MS = 1200;

/** Total budget. No room for a second attempt, so `retries` is 0. */
const REMINDER_INTENT_BUDGET_MS = 1500;

/**
 * At or above this the message is treated as a reminder request. Measured on
 * Russian cases the keyword scan misses: real requests scored 0.85 and up, and
 * the highest non-request ("add a meeting to the calendar tomorrow at 10") scored
 * 0.41. The bar sits between them, low in the gap — a false yes only adds a
 * few lines to the prompt.
 */
export const REMINDER_INTENT_YES = 0.6;

/** One chat message; the tail of a long one adds nothing to the judgment. */
const REMINDER_TEXT_CAP = 1000;

const buildReminderState = (text: string) => ({
  message: text.slice(0, REMINDER_TEXT_CAP),
});

const INSTRUCTIONS =
  "Does `message` ask for a reminder at a future time — to create one, move it, cancel it, or mark it done?";

const YES = [
  "The message asks to be reminded, alerted or pinged at a time, a date, or after an interval (`at 3 pm`, `tomorrow morning`, `in an hour`, `on Monday`).",
  "The message asks to move, cancel or complete a reminder that already exists, even without naming a time.",
  "The request is for a future notification even when the word for reminder is never used (`don't let me forget the call at three`).",
  "Voice transcripts arrive unpunctuated and with recognition errors — judge the meaning, not the wording.",
];

const NO = [
  "The message asks for work to be done now, or asks a question.",
  "A time is mentioned only as context (`the meeting was at three`, `I landed yesterday`).",
  "The message asks about the calendar or the schedule without asking to be notified.",
  "The message asks for recurring scheduled work rather than one notification.",
];

/** The one question code reads. */
const reminderQuestions = () => ({
  wants_reminder: noul(INSTRUCTIONS, { false: NO, true: YES }),
});

/** The request as it is sent, so a calibration script measures this question. */
export const reminderIntentRequest = (text: string) => ({
  model: JEV_MODEL,
  questions: reminderQuestions(),
  state: buildReminderState(text),
});

const verdictOf = (
  result: SystemOneResult<ReturnType<typeof reminderQuestions>>
) => {
  const probability = result.answers.wants_reminder.noul;
  return {
    inputTokens: result.usage.input_tokens,
    model: result.model,
    probability,
    wanted: probability >= REMINDER_INTENT_YES,
  };
};

/** What the judge reports when it answered at all. */
export type ReminderIntent = ReturnType<typeof verdictOf>;

/** `Option.none` means no key or no answer in budget; the caller keeps the scan's result. */
export const judgeReminderIntent = (text: string) =>
  Effect.map(
    askJev(reminderIntentRequest(text), {
      budgetMs: REMINDER_INTENT_BUDGET_MS,
      retries: 0,
      span: "judge.reminder-intent",
      timeoutMs: REMINDER_INTENT_TIMEOUT_MS,
    }),
    Option.map(verdictOf)
  );
