#!/usr/bin/env bun

// Shared reminder management for owner and executor agent runs. Natural
// language is resolved by the agent; this boundary accepts explicit instants
// and calendar filters and hands them to `ReminderService`, the rules the
// reminder buttons and the HTTP API share.

import { checkZone, ReminderService } from "@workspace/db";
import type {
  ReminderDue,
  ReminderEntry,
  ReminderRefused,
  ReminderTopic,
} from "@workspace/db";
import { parseDefaultTz } from "@workspace/env/bot";
import { Console, Effect, Option, Result } from "effect";

import {
  COMMAND_INDEX,
  CliFailure,
  readFlag,
  refuse,
  runDbCli,
} from "./lib/db-cli";

const ENV_TIMEZONE = parseDefaultTz(process.env.DEFAULT_TZ);

const USAGE = [
  "Usage:",
  "  reminders-cli.ts list [--date <YYYY-MM-DD|today|tomorrow>] [--from <YYYY-MM-DD>] [--to <YYYY-MM-DD>] [--tz <IANA>]",
  "  reminders-cli.ts show --id <id>",
  "  reminders-cli.ts add --text <text> [--at <ISO-8601 with offset>] [--tz <IANA>]",
  "  reminders-cli.ts update --id <id> [--text <text>] [--at <ISO-8601 with offset|none>] [--tz <IANA>]",
  "  reminders-cli.ts done --id <id>",
].join("\n");

/** The command already printed its answer on stdout; only the exit code is 1. */
const silentFailure = new CliFailure({ code: 1, message: "" });

const required = (argv: readonly string[], flag: string) => {
  const value = readFlag(argv, flag);
  return value === undefined
    ? refuse(`${flag} is required.\n\n${USAGE}`)
    : Effect.succeed(value);
};

const readId = (argv: readonly string[]) => {
  const raw = readFlag(argv, "--id");
  const id = Number(raw);
  return raw !== undefined && Number.isSafeInteger(id) && id > 0
    ? Effect.succeed(id)
    : refuse("--id must be a positive reminder id");
};

/** A `ReminderService` refusal as this CLI's stderr line, in flags. */
const refusal = (id?: number) => (error: ReminderRefused) => {
  const value = error.value ?? "";
  switch (error.reason) {
    case "missing": {
      return refuse(`No reminder #${id}.`);
    }
    case "emptyText": {
      return refuse("--text cannot be empty.");
    }
    case "badZone": {
      return refuse(`Unknown IANA timezone: ${value}`);
    }
    case "instantNeedsOffset": {
      return refuse(
        "--at must include Z or an explicit UTC offset, for example 2026-09-08T09:00:00+03:00"
      );
    }
    case "badInstant": {
      return refuse(`Invalid --at value: ${value}`);
    }
    case "badDate": {
      return refuse(`Invalid calendar date: ${value}`);
    }
    case "dateAndRange": {
      return refuse("Use --date or --from/--to, not both.");
    }
    default: {
      return refuse(error.reason);
    }
  }
};

/**
 * The zone a command without `--tz` uses: the owner's `default_tz` from
 * `/settings`, else `DEFAULT_TZ`, else its fallback. A stored zone this runtime
 * does not know is skipped, as the bot skips it.
 */
const homeTimezone = Effect.gen(function* homeTimezone() {
  const reminders = yield* ReminderService;
  const stored = yield* reminders.storedHomeZone();
  if (Option.isSome(stored)) {
    return stored.value;
  }
  return Result.isFailure(ENV_TIMEZONE)
    ? yield* refuse(ENV_TIMEZONE.failure)
    : ENV_TIMEZONE.success;
});

const readTimezone = (argv: readonly string[]) => {
  const timezone = readFlag(argv, "--tz");
  if (timezone === undefined) {
    return homeTimezone;
  }
  return checkZone(timezone).pipe(
    Effect.catchTag("ReminderRefused", refusal())
  );
};

/** An `--at` value as the service reads it; absent when the flag is. */
const isoDue = (at: string | undefined): ReminderDue | undefined =>
  at === undefined ? undefined : { kind: "iso", text: at };

