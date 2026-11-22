import { Array as Arr, Context, Effect, Option, Order, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";

/**
 * Migrations keyed by name, so forks of this repo never collide on a number.
 *
 * Ids 1–11 are the frozen legacy chain (`legacy_v1`…`legacy_v11`). Every later
 * migration is named `YYYYMMDD-<slug>` and lives in `steps/<name>.ts`, listed
 * either in `index.ts` (upstream) or `local.ts` (this fork). A name that is not
 * in the table yet runs, whatever the highest applied one is: a fork that
 * merges an older upstream migration after its own newer one still gets it.
 */

/** Name of the table applied migrations are recorded in. */
export const MIGRATIONS_TABLE = "effect_sql_migrations";

/** One schema change. Additive only: old code must still run on the result. */
export interface Migration {
  readonly name: string;
  readonly run: Effect.Effect<void, SqlError, SqlClient.SqlClient>;
}

/**
 * The directory the database file lives in, for a migration that imports a
 * file the bot kept before the table existed (`sessions.json` beside
 * `bot.db`). `Database.layer` sets it from its own filename, so a temp test db
 * looks only in its temp directory. Unset, there is nothing to import.
 */
export const DatabaseDirectory = Context.Reference<Option.Option<string>>(
  "@workspace/db/DatabaseDirectory",
  { defaultValue: Option.none }
);

/** `20261001-task-board`: a date, then a lowercase kebab slug. */
const NAMED = /^\d{8}-[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** The lists could not be merged into one run order. */
// oxlint-disable-next-line unicorn/throw-new-error -- a class factory, not a throw
export class MigrationPlanError extends Schema.TaggedError<MigrationPlanError>()(
  "MigrationPlanError",
  {
    names: Schema.Array(Schema.String),
    reason: Schema.Literals(["duplicate_name", "invalid_name"]),
  }
) {
  override get message() {
    return this.reason === "duplicate_name"
      ? `migration listed twice (index.ts and local.ts?): ${this.names.join(", ")}`
      : `migration name is not YYYYMMDD-<slug>: ${this.names.join(", ")}`;
  }
}

/**
 * The order every migration runs in: legacy first, as listed, then the upstream
 * and local ones together, sorted by name (so by date). Fails on a name listed
 * twice or not in the `YYYYMMDD-<slug>` shape.
 */
export const planMigrations = (lists: {
  readonly legacy: readonly Migration[];
  readonly upstream: readonly Migration[];
  readonly local: readonly Migration[];
}): Effect.Effect<readonly Migration[], MigrationPlanError> => {
  const named = [...lists.upstream, ...lists.local];
  const invalid = named.flatMap((m) => (NAMED.test(m.name) ? [] : [m.name]));
  if (invalid.length > 0) {
    return Effect.fail(
      new MigrationPlanError({ names: invalid, reason: "invalid_name" })
    );
  }
  const all = [...lists.legacy, ...named];
  const names = all.map((m) => m.name);
  const duplicates = names.filter((name, i) => names.indexOf(name) !== i);
  if (duplicates.length > 0) {
    return Effect.fail(
      new MigrationPlanError({ names: duplicates, reason: "duplicate_name" })
    );
  }
  const sorted = Arr.sortWith(named, (m) => m.name, Order.String);
  return Effect.succeed([...lists.legacy, ...sorted]);
};

/**
 * The table, in the Migrator's own SQLite DDL, so a pre-change build that still
 * runs `SqliteMigrator` finds the table it expects. The unique index on `name`
 * is new; the old Migrator never inserts a name twice, so it does not notice.
 */
export const ensureMigrationsTable = Effect.gen(function* ensureTable() {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS ${sql(MIGRATIONS_TABLE)} (
  migration_id integer PRIMARY KEY NOT NULL,
  created_at datetime NOT NULL DEFAULT current_timestamp,
  name VARCHAR(255) NOT NULL
)`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS ${sql(`${MIGRATIONS_TABLE}_name`)}
    ON ${sql(MIGRATIONS_TABLE)} (name)`;
});

const AppliedName = Schema.Struct({ name: Schema.String });

/**
 * Apply every migration in `plan` whose name is not in the table, in order, in
 * one `BEGIN IMMEDIATE` transaction: a second process booting at the same time
 * waits, then finds nothing to do. Each applied row gets `max(migration_id) + 1`,
 * so a pre-change build sees an id above its own latest, warns and boots.
 *
 * Returns the names it ran and the applied names `plan` does not know (a
 * rollback to an older build, or a fork migration this build never had).
 */
export const runMigrations = (plan: readonly Migration[]) =>
  Effect.gen(function* applyMigrations() {
    const sql = yield* SqlClient.SqlClient;
    yield* ensureMigrationsTable;

    const appliedNames = SqlSchema.findAll({
      Request: Schema.Void,
      Result: AppliedName,
      execute: () => sql`SELECT name FROM ${sql(MIGRATIONS_TABLE)}`,
    });

    return yield* sql.withTransaction(
      Effect.gen(function* applyPending() {
        const applied = new Set((yield* appliedNames()).map((r) => r.name));
        const ran: string[] = [];
        for (const migration of plan) {
          if (applied.has(migration.name)) {
            continue;
          }
          yield* migration.run.pipe(
            Effect.withSpan(`Migration ${migration.name}`)
          );
          yield* sql`INSERT INTO ${sql(MIGRATIONS_TABLE)} (migration_id, name)
            SELECT coalesce(max(migration_id), 0) + 1, ${migration.name}
            FROM ${sql(MIGRATIONS_TABLE)}`;
          ran.push(migration.name);
        }
        const known = new Set(plan.map((m) => m.name));
        const unknown = [...applied].filter((name) => !known.has(name));
        return { ran, unknown };
      })
    );
  });
