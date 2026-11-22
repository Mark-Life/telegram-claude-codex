import { Clock, Context, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { persistence } from "./errors";
import { Millis, OptionalFromNull } from "./schema";

/**
 * How full one provider session's context window is, as the provider's own
 * CLI counts it (`session_context`). Keyed by session, so a topic's and a
 * private chat's conversation read it the same way, and `/new` needs no
 * write: the next run is on a session with no row yet. `provider` is the
 * provider's id as text, as in `session_history`.
 */
export const SessionContextSchema = Schema.Struct({
  /** Tokens the CLI leaves out of both sides of its percentage. */
  baselineTokens: OptionalFromNull(Schema.Int),
  /** Where the CLI compacts on its own. */
  compactAt: OptionalFromNull(Schema.Int),
  model: OptionalFromNull(Schema.String),
  /** The model's own window, when the figure is measured against a smaller one. */
  modelWindowTokens: OptionalFromNull(Schema.Int),
  provider: Schema.String,
  sessionId: Schema.String,
  updatedAt: Millis,
  usedTokens: Schema.Int,
  /** The window the figure is measured against. */
  windowTokens: OptionalFromNull(Schema.Int),
});

export type SessionContext = typeof SessionContextSchema.Type;

/** A figure as a run reports it; the clock stamps it. */
export type SessionContextWrite = Omit<SessionContext, "updatedAt">;

const Row = SessionContextSchema.pipe(
  Schema.encodeKeys({
    baselineTokens: "baseline_tokens",
    compactAt: "compact_at",
    modelWindowTokens: "model_window_tokens",
    sessionId: "session_id",
    updatedAt: "updated_at",
    usedTokens: "used_tokens",
    windowTokens: "window_tokens",
  })
);

const KeySchema = Schema.Struct({
  provider: Schema.String,
  sessionId: Schema.String,
});

const CarryRequest = Schema.Struct({
  from: Schema.String,
  provider: Schema.String,
  to: Schema.String,
  updatedAt: Millis,
  usedTokens: Schema.Int,
});

const COLUMNS =
  "provider, session_id, used_tokens, window_tokens, model_window_tokens, compact_at, baseline_tokens, model, updated_at";

const make = Effect.gen(function* makeSessionContextRepo() {
  const sql = yield* SqlClient.SqlClient;
  const columns = sql.literal(COLUMNS);

  // The window, the model's window, the compaction point and the baseline
  // describe one window and change together: a figure with no window keeps
  // the known one.
  const upsert = SqlSchema.void({
    Request: Row,
    execute: (row) =>
      sql`INSERT INTO session_context (${columns})
          VALUES (${row.provider}, ${row.session_id}, ${row.used_tokens},
            ${row.window_tokens}, ${row.model_window_tokens},
            ${row.compact_at}, ${row.baseline_tokens}, ${row.model},
            ${row.updated_at})
          ON CONFLICT(provider, session_id) DO UPDATE SET
            used_tokens = excluded.used_tokens,
            window_tokens = COALESCE(excluded.window_tokens, window_tokens),
            model_window_tokens = CASE WHEN excluded.window_tokens IS NULL
              THEN model_window_tokens ELSE excluded.model_window_tokens END,
            compact_at = CASE WHEN excluded.window_tokens IS NULL
              THEN compact_at ELSE excluded.compact_at END,
            baseline_tokens = CASE WHEN excluded.window_tokens IS NULL
              THEN baseline_tokens ELSE excluded.baseline_tokens END,
            model = COALESCE(excluded.model, model),
            updated_at = excluded.updated_at`,
  });
  // The compacted session's figure on the window the old one was measured
  // against; with no row for the old one, the figure alone.
  const insertCarried = SqlSchema.void({
    Request: CarryRequest,
    execute: (request) =>
      sql`INSERT OR REPLACE INTO session_context (${columns})
          SELECT ${request.provider}, ${request.to}, ${request.usedTokens},
            old.window_tokens, old.model_window_tokens, old.compact_at,
            old.baseline_tokens, old.model, ${request.updatedAt}
          FROM (SELECT 1) LEFT JOIN session_context AS old
            ON old.provider = ${request.provider}
            AND old.session_id = ${request.from}`,
  });
  const deleteOne = SqlSchema.void({
    Request: KeySchema,
    execute: (key) =>
      sql`DELETE FROM session_context
          WHERE provider = ${key.provider} AND session_id = ${key.sessionId}`,
  });
  const selectOne = SqlSchema.findOneOption({
    Request: KeySchema,
    Result: Row,
    execute: (key) =>
      sql`SELECT ${columns} FROM session_context
          WHERE provider = ${key.provider} AND session_id = ${key.sessionId}`,
  });

  /** Record a session's latest figure. */
  const record = Effect.fn("SessionContextRepo.record")(function* record(
    entry: SessionContextWrite
  ) {
    const now = yield* Clock.currentTimeMillis;
    yield* upsert({ ...entry, updatedAt: now });
  }, persistence("SessionContextRepo.record"));

  /**
   * Record what a compaction left: `usedTokens` on session `to`, measured
   * against the window session `from` was. The same id for a session
   * compacted in place.
   */
  const carry = Effect.fn("SessionContextRepo.carry")(function* carry(request: {
    from: string;
    provider: string;
    to: string;
    usedTokens: number;
  }) {
    const now = yield* Clock.currentTimeMillis;
    yield* insertCarried({ ...request, updatedAt: now });
  }, persistence("SessionContextRepo.carry"));

  /** Forget a session's figure: what it measured no longer holds. */
  const clear = Effect.fn("SessionContextRepo.clear")(function* clear(key: {
    provider: string;
    sessionId: string;
  }) {
    yield* deleteOne(key);
  }, persistence("SessionContextRepo.clear"));

  /** One session's figure, none before its first answer. */
  const get = Effect.fn("SessionContextRepo.get")(function* get(key: {
    provider: string;
    sessionId: string;
  }) {
    return yield* selectOne(key);
  }, persistence("SessionContextRepo.get"));

  return { carry, clear, get, record } as const;
});

/** Each provider session's context figure (`session_context`). */
export class SessionContextRepo extends Context.Service<
  SessionContextRepo,
  Effect.Success<typeof make>
>()("@workspace/db/SessionContextRepo") {
  static readonly layer = Layer.effect(SessionContextRepo, make);
}