const describe = (reminder: ReminderEntry) =>
  [
    `#${reminder.id}`,
    reminder.dueAt === undefined
      ? "no due date"
      : new Date(reminder.dueAt).toISOString(),
    reminder.timezone,
    reminder.notifiedAt === undefined ? "not notified" : "notified",
    reminder.text.replaceAll("\t", " ").replaceAll("\n", " "),
  ].join("\t");

/**
 * The closeTopic port: completing by voice or text closes the same topic as
 * the Done button, through the Bot API, since this process has no bot.
 */
const closeReminderTopic = (topic: ReminderTopic) => {
  const token = process.env.BOT_TOKEN ?? "";
  if (token.length === 0) {
    return Effect.void;
  }
  return Effect.tryPromise(
    async () =>
      await fetch(`https://api.telegram.org/bot${token}/closeForumTopic`, {
        body: JSON.stringify({
          chat_id: topic.chatId,
          message_thread_id: topic.threadId,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
  ).pipe(
    // The database deletion is authoritative; closing the UI is best-effort.
    Effect.ignore
  );
};

const list = Effect.fn(function* list(argv: readonly string[]) {
  const reminders = yield* ReminderService;
  const timezone = yield* readTimezone(argv);
  const filter = yield* reminders
    .dueWindow({
      date: readFlag(argv, "--date"),
      from: readFlag(argv, "--from"),
      timezone,
      to: readFlag(argv, "--to"),
    })
    .pipe(Effect.catchTag("ReminderRefused", refusal()));
  const rows = yield* reminders.list(filter);
  yield* Console.log(
    rows.length === 0 ? "No reminders." : rows.map(describe).join("\n")
  );
});

const show = Effect.fn(function* show(argv: readonly string[]) {
  const reminders = yield* ReminderService;
  const id = yield* readId(argv);
  const reminder = yield* reminders.get(id);
  yield* Console.log(
    Option.isSome(reminder) ? describe(reminder.value) : "No such reminder."
  );
  if (Option.isNone(reminder)) {
    yield* silentFailure;
  }
});

const add = Effect.fn(function* add(argv: readonly string[]) {
  const reminders = yield* ReminderService;
  const timezone = yield* readTimezone(argv);
  const created = yield* reminders
    .create({
      due: isoDue(readFlag(argv, "--at")),
      text: yield* required(argv, "--text"),
      timezone,
    })
    .pipe(Effect.catchTag("ReminderRefused", refusal()));
  yield* Console.log(`Created reminder ${describe(created)}`);
});

const update = Effect.fn(function* update(argv: readonly string[]) {
  const reminders = yield* ReminderService;
  const id = yield* readId(argv);
  const at = readFlag(argv, "--at");
  const { after, before } = yield* reminders
    .update({
      due: at === "none" ? null : isoDue(at),
      id,
      text: readFlag(argv, "--text"),
      timezone: readFlag(argv, "--tz"),
    })
    .pipe(Effect.catchTag("ReminderRefused", refusal(id)));
  yield* Console.log(
    `Updated reminder ${describe(Option.getOrElse(after, () => before))}`
  );
});

const done = Effect.fn(function* done(argv: readonly string[]) {
  const reminders = yield* ReminderService;
  const id = yield* readId(argv);
  const completed = yield* reminders.complete({
    closeTopic: closeReminderTopic,
    id,
  });
  const removed = Option.isSome(completed);
  yield* Console.log(
    removed ? `Completed reminder #${id}.` : `No reminder #${id}.`
  );
  if (!removed) {
    yield* silentFailure;
  }
});

/** One CLI invocation; `argv` is the full `process.argv`. */
export const main = Effect.fn("reminders-cli")(function* main(
  argv: readonly string[]
) {
  switch (argv[COMMAND_INDEX] ?? "") {
    case "list": {
      return yield* list(argv);
    }
    case "show": {
      return yield* show(argv);
    }
    case "add": {
      return yield* add(argv);
    }
    case "update": {
      return yield* update(argv);
    }
    case "done":
    case "delete": {
      return yield* done(argv);
    }
    default: {
      return yield* refuse(USAGE);
    }
  }
});

if (import.meta.main) {
  runDbCli(main(process.argv));
}
