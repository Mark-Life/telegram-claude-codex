#!/usr/bin/env bun

// Read-only check that `.data/sessions.json` reached the `sessions` table: for
// every (project, provider) record in the file that holds a session id, a model
// or an effort, the table must hold a row with the same values. The file is
// read by the import's own rules (`parseSessionsFile`). Run it after the first
// boot on a build that has the `20261003-sessions` migration.
//
// It opens `bot.db` read-only and never migrates it, so running it before that
// boot changes nothing; it reports that the table is not there yet. Exit 0 when
// nothing is missing or differs, 1 otherwise.

import { existsSync, readFileSync } from "node:fs";

import { BunRuntime } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { parseSessionsFile, persistence } from "@workspace/db";
import { botDbPath, dataPath } from "@workspace/env/paths";
import { Console, Effect, Option, Result, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { PROVIDER_IDS } from "../src/registry";
import {
  CliFailure,
  orRefuse,
  quietLogger,
  refuse,
  report,
} from "./lib/db-cli";

/** The migration that created the table and imported the file. */
const IMPORT_MIGRATION = "20261003-sessions";

/** One `sessions` row under its column names. */
const SessionRow = Schema.Struct({
  effort: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  projectPath: Schema.String,
  provider: Schema.String,
  sessionId: Schema.NullOr(Schema.String),
  updatedAt: Schema.Number,
}).pipe(
  Schema.encodeKeys({
    projectPath: "project_path",
    sessionId: "session_id",
    updatedAt: "updated_at",
  })
);

/** A record as the file holds it, normalized the way the import stored it. */
type FileRecord = Omit<typeof SessionRow.Type, "updatedAt">;

/** The file's records and how many entries the import skipped. */
type FileRecords = Effect.Success<ReturnType<typeof parseSessionsFile>>;

/**
 * `created_at` has whole seconds and the import's rows carry a time inside
 * that second; a row written later went on after the upgrade.
 */
const SECOND_MS = 1000;

/** The fields a record and its row must agree on. */
const COMPARED = ["sessionId", "model", "effort"] as const;

/** One key per conversation; NUL never appears in a path or provider id. */
const keyOf = (entry: Pick<FileRecord, "projectPath" | "provider">) =>
  `${entry.projectPath}\u0000${entry.provider}`;

/** The file's records, or why it could not be read as the old store's file. */
const readSessionsFile = (file: string) =>
  Effect.try({
    catch: (cause) => cause,
    try: () => readFileSync(file, "utf-8"),
  }).pipe(
    Effect.flatMap(parseSessionsFile),
    Effect.mapError((cause) =>
      cause instanceof Error ? cause.message : String(cause)
    )
  );

/** Every row, whether `sessions` exists, and when the import ran (epoch ms). */
const readTable = Effect.gen(function* readTable() {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ name: Schema.String }),
    execute: () =>
      sql`SELECT name FROM sqlite_master
          WHERE type = 'table' AND name IN ('sessions', 'effect_sql_migrations')`,
  })();
  const names = new Set(tables.map((table) => table.name));
  if (!names.has("sessions")) {
    return Option.none();
  }
  const imported = names.has("effect_sql_migrations")
    ? yield* SqlSchema.findOneOption({
        Request: Schema.String,
        Result: Schema.Struct({ importedAt: Schema.Number }),
        execute: (name) =>
          sql`SELECT CAST(strftime('%s', created_at) AS INTEGER) * 1000 AS "importedAt"
              FROM effect_sql_migrations WHERE name = ${name}`,
      })(IMPORT_MIGRATION)
    : Option.none();
  const rows = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: SessionRow,
    execute: () =>
      sql`SELECT project_path, provider, session_id, model, effort, updated_at
          FROM sessions`,
  })();
  return Option.some({
    importedAt: Option.map(imported, (row) => row.importedAt),
    rows,
  });
}).pipe(persistence("sessions-check.read"));

/**
 * Sort every file record against the table. A row whose values differ but was
 * written after the import second is a conversation that went on after the
 * upgrade (`/model`, a new session), not a failed import.
 */
