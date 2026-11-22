import { Clock, Context, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { persistence } from "./errors";
import { Millis, OptionalFromNull } from "./schema";

/** What a parked run waits on; the agent package's `BackgroundPending`. */
const PendingSchema = Schema.Struct({
  tasks: Schema.Array(
    Schema.Struct({ description: Schema.String, type: Schema.String })
  ),
  wakeup: Schema.optional(
    Schema.Struct({ prompt: Schema.String, scheduledFor: Millis })
  ),
  workflows: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      runId: Schema.String,
      scriptPath: Schema.String,
    })
  ),
});

/**
 * One conversation parked on background work, as its last park left it.
 * `runKey` is the run slot (`runKeyOf`). `provider` is the provider's id as
 * text: this package does not know the registry. `continuations` counts the
 * resumes since the user last started a run there. `stopCause` is `restart`
 * once a shutdown cut the run; absent at boot, the bot crashed.
 */
export const BackgroundRunSchema = Schema.Struct({
  chatId: Schema.Int,
  continuations: Schema.Int,
  pending: Schema.fromJsonString(PendingSchema),
  projectPath: Schema.String,
  provider: Schema.String,
  runKey: Schema.String,
  sessionId: Schema.String,
  stopCause: OptionalFromNull(Schema.Literal("restart")),
  surface: Schema.String,
  threadId: OptionalFromNull(Schema.Int),
  updatedAt: Millis,
  userId: Schema.Int,
});

export type BackgroundRun = typeof BackgroundRunSchema.Type;

/**
 * A park as the app reports it; the clock stamps it. `stopCause` is set for
 * a run the restart cut as it parked, and cleared otherwise.
 */
export type BackgroundRunWrite = Omit<BackgroundRun, "updatedAt">;

const Row = BackgroundRunSchema.pipe(
  Schema.encodeKeys({
    chatId: "chat_id",
    projectPath: "project_path",
    runKey: "run_key",
    sessionId: "session_id",
    stopCause: "stop_cause",
    threadId: "thread_id",
    updatedAt: "updated_at",
    userId: "user_id",
  })
);

const Stamped = Schema.Struct({ at: Millis, runKey: Schema.String });

const make = Effect.gen(function* makeBackgroundRunsRepo() {
  const sql = yield* SqlClient.SqlClient;

  const columns = sql`run_key, user_id, chat_id, thread_id, surface, provider,
    session_id, project_path, pending, continuations, stop_cause, updated_at`;

  const upsert = SqlSchema.void({
    Request: Row,
    execute: (row) =>
      sql`INSERT INTO background_runs (${columns})
          VALUES (${row.run_key}, ${row.user_id}, ${row.chat_id},
            ${row.thread_id}, ${row.surface}, ${row.provider},
            ${row.session_id}, ${row.project_path}, ${row.pending},
            ${row.continuations}, ${row.stop_cause}, ${row.updated_at})
          ON CONFLICT(run_key) DO UPDATE SET
            user_id = excluded.user_id, chat_id = excluded.chat_id,
            thread_id = excluded.thread_id, surface = excluded.surface,
            provider = excluded.provider, session_id = excluded.session_id,
            project_path = excluded.project_path, pending = excluded.pending,
            continuations = excluded.continuations,
            stop_cause = excluded.stop_cause, updated_at = excluded.updated_at`,
  });
  const selectAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Row,
    execute: () =>
      sql`SELECT ${columns} FROM background_runs ORDER BY updated_at`,
  });
  const selectOne = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Row,
    execute: (runKey) =>
      sql`SELECT ${columns} FROM background_runs WHERE run_key = ${runKey}`,
  });
  const deleteOne = SqlSchema.void({
    Request: Schema.String,
    execute: (runKey) =>
      sql`DELETE FROM background_runs WHERE run_key = ${runKey}`,
  });
  const markAll = SqlSchema.void({
    Request: Millis,
    execute: (at) =>
      sql`UPDATE background_runs SET stop_cause = 'restart', updated_at = ${at}`,
  });
  const increment = SqlSchema.void({
    Request: Stamped,
    execute: (row) =>
      sql`UPDATE background_runs
          SET continuations = continuations + 1, stop_cause = NULL,
            updated_at = ${row.at}
          WHERE run_key = ${row.runKey}`,
  });

  /** Record a park: the row as the run left it. */
  const put = Effect.fn("BackgroundRunsRepo.put")(function* put(
    entry: BackgroundRunWrite
  ) {
    const updatedAt = yield* Clock.currentTimeMillis;
    yield* upsert({ ...entry, updatedAt });
  }, persistence("BackgroundRunsRepo.put"));

  /** Every parked conversation, oldest park first. */
  const list = Effect.fn("BackgroundRunsRepo.list")(function* list() {
    return yield* selectAll();
  }, persistence("BackgroundRunsRepo.list"));

  /** One slot's row, if it still has one. */
  const get = Effect.fn("BackgroundRunsRepo.get")(function* get(
    runKey: string
  ) {
    return yield* selectOne(runKey);
  }, persistence("BackgroundRunsRepo.get"));

  /** Forget a slot: its run ended, or will not be resumed. */
  const remove = Effect.fn("BackgroundRunsRepo.remove")(function* remove(
    runKey: string
  ) {
    yield* deleteOne(runKey);
  }, persistence("BackgroundRunsRepo.remove"));

  /** Shutdown: every row was cut by this restart, not by a crash. */
  const markRestart = Effect.fn("BackgroundRunsRepo.markRestart")(
    function* markRestart() {
      yield* markAll(yield* Clock.currentTimeMillis);
    },
    persistence("BackgroundRunsRepo.markRestart")
  );

  /**
   * Count one resume before it starts, so a resume that crashes the bot
   * still counts against the cap. The cause is cleared: a row found again
   * with none means that resume crashed.
   */
  const countContinuation = Effect.fn("BackgroundRunsRepo.countContinuation")(
    function* countContinuation(runKey: string) {
      const at = yield* Clock.currentTimeMillis;
      yield* increment({ at, runKey });
    },
    persistence("BackgroundRunsRepo.countContinuation")
  );

  return { countContinuation, get, list, markRestart, put, remove } as const;
});

/**
 * Conversations parked on background work (`background_runs`), one row per
 * run slot, written at each park and dropped when the run ends.
 */
export class BackgroundRunsRepo extends Context.Service<
  BackgroundRunsRepo,
  Effect.Success<typeof make>
>()("@workspace/db/BackgroundRunsRepo") {
  static readonly layer = Layer.effect(BackgroundRunsRepo, make);
}
