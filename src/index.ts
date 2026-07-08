import { spawn } from "bun";
import { stopAll } from "./agent";
import { getProvider } from "./agent/registry";
import { cleanupStaleState } from "./bot";
import { AppConfig } from "./config";
import { runtime } from "./runtime";
import { loadPersistedState } from "./state";
import { BotService } from "./telegram/bot-service";

/** Warn (but never block startup) if the Codex CLI is missing or not logged in */
const checkCodexAvailable = async () => {
  try {
    const proc = spawn({
      cmd: ["codex", "login", "status"],
      stdout: "ignore",
      stderr: "ignore",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      console.warn(
        "Codex CLI present but not logged in — /provider Codex will fail. Run `codex login`."
      );
    }
  } catch {
    console.warn(
      "Codex CLI not found — /provider Codex unavailable. Install codex to enable it."
    );
  }
};

const CLEANUP_INTERVAL = 3 * 60 * 60 * 1000;

// Boot config through the runtime — fails fast on missing/invalid env, parity
// with the old inline process.exit checks. Secrets stay redacted.
const cfg = await runtime.runPromise(AppConfig);
const { bot } = await runtime.runPromise(BotService);
const userId = cfg.allowedUserId;

bot.catch((err) => {
  console.error("Bot error:", err);
});

let shuttingDown = false;
let cleanupTimer: ReturnType<typeof setInterval> | undefined;
const shutdown = async () => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log("Shutting down...");
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
  }
  stopAll();
  // Disposing the runtime runs BotService's finalizer (bot.stop()) exactly once.
  await runtime.dispose();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

bot.start({
  onStart: () => {
    console.log("Bot started");
    checkCodexAvailable();
    cleanupTimer = setInterval(cleanupStaleState, CLEANUP_INTERVAL);
    const commands = [
      { command: "projects", description: "Switch active project" },
      { command: "provider", description: "Switch coding agent provider" },
      { command: "history", description: "Resume a past session" },
      { command: "new", description: "Start fresh conversation" },
      { command: "stop", description: "Kill active process" },
      { command: "status", description: "Show current state" },
      { command: "branch", description: "Show current git branch" },
      { command: "pr", description: "List open pull requests" },
      { command: "help", description: "Show available commands" },
      { command: "compose", description: "Start collecting messages" },
      { command: "send", description: "Send composed messages" },
      { command: "cancel", description: "Cancel compose mode" },
    ];
    const scopes = [
      { type: "default" as const },
      { type: "all_private_chats" as const },
      { type: "all_group_chats" as const },
      { type: "all_chat_administrators" as const },
    ];
    Promise.all(
      scopes.map((scope) => bot.api.setMyCommands(commands, { scope }))
    ).catch((e) => console.error("Failed to set bot commands:", e));
    const persisted = loadPersistedState();
    const providerId = persisted?.activeProvider ?? "claude";
    let providerName: string = providerId;
    try {
      providerName = getProvider(providerId).displayName;
    } catch {
      providerName = providerId;
    }
    bot.api
      .sendMessage(
        userId,
        `Bot started at ${new Date().toLocaleString()}\nProvider: ${providerName}`
      )
      .catch((e) => console.error("Failed to send startup message:", e));
  },
});
