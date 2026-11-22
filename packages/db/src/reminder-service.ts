import { Clock, Context, Effect, Layer, Option, Schema } from "effect";

import { isValidTimeZone } from "./cron";
import { RemindersRepo } from "./reminders";
import type { ReminderEntry, ReminderListFilter } from "./reminders";
import { SettingsRepo } from "./settings";

/**
 * The rules every door that writes a reminder obeys: the reminders CLI a run
 * drives, the reminder buttons and the HTTP API. Instants come in as epoch
 * milliseconds or as ISO-8601 with an explicit offset; calendar filters are
 * local dates in a zone. A door parses its own input and words a refusal its
 * own way.
 */

const ISO_INSTANT_RE = /(?:Z|[+-]\d{2}:\d{2})$/u;
const DATE_RE = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const SECOND_MS = 1000;
const DATE_PAD = 2;
const YEAR_PAD = 4;
const CONVERSION_PASSES = 3;

/** Every reason a reminder write or filter is refused. */
export const REMINDER_REFUSALS = [
  /** No reminder with that id. */
  "missing",
  /** An empty text. */
  "emptyText",
  /** A zone this runtime does not know (`value`). */
  "badZone",
  /** An instant without `Z` or an explicit offset. */
  "instantNeedsOffset",
  /** An instant that does not parse (`value`). */
  "badInstant",
  /** A calendar date that does not exist (`value`). */
  "badDate",
  /** A single day and a range together. */
  "dateAndRange",
] as const;

export type ReminderRefusalReason = (typeof REMINDER_REFUSALS)[number];

/** A reminder write or filter the rules refuse. */
// oxlint-disable-next-line unicorn/throw-new-error -- a class factory, not a throw
export class ReminderRefused extends Schema.TaggedError<ReminderRefused>()(
  "ReminderRefused",
  {
    reason: Schema.Literals(REMINDER_REFUSALS),
    value: Schema.optional(Schema.String),
  }
) {}

const refused = (reason: ReminderRefusalReason, value?: string) =>
  Effect.fail(
    new ReminderRefused(value === undefined ? { reason } : { reason, value })
  );

/**
 * A due time as a door hands it over: an `instant` in epoch milliseconds, or
 * `iso` text in ISO-8601 that names `Z` or an offset (a bare local time is
 * ambiguous and refused).
 */
export type ReminderDue =
  | { readonly at: number; readonly kind: "instant" }
  | { readonly kind: "iso"; readonly text: string };

/** A due time in epoch milliseconds. */
export const parseInstant = (
  due: ReminderDue
): Effect.Effect<number, ReminderRefused> => {
  if (due.kind === "instant") {
    return Number.isFinite(due.at)
      ? Effect.succeed(due.at)
      : refused("badInstant", String(due.at));
  }
  if (!ISO_INSTANT_RE.test(due.text)) {
    return refused("instantNeedsOffset", due.text);
  }
  const value = Date.parse(due.text);
  return Number.isFinite(value)
    ? Effect.succeed(value)
    : refused("badInstant", due.text);
};

/** A zone this runtime knows, or `badZone`. */
export const checkZone = (
  zone: string
): Effect.Effect<string, ReminderRefused> =>
  isValidTimeZone(zone) ? Effect.succeed(zone) : refused("badZone", zone);

/** A non-empty trimmed text, or `emptyText`. */
const checkText = (text: string) => {
  const trimmed = text.trim();
  return trimmed.length === 0 ? refused("emptyText") : Effect.succeed(trimmed);
};

interface DateParts {
  day: number;
  month: number;
  year: number;
}

const localDateParts = (at: number, timezone: string): DateParts => {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? "");
  return { day: value("day"), month: value("month"), year: value("year") };
};

const dateKey = (parts: DateParts) =>
  `${String(parts.year).padStart(YEAR_PAD, "0")}-${String(parts.month).padStart(DATE_PAD, "0")}-${String(parts.day).padStart(DATE_PAD, "0")}`;

const parseDate = (raw: string) => {
  const groups = DATE_RE.exec(raw)?.groups;
  if (groups === undefined) {
    return refused("badDate", raw);
  }
  const parts = {
    day: Number(groups.day),
    month: Number(groups.month),
    year: Number(groups.year),
  };
  const check = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return check.getUTCFullYear() === parts.year &&
    check.getUTCMonth() + 1 === parts.month &&
    check.getUTCDate() === parts.day
    ? Effect.succeed(parts)
    : refused("badDate", raw);
};

const shiftDate = Effect.fn(function* shiftDate(raw: string, days: number) {
  const parsed = yield* parseDate(raw);
  const shifted = new Date(
    Date.UTC(parsed.year, parsed.month - 1, parsed.day) + days * DAY_MS
  );
  return dateKey({
    day: shifted.getUTCDate(),
    month: shifted.getUTCMonth() + 1,
    year: shifted.getUTCFullYear(),
  });
});

/** Convert a local midnight to an instant, including non-whole-hour offsets. */
const localMidnight = Effect.fn(function* localMidnight(
  raw: string,
  timezone: string
) {
  const target = yield* parseDate(raw);
  const targetUtc = Date.UTC(target.year, target.month - 1, target.day);
  let guess = targetUtc;
  for (let pass = 0; pass < CONVERSION_PASSES; pass += 1) {
    const local = localDateParts(guess, timezone);
    const represented = Date.UTC(local.year, local.month - 1, local.day);
    const time = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      second: "2-digit",
      timeZone: timezone,
    }).formatToParts(guess);
    const numberPart = (type: Intl.DateTimeFormatPartTypes) =>
      Number(time.find((part) => part.type === type)?.value ?? "0");
    const representedWithTime =
      represented +
      numberPart("hour") * HOUR_MS +
      numberPart("minute") * MINUTE_MS +
      numberPart("second") * SECOND_MS;
    guess += targetUtc - representedWithTime;
  }
  return guess;
});

