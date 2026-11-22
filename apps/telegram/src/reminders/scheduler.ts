import type { ReminderEntry } from "@workspace/db";
import { Effect, Schedule } from "effect";

import {
  claimDueReminders,
  markReminderNotified,
  nameTopic,
  releaseReminderClaim,
  setReminderDestination,
} from "../db/bridge";
import type { HandlerDeps } from "../handlers/deps";
import { logRejection } from "../handlers/helpers";
import { workspaceChatId } from "../handlers/workspace";
import { t } from "../i18n";
import { logError, logWarning } from "../log";
import { TelegramBotError, sendTo, tg } from "../telegram/bridge";
import type { Route } from "../telegram/route";
import { reminderButtons } from "./format";

export const REMINDER_POLL_INTERVAL_MS = 30_000;
const MINUTE_MS = 60_000;
const UNANSWERED_REPEAT_MINUTES = 30;
const UNANSWERED_REPEAT_MS = UNANSWERED_REPEAT_MINUTES * MINUTE_MS;
const CLAIM_LEASE_MINUTES = 5;
const CLAIM_LEASE_MS = CLAIM_LEASE_MINUTES * MINUTE_MS;
const CLAIM_BATCH_SIZE = 20;
const TOPIC_TITLE_MAX = 128;
const graphemes = new Intl.Segmenter("ru", { granularity: "grapheme" });

const topicTitle = (reminder: ReminderEntry) => {
  const compact = reminder.text.trim().replaceAll(/\s+/gu, " ");
  const title = `⏰ ${compact}`;
  return Array.from(graphemes.segment(title), (part) => part.segment)
    .slice(0, TOPIC_TITLE_MAX)
    .join("");
};

const notificationText = (reminder: ReminderEntry) =>
  `⏰ ${t().reminders.notification(reminder.id)}\n\n${reminder.text}`;

/** Deliver due reminders to the immutable owner, creating one topic per row. */
export const createReminderScheduler = (deps: HandlerDeps) => {
  // In the catch blocks below a TelegramBotError is printed without its object:
  // TelegramBot has already logged it once with its label, reason and code.
  const destinationFor = async (reminder: ReminderEntry): Promise<Route> => {
    if (reminder.chatId !== undefined) {
      return { chatId: reminder.chatId, threadId: reminder.threadId ?? null };
    }
    const workspace = await workspaceChatId();
    if (workspace !== undefined) {
      try {
        const topic = await tg(
          "createForumTopic",
          async (api) =>
            await api.createForumTopic(workspace, topicTitle(reminder))
        );
        await setReminderDestination({
          chatId: workspace,
          id: reminder.id,
          threadId: topic.message_thread_id,
        });
        // A reply in the topic starts a session there; `/history` names it.
        await nameTopic({
          chatId: workspace,
          source: "bot",
          threadId: topic.message_thread_id,
          title: topic.name,
        }).catch(logRejection(`reminder ${reminder.id}: topic name not kept`));
        return { chatId: workspace, threadId: topic.message_thread_id };
      } catch (error) {
        logWarning(
          `reminder ${reminder.id}: could not create topic`,
          error instanceof TelegramBotError ? undefined : error
        );
        await setReminderDestination({ chatId: workspace, id: reminder.id });
        return { chatId: workspace, threadId: null };
      }
    }
    await setReminderDestination({ chatId: deps.ownerId, id: reminder.id });
    return { chatId: deps.ownerId, threadId: null };
  };

  const send = async (reminder: ReminderEntry) => {
    const destination = await destinationFor(reminder);
    const other = { reply_markup: reminderButtons(reminder.id) };
    try {
      return await sendTo(destination, notificationText(reminder), other);
    } catch (error) {
      if (destination.chatId === deps.ownerId) {
        throw error;
      }
      logWarning(
        `reminder ${reminder.id}: workspace delivery failed, using owner chat`,
        error instanceof TelegramBotError ? undefined : error
      );
      await setReminderDestination({ chatId: deps.ownerId, id: reminder.id });
      return await sendTo(
        { chatId: deps.ownerId, threadId: null },
        notificationText(reminder),
        other
      );
    }
  };

  const runTick = async () => {
    const now = Date.now();
    const due = await claimDueReminders({
      leaseUntil: now + CLAIM_LEASE_MS,
      limit: CLAIM_BATCH_SIZE,
      now,
      repeatBefore: now - UNANSWERED_REPEAT_MS,
    });
    for (const reminder of due) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- delivery order follows due time
        const message = await send(reminder);
        // oxlint-disable-next-line no-await-in-loop -- the lease is released in the same order
        await markReminderNotified({
          at: Date.now(),
          id: reminder.id,
          messageId: message.message_id,
        });
      } catch (error) {
        logError(
          `reminder ${reminder.id} delivery failed`,
          error instanceof TelegramBotError ? undefined : error
        );
        // oxlint-disable-next-line no-await-in-loop -- give the lease back before the next reminder
        await releaseReminderClaim(reminder.id);
      }
    }
  };

  /**
   * One delivery pass. It is pending work, so a shutdown that stops the loop
   * still waits for it.
   */
  const tick = deps.pendingWork
    .run(Effect.tryPromise(runTick).pipe(Effect.withSpan("Reminder.pass")))
    .pipe(
      Effect.catch((error) =>
        Effect.logError("reminder scheduler tick failed", error)
      )
    );

  /**
   * Poll now and then at a fixed rate until the scope closes. A pass that
   * overruns the interval is followed at once; missed polls are not replayed.
   */
  const start = tick.pipe(
    Effect.repeat(Schedule.fixed(REMINDER_POLL_INTERVAL_MS)),
    Effect.forkScoped,
    Effect.asVoid
  );

  return { start } as const;
};
