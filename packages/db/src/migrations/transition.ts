import { Effect, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";

import { ensureMigrationsTable, MIGRATIONS_TABLE } from "./runner";

const Count = Schema.Struct({ n: Schema.Int });
const UserVersion = Schema.Struct({ user_version: Schema.Int });
const Adopted = Schema.Struct({ migration_id: Schema.Int });

/**
 * Hand a `user_version` database over to the Migrator: when nothing is tracked
 * yet and the db is at version N > 0, record ids 1..N as applied so the
 * Migrator runs only what is newer. Returns how many ids it recorded (0 on a
 * fresh file and on every later boot).
 *
 * The table is `ensureMigrationsTable`'s, the Migrator's own SQLite DDL. The check
 * and the insert share one `BEGIN IMMEDIATE` transaction and the insert is
 * `OR IGNORE`, so a CLI booting at the same moment as the bot adopts nothing
 * twice.
 */
export const adoptLegacyVersion: Effect.Effect<
  number,
  SqlError | Schema.SchemaError,
  SqlClient.SqlClient
> = Effect.gen(function* handOverLegacyVersion() {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureMigrationsTable;

  const tracked = SqlSchema.findOne({
    Request: Schema.Void,
    Result: Count,
    execute: () => sql`SELECT count(*) AS n FROM ${sql(MIGRATIONS_TABLE)}`,
  });
  const userVersion = SqlSchema.findOne({
    Request: Schema.Void,
    Result: UserVersion,
    execute: () => sql`PRAGMA user_version`,
  });
  const adopt = SqlSchema.findAll({
    Request: Schema.Array(
      Schema.Struct({ migration_id: Schema.Int, name: Schema.String })
    ),
    Result: Adopted,
    execute: (rows) =>
      sql`INSERT OR IGNORE INTO ${sql(MIGRATIONS_TABLE)} ${sql.insert(rows)}
          RETURNING migration_id`,
  });

  return yield* sql
    .withTransaction(
      Effect.gen(function* adoptInTransaction() {
        const { n } = yield* tracked();
        const { user_version: version } = yield* userVersion();
        if (n > 0 || version <= 0) {
          return 0;
        }
        const rows = Array.from({ length: version }, (_, index) => ({
          migration_id: index + 1,
          name: `legacy_v${index + 1}`,
        }));
        const adopted = yield* adopt(rows);
        return adopted.length;
      })
    )
    .pipe(Effect.catchTag("NoSuchElementError", Effect.die));
});