/** `today` and `tomorrow` in `timezone`, else the date as given. */
const resolveRelativeDate = Effect.fn(function* resolveRelativeDate(
  raw: string,
  timezone: string
) {
  const today = dateKey(
    localDateParts(yield* Clock.currentTimeMillis, timezone)
  );
  if (raw === "today") {
    return today;
  }
  return raw === "tomorrow" ? yield* shiftDate(today, 1) : raw;
});

/** A range bound as an instant; absent when the bound is. */
const optionalBound = Effect.fn(function* optionalBound(
  raw: string | undefined,
  timezone: string
) {
  if (raw === undefined) {
    return Option.none<number>();
  }
  const date = yield* resolveRelativeDate(raw, timezone);
  return Option.some(yield* localMidnight(date, timezone));
});

/**
 * A due-date window from local calendar dates in `timezone`: one `date`
 * (`YYYY-MM-DD`, `today` or `tomorrow`) or a `from`/`to` range, each end a
 * local midnight, `to` exclusive. Nothing given is no window.
 */
export const dueWindow = Effect.fn("ReminderService.dueWindow")(
  function* dueWindow(input: {
    readonly date?: string;
    readonly from?: string;
    readonly timezone: string;
    readonly to?: string;
  }) {
    const { date, from, timezone, to } = input;
    if (date !== undefined && (from !== undefined || to !== undefined)) {
      return yield* refused("dateAndRange");
    }
    if (date !== undefined) {
      const startDate = yield* resolveRelativeDate(date, timezone);
      const endDate = yield* shiftDate(startDate, 1);
      const window: ReminderListFilter = {
        dueFrom: yield* localMidnight(startDate, timezone),
        dueTo: yield* localMidnight(endDate, timezone),
      };
      return window;
    }
    const window: ReminderListFilter = {
      dueFrom: Option.getOrUndefined(yield* optionalBound(from, timezone)),
      dueTo: Option.getOrUndefined(yield* optionalBound(to, timezone)),
    };
    return window;
  }
);

/** Where a reminder's topic is, for the port that closes it. */
export interface ReminderTopic {
  readonly chatId: number;
  readonly threadId: number;
}

const makeService = Effect.gen(function* makeReminderService() {
  const reminders = yield* RemindersRepo;
  const settings = yield* SettingsRepo;

  /**
   * The owner's home zone from `/settings` (`default_tz`), none when unset or
   * a zone this runtime does not know. A door falls back on `DEFAULT_TZ`.
   */
  const storedHomeZone = Effect.fn("ReminderService.storedHomeZone")(
    function* storedHomeZone() {
      return Option.filter(yield* settings.get("default_tz"), isValidTimeZone);
    }
  );

  /** A new reminder; without `due`, an undated to-do. */
  const create = Effect.fn("ReminderService.create")(function* create(input: {
    readonly due?: ReminderDue;
    readonly text: string;
    readonly timezone: string;
  }) {
    const timezone = yield* checkZone(input.timezone);
    const text = yield* checkText(input.text);
    const dueAt =
      input.due === undefined ? undefined : yield* parseInstant(input.due);
    return yield* reminders.create({ dueAt, text, timezone });
  });

  /**
   * Edit a reminder: `due` null clears its due date. Answers the reminder
   * before the edit and, unless it was completed meanwhile, after it.
   */
  const update = Effect.fn("ReminderService.update")(function* update(input: {
    readonly due?: ReminderDue | null;
    readonly id: number;
    readonly text?: string;
    readonly timezone?: string;
  }) {
    const before = yield* reminders.get(input.id);
    if (Option.isNone(before)) {
      return yield* refused("missing");
    }
    const timezone =
      input.timezone === undefined
        ? undefined
        : yield* checkZone(input.timezone);
    const text =
      input.text === undefined ? undefined : yield* checkText(input.text);
    let dueAt: number | null | undefined;
    if (input.due === null) {
      dueAt = null;
    } else if (input.due !== undefined) {
      dueAt = yield* parseInstant(input.due);
    }
    const after = yield* reminders.update(input.id, { dueAt, text, timezone });
    return { after, before: before.value } as const;
  });

  /**
   * Complete a reminder: the row goes, then its topic is closed through
   * `closeTopic`, best effort (the deletion is what counts). Answers the
   * completed reminder, none when there was none.
   */
  const complete = Effect.fn("ReminderService.complete")(
    function* complete(input: {
      readonly closeTopic: (topic: ReminderTopic) => Effect.Effect<void>;
      readonly id: number;
    }) {
      const found = yield* reminders.get(input.id);
      const removed = yield* reminders.drop(input.id);
      if (!removed || Option.isNone(found)) {
        return Option.none<ReminderEntry>();
      }
      const { chatId, threadId } = found.value;
      if (chatId !== undefined && threadId !== undefined) {
        yield* input.closeTopic({ chatId, threadId });
      }
      return found;
    }
  );

  return {
    complete,
    count: reminders.count,
    create,
    dueWindow,
    get: reminders.get,
    list: reminders.list,
    storedHomeZone,
    update,
  } as const;
});

/**
 * The one way to read and write reminders from a door. Delivery bookkeeping
 * (claims, acknowledgements, where a reminder was sent) stays on
 * `RemindersRepo`, the scheduler's side.
 */
export class ReminderService extends Context.Service<
  ReminderService,
  Effect.Success<typeof makeService>
>()("@workspace/db/ReminderService") {
  static readonly layer = Layer.effect(ReminderService, makeService);
}
