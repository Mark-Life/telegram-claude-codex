#!/usr/bin/env bun

// The bot's public identity — name, descriptions, avatar — for codex runs: the
// owner asks for a rename and the agent runs this. Only owner runs are ever
// pointed at its skill, `skills/bot-profile/SKILL.md` (see run-prompt.ts), so a
// member's agent cannot repaint the bot everyone else sees.
//
// Why a CLI and not a boot-time sync. `setMyName` is rate-limited by Telegram,
// and this bot restarts itself after every self-update — syncing the profile on
// every boot would tie the strictest limit in the API to how often the owner
// asks for a code change. Here a write happens only when asked, and every
// setter reads the current value first, so repeating a request costs nothing.
//
// The persona — the name the bot answers to, the owner's name and the bot's
// grammatical gender — lives in the bot's settings table, because the bot's own
// copy reads it. `set-persona` writes it there and, for a new name,
// renames the bot in Telegram in the same step, so the two never differ.
//
// Two settings people ask for are deliberately missing, because no Bot API
// method sets them: group privacy mode and topic ("threaded") mode live in
// BotFather only. `show` prints their current state so the agent can say what
// has to be done by hand instead of guessing.

import { Buffer } from "node:buffer";
import path from "node:path";

import { SettingsRepo } from "@workspace/db";
import type {
  PersistenceError,
  SettingChange,
  SettingKey,
} from "@workspace/db";
import { Effect, Option, Schema } from "effect";

import { DbCliLive, quietLogger } from "./lib/db-cli";

/** Read a `--flag value` pair from argv; undefined when absent. */
const readFlag = (flag: string) => {
  const idx = process.argv.indexOf(flag);
  return idx === -1 ? undefined : process.argv[idx + 1];
};

const USAGE = [
  "Usage:",
  "  profile-cli.ts show",
  "  profile-cli.ts set-name --name <text>",
  "  profile-cli.ts set-short-description --text <text>",
  "  profile-cli.ts set-description --text <text>",
  "  profile-cli.ts set-avatar --path <absolute .jpg>",
  "  profile-cli.ts remove-avatar",
  "  profile-cli.ts set-persona [--call-name <text>] [--owner-name <text>] [--gender <female|male>]",
].join("\n");

/** argv is [runtime, script, command, ...flags]. */
const COMMAND_INDEX = 2;
const command = process.argv[COMMAND_INDEX];

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

/** A required `--flag value`, rejected when absent or empty. */
const requireFlag = (flag: string, hint: string) => {
  const raw = readFlag(flag);
  return raw === undefined || raw.length === 0 ? fail(hint) : raw;
};

/**
 * A required `--flag value` that may be empty: Telegram reads an empty
 * description as "remove the one you have", so blank is a real instruction.
 */
const requirePresent = (flag: string, hint: string) =>
  readFlag(flag) ?? fail(hint);

/** The start-of-image marker every JPEG opens with. */
const JPEG_MAGIC = Buffer.from("ffd8ff", "hex");

const token = process.env.BOT_TOKEN ?? "";
if (token.length === 0) {
  fail("Missing BOT_TOKEN — this script runs inside a bot run, not standalone");
}
const API = `https://api.telegram.org/bot${token}`;

/**
 * Every response is decoded, never asserted: this is a third-party payload, so
 * an off-shape body has to read as a failed call rather than as a typed
 * success. Each method gets the decoder for the one field it actually needs.
 */
const decodeFailure = Schema.decodeUnknownOption(
  Schema.Struct({ description: Schema.String })
);

const decodeOk = Schema.decodeUnknownOption(
  Schema.Struct({ ok: Schema.Literal(true) })
);

const decodeMe = Schema.decodeUnknownOption(
  Schema.Struct({
    result: Schema.Struct({
      can_join_groups: Schema.Boolean,
      can_read_all_group_messages: Schema.Boolean,
      has_topics_enabled: Schema.Boolean,
      username: Schema.String,
    }),
  })
);

const decodeName = Schema.decodeUnknownOption(
  Schema.Struct({ result: Schema.Struct({ name: Schema.String }) })
);

const decodeDescription = Schema.decodeUnknownOption(
  Schema.Struct({ result: Schema.Struct({ description: Schema.String }) })
);

const decodeShortDescription = Schema.decodeUnknownOption(
  Schema.Struct({
    result: Schema.Struct({ short_description: Schema.String }),
  })
);

