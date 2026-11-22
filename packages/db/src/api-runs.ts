import { Clock, Context, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { persistence } from "./errors";
import { Millis, OptionalFromNull, RowId } from "./schema";

/**
 * Agent runs the HTTP API started (`api_runs`): what was asked, by which
 * key, and how it ended. The run itself lives in the bot process; this is
 * what a caller reads back, after a restart too.
 */

/**
 * Where a run stands. `running` until it ends; `interrupted` when a restart
 * cut it (the boot marks what it finds still `running`). There is no queue:
 * a run that finds no free slot is never stored.
 */
export const API_RUN_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type ApiRunStatus = (typeof API_RUN_STATUSES)[number];

/** How much a run may do: its holder's private-chat access, or a guest's. */
export const API_RUN_PROFILES = ["full", "guest"] as const;

export type ApiRunProfile = (typeof API_RUN_PROFILES)[number];

/** Whether the bot also sends the answer to the holder's private chat. */
export const API_RUN_DELIVERIES = ["never", "always", "agent"] as const;

export type ApiRunDelivery = (typeof API_RUN_DELIVERIES)[number];

/** One run as the store hands it back. */
export const ApiRunEntrySchema = Schema.Struct({
  costUsd: OptionalFromNull(Schema.Number),
  createdAt: Millis,
  deliver: Schema.Literals(API_RUN_DELIVERIES),
  /** Why a `failed`, `cancelled` or `interrupted` run ended, in English. */
  error: OptionalFromNull(Schema.String),
  finishedAt: OptionalFromNull(Millis),
  id: RowId,
  idempotencyKey: OptionalFromNull(Schema.String),
  keyId: Schema.String,
  model: OptionalFromNull(Schema.String),
  /** Where the delivered answer landed, its first message. */
  notifiedChatId: OptionalFromNull(Schema.Int),
  notifiedMessageId: OptionalFromNull(Schema.Int),
  profile: Schema.Literals(API_RUN_PROFILES),
  provider: OptionalFromNull(Schema.String),
  requestHash: Schema.String,
  /** The final answer, capped; `resultTruncated` says whether it was cut. */
  resultText: OptionalFromNull(Schema.String),
  resultTruncated: Schema.BooleanFromBit,
  status: Schema.Literals(API_RUN_STATUSES),
  userId: Schema.Int,
});

export type ApiRunEntry = typeof ApiRunEntrySchema.Type;

const ApiRunRow = ApiRunEntrySchema.pipe(
  Schema.encodeKeys({
    costUsd: "cost_usd",
    createdAt: "created_at",
    finishedAt: "finished_at",
    idempotencyKey: "idempotency_key",
    keyId: "key_id",
    notifiedChatId: "notified_chat_id",
    notifiedMessageId: "notified_message_id",
    requestHash: "request_hash",
    resultText: "result_text",
    resultTruncated: "result_truncated",
    userId: "user_id",
  })
);

const ApiRunInsert = Schema.Struct({
  createdAt: Millis,
  deliver: Schema.Literals(API_RUN_DELIVERIES),
  idempotencyKey: Schema.NullOr(Schema.String),
  keyId: Schema.String,
  profile: Schema.Literals(API_RUN_PROFILES),
  requestHash: Schema.String,
  userId: Schema.Int,
});

const ApiRunFinish = Schema.Struct({
  at: Millis,
  costUsd: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(Schema.String),
  id: RowId,
  model: Schema.NullOr(Schema.String),
  notifiedChatId: Schema.NullOr(Schema.Int),
  notifiedMessageId: Schema.NullOr(Schema.Int),
  provider: Schema.NullOr(Schema.String),
  resultText: Schema.NullOr(Schema.String),
  resultTruncated: Schema.BooleanFromBit,
  status: Schema.Literals(API_RUN_STATUSES),
});

/** How a run ended, as `finish` stores it. */
export interface ApiRunEnding {
  readonly costUsd?: number;
  readonly error?: string;
  readonly model?: string;
  readonly notified?: { readonly chatId: number; readonly messageId: number };
  readonly provider?: string;
  readonly result?: { readonly text: string; readonly truncated: boolean };
  readonly status: Exclude<ApiRunStatus, "running">;
}

const IdempotencyLookup = Schema.Struct({
  idempotencyKey: Schema.String,
  keyId: Schema.String,
});

const COLUMNS = `id, key_id, user_id, idempotency_key, request_hash, profile,
  deliver, status, provider, model, result_text, result_truncated,
  notified_chat_id, notified_message_id, cost_usd, error, created_at,
  finished_at`;

const make = Effect.gen(function* makeApiRunsRepo() {
  const sql = yield* SqlClient.SqlClient;
  const columns = sql.literal(COLUMNS);

  const insertRow = SqlSchema.findOne({
    Request: ApiRunInsert,
    Result: ApiRunRow,
    execute: (row) =>
      sql`INSERT INTO api_runs
            (key_id, user_id, idempotency_key, request_hash, profile, deliver,
             status, created_at)
          VALUES (${row.keyId}, ${row.userId}, ${row.idempotencyKey},
            ${row.requestHash}, ${row.profile}, ${row.deliver}, 'running',
            ${row.createdAt})
          RETURNING ${columns}`,
  });
  const selectOne = SqlSchema.findOneOption({
    Request: RowId,
    Result: ApiRunRow,
    execute: (id) => sql`SELECT ${columns} FROM api_runs WHERE id = ${id}`,
  });
  const selectByIdempotency = SqlSchema.findOneOption({
    Request: IdempotencyLookup,
    Result: ApiRunRow,
    execute: (row) =>
      sql`SELECT ${columns} FROM api_runs
          WHERE key_id = ${row.keyId}
            AND idempotency_key = ${row.idempotencyKey}`,
  });
  // The status guard makes the first ending win: a cancel racing the run's
  // own end, or the boot's sweep racing nothing, writes once.
  const finishRow = SqlSchema.findOneOption({
    Request: ApiRunFinish,
    Result: ApiRunRow,
    execute: (row) =>
      sql`UPDATE api_runs
          SET status = ${row.status}, finished_at = ${row.at},
            provider = ${row.provider}, model = ${row.model},
            result_text = ${row.resultText},
            result_truncated = ${row.resultTruncated},
            notified_chat_id = ${row.notifiedChatId},
            notified_message_id = ${row.notifiedMessageId},
            cost_usd = ${row.costUsd}, error = ${row.error}
          WHERE id = ${row.id} AND status = 'running'
          RETURNING ${columns}`,
  });
  const interruptAll = SqlSchema.findAll({
    Request: Millis,
    Result: Schema.Struct({ id: RowId }),
    execute: (at) =>
      sql`UPDATE api_runs
          SET status = 'interrupted', finished_at = ${at},
            error = 'The bot restarted while the run was working.'
          WHERE status = 'running'
          RETURNING id`,
  });
  /**
   * Store a new run as `running`. A second run with the same key and
   * idempotency key fails with `UniqueViolation`: the caller reads the
   * first one back.
   */
  const create = Effect.fn("ApiRunsRepo.create")(function* create(input: {
    readonly deliver: ApiRunDelivery;
    readonly idempotencyKey: string | undefined;
    readonly keyId: string;
    readonly profile: ApiRunProfile;
    readonly requestHash: string;
    readonly userId: number;
  }) {
    const createdAt = yield* Clock.currentTimeMillis;
    return yield* insertRow({
      ...input,
      createdAt,
      idempotencyKey: input.idempotencyKey ?? null,
    }).pipe(
      // An INSERT … RETURNING always hands back its row; no row is a defect.
      Effect.catchTag("NoSuchElementError", (cause) => Effect.die(cause))
    );
  }, persistence("ApiRunsRepo.create"));

  /** One run by id. */
  const get = Effect.fn("ApiRunsRepo.get")(function* get(id: number) {
    return yield* selectOne(id);
  }, persistence("ApiRunsRepo.get"));

  /** The run a key started under an idempotency key, if any. */
  const byIdempotencyKey = Effect.fn("ApiRunsRepo.byIdempotencyKey")(
    function* byIdempotencyKey(input: {
      readonly idempotencyKey: string;
      readonly keyId: string;
    }) {
      return yield* selectByIdempotency(input);
    },
    persistence("ApiRunsRepo.byIdempotencyKey")
  );

  /**
   * Record how a running run ended. None when it had already ended: the
   * first ending stands.
   */
  const finish = Effect.fn("ApiRunsRepo.finish")(function* finish(
    id: number,
    ending: ApiRunEnding
  ) {
    const at = yield* Clock.currentTimeMillis;
    return yield* finishRow({
      at,
      costUsd: ending.costUsd ?? null,
      error: ending.error ?? null,
      id,
      model: ending.model ?? null,
      notifiedChatId: ending.notified?.chatId ?? null,
      notifiedMessageId: ending.notified?.messageId ?? null,
      provider: ending.provider ?? null,
      resultText: ending.result?.text ?? null,
      resultTruncated: ending.result?.truncated ?? false,
      status: ending.status,
    });
  }, persistence("ApiRunsRepo.finish"));

  /**
   * At boot: every run still `running` belonged to the process before, which
   * is gone, so it is `interrupted`. Answers how many there were.
   */
  const interruptRunning = Effect.fn("ApiRunsRepo.interruptRunning")(
    function* interruptRunning() {
      const at = yield* Clock.currentTimeMillis;
      const rows = yield* interruptAll(at);
      return rows.length;
    },
    persistence("ApiRunsRepo.interruptRunning")
  );

  return {
    byIdempotencyKey,
    create,
    finish,
    get,
    interruptRunning,
  } as const;
});

/** The `api_runs` table; `AgentRuns` in the bot is the one writer. */
export class ApiRunsRepo extends Context.Service<
  ApiRunsRepo,
  Effect.Success<typeof make>
>()("@workspace/db/ApiRunsRepo") {
  static readonly layer = Layer.effect(ApiRunsRepo, make);
}
