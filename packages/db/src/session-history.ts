import { Clock, Context, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { persistence } from "./errors";
import { Millis, OptionalFromNull } from "./schema";

/** The longest title kept, in characters. */
export const HISTORY_TITLE_MAX = 120;

/**
 * A title as `/history` shows it: one line, whitespace collapsed, cut at
 * `HISTORY_TITLE_MAX` characters (never inside an emoji).
 */
export const historyTitle = (text: string) => {
  const line = text.replaceAll(/\s+/gu, " ").trim();
  const graphemes = Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line),
    (part) => part.segment
  );
  return graphemes.length <= HISTORY_TITLE_MAX
    ? line
    : `${graphemes.slice(0, HISTORY_TITLE_MAX - 1).join("")}…`;
};

/** Why a session continues another: a compaction started a fresh one. */
const PREVIOUS_REASONS = ["compact"] as const;

export type PreviousReason = (typeof PREVIOUS_REASONS)[number];

/**
 * One provider session, the record `/history` lists. `provider` is the
 * provider's id as text: this package does not know the registry, so a
 * reader filters by the ids it has. `userId` and `chatId` are absent on a row
 * imported from the provider's own files, `userId` also on one backfilled
 * from a topic.
 */
export const SessionHistoryEntrySchema = Schema.Struct({
  chatId: OptionalFromNull(Schema.Int),
  effort: OptionalFromNull(Schema.String),
  lastActiveAt: Millis,
  model: OptionalFromNull(Schema.String),
  /** The session this one continues; `/history` lists only the newest. */
  previousReason: OptionalFromNull(Schema.String),
  previousSessionId: OptionalFromNull(Schema.String),
  projectPath: Schema.String,
  provider: Schema.String,
  sessionId: Schema.String,
  startedAt: Millis,
  threadId: OptionalFromNull(Schema.Int),
  title: Schema.String,
  userId: OptionalFromNull(Schema.Int),
});

export type SessionHistoryEntry = typeof SessionHistoryEntrySchema.Type;

/** A session as `/history` lists it: the row and its topic's name, if known. */
const SessionHistoryListedSchema = Schema.Struct({
  ...SessionHistoryEntrySchema.fields,
  topicTitle: OptionalFromNull(Schema.String),
});

export type SessionHistoryListed = typeof SessionHistoryListedSchema.Type;

/** A session as a run reports it; the clock stamps both times. */
export type SessionHistoryWrite = Omit<
  SessionHistoryEntry,
  "lastActiveAt" | "previousReason" | "previousSessionId" | "startedAt"
>;

/** Which session: its provider and id. */
export type SessionHistoryKey = Pick<
  SessionHistoryEntry,
  "provider" | "sessionId"
>;

const KEYS = {
  chatId: "chat_id",
  lastActiveAt: "last_active_at",
  previousReason: "previous_reason",
  previousSessionId: "previous_session_id",
  projectPath: "project_path",
  sessionId: "session_id",
  startedAt: "started_at",
  threadId: "thread_id",
  userId: "user_id",
} as const;

const Row = SessionHistoryEntrySchema.pipe(Schema.encodeKeys(KEYS));

const ListedRow = SessionHistoryListedSchema.pipe(
  Schema.encodeKeys({ ...KEYS, topicTitle: "topic_title" })
);

const KeySchema = Schema.Struct({
  provider: Schema.String,
  sessionId: Schema.String,
});

const PageRequest = Schema.Struct({
  limit: Schema.Int,
  offset: Schema.Int,
  providers: Schema.Array(Schema.String),
});

const CountRow = Schema.Struct({ n: Schema.Int, provider: Schema.String });

const Succession = Schema.Struct({
  from: Schema.String,
  now: Millis,
  provider: Schema.String,
  reason: Schema.Literals(PREVIOUS_REASONS),
  to: Schema.String,
});

const COLUMNS =
  "provider, session_id, project_path, user_id, chat_id, thread_id, title, model, effort, started_at, last_active_at, previous_session_id, previous_reason";