/**
 * POST a method and decode the answer, or exit with what Telegram said. The
 * rate limit arrives here as a plain description: "Too Many Requests: retry
 * after N".
 */
const call = async <A>(opts: {
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this IS the parse at the I/O boundary: every decoder here comes from Schema.decodeUnknownOption, whose contract is unknown -> Option<A>
  readonly decode: (input: unknown) => Option.Option<A>;
  readonly method: string;
  readonly payload?: Record<string, string>;
}): Promise<A> => {
  const init: RequestInit =
    opts.payload === undefined
      ? { method: "POST" }
      : {
          body: JSON.stringify(opts.payload),
          headers: { "content-type": "application/json" },
          method: "POST",
        };
  const res = await fetch(`${API}/${opts.method}`, init);
  const body: unknown = await res.json();
  return Option.getOrElse(opts.decode(body), () =>
    fail(
      `Telegram rejected ${opts.method}: ${Option.match(decodeFailure(body), {
        onNone: () => "malformed response",
        onSome: (failure) => failure.description,
      })}`
    )
  );
};

/** Send multipart, for the one method that uploads a file. */
const callForm = async (method: string, form: FormData) => {
  const res = await fetch(`${API}/${method}`, { body: form, method: "POST" });
  const body: unknown = await res.json();
  Option.getOrElse(decodeOk(body), () =>
    fail(
      `Telegram rejected ${method}: ${Option.match(decodeFailure(body), {
        onNone: () => "malformed response",
        onSome: (failure) => failure.description,
      })}`
    )
  );
};

/**
 * The three text fields, each paired with its getter, its setter, the response
 * key both use and Telegram's own length cap. One table so `show` and the
 * setters cannot disagree about any of it.
 */
const TEXT_FIELDS = {
  description: {
    get: "getMyDescription",
    key: "description",
    max: 512,
    read: async () => {
      const body = await call({
        decode: decodeDescription,
        method: "getMyDescription",
      });
      return body.result.description;
    },
    set: "setMyDescription",
  },
  name: {
    get: "getMyName",
    key: "name",
    max: 64,
    read: async () => {
      const body = await call({ decode: decodeName, method: "getMyName" });
      return body.result.name;
    },
    set: "setMyName",
  },
  "short-description": {
    get: "getMyShortDescription",
    key: "short_description",
    max: 120,
    read: async () => {
      const body = await call({
        decode: decodeShortDescription,
        method: "getMyShortDescription",
      });
      return body.result.short_description;
    },
    set: "setMyShortDescription",
  },
} as const;

type TextField = keyof typeof TEXT_FIELDS;

/** Read one text field's current value. */
const readText = async (field: TextField) => await TEXT_FIELDS[field].read();

/**
 * Write one text field, but only when it differs — a repeated "rename me to X"
 * then costs nothing, which matters because setMyName is the rate-limited one.
 *
 * The length guard is a local courtesy in UTF-16 units, the same unit Telegram
 * counts entity offsets in. The API stays the authority: anything this lets
 * through and Telegram does not comes back as a plain rejection message.
 */
const writeText = async (field: TextField, value: string) => {
  const spec = TEXT_FIELDS[field];
  const { length } = value;
  if (length > spec.max) {
    fail(
      `--${field === "name" ? "name" : "text"} is ${length} characters; Telegram allows ${spec.max}`
    );
  }
  if ((await readText(field)) === value) {
    console.log(`Unchanged: ${field} is already that. Nothing sent.`);
    return;
  }
  await call({
    decode: decodeOk,
    method: spec.set,
    payload: { [spec.key]: value },
  });
  console.log(`Set ${field} to: ${value}`);
};

const PERSONA_KEYS = ["call_name", "owner_name", "persona_gender"] as const;

/** Run one settings effect against the bot database, then close it. */
const withSettings = async <A>(
  use: (repo: typeof SettingsRepo.Service) => Effect.Effect<A, PersistenceError>
) =>
  await Effect.runPromise(
    SettingsRepo.use(use).pipe(
      Effect.provide(DbCliLive),
      Effect.provide(quietLogger)
    )
  );

const readPersona = async () =>
  await withSettings((repo) =>
    Effect.forEach(PERSONA_KEYS, (key) =>
      repo.get(key).pipe(Effect.map((value) => [key, value] as const))
    )
  );

/** Width of the label column in `show`, so persona values line up. */
const LABEL_WIDTH = 19;

