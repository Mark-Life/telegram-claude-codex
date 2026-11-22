#!/usr/bin/env bun

// HTTP API keys for codex runs: the owner or an executor says "make me a key
// for ChatGPT" and the agent runs this. It goes through the same
// `ApiKeyService` as the bot's /apikeys command and the HTTP API, so the three
// doors agree. Owner and executor runs are pointed at
// `skills/bot-api-keys/SKILL.md`, which documents it (see bot-skills.ts).
//
// The holder is the person the run works for (`BOT_TASK_AUTHOR_ID`, set by
// the bot), never a flag. The token never reaches stdout, which feeds the
// agent's transcript: it goes to the holder's Telegram DM through the Bot API,
// and the bot deletes that DM after ten minutes. A run with the machine can
// forge the env or write `.data/bot.db` itself, so this is a convenience, not
// a trust boundary; the bot's access watcher tells the owner of every new key.

import { appendFile, mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

import {
  apiKeyHint,
  ApiKeyService,
  SettingsRepo,
  taskStampFromEnv,
  TOKEN_MESSAGE_MINUTES,
} from "@workspace/db";
import type { ApiKeyEntry } from "@workspace/db";
import { DATA_DIR } from "@workspace/env/paths";
import { Console, Effect, Option, Redacted, Schema } from "effect";

// The token DM is the bot's own copy, the one /apikeys sends: copy lives only
// in the bot's i18n, and this script runs inside the bot's checkout.
import { api as enApi } from "../../../apps/telegram/src/i18n/en/api";
import { api as ruApi } from "../../../apps/telegram/src/i18n/ru/api";
import {
  COMMAND_INDEX,
  orRefuse,
  readFlag,
  refuse,
  runDbCli,
} from "./lib/db-cli";

const USAGE = [
  "Usage:",
  "  apikeys-cli.ts create --name <name>",
  "  apikeys-cli.ts list",
  "  apikeys-cli.ts revoke --id <key id>",
  "",
  "A key acts as the person this run works for. create sends the token to their Telegram DM and prints only its id.",
].join("\n");

/** The owner's id, which decides who sees every key. */
const ownerId = () => Number(process.env.ALLOWED_USER_ID ?? 0) || 0;

/** The person this run works for, as the bot told it. */
const holderOf = Effect.suspend(() => {
  const { authorUserId } = taskStampFromEnv(process.env);
  return authorUserId === null
    ? refuse(
        "This run does not say whom it works for (BOT_TASK_AUTHOR_ID), so it cannot hold API keys. Use /apikeys in Telegram."
      )
    : Effect.succeed(authorUserId);
});

/**
 * Append a key event to the shared wide-event ledger in the bot's
 * `telegram.api` shape. Best-effort: the key is already made or revoked.
 */
const logKeyEvent = (entry: {
  action: "key_issue" | "key_revoke";
  byUserId: number;
  holderId: number;
  keyId: string;
}) => {
  const file = path.resolve(
    DATA_DIR,
    process.env.TG_LOG_FILE ?? "events.jsonl"
  );
  const line = `${JSON.stringify({
    ...entry,
    actor: "cli",
    event: "telegram.api",
    host: hostname(),
    op: null,
    status: null,
    ts: new Date().toISOString(),
    version: "cli",
  })}\n`;
  return Effect.tryPromise(async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, line);
  }).pipe(Effect.ignore);
};

/**
 * The token DM, worded as /apikeys words it, in the bot's language (`en`
 * unless the owner chose `ru`, as the bot reads `bot_language`).
 */
const tokenText = (input: { language: string; name: string; token: string }) =>
  (input.language === "en" ? enApi : ruApi).apiKeys.created({
    minutes: TOKEN_MESSAGE_MINUTES,
    name: input.name,
    token: input.token,
  });

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const SentMessage = Schema.Struct({
  ok: Schema.Literal(true),
  result: Schema.Struct({ message_id: Schema.Int }),
});

/**
 * Send the token to the holder's private chat through the Bot API; the sent
 * message's id, or none when it did not go out.
 */
