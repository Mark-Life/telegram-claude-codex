import { Schema } from "effect";
import {
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from "effect/http-api";

import { Forbidden, InvalidInput, NotFound } from "../errors";
import { ApiAuth } from "../middleware";
import { IsoTime, pathId } from "./shared";

/**
 * One-off reminders and undated to-dos: the same list as /reminders in
 * Telegram and the bot's reminders CLI, under the same rules.
 */

const Tz = Schema.String.annotate({
  description:
    "An IANA timezone. Absent: the owner's home zone from /settings, else the bot's DEFAULT_TZ.",
  examples: ["Europe/Berlin"],
});

const At = Schema.String.annotate({
  description:
    "When the reminder is due: ISO 8601 with `Z` or an explicit UTC offset. A bare local time is refused as ambiguous.",
  examples: ["2026-09-08T09:00:00+03:00"],
});

const Text = Schema.NonEmptyString.annotate({
  description: "What to remind about.",
});

const CalendarDate = Schema.String.annotate({
  description: "A local calendar date `YYYY-MM-DD`, `today` or `tomorrow`.",
  examples: ["2026-09-08", "today"],
});

/** One reminder as the API shows it. */
export const ReminderSchema = Schema.Struct({
  acknowledgedAt: Schema.optionalKey(
    IsoTime.annotate({
      description: "When someone pressed a button on its delivered message.",
    })
  ),
  chatId: Schema.optionalKey(
    Schema.Int.annotate({
      description: "The chat it was delivered to, once it was.",
    })
  ),
  createdAt: IsoTime,
  dueAt: Schema.optionalKey(
    IsoTime.annotate({
      description: "When it is due; absent for an undated to-do.",
    })
  ),
  id: Schema.Int.annotate({ description: "The reminder's id." }),
  notifiedAt: Schema.optionalKey(
    IsoTime.annotate({ description: "When the bot delivered it." })
  ),
  text: Schema.String,
  threadId: Schema.optionalKey(
    Schema.Int.annotate({
      description: "The topic it was delivered to, once it was.",
    })
  ),
  timezone: Schema.String.annotate({
    description: "The IANA zone its due time is shown in.",
  }),
}).annotate({ identifier: "Reminder" });

export type Reminder = typeof ReminderSchema.Type;

export const ReminderList = Schema.Struct({
  reminders: Schema.Array(ReminderSchema),
  timezone: Schema.String.annotate({
    description: "The zone the calendar filters were read in.",
  }),
}).annotate({ identifier: "ReminderList" });

export const ReminderListQuery = Schema.Struct({
  date: Schema.optionalKey(
    CalendarDate.annotate({
      description:
        "Only reminders due on this local day (`YYYY-MM-DD`, `today` or `tomorrow`). Not together with `from`/`to`.",
    })
  ),
  from: Schema.optionalKey(
    CalendarDate.annotate({
      description: "Only reminders due from this local day's midnight on.",
    })
  ),
  to: Schema.optionalKey(
    CalendarDate.annotate({
      description:
        "Only reminders due before this local day's midnight (exclusive).",
    })
  ),
  tz: Schema.optionalKey(Tz),
});

/** A new reminder. */
export const ReminderCreate = Schema.Struct({
  at: Schema.optionalKey(At),
  text: Text,
  tz: Schema.optionalKey(Tz),
}).annotate({ identifier: "ReminderCreate" });

/** An edit of a reminder: an absent field is left alone. */
export const ReminderUpdate = Schema.Struct({
  at: Schema.optionalKey(
    Schema.NullOr(At).annotate({
      description: "A new due time; `null` makes it an undated to-do.",
    })
  ),
  text: Schema.optionalKey(Text),
  tz: Schema.optionalKey(Tz),
}).annotate({ identifier: "ReminderUpdate" });

const ReminderIdParams = {
  reminderId: pathId("The reminder's id, as `reminders.list` shows it."),
};

export const RemindersGroup = HttpApiGroup.make("reminders")
  .add(
    HttpApiEndpoint.get("list", "/v1/reminders", {
      error: [Forbidden, InvalidInput],
      query: ReminderListQuery,
      success: ReminderList,
    }).annotateMerge(
      OpenApi.annotations({
        description:
          "List reminders.\n\nIn due order, undated to-dos last. `date`, or `from` and `to`, narrow it to local calendar days in `tz`.",
        identifier: "reminders.list",
        summary: "List reminders",
      })
    ),
    HttpApiEndpoint.post("create", "/v1/reminders", {
      error: [Forbidden, InvalidInput],
      payload: ReminderCreate,
      success: ReminderSchema,
    }).annotateMerge(
      OpenApi.annotations({
        description:
          'Create a reminder.\n\nWith `at`, the bot sends it in its own topic when it is due; without, it is an undated to-do on the list. Resolve natural language ("tomorrow at 9") to an instant with an offset first.',
        identifier: "reminders.create",
        summary: "Create a reminder",
      })
    ),
    HttpApiEndpoint.patch("update", "/v1/reminders/:reminderId", {
      error: [Forbidden, InvalidInput, NotFound],
      params: ReminderIdParams,
      payload: ReminderUpdate,
      success: ReminderSchema,
    }).annotateMerge(
      OpenApi.annotations({
        description:
          "Change a reminder.\n\nOnly the fields sent change; a new `at` reschedules it. Answers the reminder as it now stands.",
        identifier: "reminders.update",
        summary: "Change a reminder",
      })
    ),
    HttpApiEndpoint.post("complete", "/v1/reminders/:reminderId/complete", {
      error: [Forbidden, NotFound],
      params: ReminderIdParams,
      success: ReminderSchema,
    }).annotateMerge(
      OpenApi.annotations({
        description:
          "Complete a reminder.\n\nIt leaves the list and its Telegram topic, if it has one, is closed, as the Done button does. Answers the completed reminder.",
        identifier: "reminders.complete",
        summary: "Complete a reminder",
      })
    ),
    HttpApiEndpoint.delete("delete", "/v1/reminders/:reminderId", {
      error: [Forbidden, NotFound],
      params: ReminderIdParams,
      success: HttpApiSchema.NoContent,
    }).annotateMerge(
      OpenApi.annotations({
        description:
          "Delete a reminder.\n\nThe same as `reminders.complete`, as in the bot's CLI: it leaves the list and its topic is closed. Answers nothing.",
        identifier: "reminders.delete",
        summary: "Delete a reminder",
      })
    )
  )
  .middleware(ApiAuth)
  .annotateMerge(
    OpenApi.annotations({
      description:
        "One-off reminders and undated to-dos: the same list and rules as /reminders in Telegram. Repeating work belongs to `tasks`.",
      title: "reminders",
    })
  );
