import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";
import type { SqlError } from "effect/sql/SqlError";

import { LEGACY_MIGRATIONS } from "./legacy";
import type { LegacyMigration } from "./legacy";
import { LOCAL_MIGRATIONS } from "./local";
import type { Migration } from "./runner";
import { accountActions } from "./steps/20260922-account-actions";
import { taskAuthor } from "./steps/20260922-task-author";
import { sessions } from "./steps/20261003-sessions";
import { sessionHistory } from "./steps/20261009-session-history";
import { taskAuthorUser } from "./steps/20261009-task-author-user";
import { userSettings } from "./steps/20261012-user-settings";
import { backgroundRuns } from "./steps/20261014-background-runs";
import { sessionContext } from "./steps/20261014-session-context";
import { taskProvider } from "./steps/20261015-task-provider";
import { sessionRecord } from "./steps/20261018-session-record";
import { taskSession } from "./steps/20261020-task-session";
import { apiKeys } from "./steps/20261021-api-keys";
import { apiRuns } from "./steps/20261021-api-runs";

/**
 * The old runner's one tolerance, kept exactly: an `ALTER TABLE … ADD COLUMN`
 * whose column already exists (a db a partial run left behind) is skipped. A
 * failed ALTER fails only its own statement; the transaction stays usable.
 */
const isDuplicateAddedColumn =
  (statement: string) =>
  (error: SqlError): boolean =>
    statement.trimStart().startsWith("ALTER TABLE") &&
    isSqlError(error) &&
    error.reason.cause instanceof Error &&
    error.reason.cause.message.startsWith("duplicate column name:");

/**
 * One frozen legacy migration as an Effect SQL migration. It still writes
 * `user_version`, so a db created by this build ends at 11 and a rollback to
 * the sync runner finds it up to date instead of replaying 1–11 over it.
 * Named migrations never touch `user_version`.
 */
const legacyStep = (migration: LegacyMigration) =>
  Effect.gen(function* runLegacyStep() {
    const sql = yield* SqlClient.SqlClient;
    for (const statement of migration.statements) {
      yield* sql
        .unsafe(statement)
        .pipe(
          Effect.catchIf(isDuplicateAddedColumn(statement), () => Effect.void)
        );
    }
    // PRAGMA values cannot be bound; the version is a literal from legacy.ts.
    yield* sql.unsafe(`PRAGMA user_version = ${migration.version}`);
  });

/** The frozen legacy chain, in order, named `legacy_v1`…`legacy_v11`. */
const LEGACY_STEPS: readonly Migration[] = LEGACY_MIGRATIONS.map(
  (migration) => ({
    name: `legacy_v${migration.version}`,
    run: legacyStep(migration),
  })
);

/**
 * Upstream's migrations, one `steps/<YYYYMMDD-slug>.ts` file each. Only the
 * upstream repo adds here; a fork lists its own in `local.ts`, so the two never
 * conflict in a merge. The runner sorts both by name; order here is free.
 */
const UPSTREAM_MIGRATIONS: readonly Migration[] = [
  accountActions,
  taskAuthor,
  sessions,
  taskAuthorUser,
  sessionHistory,
  userSettings,
  backgroundRuns,
  sessionContext,
  taskProvider,
  sessionRecord,
  taskSession,
  apiKeys,
  apiRuns,
];

/** Every list the runner merges; `planMigrations` gives the run order. */
export const MIGRATION_LISTS = {
  legacy: LEGACY_STEPS,
  local: LOCAL_MIGRATIONS,
  upstream: UPSTREAM_MIGRATIONS,
} as const;

/**
 * How many migrations this build knows, which is also the highest id a fresh
 * db ends at: every applied row gets `max + 1`, so ids stay dense.
 */
export const LATEST_MIGRATION_ID =
  LEGACY_STEPS.length + UPSTREAM_MIGRATIONS.length + LOCAL_MIGRATIONS.length;
