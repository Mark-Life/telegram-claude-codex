import { PROVIDER_IDS } from "@workspace/agent/registry";
import { Millis, OptionalFromNull, persistence } from "@workspace/db";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

/** Identifies one forum topic: the supergroup plus the topic's message thread. */
export const ThreadKeySchema = Schema.Struct({
  chatId: Schema.Int,
  threadId: Schema.Int,
});

export type ThreadKey = typeof ThreadKeySchema.Type;

/**
 * One stored topic, as the store hands it back. A row whose provider is no
 * longer in the build carries a session id nothing can resume; every read
 * filters it out in SQL, so the topic reads as absent and starts fresh.
 */
export const ThreadEntrySchema = Schema.Struct({
  chatId: Schema.Int,
  /** Reasoning effort this topic was routed to, or told to use. */
  effort: OptionalFromNull(Schema.String),
  /** Model slug this topic was routed to, or told to use. */
  model: OptionalFromNull(Schema.String),
  projectPath: Schema.String,
  provider: Schema.Literals(PROVIDER_IDS),
  sessionId: OptionalFromNull(Schema.String),
  threadId: Schema.Int,
  updatedAt: Millis,
});

export type ThreadEntry = typeof ThreadEntrySchema.Type;

/** What a topic pins: the project it works on and the session it continues. */
export type ThreadRecord = Omit<ThreadEntry, keyof ThreadKey>;

/** The model and effort one topic runs on; either half may be unset. */
export type ThreadPick = Pick<ThreadRecord, "effort" | "model">;

/** The provider a run writes as; its write lands only on a row on it. */
type RunWrite = Pick<ThreadRecord, "provider">;

/** The `threads` row: the entry under its column names, blanks as NULL. */
const ThreadRow = ThreadEntrySchema.pipe(
  Schema.encodeKeys({
    chatId: "chat_id",
    projectPath: "project_path",
    sessionId: "session_id",
    threadId: "thread_id",
    updatedAt: "updated_at",
  })
);

/** A pin as bound to the upsert. */
const PinWrite = Schema.Struct({
  chatId: Schema.Int,
  projectPath: Schema.String,
  provider: ThreadEntrySchema.fields.provider,
  threadId: Schema.Int,
  updatedAt: Millis,
});

/** A session as bound to its update, written only onto a row on `provider`. */
const SessionWrite = Schema.Struct({
  chatId: Schema.Int,
  provider: ThreadEntrySchema.fields.provider,
  sessionId: Schema.String,
  threadId: Schema.Int,
  updatedAt: Millis,
});

/** A pick as bound to its update; an unset half is NULL, "still to route". */
const PickWrite = Schema.Struct({
  chatId: Schema.Int,
  effort: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  threadId: Schema.Int,
  updatedAt: Millis,
});

/** What `UPDATE … RETURNING chat_id` hands back: one row per topic touched. */
const TouchedThread = Schema.Struct({ chat_id: Schema.Int });

