#!/usr/bin/env bun
export {};

const BLOCKED_PATTERNS = [
  /^\.env/,
  /^credentials/i,
  /^secrets/i,
  /\.pem$/,
  /\.key$/,
];

/** Read a `--flag value` pair from argv; returns undefined when absent. */
const readFlag = (flag: string) => {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
};

// --path is preferred; the bare positional arg stays a fallback for compat.
const positional = process.argv[2]?.startsWith("--")
  ? undefined
  : process.argv[2];
const filePath = readFlag("--path") ?? positional;
if (!filePath) {
  console.error(
    "Usage: send-file-to-user.ts --path <filepath> --chat <chatId>"
  );
  process.exit(1);
}

// --chat is preferred; TELEGRAM_CHAT_ID stays a fallback for compat.
const chatId = readFlag("--chat") ?? process.env.TELEGRAM_CHAT_ID;
const botToken = process.env.BOT_TOKEN;
if (!(botToken && chatId)) {
  console.error("Missing BOT_TOKEN or chat id (--chat / TELEGRAM_CHAT_ID)");
  process.exit(1);
}

// Reject a redirected chat id (prompt-injection defense): the requested chat
// must match the allowed one. ALLOWED_USER_ID is the source of truth; fall back
// to TELEGRAM_CHAT_ID for older single-user setups.
const allowedChat = process.env.ALLOWED_USER_ID ?? process.env.TELEGRAM_CHAT_ID;
if (allowedChat && chatId !== allowedChat) {
  console.error(`Blocked: chat ${chatId} is not the allowed recipient`);
  process.exit(1);
}

const file = Bun.file(filePath);
if (!(await file.exists())) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

const basename = filePath.split("/").pop() ?? "";
const blocked = BLOCKED_PATTERNS.some((p) => p.test(basename));
if (blocked) {
  console.error(`Blocked: ${basename} matches sensitive file pattern`);
  process.exit(1);
}

const form = new FormData();
form.append("chat_id", chatId);
form.append("document", file, basename);

const res = await fetch(
  `https://api.telegram.org/bot${botToken}/sendDocument`,
  {
    method: "POST",
    body: form,
  }
);

const data = await res.json();
if (!data.ok) {
  console.error(`Telegram API error: ${JSON.stringify(data)}`);
  process.exit(1);
}

console.log(`Sent ${basename} to chat ${chatId}`);
