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
    "Usage: send-file-to-user.ts --path <filepath> --chat <chatId> [--thread <topicId>]"
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
// must match one of the allowed ones. The private chat is ALLOWED_USER_ID; the
// forum supergroup is ALLOWED_CHAT_ID, and a run started there asks for that id
// rather than the user's. TELEGRAM_CHAT_ID stays a fallback for older setups.
const allowedChats = [
  process.env.ALLOWED_USER_ID,
  process.env.ALLOWED_CHAT_ID,
  process.env.TELEGRAM_CHAT_ID,
].filter((id) => id !== undefined && id !== "");
if (allowedChats.length > 0 && !allowedChats.includes(chatId)) {
  console.error(`Blocked: chat ${chatId} is not the allowed recipient`);
  process.exit(1);
}

// A forum topic needs the thread id or the document lands in General.
const threadId = readFlag("--thread");

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
if (threadId) {
  form.append("message_thread_id", threadId);
}
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