const make = Effect.gen(function* makeThreadsRepo() {
  const sql = yield* SqlClient.SqlClient;

  // A row whose provider left the build is filtered here, not decoded: the
  // session it carries cannot be resumed, so the topic reads as absent.
  const selectOne = SqlSchema.findOneOption({
    Request: ThreadKeySchema,
    Result: ThreadRow,
    execute: (key) =>
      sql`SELECT chat_id, thread_id, project_path, provider, session_id, model, effort, updated_at
          FROM threads
          WHERE chat_id = ${key.chatId} AND thread_id = ${key.threadId}
            AND provider IN ${sql.in(PROVIDER_IDS)}`,
  });
  const selectByChat = SqlSchema.findAll({
    Request: Schema.Int,
    Result: ThreadRow,
    execute: (chatId) =>
      sql`SELECT chat_id, thread_id, project_path, provider, session_id, model, effort, updated_at
          FROM threads
          WHERE chat_id = ${chatId} AND provider IN ${sql.in(PROVIDER_IDS)}
          ORDER BY updated_at DESC`,
  });
  // The session survives only while the topic keeps working on the same project
  // with the same provider: a switch makes the stored id unresumable.
  // A pin that starts a fresh conversation starts a fresh routing decision
  // too: the pick belongs to the conversation, not to the topic's row.
  const upsert = SqlSchema.findOne({
    Request: PinWrite,
    Result: ThreadRow,
    execute: (row) =>
      sql`INSERT INTO threads (chat_id, thread_id, project_path, provider, session_id, model, effort, updated_at)
          VALUES (${row.chatId}, ${row.threadId}, ${row.projectPath}, ${row.provider}, NULL, NULL, NULL, ${row.updatedAt})
          ON CONFLICT(chat_id, thread_id) DO UPDATE SET
            project_path = excluded.project_path,
            provider = excluded.provider,
            session_id = CASE WHEN threads.project_path = excluded.project_path
                AND threads.provider = excluded.provider
              THEN threads.session_id ELSE NULL END,
            model = CASE WHEN threads.project_path = excluded.project_path
                AND threads.provider = excluded.provider
              THEN threads.model ELSE NULL END,
            effort = CASE WHEN threads.project_path = excluded.project_path
                AND threads.provider = excluded.provider
              THEN threads.effort ELSE NULL END,
            updated_at = excluded.updated_at
          RETURNING chat_id, thread_id, project_path, provider, session_id, model, effort, updated_at`,
  });
  const updateSession = SqlSchema.findAll({
    Request: SessionWrite,
    Result: TouchedThread,
    execute: (row) =>
      sql`UPDATE threads SET session_id = ${row.sessionId}, updated_at = ${row.updatedAt}
          WHERE chat_id = ${row.chatId} AND thread_id = ${row.threadId}
            AND provider = ${row.provider}
          RETURNING chat_id`,
  });
  const dropSession = SqlSchema.void({
    Request: ThreadKeySchema,
    execute: (key) =>
      sql`UPDATE threads SET session_id = NULL, model = NULL, effort = NULL
          WHERE chat_id = ${key.chatId} AND thread_id = ${key.threadId}`,
  });
  const updatePick = SqlSchema.findAll({
    Request: PickWrite,
    Result: TouchedThread,
    execute: (row) =>
      sql`UPDATE threads SET model = ${row.model}, effort = ${row.effort}, updated_at = ${row.updatedAt}
          WHERE chat_id = ${row.chatId} AND thread_id = ${row.threadId}
          RETURNING chat_id`,
  });
  const remove = SqlSchema.void({
    Request: ThreadKeySchema,
    execute: (key) =>
      sql`DELETE FROM threads WHERE chat_id = ${key.chatId} AND thread_id = ${key.threadId}`,
  });

  // The raw writes, shared by the single methods and the transactions below.
  const writePin = Effect.fnUntraced(function* writePin(
    entry: ThreadKey & Pick<ThreadRecord, "projectPath" | "provider">
  ) {
    const updatedAt = yield* Clock.currentTimeMillis;
    return yield* upsert({
      chatId: entry.chatId,
      projectPath: entry.projectPath,
      provider: entry.provider,
      threadId: entry.threadId,
      updatedAt,
    }).pipe(
      // An INSERT … RETURNING always hands back its row; no row is a defect.
      Effect.catchTag("NoSuchElementError", (cause) => Effect.die(cause))
    );
  });
  const writeSession = Effect.fnUntraced(function* writeSession(
    entry: ThreadKey & RunWrite & { readonly sessionId: string }
  ) {
    const updatedAt = yield* Clock.currentTimeMillis;
    const touched = yield* updateSession({
      chatId: entry.chatId,
      provider: entry.provider,
      sessionId: entry.sessionId,
      threadId: entry.threadId,
      updatedAt,
    });
    return touched.length > 0;
  });
  const writePick = Effect.fnUntraced(function* writePick(
    entry: ThreadKey & ThreadPick
  ) {
    const updatedAt = yield* Clock.currentTimeMillis;
    const touched = yield* updatePick({
      chatId: entry.chatId,
      effort: entry.effort ?? null,
      model: entry.model ?? null,
      threadId: entry.threadId,
      updatedAt,
    });
    return touched.length > 0;
  });

  /**
   * Whether a run on `provider` may write this topic: it has no row yet, or
   * its row is on that provider. A row on another provider means `/provider`
   * moved the topic after the run started, and the run's write would put the
   * topic back.
   */
  const ownedBy = Effect.fnUntraced(function* ownedBy(
    entry: ThreadKey & RunWrite
  ) {
    const row = yield* selectOne(entry);
    return Option.match(row, {
      onNone: () => true,
      onSome: (found) => found.provider === entry.provider,
    });
  });

  /** The topic's row, none when it was never used. */
  const get = Effect.fn("ThreadsRepo.get")(function* get(key: ThreadKey) {
    return yield* selectOne(key);
  }, persistence("ThreadsRepo.get"));

  /** Every topic of a chat, most recently used first. */
  const list = Effect.fn("ThreadsRepo.list")(function* list(chatId: number) {
    return yield* selectByChat(chatId);
  }, persistence("ThreadsRepo.list"));

  /**
   * Pin a topic to a project and provider, creating the row on first use.
   * Returns the row as it now stands, so a caller sees at once whether the
   * pinned session survived the pin. Only a project switch and `/provider`
   * call this; a run pins through `pinForRun`.
   */
  const pin = Effect.fn("ThreadsRepo.pin")(function* pin(
    entry: ThreadKey & Pick<ThreadRecord, "projectPath" | "provider">
  ) {
    return yield* writePin(entry);
  }, persistence("ThreadsRepo.pin"));

  /**
   * `pin` for a run, in one transaction: none, and nothing written, when the
   * topic's row is on another provider than the run's.
   */
  const pinForRun = Effect.fn("ThreadsRepo.pinForRun")(function* pinForRun(
    entry: ThreadKey & Pick<ThreadRecord, "projectPath" | "provider">
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* checkThenPin() {
        if (!(yield* ownedBy(entry))) {
          return Option.none<ThreadEntry>();
        }
        return Option.some(yield* writePin(entry));
      })
    );
  }, persistence("ThreadsRepo.pinForRun"));

  /**
   * Record the session a topic continues on; false when the topic has no row
   * or its row is on another provider.
   */
  const setSession = Effect.fn("ThreadsRepo.setSession")(function* setSession(
    entry: ThreadKey & RunWrite & { readonly sessionId: string }
  ) {
    return yield* writeSession(entry);
  }, persistence("ThreadsRepo.setSession"));

  /**
   * Forget the topic's session but keep its project pin (`/new`). The routed
   * model goes with it: the next message opens a new conversation, and a new
   * conversation is routed again. `updated_at` is left alone, as before.
   */
  const clearSession = Effect.fn("ThreadsRepo.clearSession")(
    function* clearSession(key: ThreadKey) {
      yield* dropSession(key);
    },
    persistence("ThreadsRepo.clearSession")
  );

  /**
   * Record the model and effort this topic runs on — the router's pick, or the
   * human's own choice. Either half may be unset, which means "still to route".
   */
  const setPick = Effect.fn("ThreadsRepo.setPick")(function* setPick(
    entry: ThreadKey & ThreadPick
  ) {
    return yield* writePick(entry);
  }, persistence("ThreadsRepo.setPick"));

  /** Drop a topic entirely (the user deleted it). */
  const drop = Effect.fn("ThreadsRepo.drop")(function* drop(key: ThreadKey) {
    yield* remove(key);
  }, persistence("ThreadsRepo.drop"));

  /**
   * Pin the topic and record the session it continues on, as one transaction:
   * a run that ended on a session must never leave a pin without it. False,
   * with nothing written, when the row is on another provider.
   */
  const adopt = Effect.fn("ThreadsRepo.adopt")(function* adopt(
    entry: ThreadKey &
      Pick<ThreadRecord, "projectPath" | "provider"> & {
        readonly sessionId: string;
      }
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* pinThenSession() {
        if (!(yield* ownedBy(entry))) {
          return false;
        }
        yield* writePin(entry);
        return yield* writeSession(entry);
      })
    );
  }, persistence("ThreadsRepo.adopt"));

  /**
   * Pin the topic and record its pick, as one transaction. The row is pinned
   * first because a pick can be written before the topic has ever run
   * (`/model` on a fresh topic), and an UPDATE against no row is silent.
   * False, with nothing written, when the row is on another provider.
   */
  const pinWithPick = Effect.fn("ThreadsRepo.pinWithPick")(
    function* pinWithPick(
      entry: ThreadKey &
        Pick<ThreadRecord, "projectPath" | "provider"> &
        ThreadPick
    ) {
      return yield* sql.withTransaction(
        Effect.gen(function* pinThenPick() {
          if (!(yield* ownedBy(entry))) {
            return false;
          }
          yield* writePin(entry);
          return yield* writePick(entry);
        })
      );
    },
    persistence("ThreadsRepo.pinWithPick")
  );

  return {
    adopt,
    clearSession,
    drop,
    get,
    list,
    pin,
    pinForRun,
    pinWithPick,
    setPick,
    setSession,
  } as const;
});

/**
 * Forum topics (`threads`). A topic owns its conversation: the row says which
 * project it works on and which session to resume, so two topics of the same
 * chat never share state. Everything outside a topic (private chat, plain
 * group, the General topic) keeps the per-project session store instead.
 *
 * Transactions live only inside repositories. Never run the bridge, Telegram
 * or an agent inside `withTransaction`: the transaction holds the client's only
 * permit, so it would stall every other query in the process.
 */
export class ThreadsRepo extends Context.Service<
  ThreadsRepo,
  Effect.Success<typeof make>
>()("@workspace/telegram/ThreadsRepo") {
  static readonly layer = Layer.effect(ThreadsRepo, make);
}
