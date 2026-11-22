import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { Clock, Effect, Option, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { DatabaseDirectory } from "../runner";
import type { Migration } from "../runner";

/** The file conversations outside a forum topic were kept in before the table. */
const SESSIONS_FILE = "sessions.json";

/**
 * The file's outer shape: `{ sessions: { [project]: { [provider]: record } } }`.
 * Only the outer object has to hold; a project or record of the wrong shape is
 * skipped on its own, so one bad entry never costs the others.
 */
const SessionsFile = Schema.fromJsonString(
  Schema.Struct({ sessions: Schema.Record(Schema.String, Schema.Unknown) })
);
const decodeFile = Schema.decodeUnknownEffect(SessionsFile);

/** One project's records, keyed by provider. */
const decodeProject = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, Schema.Unknown)
);

/** One record as the old store wrote it; every field may be absent. */
const decodeRecord = Schema.decodeUnknownOption(
  Schema.Struct({
    effort: Schema.optional(Schema.NullOr(Schema.String)),
    model: Schema.optional(Schema.NullOr(Schema.String)),
    sessionId: Schema.optional(Schema.NullOr(Schema.String)),
  })
);

/** A non-empty string, or NULL: the old store read `""` as no value too. */
const textOrNull = (value: string | null | undefined) =>
  value === undefined || value === null || value.length === 0 ? null : value;

/**
 * Every row the file holds, under every provider key it names: an unknown
 * provider is kept, the store's reads filter by the build's providers. A record
 * with no session id, model or effort carries nothing and is skipped, as is
 * one of the wrong shape.
 */
const sessionRows = (file: typeof SessionsFile.Type) => {
  const projects = Object.entries(file.sessions).map(
    ([projectPath, byProvider]) => ({
      byProvider: decodeProject(byProvider),
      projectPath,
    })
  );
  const records = projects.flatMap(({ byProvider, projectPath }) =>
    Option.match(byProvider, {
      onNone: () => [Option.none()],
      onSome: (entries) =>
        Object.entries(entries).map(([provider, value]) =>
          decodeRecord(value).pipe(
            Option.map((record) => ({
              effort: textOrNull(record.effort),
              model: textOrNull(record.model),
              projectPath,
              provider,
              sessionId: textOrNull(record.sessionId),
            })),
            Option.filter(
              (row) => (row.sessionId ?? row.model ?? row.effort) !== null
            )
          )
        ),
    })
  );
  const rows = records.flatMap((row) => Option.toArray(row));
  return { rows, skipped: records.length - rows.length };
};

/**
 * The rows a `sessions.json` text holds and how many entries were skipped.
 * Fails when the text is not JSON or not the store's outer shape. Exported so
 * `sessions-check.ts` reads the file by the import's own rules.
 */
export const parseSessionsFile = (text: string) =>
  decodeFile(text).pipe(Effect.map(sessionRows));

/**
 * The file's rows, none when it is absent, unreadable, not JSON or not the
 * store's shape. Absent is a fresh install and logs at info; the rest is a
 * warning, because the sessions in it are not carried over.
 */
const readSessionsFile = Effect.fnUntraced(function* readSessionsFile(
  file: string
) {
  if (!existsSync(file)) {
    yield* Effect.logInfo("no sessions.json to import").pipe(
      Effect.annotateLogs({ file })
    );
    return Option.none();
  }
  return yield* Effect.try({
    catch: (cause) => cause,
    try: () => readFileSync(file, "utf-8"),
  }).pipe(
    Effect.flatMap(parseSessionsFile),
    Effect.matchEffect({
      onFailure: (cause) =>
        Effect.logWarning("sessions.json not imported").pipe(
          Effect.annotateLogs({
            detail: cause instanceof Error ? cause.message : String(cause),
            file,
          }),
          Effect.as(Option.none())
        ),
      onSuccess: (decoded) => Effect.succeed(Option.some(decoded)),
    })
  );
});

/**
 * Conversations outside a forum topic: the session one continues on and the
 * model and effort it was routed to, per project directory and provider. The
 * same columns as `threads` without the topic key. New table only; an older
 * build never reads it.
 *
 * The rows `sessions.json` (beside the db file) holds are copied in, in this
 * migration's transaction. A missing or broken file imports nothing and never
 * fails the boot. The file itself is left as it was, so a rollback to a build
 * that still reads it resumes every conversation as of this boot.
 */
export const sessions: Migration = {
  name: "20261003-sessions",
  run: Effect.gen(function* sessionsMigration() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE IF NOT EXISTS sessions (
      project_path TEXT NOT NULL,
      provider TEXT NOT NULL,
      session_id TEXT,
      model TEXT,
      effort TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_path, provider)
    )`;

    const directory = yield* DatabaseDirectory;
    if (Option.isNone(directory)) {
      return;
    }
    const file = path.join(directory.value, SESSIONS_FILE);
    const parsed = yield* readSessionsFile(file);
    if (Option.isNone(parsed)) {
      return;
    }
    const { rows, skipped } = parsed.value;
    const updatedAt = yield* Clock.currentTimeMillis;
    for (const row of rows) {
      yield* sql`INSERT OR IGNORE INTO sessions
          (project_path, provider, session_id, model, effort, updated_at)
        VALUES (${row.projectPath}, ${row.provider}, ${row.sessionId},
          ${row.model}, ${row.effort}, ${updatedAt})`;
    }
    yield* Effect.logInfo("sessions.json imported").pipe(
      Effect.annotateLogs({ file, imported: rows.length, skipped })
    );
  }),
};
