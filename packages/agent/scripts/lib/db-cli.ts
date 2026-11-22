// The process boundary every db-backed script shares: the repositories over
// the one bot database, a logger that never touches stdout, and a runner that
// turns a command's Effect into an exit code. The codex agent parses what a
// CLI prints, so stdout is the command's answer alone and stderr carries
// refusals and logs.

import { BunRuntime } from "@effect/platform-bun";
import { Database, DbRepos } from "@workspace/db";
import type { DatabaseInitError, PersistenceError } from "@workspace/db";
import {
  Cause,
  Console,
  Effect,
  Layer,
  Logger,
  Option,
  References,
  Runtime,
  Schema,
} from "effect";

/**
 * A command refused its input or found nothing to do. `message` is written to
 * stderr as-is, or nothing when it is empty — for a command that already
 * answered on stdout and only needs a non-zero exit. `code` is the process
 * exit code.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- a class factory, not a throw
export class CliFailure extends Schema.TaggedError<CliFailure>()("CliFailure", {
  code: Schema.Int,
  message: Schema.String,
}) {
  /** `BunRuntime.runMain`'s default teardown exits with this code. */
  override get [Runtime.errorExitCode]() {
    return this.code;
  }
}

/** The old `fail(message)`: the message on stderr and exit code 1. */
export const refuse = (message: string) => new CliFailure({ code: 1, message });

/** The value inside, or the old `x ?? fail(message)`: a refusal when none. */
export const orRefuse =
  (message: string) =>
  <A>(option: Option.Option<A>): Effect.Effect<A, CliFailure> =>
    Option.isSome(option) ? Effect.succeed(option.value) : refuse(message);

/**
 * argv is [runtime, script, command, ...flags]; `main(process.argv)` keeps
 * that shape so a check can hand a CLI a literal argv.
 */
export const COMMAND_INDEX = 2;

/** Read a `--flag value` pair from argv; undefined when absent. */
export const readFlag = (argv: readonly string[], flag: string) => {
  const idx = argv.indexOf(flag);
  return idx === -1 ? undefined : argv[idx + 1];
};

/** Whether a valueless `--flag` is present. */
export const hasFlag = (argv: readonly string[], flag: string) =>
  argv.includes(flag);

/**
 * Warnings and errors as logfmt on stderr, nothing on stdout. The Database
 * layer's "database migrated" line is Info and stays silent; a schema newer
 * than this build, or a failed command, still reaches the operator.
 */
export const quietLogger = Layer.mergeAll(
  Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)]),
  Layer.succeed(References.MinimumLogLevel, "Warn")
);

/** Every repository over `.data/bot.db`, opened and migrated on first use. */
export const DbCliLive = DbRepos.layer.pipe(Layer.provide(Database.live));

/** What a CLI's `main` may fail with. */
export type CliError = CliFailure | DatabaseInitError | PersistenceError;

/**
 * Report a command's failure once, at this boundary. A refusal prints its
 * message the way the old `fail` did; a storage failure or a defect is logged
 * with its cause, so the agent sees a line and the operator sees why.
 */
export const report = (cause: Cause.Cause<CliError>) => {
  if (Cause.hasInterruptsOnly(cause)) {
    return Effect.void;
  }
  const error = Cause.squash(cause);
  if (error instanceof CliFailure) {
    return error.message.length === 0
      ? Effect.void
      : Console.error(error.message);
  }
  return Effect.logError("db cli failed", cause);
};

/**
 * Run a CLI command as the process: repositories provided, logs on stderr,
 * exit code 0 on success, `CliFailure.code` on a refusal and 1 on anything
 * else. Ending the fiber closes the connection, which checkpoints the WAL —
 * the reason no command calls `process.exit` itself.
 */
export const runDbCli = (
  program: Effect.Effect<void, CliError, DbRepos.Services>
) => {
  BunRuntime.runMain(
    program.pipe(
      Effect.provide(DbCliLive),
      // After the layer, so a database that fails to open is reported too.
      Effect.tapCause(report),
      Effect.provide(quietLogger)
    ),
    { disableErrorReporting: true }
  );
};
