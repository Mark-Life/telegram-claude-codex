import { getBasicPeerType } from "@mtcute/bun";
import type { Message, Peer } from "@mtcute/bun";
import { SettingsRepo } from "@workspace/db";
import { Context, Effect, Layer, Option } from "effect";

import { TelegramAccount } from "../telegram/telegram-account";
import { topicIdOf } from "./present";

/**
 * What a run read on the owner's account, marked so in Telegram: a chat read
 * up to the newest message `get_history` returned and its mentions seen, a
 * voice note or round video listened once `download_media` fetched it. Both
 * follow the owner's `mark_read` switch from `/settings`, read on every call,
 * and both are best effort, in the background: a mark that fails is logged
 * and never fails or delays the read it follows. `mark_read`, the tool, is
 * the run asking for it, so it ignores the switch.
 */

/** The voice note or round video a message carries, if any. */
const playableOf = (message: Message) => {
  const { media } = message;
  return media?.type === "voice" || (media?.type === "video" && media.isRound)
    ? media
    : undefined;
};

/**
 * A voice note or round video the owner has not played. Self-destructing
 * media is left out: marking it played starts its timer, and a view-once one
 * is gone before the owner ever sees it.
 */
const unplayed = (message: Message) =>
  !message.isOutgoing &&
  message.hasUnreadMedia &&
  playableOf(message)?.ttlSeconds === null;

/**
 * A mention of the owner still unread: its own flag, which a read mark on the
 * chat leaves alone. A voice or round video mention stays for `download_media`.
 */
const unreadMention = (message: Message) =>
  !message.isOutgoing &&
  message.isMention &&
  message.hasUnreadMedia &&
  playableOf(message) === undefined;

/** How many topics of one forum `mark_read` goes through. */
const MAX_TOPICS = 500;
/** Topics marked at once: a busy forum page answers fast, short of a flood wait. */
const TOPIC_CONCURRENCY = 5;

const isForum = (peer: Peer) => peer.type === "chat" && peer.isForum;

/** The newest message per forum topic among `messages`; General has no entry. */
const newestByTopic = (messages: readonly Message[]) => {
  const newest = new Map<number, number>();
  for (const message of messages) {
    const topic = topicIdOf(message);
    if (topic !== null) {
      newest.set(topic, Math.max(message.id, newest.get(topic) ?? 0));
    }
  }
  return newest;
};

const make = Effect.gen(function* make() {
  const account = yield* TelegramAccount;
  const settings = yield* SettingsRepo;

  /**
   * The switch in force. A failed read leaves the chat as it was, the side
   * that changes nothing the owner sees.
   */
  const enabled = settings.get("mark_read").pipe(
    Effect.map((stored) => Option.getOrUndefined(stored) !== "off"),
    Effect.catch((error) =>
      Effect.logWarning("mark read setting read failed, not marking").pipe(
        Effect.annotateLogs({ reason: error.reason }),
        Effect.as(false)
      )
    )
  );

  /**
   * Mark a chat read up to `maxId`. A forum keeps a read state per topic, so
   * each topic in `topics` (topic id to its newest read message) is marked on
   * its own; the chat's own mark covers General. With `clearMentions` every
   * mention in the chat is seen too.
   */
  const readChat = (
    peer: Peer,
    input: {
      readonly clearMentions: boolean;
      readonly maxId: number;
      readonly topics: ReadonlyMap<number, number>;
    }
  ) =>
    Effect.andThen(
      account.use("readHistory", async (client) => {
        await client.readHistory(peer.id, {
          clearMentions: input.clearMentions,
          maxId: input.maxId,
        });
      }),
      Effect.forEach(
        input.topics,
        ([topic, readMaxId]) =>
          account.use("readDiscussion", async (client) => {
            await client.call({
              _: "messages.readDiscussion",
              msgId: topic,
              peer: await client.resolvePeer(peer.id),
              readMaxId,
            });
          }),
        { concurrency: TOPIC_CONCURRENCY, discard: true }
      )
    );

  /**
   * The `mark_read` tool: the chat read up to `upTo`, or all of it. In a forum,
   * every topic with unread messages is read up to the same message. Mentions
   * are cleared only with the whole chat: Telegram clears them chat-wide.
   */
  const markChat = (peer: Peer, upTo: number | undefined) =>
    Effect.gen(function* () {
      const topics = isForum(peer)
        ? yield* account.use("iterForumTopics", async (client) => {
            const unread = new Map<number, number>();
            for await (const topic of client.iterForumTopics(peer.id, {
              limit: MAX_TOPICS,
            })) {
              // The id alone: `lastMessage` throws when the page left it out.
              const last = topic.raw.topMessage;
              if (topic.unreadCount > 0) {
                unread.set(topic.id, Math.min(upTo ?? last, last));
              }
            }
            return unread;
          })
        : new Map<number, number>();
      yield* readChat(peer, {
        clearMentions: upTo === undefined,
        maxId: upTo ?? 0,
        topics,
      });
    });

  /**
   * Mark the contents of these messages read: a voice listened, a round video
   * watched, a mention seen.
   */
  const readContents = (peer: Peer, ids: readonly number[]) =>
    account.use("readMessageContents", async (client) => {
      if (getBasicPeerType(peer.id) === "channel") {
        await client.call({
          _: "channels.readMessageContents",
          channel: await client.resolveChannel(peer.id),
          id: [...ids],
        });
        return;
      }
      await client.call({ _: "messages.readMessageContents", id: [...ids] });
    });

  /**
   * A mark that follows a read: only with the switch on, never failing it,
   * and in the background, so the run gets its read without waiting on it.
   */
  const quietly = <E, R>(mark: Effect.Effect<void, E, R>) =>
    Effect.flatMap(enabled, (on) => (on ? mark : Effect.void)).pipe(
      // A failed call was already logged by `TelegramAccount`.
      Effect.catch((error) =>
        Effect.logDebug("account mark read skipped", error)
      ),
      Effect.forkDetach,
      Effect.asVoid
    );

  /**
   * After `get_history`. A page that ends at the newest message (`top`) reads
   * the chat up to it, each forum topic up to its own newest on the page, and,
   * outside a forum, every mention. An older page only marks the mentions it
   * holds: the chat is already read past it, or will be when the run reads
   * the newest page.
   */
  const afterHistory = (
    peer: Peer,
    messages: readonly Message[],
    top: boolean
  ) => {
    const newest = Math.max(0, ...messages.map((message) => message.id));
    const forum = isForum(peer);
    const mentions =
      top && !forum
        ? []
        : messages.flatMap((message) =>
            unreadMention(message) ? [message.id] : []
          );
    const marks = [
      ...(top && newest > 0
        ? [
            readChat(peer, {
              clearMentions: !forum,
              maxId: newest,
              topics: forum ? newestByTopic(messages) : new Map(),
            }),
          ]
        : []),
      ...(mentions.length > 0 ? [readContents(peer, mentions)] : []),
    ];
    return marks.length === 0
      ? Effect.void
      : quietly(Effect.all(marks, { concurrency: "unbounded", discard: true }));
  };

  /** After `download_media`: a voice note or round video, listened. */
  const afterDownload = (peer: Peer, message: Message) =>
    unplayed(message) ? quietly(readContents(peer, [message.id])) : Effect.void;

  return { afterDownload, afterHistory, markChat } as const;
});

export class MarkRead extends Context.Service<
  MarkRead,
  Effect.Success<typeof make>
>()("@workspace/MarkRead") {
  static readonly layer = Layer.effect(MarkRead, make);
}
