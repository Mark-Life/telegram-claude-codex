import { Clock, Context, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { persistence } from "./errors";
import { Millis } from "./schema";

/**
 * Who gave a topic its name: Telegram (a name it made up), the user, or the
 * bot (its own title from the first message, or a topic it created).
 */
const TOPIC_TITLE_SOURCES = ["bot", "telegram", "user"] as const;

export type TopicTitleSource = (typeof TOPIC_TITLE_SOURCES)[number];

const TopicWrite = Schema.Struct({
  chatId: Schema.Int,
  source: Schema.Literals(TOPIC_TITLE_SOURCES),
  threadId: Schema.Int,
  title: Schema.String,
  updatedAt: Millis,
});

const make = Effect.gen(function* makeTopicsRepo() {
  const sql = yield* SqlClient.SqlClient;

  const upsert = SqlSchema.void({
    Request: TopicWrite,
    execute: (row) =>
      sql`INSERT INTO topics (chat_id, thread_id, title, title_source, updated_at)
          VALUES (${row.chatId}, ${row.threadId}, ${row.title}, ${row.source},
            ${row.updatedAt})
          ON CONFLICT(chat_id, thread_id) DO UPDATE SET
            title = excluded.title,
            title_source = excluded.title_source,
            updated_at = excluded.updated_at`,
  });

  /** Keep the name a topic has now; the last name written wins. */
  const name = Effect.fn("TopicsRepo.name")(function* name(
    entry: Omit<typeof TopicWrite.Type, "updatedAt">
  ) {
    const updatedAt = yield* Clock.currentTimeMillis;
    yield* upsert({ ...entry, updatedAt });
  }, persistence("TopicsRepo.name"));

  return { name } as const;
});

/**
 * Telegram topic names (`topics`), one row per topic. A name belongs to the
 * topic, not to a session: `/history` joins it onto every session the topic
 * hosted.
 */
export class TopicsRepo extends Context.Service<
  TopicsRepo,
  Effect.Success<typeof make>
>()("@workspace/db/TopicsRepo") {
  static readonly layer = Layer.effect(TopicsRepo, make);
}
