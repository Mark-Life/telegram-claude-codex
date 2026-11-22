import {
  BotApi,
  CurrentPrincipal,
  InvalidInput,
  NotFound,
} from "@workspace/api";
import type { Reminder } from "@workspace/api";
import { checkZone, ReminderService } from "@workspace/db";
import type {
  ReminderDue,
  ReminderEntry,
  ReminderRefused,
} from "@workspace/db";
import { AppConfig } from "@workspace/env/bot";
import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { canManageTasks } from "../access/tier";
import { closeReminderTopic } from "../handlers/reminders";
import { readHomeTz } from "../reminders/home-tz";
import { field, isoOf, operatorOnly, optionalIso } from "./views";

/**
 * Reminders over HTTP: a door over `ReminderService`, as the reminder
 * buttons and the reminders CLI are. The reminder scheduler polls the table,
 * so a new or moved reminder needs no reload.
 */

/** A reminder as the API shows it. */
export const reminderView = (reminder: ReminderEntry): Reminder => ({
  ...field("acknowledgedAt", optionalIso(reminder.acknowledgedAt)),
  ...field("chatId", reminder.chatId),
  createdAt: isoOf(reminder.createdAt),
  ...field("dueAt", optionalIso(reminder.dueAt)),
  id: reminder.id,
  ...field("notifiedAt", optionalIso(reminder.notifiedAt)),
  text: reminder.text,
  ...field("threadId", reminder.threadId),
  timezone: reminder.timezone,
});

const missing = (id: number) => new NotFound({ message: `No reminder ${id}.` });

const invalidInput = (message: string) =>
  Effect.fail(new InvalidInput({ message }));

/** A refusal other than `missing` as `InvalidInput`, in the API's field names. */
const invalid = (
  error: ReminderRefused
): Effect.Effect<never, InvalidInput> => {
  const value = error.value ?? "";
  switch (error.reason) {
    case "missing": {
      // Only a write to an existing reminder can miss it; `refusal` answers that.
      return Effect.die(error);
    }
    case "badDate": {
      return invalidInput(
        `Invalid calendar date: ${value}. Use YYYY-MM-DD, today or tomorrow.`
      );
    }
    case "badInstant": {
      return invalidInput(`Invalid \`at\`: ${value}.`);
    }
    case "badZone": {
      return invalidInput(`Unknown IANA timezone: ${value}.`);
    }
    case "dateAndRange": {
      return invalidInput("Use `date` or `from`/`to`, not both.");
    }
    case "emptyText": {
      return invalidInput("`text` cannot be empty.");
    }
    case "instantNeedsOffset": {
      return invalidInput(
        "`at` must include Z or an explicit UTC offset, for example 2026-09-08T09:00:00+03:00."
      );
    }
    default: {
      return invalidInput(error.reason);
    }
  }
};

/** A refusal of a write to reminder `id`, `missing` included. */
const refusal =
  (id: number) =>
  (error: ReminderRefused): Effect.Effect<never, InvalidInput | NotFound> =>
    error.reason === "missing" ? Effect.fail(missing(id)) : invalid(error);

/** An `at` value as the service reads it; absent when it is. */
const isoDue = (at: string | undefined): ReminderDue | undefined =>
  at === undefined ? undefined : { kind: "iso", text: at };

export const RemindersLive = HttpApiBuilder.group(
  BotApi,
  "reminders",
  Effect.fnUntraced(function* (handlers) {
    const reminders = yield* ReminderService;
    const { defaultTz } = yield* AppConfig;

    /** Reminders are shared operational state: owner and executors only. */
    const operator = Effect.gen(function* () {
      const principal = yield* CurrentPrincipal;
      yield* operatorOnly(canManageTasks(principal.tier), "reminders");
    });

    /** The zone asked for, else the owner's home zone, as /reminders reads it. */
    const zoneOf = (tz: string | undefined) =>
      tz === undefined
        ? Effect.promise(async () => await readHomeTz(defaultTz))
        : checkZone(tz).pipe(Effect.catchTag("ReminderRefused", invalid));

    /** Complete a reminder and close its topic; NotFound when there is none. */
    const complete = (id: number) =>
      reminders.complete({ closeTopic: closeReminderTopic, id }).pipe(
        Effect.orDie,
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(missing(id)),
            onSome: Effect.succeed,
          })
        )
      );

    return handlers
      .handle("list", ({ query }) =>
        Effect.gen(function* () {
          yield* operator;
          const timezone = yield* zoneOf(query.tz);
          const window = yield* reminders
            .dueWindow({
              date: query.date,
              from: query.from,
              timezone,
              to: query.to,
            })
            .pipe(Effect.catchTag("ReminderRefused", invalid));
          const rows = yield* reminders.list(window).pipe(Effect.orDie);
          return { reminders: rows.map(reminderView), timezone };
        })
      )
      .handle("create", ({ payload }) =>
        Effect.gen(function* () {
          yield* operator;
          const timezone = yield* zoneOf(payload.tz);
          const created = yield* reminders
            .create({ due: isoDue(payload.at), text: payload.text, timezone })
            .pipe(
              Effect.catchTag("ReminderRefused", invalid),
              Effect.catchTag("PersistenceError", Effect.die)
            );
          return reminderView(created);
        })
      )
      .handle("update", ({ params, payload }) =>
        Effect.gen(function* () {
          yield* operator;
          const id = Number(params.reminderId);
          const { after } = yield* reminders
            .update({
              due: payload.at === null ? null : isoDue(payload.at),
              id,
              text: payload.text,
              timezone: payload.tz,
            })
            .pipe(
              Effect.catchTag("ReminderRefused", refusal(id)),
              Effect.catchTag("PersistenceError", Effect.die)
            );
          // Completed between the read and the write: it is gone.
          if (Option.isNone(after)) {
            return yield* missing(id);
          }
          return reminderView(after.value);
        })
      )
      .handle("complete", ({ params }) =>
        Effect.gen(function* () {
          yield* operator;
          return reminderView(yield* complete(Number(params.reminderId)));
        })
      )
      .handle("delete", ({ params }) =>
        Effect.gen(function* () {
          yield* operator;
          yield* complete(Number(params.reminderId));
        })
      );
  })
);