const sendToken = (input: { chatId: number; text: string }) => {
  const token = process.env.BOT_TOKEN ?? "";
  if (token.length === 0) {
    return Effect.succeed(Option.none<number>());
  }
  return Effect.tryPromise(async () => {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        body: JSON.stringify({
          chat_id: input.chatId,
          parse_mode: "HTML",
          text: input.text,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }
    );
    const body: unknown = await response.json();
    return body;
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SentMessage)),
    Effect.map((sent) => Option.some(sent.result.message_id)),
    Effect.orElseSucceed(() => Option.none<number>())
  );
};

const describe = (key: ApiKeyEntry) =>
  [
    key.id,
    key.name,
    `holder=${key.userId}`,
    `created=${new Date(key.createdAt).toISOString()}`,
    `last_used=${key.lastUsedAt === undefined ? "-" : new Date(key.lastUsedAt).toISOString()}`,
    `via=${key.createdVia}`,
  ].join("\t");

const create = Effect.fn(function* create(argv: readonly string[]) {
  const keys = yield* ApiKeyService;
  const settings = yield* SettingsRepo;
  const holderId = yield* holderOf;
  const name = readFlag(argv, "--name") ?? "";
  const issued = yield* keys
    .issue({
      createdBy: holderId,
      holderId,
      name,
      ownerId: ownerId(),
      via: "cli",
    })
    .pipe(
      Effect.catchTag("ApiKeyRefused", (error) =>
        refuse(
          error.reason === "name"
            ? "--name must be one line of 1-64 characters"
            : `${holderId} is not the owner or an executor, so they cannot hold API keys.`
        )
      )
    );
  const { key } = issued;
  const language = Option.getOrElse(
    yield* settings.get("bot_language"),
    () => "en"
  );
  const sent = yield* sendToken({
    chatId: holderId,
    text: tokenText({
      language,
      name: escapeHtml(key.name),
      token: Redacted.value(issued.token),
    }),
  });
  const messageId = yield* Option.match(sent, {
    // The secret exists nowhere else: a key nobody can read is revoked.
    onNone: () =>
      keys
        .revoke({ keyId: key.id, ownerId: ownerId(), viewerId: holderId })
        .pipe(
          Effect.andThen(
            refuse(
              "The token could not be sent to the holder's Telegram DM (is BOT_TOKEN set, and has the holder started the bot?). The key was revoked; nothing was kept."
            )
          )
        ),
    onSome: Effect.succeed,
  });
  yield* keys.noteTokenMessage({
    chatId: holderId,
    id: key.id,
    messageId,
  });
  yield* logKeyEvent({
    action: "key_issue",
    byUserId: holderId,
    holderId,
    keyId: key.id,
  });
  yield* Console.log(
    `Created ${apiKeyHint(key.id)} "${key.name}" for ${holderId}. The token was sent to their Telegram DM and deletes itself in ${TOKEN_MESSAGE_MINUTES} minutes.`
  );
});

const list = Effect.gen(function* list() {
  const keys = yield* ApiKeyService;
  const viewerId = yield* holderOf;
  const live = yield* keys.list({ ownerId: ownerId(), viewerId });
  yield* Console.log(
    live.length === 0 ? "No live API keys." : live.map(describe).join("\n")
  );
});

const revoke = Effect.fn(function* revoke(argv: readonly string[]) {
  const keys = yield* ApiKeyService;
  const viewerId = yield* holderOf;
  const keyId = readFlag(argv, "--id") ?? "";
  const revoked = yield* keys
    .revoke({ keyId, ownerId: ownerId(), viewerId })
    .pipe(
      Effect.flatMap(
        orRefuse(`No live API key ${keyId} that ${viewerId} may revoke.`)
      )
    );
  yield* logKeyEvent({
    action: "key_revoke",
    byUserId: viewerId,
    holderId: revoked.userId,
    keyId: revoked.id,
  });
  yield* Console.log(`Revoked ${apiKeyHint(keyId)} "${revoked.name}".`);
});

/** One CLI invocation; `argv` is the full `process.argv`. */
export const main = Effect.fn("apikeys-cli")(function* main(
  argv: readonly string[]
) {
  const command = argv[COMMAND_INDEX] ?? "";
  switch (command) {
    case "create": {
      return yield* create(argv);
    }
    case "list": {
      return yield* list;
    }
    case "revoke": {
      return yield* revoke(argv);
    }
    default: {
      return yield* refuse(USAGE);
    }
  }
});

if (import.meta.main) {
  runDbCli(main(process.argv));
}
