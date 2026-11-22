import { existsSync } from "node:fs";
import path from "node:path";

/** How many parent directories to walk up before giving up. */
const MAX_DEPTH = 10;

/**
 * Walks up from this module until it finds `turbo.json`, the monorepo root.
 * Returns null when nothing matches within `MAX_DEPTH` parents.
 */
export const findMonorepoRoot = () => {
  let dir = import.meta.dirname;
  for (let i = 0; i < MAX_DEPTH; i += 1) {
    if (existsSync(path.resolve(dir, "turbo.json"))) {
      return dir;
    }
    dir = path.resolve(dir, "..");
  }
  return null;
};

/**
 * Single runtime data directory shared by every package and every entrypoint.
 * Resolved from the repo root, never from cwd, so `turbo dev` and
 * `bun run src/index.ts` read and write the same `.data`.
 */
export const DATA_DIR = path.join(findMonorepoRoot() ?? process.cwd(), ".data");

/** Absolute path of `name` inside the shared data directory. */
export const dataPath = (name: string) => path.join(DATA_DIR, name);

/**
 * Absolute path of the bot's SQLite database. One file holds every bot-owned
 * table (compose, settings, and whatever later features add), so there is a
 * single store to back up and a single write path.
 */
export const botDbPath = () => dataPath("bot.db");

/**
 * Absolute path of the Telegram account (MTProto) session: mtcute's own SQLite
 * file, never `bot.db`, so it never shares a connection with the bot's client.
 * It holds the account's auth key: whoever reads it is logged in as the owner.
 */
export const telegramAccountDbPath = () => dataPath("telegram-account.db");

/**
 * Absolute path of the live agent turn snapshot. Transient: the bot rewrites it
 * on every turn start and end and empties it on a clean shutdown, so it is
 * never backed up. A reader trusts it only while its `pid` is the bot's.
 */
export const runsSnapshotPath = () => dataPath("runs.json");

/**
 * Per-user scratch directory for tiers and surfaces with restricted execution.
 * A sandboxed run must never be pointed at the bot repo because it holds
 * `.env`.
 */
export const scratchPath = (userId: number) =>
  path.join(DATA_DIR, "scratch", String(userId));

/**
 * Scratch directory of one guest-profile API run: empty and its own, so the
 * run never sees the holder's scratch files. Removed when the run ends.
 */
export const apiRunScratchPath = (runId: number) =>
  path.join(DATA_DIR, "scratch", `api-${runId}`);

/**
 * Directory of one group: every group run works in it, read-only, and the
 * files its members send land in it. One per chat, so a group never sees
 * another group's files or a member's private scratch.
 */
export const groupDirPath = (chatId: number) =>
  path.join(DATA_DIR, "groups", String(chatId));

/** The directory every group's own directory sits in. */
export const groupsDirPath = () => path.join(DATA_DIR, "groups");
