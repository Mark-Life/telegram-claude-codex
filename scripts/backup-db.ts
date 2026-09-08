#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const DEFAULT_KEEP_DAYS = 14;
const MS_PER_DAY = 86_400_000;
const SNAPSHOT_NAME = /^bot-\d{8}\.db\.gz$/;

const repoDir = resolve(import.meta.dir, "..");
const dataDir = join(repoDir, ".data");
const dbFile = process.env.BOT_DB_FILE?.trim() || join(dataDir, "bot.db");
const backupsDir = join(dataDir, "backups");

/** `bot-YYYYMMDD.db.gz` for a date, in local time — one snapshot per day. */
const snapshotName = (date: Date) => {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `bot-${y}${m}${d}.db.gz`;
};

/** Retention window from BACKUP_KEEP_DAYS; a bad value falls back to 14 days. */
const keepDays = (raw = process.env.BACKUP_KEEP_DAYS) => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_KEEP_DAYS;
};

/**
 * Consistent copy of the live database.
 *
 * A plain file copy is not enough: the bot runs in WAL mode, so writes that are
 * committed may still live in `bot.db-wal` and a copied `bot.db` would silently
 * lose them. `.backup` uses SQLite's online backup API, which folds the WAL in.
 */
const snapshot = (target: string) => {
  const sqlite3 = Bun.which("sqlite3");
  if (!sqlite3) {
    console.error(
      "sqlite3 not found on PATH. It is required for a consistent WAL backup (a file copy can lose committed writes). Install it: sudo apt-get install -y sqlite3"
    );
    return false;
  }
  const r = Bun.spawnSync([sqlite3, dbFile, `.backup '${target}'`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) {
    console.error(
      new TextDecoder().decode(r.stderr).trim() || "sqlite3 failed"
    );
    return false;
  }
  return true;
};

/** Delete snapshots older than the retention window; returns how many went. */
const prune = async (now: number) => {
  const cutoff = now - keepDays() * MS_PER_DAY;
  let removed = 0;
  for (const name of await readdir(backupsDir)) {
    if (!SNAPSHOT_NAME.test(name)) {
      continue;
    }
    const file = join(backupsDir, name);
    if ((await stat(file)).mtimeMs < cutoff) {
      await rm(file);
      removed += 1;
    }
  }
  return removed;
};

/**
 * Snapshot `.data/bot.db`, gzip it into `.data/backups/bot-YYYYMMDD.db.gz` and
 * drop snapshots past the retention window. Exit code 1 on a failed snapshot so
 * the systemd timer surfaces it.
 */
const main = async () => {
  if (!existsSync(dbFile)) {
    console.log(`No database at ${dbFile} — nothing to back up.`);
    return 0;
  }
  await mkdir(backupsDir, { recursive: true });

  const out = join(backupsDir, snapshotName(new Date()));
  const tmp = `${out}.tmp.db`;
  try {
    if (!snapshot(tmp)) {
      return 1;
    }
    const gz = Bun.gzipSync(await Bun.file(tmp).bytes());
    await Bun.write(out, gz);
    console.log(`Backup: ${out} (${gz.byteLength} bytes)`);
  } finally {
    await rm(tmp, { force: true });
    // sqlite3 writes sidecars next to the snapshot when the source is busy.
    await rm(`${tmp}-wal`, { force: true });
    await rm(`${tmp}-shm`, { force: true });
  }

  const removed = await prune(Date.now());
  if (removed > 0) {
    console.log(`Pruned ${removed} snapshot(s) older than ${keepDays()} days`);
  }
  return 0;
};

process.exit(await main());
