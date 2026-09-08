import type { Database } from "bun:sqlite";

interface Migration {
  /** Statements applied in order, inside one transaction. */
  statements: readonly string[];
  /** Monotonic version written to the `user_version` pragma once applied. */
  version: number;
}

/**
 * Ordered schema migrations.
 *
 * Adding one: append an entry with the next version number and one SQL
 * statement per array element. The runner applies every entry newer than the
 * db's `user_version`, in order, each in its own transaction, and bumps the
 * pragma with it. Never edit, reorder or delete a shipped entry — databases in
 * the field already ran it; correct it with a new entry instead.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    statements: [
      `CREATE TABLE IF NOT EXISTS threads (
        chat_id INTEGER NOT NULL,
        thread_id INTEGER NOT NULL,
        project_path TEXT NOT NULL,
        provider TEXT NOT NULL,
        session_id TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, thread_id)
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        project_path TEXT NOT NULL,
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (project_path, provider)
      )`,
      `CREATE TABLE IF NOT EXISTS compose (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        thread_id INTEGER,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS compose_buffer_idx
        ON compose (chat_id, user_id, thread_id, seq)`,
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    ],
    version: 1,
  },
];

/** Highest version this build knows about. */
export const LATEST_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

/** Current schema version of `db` (0 on a fresh file). */
export const schemaVersion = (db: Database) =>
  db.query<{ user_version: number }, []>("PRAGMA user_version").get()
    ?.user_version ?? 0;

/**
 * Apply every migration newer than the db's `user_version` and return the
 * resulting version. Idempotent: reopening an up-to-date db runs nothing.
 */
export const runMigrations = (db: Database) => {
  const current = schemaVersion(db);
  for (const migration of MIGRATIONS.filter((m) => m.version > current)) {
    db.transaction(() => {
      for (const statement of migration.statements) {
        db.run(statement);
      }
      // PRAGMA values cannot be bound; the version is a literal from this file.
      db.run(`PRAGMA user_version = ${migration.version}`);
    })();
  }
  return Math.max(current, LATEST_VERSION);
};
