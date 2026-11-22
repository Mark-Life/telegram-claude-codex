import { Clock, Context, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { persistence } from "./errors";
import { Millis } from "./schema";

/** How long a presence check is trusted before the group is checked again. */
const HOURS_PER_DAY = 24;
const MS_PER_HOUR = 3_600_000;
export const PRESENCE_TTL_MS = HOURS_PER_DAY * MS_PER_HOUR;

/** Cached answer to "is the owner still in this group?". */
export const GroupEntrySchema = Schema.Struct({
  chatId: Schema.Int,
  checkedAt: Millis,
  ownerPresent: Schema.BooleanFromBit,
});

export type GroupEntry = typeof GroupEntrySchema.Type;

/** The `groups` row: the entry under its column names, `owner_present` a bit. */
const GroupRow = GroupEntrySchema.pipe(
  Schema.encodeKeys({
    chatId: "chat_id",
    checkedAt: "checked_at",
    ownerPresent: "owner_present",
  })
);

/** True when a cached check is old enough to be worth repeating. */
export const isStale = (entry: GroupEntry, now: number) =>
  now - entry.checkedAt >= PRESENCE_TTL_MS;

const make = Effect.gen(function* makeGroupsRepo() {
  const sql = yield* SqlClient.SqlClient;

  const selectOne = SqlSchema.findOneOption({
    Request: Schema.Int,
    Result: GroupRow,
    execute: (chatId) =>
      sql`SELECT chat_id, owner_present, checked_at FROM groups
          WHERE chat_id = ${chatId}`,
  });
  const upsert = SqlSchema.void({
    Request: GroupRow,
    execute: (row) =>
      sql`INSERT INTO groups (chat_id, owner_present, checked_at)
          VALUES (${row.chat_id}, ${row.owner_present}, ${row.checked_at})
          ON CONFLICT(chat_id) DO UPDATE SET
            owner_present = excluded.owner_present,
            checked_at = excluded.checked_at`,
  });
  const remove = SqlSchema.void({
    Request: Schema.Int,
    execute: (chatId) => sql`DELETE FROM groups WHERE chat_id = ${chatId}`,
  });

  /** The cached check for a group, none when it was never checked. */
  const get = Effect.fn("GroupsRepo.get")(function* get(chatId: number) {
    return yield* selectOne(chatId);
  }, persistence("GroupsRepo.get"));

  /** Record a fresh presence check, stamped now. */
  const remember = Effect.fn("GroupsRepo.remember")(function* remember(
    entry: Pick<GroupEntry, "chatId" | "ownerPresent">
  ) {
    const checkedAt = yield* Clock.currentTimeMillis;
    yield* upsert({
      chatId: entry.chatId,
      checkedAt,
      ownerPresent: entry.ownerPresent,
    });
  }, persistence("GroupsRepo.remember"));

  /** Forget a group entirely (the bot left it). */
  const forget = Effect.fn("GroupsRepo.forget")(function* forget(
    chatId: number
  ) {
    yield* remove(chatId);
  }, persistence("GroupsRepo.forget"));

  return { forget, get, remember } as const;
});

/**
 * Owner-presence cache (`groups`). The bot only works in groups the owner is a
 * member of; asking Telegram on every message would be a round trip per
 * update, so the answer is cached and re-checked once a day.
 *
 * Transactions live only inside repositories. Never run the bridge, Telegram
 * or an agent inside `withTransaction`: the transaction holds the client's only
 * permit, so it would stall every other query in the process.
 */
export class GroupsRepo extends Context.Service<
  GroupsRepo,
  Effect.Success<typeof make>
>()("@workspace/db/GroupsRepo") {
  static readonly layer = Layer.effect(GroupsRepo, make);
}
