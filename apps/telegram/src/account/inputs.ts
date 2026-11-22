import { Long } from "@mtcute/bun";
import type { InputReaction, Message, Peer } from "@mtcute/bun";
import { Data, Effect, Option, Schema } from "effect";

import type { TelegramAccountHandle } from "../telegram/telegram-account";
import {
  MAX_IDS,
  MAX_WRITE_CHARS,
  parseCustomReaction,
  parsePeer,
  peerLabel,
} from "./present";

/**
 * What the account tools check in a run's input before anything reaches
 * Telegram: a chat reference, a date, the text of a write, a list of ids and
 * the opaque paging cursors the tools hand back. A wrong input fails with
 * `BadInput`, whose message goes back to the run as is.
 */

/** Input the run got wrong; its message goes back to the run as is. */
export class BadInput extends Data.TaggedError("BadInput")<{
  readonly message: string;
}> {}

export const badInput = (message: string) => new BadInput({ message });

const peerOf = (raw: number | string) => {
  const peer = parsePeer(String(raw));
  return peer === undefined
    ? Effect.fail(
        badInput(
          `Not a chat reference: ${String(raw)}. Use "me", a numeric id or a @username.`
        )
      )
    : Effect.succeed(peer);
};

/** Resolve a chat reference to the peer it names, as the account sees it. */
export const resolveChat = (
  account: TelegramAccountHandle,
  raw: number | string
) =>
  Effect.flatMap(peerOf(raw), (peer) =>
    account.use("getPeer", async (client) => await client.getPeer(peer))
  );

/**
 * A topic of a forum chat, looked up so a confirmation names it and a write
 * into a topic that does not exist is never offered to the owner. `param` is
 * the input that named it, for the error the run reads.
 */
export const forumTopic = Effect.fnUntraced(function* (input: {
  readonly account: TelegramAccountHandle;
  readonly chat: Peer;
  readonly id: number;
  readonly param: string;
}) {
  const { chat } = input;
  if (chat.type !== "chat" || !chat.isForum) {
    return yield* badInput(
      `That chat has no topics; leave out ${input.param}.`
    );
  }
  const [topic] = yield* input.account.use(
    "getForumTopicsById",
    async (client) => await client.getForumTopicsById(chat.id, input.id)
  );
  if (topic === null || topic === undefined) {
    return yield* badInput(
      `No topic ${input.id} in that chat (${input.param}). Use list_topics; never guess one.`
    );
  }
  return { draft: topic.draftMessage, id: topic.id, title: topic.title };
});

/**
 * Whether the owner wrote a message. mtcute's `isOutgoing` is Telegram's
 * `out`, which is false in Saved Messages, so a note there counts as the
 * owner's too, unless it is a forward: that text is someone else's, and
 * Telegram refuses to edit it.
 */
export const isOwn = (peer: Peer, message: Message) =>
  message.isOutgoing ||
  (peer.type === "user" && peer.isSelf && message.forward === null);

/** One message of a chat, or BadInput naming it. */
export const oneMessage = Effect.fnUntraced(function* (input: {
  readonly account: TelegramAccountHandle;
  readonly id: number;
  readonly peer: Peer;
}) {
  const { id, peer } = input;
  const [message] = yield* input.account.use(
    "getMessages",
    async (client) => await client.getMessages(peer.id, [id])
  );
  if (message === null || message === undefined) {
    return yield* badInput(`No message ${id} in that chat.`);
  }
  return message;
});

/** The messages found for `ids`, in order, and the ids with none. */
export const splitFound = (
  ids: readonly number[],
  found: readonly (Message | null)[]
) => ({
  messages: found.filter((message) => message !== null),
  missing: ids.filter((_, index) => !found[index]),
});

/**
 * Every message of `ids` in one chat, in order, or BadInput naming the ones
 * missing. `scheduled` looks among the chat's scheduled messages instead;
 * `where` names the chat in the error the run reads.
 */
export const allMessages = Effect.fnUntraced(function* (input: {
  readonly account: TelegramAccountHandle;
  readonly ids: readonly number[];
  readonly peer: Peer;
  readonly scheduled?: boolean;
  readonly where?: string;
}) {
  const { ids, peer } = input;
  const found = yield* input.scheduled === true
    ? input.account.use(
        "getScheduledMessages",
        async (client) => await client.getScheduledMessages(peer.id, [...ids])
      )
    : input.account.use(
        "getMessages",
        async (client) => await client.getMessages(peer.id, [...ids])
      );
  const { messages, missing } = splitFound(ids, found);
  if (missing.length > 0) {
    const where = input.where ?? "in that chat";
    return yield* badInput(
      input.scheduled === true
        ? `No scheduled message ${missing.join(", ")} ${where}. Use list_scheduled.`
        : `No message ${missing.join(", ")} ${where}.`
    );
  }
  return messages;
});

/** A chat as a write keeps it: its marked id and the label the owner reads. */
export const ref = (peer: Peer) => ({ id: peer.id, label: peerLabel(peer) });

