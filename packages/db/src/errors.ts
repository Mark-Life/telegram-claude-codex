import { Effect, Schema } from "effect";
import type { SqlError, SqlErrorReason } from "effect/sql/SqlError";

/**
 * The storage failure every repository method fails with. `operation` names the
 * method ("UsersRepo.grant"), `reason` is the class of failure a caller may
 * match on. `message` never carries SQLite text or bound values — business rows
 * are private correspondence and `bot.catch` prints `error.message`; the cause
 * goes to the log only.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- a class factory, not a throw
export class PersistenceError extends Schema.TaggedError<PersistenceError>()(
  "PersistenceError",
  {
    cause: Schema.Defect(),
    operation: Schema.String,
    reason: Schema.Literals([
      "UniqueViolation",
      "Constraint",
      "Busy",
      "Connection",
      "Decode",
      "Unknown",
    ]),
  }
) {
  override get message() {
    return `${this.operation} failed (${this.reason})`;
  }

  /** Only a lock timeout is worth another attempt; repos never retry themselves. */
  get isRetryable() {
    return this.reason === "Busy";
  }
}

export type PersistenceReason = PersistenceError["reason"];

/** How each SQL failure class reads to a caller; exhaustive by type. */
const SQL_REASONS = {
  AuthenticationError: "Connection",
  AuthorizationError: "Connection",
  ConnectionError: "Connection",
  ConstraintError: "Constraint",
  DeadlockError: "Busy",
  LockTimeoutError: "Busy",
  SerializationError: "Busy",
  SqlSyntaxError: "Unknown",
  StatementTimeoutError: "Unknown",
  UniqueViolation: "UniqueViolation",
  UnknownError: "Unknown",
} as const satisfies Record<SqlErrorReason["_tag"], PersistenceReason>;

const reasonOf = (cause: SqlError | Schema.SchemaError): PersistenceReason =>
  Schema.isSchemaError(cause) ? "Decode" : SQL_REASONS[cause.reason._tag];

/**
 * Classify a repository method's SQL and Schema failures as one
 * `PersistenceError` labelled with `operation`. Used as the whole-function
 * transform of every `Effect.fn` in a repo.
 *
 * `Effect.fn` hands a transform the method's arguments after the effect. They
 * are declared here, unused, so that the method's parameter list is inferred
 * from its body: without them a method whose parameters are all optional
 * (`list(filter?)`) would compile as taking none.
 */
export const persistence =
  (operation: string) =>
  <A, R>(
    self: Effect.Effect<A, SqlError | Schema.SchemaError, R>,
    ..._args: readonly unknown[]
  ): Effect.Effect<A, PersistenceError, R> =>
    Effect.mapError(
      self,
      (cause) =>
        new PersistenceError({ cause, operation, reason: reasonOf(cause) })
    );
