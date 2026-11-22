import { Database as BunDatabase } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SqliteClient } from "@effect/sql-sqlite-bun";
import { Effect, Layer, References } from "effect";
import type * as SqlClient from "effect/sql/SqlClient";

import * as Database from "./database";
import { LEGACY_MIGRATIONS } from "./migrations/legacy";

/** A throwaway database file for one test. */
export interface TestDb {
  /** Absolute path of the temp file. */
  readonly file: string;
  /**
   * Run one effect against the file: a fresh `Database.layer` opens and
   * migrates it, and closes it when the effect ends. Two `run` calls are a
   * close and a reopen.
   */
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, SqlClient.SqlClient | SqliteClient.SqliteClient>
  ) => Promise<A>;
  /** Delete the temp directory. */
  readonly cleanup: () => void;
}

/** A temp database per test; never `.data`. */
export const makeTestDb = (): TestDb => {
  const dir = mkdtempSync(path.join(tmpdir(), "bot-db-"));
  const file = path.join(dir, "bot.db");
  return {
    cleanup: () => {
      rmSync(dir, { force: true, recursive: true });
    },
    file,
    run: async (effect) =>
      await Effect.runPromise(
        effect.pipe(
          Effect.provide(Layer.fresh(Database.layer({ filename: file }))),
          // The layer's "database migrated" line on every fresh file is noise
          // here; warnings and errors still print.
          Effect.provideService(References.MinimumLogLevel, "Warn")
        )
      ),
  };
};

/**
 * Put `file` in the state a pre-cutover build left it at `version`: the frozen
 * legacy statements up to that version and `user_version`, then `rows` (data
 * that build wrote), all through raw `bun:sqlite` with no Effect SQL table. The
 * only `bun:sqlite` use left.
 */
export const seedLegacy = (
  file: string,
  version: number,
  rows: readonly string[] = []
) => {
  const db = new BunDatabase(file, { create: true });
  try {
    db.run("PRAGMA journal_mode = WAL");
    for (const migration of LEGACY_MIGRATIONS) {
      if (migration.version > version) {
        break;
      }
      db.transaction(() => {
        for (const statement of migration.statements) {
          db.run(statement);
        }
        db.run(`PRAGMA user_version = ${migration.version}`);
      })();
    }
    for (const statement of rows) {
      db.run(statement);
    }
  } finally {
    db.close();
  }
};
