import { OptionalFromNull, persistence } from "@workspace/db";
import type { PersistenceError } from "@workspace/db";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { PROVIDER_IDS } from "./registry";
import type { ProviderId } from "./types";

/**
 * One conversation outside a forum topic, as the `sessions` row holds it. The
 * session id appears once the first run has started; the routed model and
 * effort are written before it, on the very first message, and all three live
 * and die together — `/new` drops the row, so the next message is routed
 * afresh.
 */
const SessionEntrySchema = Schema.Struct({
  effort: OptionalFromNull(Schema.String),
  model: OptionalFromNull(Schema.String),
  sessionId: OptionalFromNull(Schema.String),
});

/** The model and effort one conversation runs on; either half may be unset. */
export type SessionPick = Pick<
  typeof SessionEntrySchema.Type,
  "effort" | "model"
>;

/** The row under its column names. */
const SessionRow = SessionEntrySchema.pipe(
  Schema.encodeKeys({ sessionId: "session_id" })
);

/** Which conversation: the directory a run works in and its provider. */
const SessionKey = Schema.Struct({
  projectPath: Schema.String,
  provider: Schema.Literals(PROVIDER_IDS),
});

/** A session id as bound to its upsert. */
const SessionWrite = Schema.Struct({
  ...SessionKey.fields,
  sessionId: Schema.String,
  updatedAt: Schema.Int,
});

/** A pick as bound to its upsert; an unset half is NULL, "still to route". */
const PickWrite = Schema.Struct({
  ...SessionKey.fields,
  effort: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  updatedAt: Schema.Int,
});

/** Log a store failure once, with its operation and class. */
const logFailure = (error: PersistenceError) =>
  Effect.logError("session store op failed", error.cause).pipe(
    Effect.annotateLogs({ operation: error.operation, reason: error.reason })
  );