const personaLine = (key: SettingKey, value: Option.Option<string>) =>
  `${`${key}:`.padEnd(LABEL_WIDTH)}${Option.getOrElse(value, () => "(unset)")}`;

if (command === "show") {
  // getMe is the only place the BotFather-owned flags surface.
  const { result: me } = await call({ decode: decodeMe, method: "getMe" });
  const privacyDisabled = me.can_read_all_group_messages;
  const topicsEnabled = me.has_topics_enabled;
  const [name, short, description, persona] = await Promise.all([
    readText("name"),
    readText("short-description"),
    readText("description"),
    readPersona(),
  ]);
  console.log(
    [
      `username:          @${me.username}`,
      `name:              ${name}`,
      `short description: ${short === "" ? "(empty)" : short}`,
      `description:       ${description === "" ? "(empty)" : description}`,
      "",
      "Persona (bot settings):",
      ...persona.map(([key, value]) => `  ${personaLine(key, value)}`),
      "",
      "BotFather-only, no API can set these:",
      `  group privacy disabled: ${privacyDisabled}${privacyDisabled ? "" : "  <- /setprivacy -> Disable, or the bot sees only @mentions in groups"}`,
      `  topics (threaded) mode: ${topicsEnabled}${topicsEnabled ? "" : "  <- BotFather -> Bot Settings -> Topics"}`,
      `  can join groups:        ${me.can_join_groups}`,
    ].join("\n")
  );
  process.exit(0);
}

if (command === "set-name") {
  await writeText(
    "name",
    requireFlag("--name", "set-name needs --name <text>")
  );
  process.exit(0);
}

if (command === "set-persona") {
  const callName = readFlag("--call-name")?.trim();
  const ownerName = readFlag("--owner-name")?.trim();
  const gender = readFlag("--gender");
  if (
    callName === undefined &&
    ownerName === undefined &&
    gender === undefined
  ) {
    fail(
      "set-persona needs at least one of --call-name, --owner-name, --gender"
    );
  }
  if (callName?.length === 0 || ownerName?.length === 0) {
    fail("--call-name and --owner-name cannot be empty");
  }
  if (gender !== undefined && gender !== "female" && gender !== "male") {
    fail("--gender must be female or male");
  }
  const changes: SettingChange[] = [
    ...(callName === undefined
      ? []
      : [{ key: "call_name", value: callName } as const]),
    ...(ownerName === undefined
      ? []
      : [{ key: "owner_name", value: ownerName } as const]),
    ...(gender === undefined
      ? []
      : [{ key: "persona_gender", value: gender } as const]),
  ];
  // Telegram first: a rejected or rate-limited rename exits before the db is
  // touched, so the stored name never runs ahead of the one people see.
  if (callName !== undefined) {
    await writeText("name", callName);
  }
  await withSettings((repo) => repo.apply(changes));
  for (const change of changes) {
    console.log(`Set ${change.key} to: ${change.value}`);
  }
  process.exit(0);
}

if (command === "set-short-description" || command === "set-description") {
  await writeText(
    command === "set-description" ? "description" : "short-description",
    requirePresent("--text", `${command} needs --text <text>`)
  );
  process.exit(0);
}

if (command === "set-avatar") {
  const filePath = requireFlag(
    "--path",
    "set-avatar needs --path <absolute .jpg>"
  );
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    fail(`File not found: ${filePath}`);
  }
  // Telegram takes only JPEG for a static profile photo. Check the magic bytes
  // rather than the extension: a mislabelled .jpg would otherwise fail inside
  // the API with a message the agent cannot act on.
  const head = Buffer.from(
    await file.slice(0, JPEG_MAGIC.length).arrayBuffer()
  );
  if (!head.equals(JPEG_MAGIC)) {
    fail(`Not a JPEG: ${filePath}. Telegram accepts .jpg for a profile photo.`);
  }
  const form = new FormData();
  // The file rides under its own name and the photo param points at it; a
  // profile photo cannot be a reused file_id, it is always a fresh upload.
  form.append(
    "photo",
    JSON.stringify({ photo: "attach://avatar", type: "static" })
  );
  form.append("avatar", file, path.basename(filePath));
  await callForm("setMyProfilePhoto", form);
  console.log(`Avatar set from ${filePath}.`);
  process.exit(0);
}

if (command === "remove-avatar") {
  await call({ decode: decodeOk, method: "removeMyProfilePhoto" });
  console.log("Avatar removed.");
  process.exit(0);
}

fail(USAGE);
