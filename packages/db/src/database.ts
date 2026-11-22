import { mkdirSync } from "node:fs";
import path from "node:path";

import { SqliteClient } from "@effect/sql-sqlite-bun";
import { botDbPath } from "@workspace/env/paths";
import { Context, Effect, Layer, Option, Schema } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";

import { MIGRATION_LISTS } from "./migrations/index";
import {
  DatabaseDirectory,
  planMigrations,
  runMigrations,
} from "./migrations/runner";
import { adoptLegacyVersion } from "./migrations/transition";

/**
 * The bot's SQLite store as an Effect SQL client: one `bun:sqlite` connection
 * behind a one-permit semaphore, WAL and a 5 s busy timeout (the client's
 * defaults, unchanged from the sync handle), opened, adopted and migrated
 * while the layer builds.
 *
 * One client per process. The bot builds `live` once in its runtime, a CLI
 * once in its own; two connections to one file inside one process can stall
 * the JS thread on a busy-wait while the other holds `BEGIN IMMEDIATE`.
 */

/**
 * The database could not be opened, adopted, migrated or verified. It fails the
 * Database layer, so the bot stops before polling and systemd restarts it.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- a class factory, not a throw
export class DatabaseInitError extends Schema.TaggedError<DatabaseInitError>()(
  "DatabaseInitError",
  {
    cause: Schema.Defect(),
    stage: Schema.Literals([
      "open",
      "adopt_legacy",
      "migrate",
      "foreign_key_check",
    ]),
  }
) {
  override get message() {
    return `database init failed (${this.stage})`;
  }
}

export interface DatabaseOptions {
  /** Absolute path of the SQLite file; its directory is created if missing. */
  readonly filename: string;
}

const initError =
  (stage: DatabaseInitError["stage"]) =>
  (cause: unknown): DatabaseInitError =>
    new DatabaseInitError({ cause, stage });

/** `mkdir -p` the file's directory: the client does not, the sync handle did. */
const ensureDirectory = (filename: string) =>
  Effect.try({
    catch: initError("open"),
    try: () => {
      mkdirSync(path.dirname(filename), { recursive: true });
    },
  });

/**
 * Bring the schema up to date. The order is the data-safety contract:
 *
 * 0. Merge the upstream and local lists; a name listed twice or misnamed fails
 *    the boot before anything touches the file.
 * 1. Foreign keys off. It is a connection setting and SQLite ignores it inside
 *    the migration transaction, so a future table rebuild would otherwise
 *    cascade-delete child rows.
 * 2. Adopt a `user_version` db (its own transaction).
 * 3. Run every pending migration (one transaction).
 * 4. Foreign keys back on, whatever happened — the runtime setting the old
 *    handle had; the `group_facts` and `business_messages` cascades need it.
 * 5. Only when something ran: `foreign_key_check`, so a boot never fails on a
 *    condition it did not cause.
 * 6. An applied name this build does not list is the rollback case (or a fork
 *    migration upstream never had): warn, go on.
 */
const prepare = Effect.gen(function* prepare() {
  const sql = yield* SqlClient.SqlClient;
  const plan = yield* planMigrations(MIGRATION_LISTS).pipe(
    Effect.mapError(initError("migrate"))
  );

  yield* sql`PRAGMA foreign_keys = OFF`.pipe(
    Effect.mapError(initError("open"))
  );

  const { adopted, ran, unknown } = yield* Effect.gen(function* migrate() {
    const adoptedCount = yield* adoptLegacyVersion.pipe(
      Effect.mapError(initError("adopt_legacy"))
    );
    const result = yield* runMigrations(plan).pipe(
      Effect.mapError(initError("migrate")),
      // A migration that throws is still this boot's failure to report, not a
      // crash with no stage.
      Effect.catchDefect((defect) => Effect.fail(initError("migrate")(defect)))
    );
    return { adopted: adoptedCount, ...result };
  }).pipe(Effect.ensuring(Effect.orDie(sql`PRAGMA foreign_keys = ON`)));

  if (ran.length > 0) {
    const violations = yield* sql`PRAGMA foreign_key_check`.pipe(
      Effect.mapError(initError("foreign_key_check"))
    );
    if (violations.length > 0) {
      yield* initError("foreign_key_check")(violations);
    }
  }

  if (unknown.length > 0) {
    yield* Effect.logWarning("database schema is newer than this build").pipe(
      Effect.annotateLogs({ unknown_migrations: unknown.join(",") })
    );
  }

  const summary = Effect.annotateLogs({
    adopted_legacy: adopted,
    ran: ran.join(","),
  });
  yield* adopted > 0 || ran.length > 0
    ? summary(Effect.logInfo("database migrated"))
    : summary(Effect.logDebug("database up to date"));
}).pipe(Effect.withSpan("Database.prepare"));

/** The raw client on `filename`, its open failure typed. */
const client = (
  filename: string
): Layer.Layer<
  SqlClient.SqlClient | SqliteClient.SqliteClient,
  DatabaseInitError
> =>
  Layer.effectContext(
    SqliteClient.make({ filename }).pipe(
      // `new Database` and the client's own pragmas throw synchronously on a
      // file that cannot be opened or is not a database. Same wiring as
      // `SqliteClient.layer`, which offers no way to type that failure.
      Effect.catchDefect((defect) => Effect.fail(initError("open")(defect))),
      Effect.map((sqlite) =>
        Context.make(SqliteClient.SqliteClient, sqlite).pipe(
          Context.add(SqlClient.SqlClient, sqlite)
        )
      )
    )
  ).pipe(Layer.provide(Reactivity.layer));

/**
 * The SQLite client on `filename`, migrated. Exposes `SqlClient` for the
 * repositories and `SqliteClient` for a future Better Auth dialect; the app
 * hides both behind its repository layer.
 */
export const layer = (
  options: DatabaseOptions
): Layer.Layer<
  SqlClient.SqlClient | SqliteClient.SqliteClient,
  DatabaseInitError
> =>
  Layer.effectDiscard(
    // A migration that imports a file the bot kept before its table existed
    // looks for it beside the db file, so a temp test db never reads `.data`.
    prepare.pipe(
      Effect.provideService(
        DatabaseDirectory,
        Option.some(path.dirname(options.filename))
      )
    )
  ).pipe(
    Layer.provideMerge(client(options.filename)),
    Layer.provide(Layer.effectDiscard(ensureDirectory(options.filename)))
  );

/** The process-wide bot database, `.data/bot.db`. */
export const live = layer({ filename: botDbPath() });