export const parseDate = (raw: string | undefined) => {
  if (raw === undefined) {
    return Effect.succeedNone;
  }
  const at = Date.parse(raw);
  return Number.isFinite(at)
    ? Effect.succeedSome(new Date(at))
    : Effect.fail(badInput(`Invalid ISO date: ${raw}`));
};

/** A zone designator at the end of an ISO-8601 datetime: `Z` or `±hh:mm`. */
const ZONED = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/iu;
export const MS_PER_SECOND = 1000;
const MIN_SCHEDULE_SECONDS = 10;
/** How far ahead a scheduled write must still be when it goes out. */
export const MIN_SCHEDULE_MS = MIN_SCHEDULE_SECONDS * MS_PER_SECOND;
const MAX_SCHEDULE_DAYS = 365;
const MS_PER_DAY = 86_400_000;
const MAX_SCHEDULE_MS = MAX_SCHEDULE_DAYS * MS_PER_DAY;

/**
 * A future moment a write names, in ms: when a scheduled write goes out, or
 * when a mute ends. The datetime must carry its zone, so a run's local guess
 * is never read in the server's zone, and land between ten seconds and a year
 * from now, which is what Telegram accepts. `param` names the input in the
 * error the run reads.
 */
export const parseSchedule = (raw: string | undefined, param = "schedule") => {
  if (raw === undefined) {
    return Effect.succeedNone;
  }
  if (!ZONED.test(raw.trim())) {
    return Effect.fail(
      badInput(
        `${param} needs a zone: end it with Z or an offset like +03:00 (got ${raw}).`
      )
    );
  }
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) {
    return Effect.fail(badInput(`Invalid ISO date: ${raw}`));
  }
  const now = Date.now();
  if (at < now + MIN_SCHEDULE_MS || at > now + MAX_SCHEDULE_MS) {
    return Effect.fail(
      badInput(
        `${param} must be between ${MIN_SCHEDULE_SECONDS} seconds and ${MAX_SCHEDULE_DAYS} days from now.`
      )
    );
  }
  return Effect.succeedSome(at);
};

export const checkText = (text: string) => {
  if (text.trim().length === 0) {
    return Effect.fail(badInput("text must not be blank"));
  }
  return text.length > MAX_WRITE_CHARS
    ? Effect.fail(
        badInput(
          `text is ${text.length} characters; the limit is ${MAX_WRITE_CHARS}. Split it.`
        )
      )
    : Effect.succeed(text);
};

export const checkIds = (ids: readonly number[], max = MAX_IDS) =>
  ids.length === 0 || ids.length > max
    ? Effect.fail(badInput(`Give between 1 and ${max} message ids.`))
    : Effect.succeed(ids);

/**
 * Exactly one of `modes` is set. Each entry names the input and whether the
 * run gave it; the error names them all.
 */
export const exactlyOne = (modes: Readonly<Record<string, boolean>>) => {
  const given = Object.entries(modes).filter(([, set]) => set);
  return given.length === 1
    ? Effect.void
    : Effect.fail(
        badInput(`Give exactly one of ${Object.keys(modes).join(", ")}.`)
      );
};

/** Where a global search page ends: Telegram's offset, the peer by its id. */
export const GlobalCursor = Schema.Struct({
  id: Schema.Int,
  peer: Schema.Int,
  rate: Schema.Int,
});

/** Where a page of forum topics ends, as mtcute pages them. */
export const TopicCursor = Schema.Struct({
  date: Schema.Int,
  id: Schema.Int,
  topic: Schema.Int,
});

/** An opaque paging cursor: base64url JSON a tool hands back as `next_cursor`. */
export const encodeCursor = (
  value: typeof GlobalCursor.Type | typeof TopicCursor.Type
) => Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * A cursor the run passed back, decoded against what the tool wrote into it.
 * None when the run passed none; a cursor this tool never wrote is BadInput.
 */
export const decodeCursor = <S extends Schema.Codec<unknown, unknown>>(
  schema: S,
  raw: string | undefined
) => {
  if (raw === undefined) {
    return Effect.succeed(Option.none<S["Type"]>());
  }
  const text = Buffer.from(raw, "base64url").toString("utf-8");
  return Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
    Effect.map((value) => Option.some<S["Type"]>(value)),
    Effect.mapError(() =>
      badInput("Not a cursor from this tool; pass next_cursor back unchanged.")
    )
  );
};

/**
 * A reaction as mtcute takes it, from its name: an emoji, or `custom:<id>`
 * for a custom emoji, the way `present.ts` hands them out.
 */
export const toReaction = (name: string): InputReaction => {
  const custom = parseCustomReaction(name);
  return custom === undefined ? name : Long.fromString(custom);
};

/**
 * A reaction name from the run, trimmed; none when none is given. A blank
 * one is BadInput.
 */
export const parseReactionName = (raw: string | undefined) => {
  if (raw === undefined) {
    return Effect.succeed(Option.none<string>());
  }
  const value = raw.trim();
  return value === ""
    ? Effect.fail(badInput("emoji must not be blank."))
    : Effect.succeed(Option.some(value));
};

/** A reaction from the run as mtcute takes it; none when none is given. */
export const parseReaction = (raw: string | undefined) =>
  Effect.map(parseReactionName(raw), Option.map(toReaction));
