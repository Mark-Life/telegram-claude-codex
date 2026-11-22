import type { ReminderEntry } from "@workspace/db";
import { InlineKeyboard } from "grammy";

import { t } from "../i18n";
import { truncate } from "../telegram/format";

export const REMINDER_PAGE_SIZE = 10;
const ITEM_TEXT_LIMIT = 280;
const TARGET_HOUR = 9;
const CONVERSION_PASSES = 3;

/** `homeTz` is the home zone (`readHomeTz`): a reminder in it carries no zone label. */
export const formatDue = (
  reminder: ReminderEntry,
  homeTz: string,
  now = Date.now()
) => {
  if (reminder.dueAt === undefined) {
    return t().reminders.noDue;
  }
  const local = new Intl.DateTimeFormat(t().dateLocale, {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: reminder.timezone,
    year: "numeric",
  }).format(reminder.dueAt);
  const zone = reminder.timezone === homeTz ? "" : ` (${reminder.timezone})`;
  const overdue = reminder.dueAt < now ? ` · ${t().reminders.overdue}` : "";
  return `${local}${zone}${overdue}`;
};

export const reminderButtons = (id: number) =>
  new InlineKeyboard()
    .text(`✅ ${t().reminders.buttons.done}`, `remdone:${id}`)
    .text(`⏰ ${t().reminders.buttons.postpone}`, `rempostpone:${id}`);

/**
 * Every snooze a reminder offers. The buttons and the pattern that accepts a
 * press (`handlers/reminders.ts`) both read it, so the two cannot drift.
 */
export const SNOOZE_CHOICES = [
  { label: "min15", minutes: 15 },
  { label: "min30", minutes: 30 },
  { label: "hour1", minutes: 60 },
  { label: "hours4", minutes: 240 },
  { label: "hours8", minutes: 480 },
  { label: "day", minutes: 1440 },
] as const satisfies readonly {
  label: keyof ReturnType<typeof t>["reminders"]["snooze"];
  minutes: number;
}[];

const SNOOZE_COLUMNS = 2;

export const postponeButtons = (id: number) => {
  const copy = t().reminders.snooze;
  const buttons = [
    ...SNOOZE_CHOICES.map((choice) =>
      InlineKeyboard.text(
        copy[choice.label],
        `remsnooze:${choice.minutes}:${id}`
      )
    ),
    InlineKeyboard.text(copy.other, `remcustom:${id}`),
  ];
  return new InlineKeyboard([buttons]).toFlowed(SNOOZE_COLUMNS);
};

export const pageButtons = (input: { page: number; pages: number }) => {
  const keyboard = new InlineKeyboard();
  if (input.page > 0) {
    keyboard.text(`← ${t().reminders.back}`, `rempage:${input.page - 1}`);
  }
  if (input.page + 1 < input.pages) {
    keyboard.text(`${t().reminders.next} →`, `rempage:${input.page + 1}`);
  }
  return keyboard;
};

export const formatReminderPage = (input: {
  homeTz: string;
  page: number;
  reminders: readonly ReminderEntry[];
  total: number;
}) => {
  const pages = Math.max(1, Math.ceil(input.total / REMINDER_PAGE_SIZE));
  const copy = t().reminders.page;
  const heading = copy.heading(input.total);
  if (input.reminders.length === 0) {
    return `${heading}\n\n${input.total === 0 ? copy.empty : copy.emptyPage}`;
  }
  const items = input.reminders.map(
    (reminder, index) =>
      `${index + 1}. #${reminder.id} · ${formatDue(reminder, input.homeTz)}\n${truncate(reminder.text, ITEM_TEXT_LIMIT)}`
  );
  return `${heading}\n${copy.pageOf({ page: input.page + 1, pages })}\n\n${items.join("\n\n")}`;
};

interface LocalParts {
  day: number;
  hour: number;
  minute: number;
  month: number;
  second: number;
  year: number;
}

const partsAt = (at: number, timezone: string): LocalParts => {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    month: value("month"),
    second: value("second"),
    year: value("year"),
  };
};

/** Tomorrow at 09:00 in a reminder's own timezone, DST included. */
export const tomorrowAtNine = (now: number, timezone: string) => {
  const local = partsAt(now, timezone);
  const tomorrow = new Date(
    Date.UTC(local.year, local.month - 1, local.day + 1)
  );
  const targetUtc = Date.UTC(
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth(),
    tomorrow.getUTCDate(),
    TARGET_HOUR
  );
  let guess = targetUtc;
  for (let pass = 0; pass < CONVERSION_PASSES; pass += 1) {
    const represented = partsAt(guess, timezone);
    const representedUtc = Date.UTC(
      represented.year,
      represented.month - 1,
      represented.day,
      represented.hour,
      represented.minute,
      represented.second
    );
    guess += targetUtc - representedUtc;
  }
  return guess;
};