const compare = (args: {
  importedAt: number;
  records: readonly FileRecord[];
  rows: readonly (typeof SessionRow.Type)[];
}) => {
  const byKey = new Map(args.rows.map((row) => [keyOf(row), row]));
  const fileKeys = new Set(args.records.map(keyOf));
  const verdicts = args.records.map((record) => {
    const row = byKey.get(keyOf(record));
    if (row === undefined) {
      return { fields: [], kind: "missing" as const, record };
    }
    const fields = COMPARED.filter((field) => row[field] !== record[field]);
    if (fields.length === 0) {
      return { fields, kind: "same" as const, record };
    }
    const changedLater = row.updatedAt >= args.importedAt + SECOND_MS;
    return {
      fields,
      kind: changedLater ? ("changed" as const) : ("differing" as const),
      record,
    };
  });
  const ofKind = (kind: (typeof verdicts)[number]["kind"]) =>
    verdicts.filter((verdict) => verdict.kind === kind);
  return {
    changed: ofKind("changed"),
    differing: ofKind("differing"),
    extra: args.rows.filter((row) => !fileKeys.has(keyOf(row))),
    missing: ofKind("missing"),
    same: ofKind("same"),
  };
};

/** `/home/me/app codex`: how a conversation is named in the report. */
const label = (record: FileRecord) =>
  `${record.projectPath} ${record.provider}`;

/**
 * The file's records against the table, printed. Fails with exit code 1 when
 * the table is not there yet or a record is missing or differs.
 */
const verify = Effect.fn("sessions-check.verify")(function* verify(
  db: string,
  file: FileRecords
) {
  if (!existsSync(db)) {
    yield* refuse(`No ${db}: the bot has never booted from this directory.`);
  }
  const table = yield* readTable.pipe(
    Effect.provide(SqliteClient.layer({ filename: db, readonly: true })),
    Effect.flatMap(
      orRefuse(
        `${db} has no sessions table yet: restart the bot on this build first.`
      )
    )
  );
  const importedAt = yield* orRefuse(
    `${db} has a sessions table but no ${IMPORT_MIGRATION} migration: the table is not the one this build made. Stop and tell the owner.`
  )(table.importedAt);
  const { rows } = table;
  const result = compare({ importedAt, records: file.rows, rows });
  const known = new Set<string>(PROVIDER_IDS);
  const foreign = [
    ...new Set(rows.map((row) => row.provider).filter((id) => !known.has(id))),
  ];
  const failed = result.missing.length > 0 || result.differing.length > 0;
  const lines = [
    `sessions.json: ${file.rows.length} records with a session id or a pick, ${file.skipped} empty or malformed entries skipped`,
    `sessions table: ${rows.length} rows${foreign.length === 0 ? "" : `, some under providers this build does not run: ${foreign.join(", ")}`}`,
    `matching: ${result.same.length}`,
    `changed after the upgrade (fine): ${result.changed.length}`,
    `rows not in sessions.json, written after the upgrade (fine): ${result.extra.length}`,
    `missing: ${result.missing.length}`,
    ...result.missing.map((verdict) => `  missing: ${label(verdict.record)}`),
    `differing: ${result.differing.length}`,
    ...result.differing.map(
      (verdict) =>
        `  differing: ${label(verdict.record)} (${verdict.fields.join(", ")})`
    ),
    failed
      ? "FAIL: some records in sessions.json are not in the table as they were. `/new` deletes a row, so a missing record is expected only if that conversation was reset after the upgrade."
      : "OK: every record in sessions.json is in the table.",
  ];
  yield* Console.log(lines.join("\n"));
  if (failed) {
    yield* new CliFailure({ code: 1, message: "" });
  }
});

/** The whole check; an absent or unreadable file is reported and exits 0. */
export const check = Effect.fn("sessions-check")(function* check(paths: {
  db: string;
  file: string;
}) {
  if (!existsSync(paths.file)) {
    yield* Console.log(
      `No ${paths.file}: nothing to compare. A fresh install never had one.`
    );
    return;
  }
  const parsed = yield* Effect.result(readSessionsFile(paths.file));
  if (Result.isFailure(parsed)) {
    yield* Console.log(
      [
        `${paths.file} is not the old store's file (${parsed.failure}).`,
        "The upgrade imported nothing from it. The old build read such a file as no sessions too, so nothing was lost.",
      ].join("\n")
    );
    return;
  }
  yield* verify(paths.db, parsed.success);
});

if (import.meta.main) {
  BunRuntime.runMain(
    check({ db: botDbPath(), file: dataPath("sessions.json") }).pipe(
      Effect.tapCause(report),
      Effect.provide(quietLogger)
    ),
    { disableErrorReporting: true }
  );
}
