import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { runMigrations } from "./migrations";

const BUSY_TIMEOUT_MS = 5000;

/** Where the JSON stores already live, so the db sits beside them. */
export const DATA_DIR = join(import.meta.dirname, "..", "..", ".data");

/** Process-wide database file. */
export const DB_FILE = join(DATA_DIR, "bot.db");

/**
 * Open (creating if needed) a bot database at `file`, apply the pragmas the bot
 * relies on — WAL so a reader never blocks the writer, a busy timeout so a
 * concurrent write waits instead of throwing — and migrate it to the latest
 * schema. The path is a parameter so tests point at a temp file.
 */
export const openDb = (file: string) => {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  runMigrations(db);
  return db;
};

let instance: Database | undefined;

/**
 * The process-wide bot database (`.data/bot.db`), opened and migrated on first
 * use. Single handle => single write path.
 */
export const getDb = () => {
  instance ??= openDb(DB_FILE);
  return instance;
};

/**
 * Move a database that cannot be opened out of the way, WAL sidecars included,
 * and return where it went (undefined when there was no file). A file that
 * fails to open fails on every boot, so the operator gets a bot on a fresh db
 * plus the damaged file to inspect, rather than a restart loop.
 */
export const quarantineDb = (file = DB_FILE) => {
  if (!existsSync(file)) {
    return undefined;
  }
  const moved = `${file}.corrupt-${Date.now()}`;
  renameSync(file, moved);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${file}${suffix}`)) {
      renameSync(`${file}${suffix}`, `${moved}${suffix}`);
    }
  }
  return moved;
};

/** Close the process-wide database; the next `getDb` reopens it. */
export const closeDb = () => {
  instance?.close();
  instance = undefined;
};