/** `COLUMNS` on the row aliased `h`, for a query that joins another table. */
const H_COLUMNS = COLUMNS.split(", ")
  .map((column) => `h.${column}`)
  .join(", ");

const make = Effect.gen(function* makeSessionHistoryRepo() {
  const sql = yield* SqlClient.SqlClient;
  const columns = sql.literal(COLUMNS);
  const hColumns = sql.literal(H_COLUMNS);
  // A session another one continues is listed as its successor only, until
  // it is resumed after it: then the user is back on it.
  const newest = sql`NOT EXISTS (
    SELECT 1 FROM session_history n
    WHERE n.provider = h.provider AND n.previous_session_id = h.session_id
      AND n.last_active_at >= h.last_active_at
  )`;

  // A resumed session keeps its first title, directory and start; it gets the
  // later time, the model it runs on now, and the who and where an imported
  // row lacked.
  const upsert = SqlSchema.void({
    Request: Row,
    execute: (row) =>
      sql`INSERT INTO session_history (${columns})
          VALUES (${row.provider}, ${row.session_id}, ${row.project_path},
            ${row.user_id}, ${row.chat_id}, ${row.thread_id}, ${row.title},
            ${row.model}, ${row.effort}, ${row.started_at},
            ${row.last_active_at}, NULL, NULL)
          ON CONFLICT(provider, session_id) DO UPDATE SET
            last_active_at = max(last_active_at, excluded.last_active_at),
            model = COALESCE(excluded.model, model),
            effort = COALESCE(excluded.effort, effort),
            user_id = COALESCE(user_id, excluded.user_id),
            chat_id = COALESCE(chat_id, excluded.chat_id),
            thread_id = COALESCE(thread_id, excluded.thread_id),
            title = CASE WHEN title = '' THEN excluded.title ELSE title END`,
  });
  // A known session keeps what it has; one known only from a topic's
  // pointer (a blank title) takes the first message and the start.
  const insertPast = SqlSchema.void({
    Request: Row,
    execute: (row) =>
      sql`INSERT INTO session_history (${columns})
          VALUES (${row.provider}, ${row.session_id}, ${row.project_path},
            ${row.user_id}, ${row.chat_id}, ${row.thread_id}, ${row.title},
            ${row.model}, ${row.effort}, ${row.started_at},
            ${row.last_active_at}, ${row.previous_session_id},
            ${row.previous_reason})
          ON CONFLICT(provider, session_id) DO UPDATE SET
            title = excluded.title,
            started_at = min(started_at, excluded.started_at)
          WHERE title = ''`,
  });
  // The successor takes the predecessor's place: its title, directory, who
  // and where, and its start. A successor a run already recorded keeps what
  // it has and gains the link.
  const insertSuccessor = SqlSchema.void({
    Request: Succession,
    execute: (row) =>
      sql`INSERT INTO session_history (${columns})
          SELECT provider, ${row.to}, project_path, user_id, chat_id,
            thread_id, title, model, effort, started_at, ${row.now},
            ${row.from}, ${row.reason}
          FROM session_history
          WHERE provider = ${row.provider} AND session_id = ${row.from}
          ON CONFLICT(provider, session_id) DO UPDATE SET
            last_active_at = max(last_active_at, excluded.last_active_at),
            previous_session_id = excluded.previous_session_id,
            previous_reason = excluded.previous_reason,
            title = CASE WHEN title = '' THEN excluded.title ELSE title END,
            started_at = min(started_at, excluded.started_at)`,
  });
  const selectOne = SqlSchema.findOneOption({
    Request: KeySchema,
    Result: Row,
    execute: (key) =>
      sql`SELECT ${columns} FROM session_history
          WHERE provider = ${key.provider} AND session_id = ${key.sessionId}`,
  });
  const selectPage = SqlSchema.findAll({
    Request: PageRequest,
    Result: ListedRow,
    execute: (request) =>
      sql`SELECT ${hColumns}, t.title AS topic_title
          FROM session_history h
          LEFT JOIN topics t
            ON t.chat_id = h.chat_id AND t.thread_id = h.thread_id
          WHERE h.provider IN ${sql.in(request.providers)} AND ${newest}
          ORDER BY h.last_active_at DESC, h.rowid DESC
          LIMIT ${request.limit} OFFSET ${request.offset}`,
  });
  const selectCounts = SqlSchema.findAll({
    Request: Schema.Array(Schema.String),
    Result: CountRow,
    execute: (providers) =>
      sql`SELECT h.provider, COUNT(*) AS n FROM session_history h
          WHERE h.provider IN ${sql.in(providers)} AND ${newest}
          GROUP BY h.provider`,
  });

  /** Record that a run is on this session: new, or resumed. */
  const record = Effect.fn("SessionHistoryRepo.record")(function* record(
    entry: SessionHistoryWrite
  ) {
    const now = yield* Clock.currentTimeMillis;
    yield* upsert({ ...entry, lastActiveAt: now, startedAt: now });
  }, persistence("SessionHistoryRepo.record"));

  /**
   * Record that session `to` continues `from` on the same provider, as a
   * compaction that starts a fresh session does: `to` takes `from`'s place in
   * `/history`, and `from` is still found by id. Nothing is written when
   * `from` was never recorded; the next run on `to` records it as new.
   */
  const succeed = Effect.fn("SessionHistoryRepo.succeed")(function* succeed(
    request: Omit<typeof Succession.Type, "now">
  ) {
    if (request.from === request.to) {
      return;
    }
    const now = yield* Clock.currentTimeMillis;
    yield* insertSuccessor({ ...request, now });
  }, persistence("SessionHistoryRepo.succeed"));

  /**
   * Add sessions found in a provider's own files, in one transaction. A
   * session already known is left as it is, but for a blank title.
   */
  const importPast = Effect.fn("SessionHistoryRepo.importPast")(
    function* importPast(entries: readonly SessionHistoryEntry[]) {
      yield* sql.withTransaction(
        Effect.forEach(entries, (entry) => insertPast(entry), {
          discard: true,
        })
      );
    },
    persistence("SessionHistoryRepo.importPast")
  );

  /** One session, none when it was never recorded. */
  const get = Effect.fn("SessionHistoryRepo.get")(function* get(
    key: SessionHistoryKey
  ) {
    return yield* selectOne(key);
  }, persistence("SessionHistoryRepo.get"));

  /**
   * Sessions on `providers`, most recently used first, each with its topic's
   * name; a session another continues is left out.
   */
  const page = Effect.fn("SessionHistoryRepo.page")(function* page(request: {
    limit: number;
    offset: number;
    providers: readonly string[];
  }) {
    if (request.providers.length === 0) {
      return [];
    }
    return yield* selectPage(request);
  }, persistence("SessionHistoryRepo.page"));

  /**
   * How many sessions each of `providers` lists, as `page` counts them; a
   * provider with none is absent.
   */
  const counts = Effect.fn("SessionHistoryRepo.counts")(function* counts(
    providers: readonly string[]
  ) {
    if (providers.length === 0) {
      return [];
    }
    return yield* selectCounts(providers);
  }, persistence("SessionHistoryRepo.counts"));

  return { counts, get, importPast, page, record, succeed } as const;
});

/**
 * Past conversations (`session_history`), one row per provider session.
 *
 * Transactions live only inside repositories. Never run the bridge, Telegram
 * or an agent inside `withTransaction`: the transaction holds the client's only
 * permit, so it would stall every other query in the process.
 */
export class SessionHistoryRepo extends Context.Service<
  SessionHistoryRepo,
  Effect.Success<typeof make>
>()("@workspace/db/SessionHistoryRepo") {
  static readonly layer = Layer.effect(SessionHistoryRepo, make);
}
