import { spawn } from "bun";
import { Option } from "effect";
import type { Api } from "grammy";
import { stopAll } from "./agent";
import { getProvider } from "./agent/registry";
import { cleanupStaleState } from "./bot";
import { AppConfig } from "./config";
import { closeDb, DB_FILE, getDb, quarantineDb, runLegacyImport } from "./db";
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

/**
 * Warn about the BotFather-only switches no API can change.
 *
 * `getMe` exposes them read-only. With privacy mode on the bot never receives
 * plain group messages, so prompts written in a forum topic silently never
 * arrive; without group membership it cannot be added to the forum at all.
 * Read-only and never fatal: a wrong flag degrades groups, private chat still
 * works, so it is not worth refusing to boot over.
 */
const warnBotFatherSettings = async (api: Api) => {
  try {
    const me = await api.getMe();
    if (!me.can_read_all_group_messages) {
      console.warn(
        "Privacy mode is enabled: the bot only sees commands and replies in groups, so topic prompts will be missed. Fix in BotFather: /setprivacy -> pick the bot -> Disable."
      );
    }
    if (!me.can_join_groups) {
      console.warn(
        "This bot cannot be added to groups, so forum topics are unavailable. Fix in BotFather: /setjoingroups -> pick the bot -> Enable."
      );
    }
  } catch (e) {
    console.warn("Could not read bot settings from Telegram:", e);
  }
};

/**
 * Open the database and fold the old JSON stores into it once, before any
 * update is served. Fail-open on both halves: a file that cannot be opened is
 * moved aside so the bot boots on a fresh db instead of restart-looping, and
 * the JSON files stay on disk, so an import that throws costs the operator
 * their saved selection, never the boot.
 */
const openDatabase = () => {
  try {
    getDb();
  } catch (e) {
    const moved = quarantineDb();
    console.error(
      `Database could not be opened, moved to ${moved ?? "(no file)"}, starting fresh:`,
      e
    );
    getDb();
  }
  console.log(`Database: ${DB_FILE}`);
  try {
    const result = runLegacyImport(getDb());
    if (result.skipped) {
      console.log("Legacy JSON import: nothing to import");
      return;
    }
    console.log(
      `Legacy JSON import: ${result.imported} session(s), bot state ${result.state ? "imported" : "not found"}`
    );
  } catch (e) {
    console.warn("Legacy JSON import failed, continuing on db state:", e);
  }
};

const CLEANUP_INTERVAL = 3 * 60 * 60 * 1000;

openDatabase();

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
  await stopAll();
  // Disposing the runtime runs BotService's finalizer (bot.stop()) exactly once.
  await runtime.dispose();
  // Last: nothing may still be writing once the handle is gone.
  closeDb();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

bot.start({
  onStart: () => {
    console.log("Bot started");
    // Auth mode is silently flipped by ANTHROPIC_API_KEY presence: absent =>
    // on-disk subscription login (~/.claude); present => metered API pricing.
    console.log(
      Option.isSome(cfg.anthropicApiKey)
        ? "Agent auth: ANTHROPIC_API_KEY (API pricing)"
        : "Agent auth: subscription login (~/.claude)"
    );
    checkCodexAvailable();
    warnBotFatherSettings(bot.api);
    cleanupTimer = setInterval(cleanupStaleState, CLEANUP_INTERVAL);
    const commands = [
      { command: "projects", description: "Switch active project" },
      { command: "provider", description: "Switch coding agent provider" },
      { command: "model", description: "Switch model for active provider" },
      { command: "effort", description: "Switch reasoning effort" },
      { command: "history", description: "Resume a past session" },
      { command: "new", description: "Start fresh conversation" },
      { command: "compact", description: "Summarize session, keep it" },
      { command: "stop", description: "Kill active process" },
      { command: "status", description: "Show current state" },
      {
        command: "verbose",
        description: "Toggle tool-call and thinking output",
      },
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