const make = Effect.gen(function* makeSessionStore() {
  const sql = yield* SqlClient.SqlClient;

  // A row whose provider left the build is filtered here, as in `threads`: the
  // session it carries cannot be resumed.
  const selectOne = SqlSchema.findOneOption({
    Request: SessionKey,
    Result: SessionRow,
    execute: (key) =>
      sql`SELECT session_id, model, effort FROM sessions
          WHERE project_path = ${key.projectPath} AND provider = ${key.provider}
            AND provider IN ${sql.in(PROVIDER_IDS)}`,
  });
  // Each write sets only its own columns, so a pick written before the first
  // run survives the run that creates the session id.
  const upsertSession = SqlSchema.void({
    Request: SessionWrite,
    execute: (row) =>
      sql`INSERT INTO sessions (project_path, provider, session_id, model, effort, updated_at)
          VALUES (${row.projectPath}, ${row.provider}, ${row.sessionId}, NULL, NULL, ${row.updatedAt})
          ON CONFLICT(project_path, provider) DO UPDATE SET
            session_id = excluded.session_id,
            updated_at = excluded.updated_at`,
  });
  const upsertPick = SqlSchema.void({
    Request: PickWrite,
    execute: (row) =>
      sql`INSERT INTO sessions (project_path, provider, session_id, model, effort, updated_at)
          VALUES (${row.projectPath}, ${row.provider}, NULL, ${row.model}, ${row.effort}, ${row.updatedAt})
          ON CONFLICT(project_path, provider) DO UPDATE SET
            model = excluded.model,
            effort = excluded.effort,
            updated_at = excluded.updated_at`,
  });
  const remove = SqlSchema.void({
    Request: SessionKey,
    execute: (key) =>
      sql`DELETE FROM sessions
          WHERE project_path = ${key.projectPath} AND provider = ${key.provider}`,
  });

  /** The conversation's row; a failed read is logged and reads as none. */
  const read = Effect.fn("SessionStore.read")(
    function* read(projectPath: string, provider: ProviderId) {
      return yield* selectOne({ projectPath, provider });
    },
    persistence("SessionStore.read"),
    Effect.tapError(logFailure),
    Effect.orElseSucceed(() => Option.none())
  );

  /** Session id the conversation resumes, undefined when it has none. */
  const get = Effect.fn("SessionStore.get")(function* get(
    project: string,
    provider: ProviderId
  ) {
    const row = yield* read(project, provider);
    return Option.getOrUndefined(row)?.sessionId;
  });

  /** The model and effort this conversation runs on; empty until routed. */
  const getPick = Effect.fn("SessionStore.getPick")(function* getPick(
    project: string,
    provider: ProviderId
  ) {
    const row = yield* read(project, provider);
    const pick: SessionPick = Option.match(row, {
      onNone: () => ({}),
      onSome: ({ effort, model }) => ({ effort, model }),
    });
    return pick;
  });

  /** Record the session id, keeping the conversation's pick. */
  const set = Effect.fn("SessionStore.set")(
    function* set(args: {
      project: string;
      provider: ProviderId;
      sessionId: string;
    }) {
      const updatedAt = yield* Clock.currentTimeMillis;
      yield* upsertSession({
        projectPath: args.project,
        provider: args.provider,
        sessionId: args.sessionId,
        updatedAt,
      });
    },
    persistence("SessionStore.set"),
    Effect.tapError(logFailure)
  );

  /**
   * Record the model and effort, keeping the session id. An unset half is
   * stored as unset, so "Auto" clearing an override reaches the router.
   */
  const setPick = Effect.fn("SessionStore.setPick")(
    function* setPick(args: {
      pick: SessionPick;
      project: string;
      provider: ProviderId;
    }) {
      const updatedAt = yield* Clock.currentTimeMillis;
      yield* upsertPick({
        effort: args.pick.effort ?? null,
        model: args.pick.model ?? null,
        projectPath: args.project,
        provider: args.provider,
        updatedAt,
      });
    },
    persistence("SessionStore.setPick"),
    Effect.tapError(logFailure)
  );

  /** Drop the conversation (`/new`): the next message starts and routes afresh. */
  const clear = Effect.fn("SessionStore.clear")(
    function* clear(project: string, provider: ProviderId) {
      yield* remove({ projectPath: project, provider });
    },
    persistence("SessionStore.clear"),
    Effect.tapError(logFailure)
  );

  return { clear, get, getPick, set, setPick } as const;
});

/**
 * SessionStore: the conversations outside a forum topic, one `sessions` row
 * per project directory and provider, so ids of two providers never collide.
 * Reads fail open: a failed read is logged and reads as no session, so the
 * conversation starts fresh. A failed write is logged here and fails with
 * `PersistenceError`; the caller decides whether that costs the answer.
 * `runAgent` taps it on the normalized event stream so a session id is
 * recorded as soon as it exists.
 */
export class SessionStore extends Context.Service<
  SessionStore,
  Effect.Success<typeof make>
>()("@workspace/SessionStore") {
  static readonly layer = Layer.effect(SessionStore, make);
}

/** Effect accessors — run them through the app's ManagedRuntime. */
export const getSession = (project: string, provider: ProviderId) =>
  Effect.flatMap(SessionStore, (s) => s.get(project, provider));
export const setSession = (args: {
  project: string;
  provider: ProviderId;
  sessionId: string;
}) => Effect.flatMap(SessionStore, (s) => s.set(args));
export const clearSession = (project: string, provider: ProviderId) =>
  Effect.flatMap(SessionStore, (s) => s.clear(project, provider));
export const getSessionPick = (project: string, provider: ProviderId) =>
  Effect.flatMap(SessionStore, (s) => s.getPick(project, provider));
export const setSessionPick = (args: {
  pick: SessionPick;
  project: string;
  provider: ProviderId;
}) => Effect.flatMap(SessionStore, (s) => s.setPick(args));
