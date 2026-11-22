#!/usr/bin/env bun

import path from "node:path";

import { Effect } from "effect";

import { canonical, protectionOf } from "../src/protected-files";
import { DbCliLive, quietLogger } from "./lib/db-cli";
import { checkRecipient } from "./lib/recipient";

/** Read a `--flag value` pair from argv; returns undefined when absent. */
const readFlag = (flag: string) => {
  const idx = process.argv.indexOf(flag);
  return idx === -1 ? undefined : process.argv[idx + 1];
};

/** argv is [runtime, script, ...args], so the first user arg sits at index 2. */
const FIRST_ARG_INDEX = 2;

// --path is preferred; the bare positional arg stays a fallback for compat.
const positional =
  process.argv[FIRST_ARG_INDEX]?.startsWith("--") === false
    ? process.argv[FIRST_ARG_INDEX]
    : undefined;
const filePath = readFlag("--path") ?? positional;
if (filePath === undefined || filePath.length === 0) {
  console.error(
    "Usage: send-file-to-user.ts --path <filepath> --chat <chatId> [--thread <threadId>]"
  );
  process.exit(1);
}

// --chat is preferred; TELEGRAM_CHAT_ID stays a fallback for compat.
const chatId = readFlag("--chat") ?? process.env.TELEGRAM_CHAT_ID;
const botToken = process.env.BOT_TOKEN;
if (
  botToken === undefined ||
  botToken.length === 0 ||
  chatId === undefined ||
  chatId.length === 0
) {
  console.error("Missing BOT_TOKEN or chat id (--chat / TELEGRAM_CHAT_ID)");
  process.exit(1);
}

// The owner or an executor, in a positive topic if any (`lib/recipient.ts`).
// A refusal prints its reason and exits 1; a failed db read rejects and ends
// the script with the error on stderr.
const checked = await Effect.runPromise(
  checkRecipient({
    chat: chatId,
    hasThread: process.argv.includes("--thread"),
    thread: readFlag("--thread"),
  }).pipe(
    Effect.catchTag("CliFailure", (failure) =>
      Effect.sync(() => {
        console.error(failure.message);
        return process.exit(1);
      })
    ),
    Effect.provide(DbCliLive),
    Effect.provide(quietLogger)
  )
);
const { threadId } = checked;

const realPath = await canonical(filePath);
const file = Bun.file(realPath);
if (!(await file.exists())) {
  console.error(`File not found: absolute_path=${realPath}`);
  process.exit(1);
}

// The bot's own secrets and secret-looking names: one deny list, shared with
// the account's send_media (`src/protected-files.ts`).
const basename = path.basename(realPath);
const protection = await protectionOf(realPath);
if (protection === "bot-file") {
  console.error(`Blocked: ${realPath} is a protected bot file`);
  process.exit(1);
}
if (protection === "sensitive-name") {
  console.error(`Blocked: ${basename} matches sensitive file pattern`);
  process.exit(1);
}

const form = new FormData();
form.append("chat_id", chatId);
if (threadId !== undefined) {
  form.append("message_thread_id", String(threadId));
}
form.append("document", file, basename);

const destination = `chat_id=${chatId} thread_id=${threadId ?? "main"}`;
console.log(
  `Sending file: absolute_path=${realPath} filename=${JSON.stringify(basename)} ${destination}`
);

const res = await fetch(
  `https://api.telegram.org/bot${botToken}/sendDocument`,
  {
    body: form,
    method: "POST",
  }
);

const data: unknown = await res.json();
if (!res.ok) {
  console.error(`Telegram API error ${res.status}: ${JSON.stringify(data)}`);
  process.exit(1);
}

console.log(
  `Sent file: absolute_path=${realPath} filename=${JSON.stringify(basename)} ${destination}`
);
