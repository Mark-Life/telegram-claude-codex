import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  FileLocation,
  getMarkedPeerId,
  Message,
  parsePeer as peerFromTl,
  PeersIndex,
  RawDocument,
  SearchFilters,
} from "@mtcute/bun";
import type { Peer, tl, TelegramClient } from "@mtcute/bun";
import { dataPath } from "@workspace/env/paths";
import { Context, Duration, Effect, Layer, Option } from "effect";

import { TelegramAccount } from "../telegram/telegram-account";
import {
  badInput,
  checkIds,
  checkText,
  decodeCursor,
  encodeCursor,
  exactlyOne,
  GlobalCursor,
  isOwn,
  MS_PER_SECOND,
  oneMessage,
  parseDate,
  parseReaction,
  resolveChat,
  splitFound,
  TopicCursor,
} from "./inputs";
import { MarkRead } from "./mark-read";
import {
  boundedLimit,
  fitList,
  MAX_IDS,
  presentDialog,
  presentFolder,
  presentMember,
  presentMessage,
  presentPeer,
  presentReactions,
  presentTopic,
  reactionName,
} from "./present";
import { BYTES_PER_MB, MS_PER_HOUR, pruneOlderThan } from "./scratch";
import type { ArgsOf, MEMBER_TYPES, SEARCH_FILTERS } from "./tool-call-schema";

/**
 * The `telegram_account` tools that only read. Each one answers bounded JSON
 * (`present.ts`); a list cut to the output cap says `truncated: true` and its
 * cursor points at the last item kept. Only `get_history` and
 * `download_media` change anything: the owner's read marks, under their
 * `mark_read` switch (`mark-read.ts`).
 */

const DEFAULT_DIALOGS = 30;
const MAX_DIALOGS = 100;
/** How many chats one `list_dialogs` or `unread_mentions` may page through. */
const MAX_DIALOG_SCAN = 500;
const DEFAULT_HISTORY = 30;
const MAX_HISTORY = 100;
const DEFAULT_SEARCH = 20;
const MAX_SEARCH = 50;
const DEFAULT_TOPICS = 30;
const MAX_TOPICS = 100;
const DEFAULT_CONTACTS = 50;
const MAX_CONTACTS = 100;
const DEFAULT_MEMBERS = 50;
const MAX_MEMBERS = 200;
const DEFAULT_REACTION_USERS = 50;
const MAX_REACTION_USERS = 100;
const DEFAULT_MENTIONS = 20;
const MAX_MENTIONS = 100;
/** Most chats one `unread_mentions` without a chat reads. */
const MAX_MENTION_CHATS = 20;
/** Chats read at once by `unread_mentions`, short of a flood wait. */
const MENTION_CONCURRENCY = 3;
/** How far up a reply chain `get_messages` follows. */
const MAX_REPLY_HOPS = 10;
const MAX_DOWNLOAD_MB = 50;
const MAX_DOWNLOAD_BYTES = MAX_DOWNLOAD_MB * BYTES_PER_MB;
/** `transcribe_voice` asks again this often while Telegram is still at it. */
const TRANSCRIBE_POLL_SECONDS = 3;
const TRANSCRIBE_POLL = Duration.seconds(TRANSCRIBE_POLL_SECONDS);
/** Times `transcribe_voice` asks again before it answers what it has. */
const TRANSCRIBE_RETRIES = 2;

/** Downloaded media lands here, one file per message. */
const MEDIA_DIR = dataPath("account-media");
const MEDIA_KEEP_HOURS = 24;
const MEDIA_KEEP_MS = MEDIA_KEEP_HOURS * MS_PER_HOUR;

const SEARCH_FILTER: Record<
  (typeof SEARCH_FILTERS)[number],
  tl.TypeMessagesFilter
> = {
  audio: SearchFilters.Audio,
  contact: SearchFilters.Contact,
  document: SearchFilters.Document,
  gif: SearchFilters.Gif,
  location: SearchFilters.Location,
  mention: SearchFilters.MyMention,
  photo: SearchFilters.Photo,
  photo_video: SearchFilters.PhotoAndVideo,
  pinned: SearchFilters.Pinned,
  poll: SearchFilters.Polls,
  round: SearchFilters.Round,
  round_voice: SearchFilters.RoundAndVoice,
  url: SearchFilters.Url,
  video: SearchFilters.Video,
  voice: SearchFilters.Voice,
};

const DIGITS = /^\d+$/u;

/** A chat search cursor: the id of the last message of the page before. */
const chatCursor = (raw: string | undefined) => {
  if (raw === undefined) {
    return Effect.succeedNone;
  }
  return DIGITS.test(raw)
    ? Effect.succeedSome(Number(raw))
    : Effect.fail(
        badInput(
          "Not a cursor from this tool; pass next_cursor back unchanged."
        )
      );
};

const TME_LINK = /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\//iu;
const LANGUAGE = /^[a-z]{2,3}(?:[-_][a-z\d]{2,8})?$/iu;

/** Messages out of a raw `messages.Messages` answer. */
const messagesOf = (res: tl.messages.TypeMessages) => {
  if (res._ === "messages.messagesNotModified") {
    return [];
  }
  const peers = PeersIndex.from(res);
  return res.messages.flatMap((raw) =>
    raw._ === "messageEmpty" ? [] : [new Message(raw, peers)]
  );
};

/** A peer named in a raw answer, or null when the answer left it out. */
const peerIn = (peer: tl.TypePeer, index: PeersIndex) => {
  try {
    return presentPeer(peerFromTl(peer, index));
  } catch {
    return {
      id: getMarkedPeerId(peer),
      name: null,
      type: null,
      username: null,
    };
  }
};

/** Telegram's answers to `getOutboxReadDate` that are an answer, not a fault. */
const READ_DATE_UNKNOWN = new Set([
  "USER_PRIVACY_RESTRICTED",
  "YOUR_PRIVACY_RESTRICTED",
  "MESSAGE_TOO_OLD",
]);

/** Member lists Telegram searches by name; the others ignore a query. */
const QUERY_MEMBER_TYPES: ReadonlySet<(typeof MEMBER_TYPES)[number]> = new Set([
  "all",
  "banned",
  "restricted",
  "contacts",
  "mention",
] as const);

/** The member lists a basic group has, filtered here. */
const BASIC_GROUP_MEMBER_TYPES: ReadonlySet<(typeof MEMBER_TYPES)[number]> =
  new Set(["all", "recent", "admins", "bots"] as const);

/**
 * The id a message answers, if any. In a forum topic a message that answers
 * nothing still carries the topic root as `replyToMsgId`, with no
 * `replyToTopId`; that is the topic header, not a reply.
 */
const repliedId = (message: Message): number | null => {
  const replied = message.replyToMessage;
  const topicHeader =
    replied?.isForumTopic === true && replied.raw.replyToTopId === undefined;
  return topicHeader ? null : (replied?.id ?? null);
};

/**
 * Up a reply chain from one message: it, what it answers, and so on, at
 * most `MAX_REPLY_HOPS` up. `complete` is false when the chain goes on.
 */
const replyChain = async (client: TelegramClient, start: Message) => {
  const chain = [start];
  let current = start;
  for (let hop = 0; hop < MAX_REPLY_HOPS; hop += 1) {
    if (repliedId(current) === null) {
      return { chain, complete: true };
    }
    // oxlint-disable-next-line no-await-in-loop -- each hop needs the one before
    const parent = await client.getReplyTo(current);
    if (parent === null) {
      return { chain, complete: true };
    }
    chain.push(parent);
    current = parent;
  }
  return { chain, complete: repliedId(current) === null };
};

const make = Effect.gen(function* make() {
  const account = yield* TelegramAccount;
  const markRead = yield* MarkRead;
  const resolve = (raw: number | string) => resolveChat(account, raw);

  const listDialogs = Effect.fnUntraced(function* (
    input: ArgsOf<"list_dialogs">
  ) {
    const limit = boundedLimit(input.limit, DEFAULT_DIALOGS, MAX_DIALOGS);
    const skip = input.offset ?? 0;
    const page = yield* account.use("iterDialogs", async (client) => {
      const found = [];
      let matched = 0;
      let more = false;
      for await (const dialog of client.iterDialogs({
        archived: input.archived === true ? "keep" : "exclude",
        folder: input.folder,
        limit: MAX_DIALOG_SCAN,
      })) {
        if (input.unread_only !== true || dialog.unreadCount > 0) {
          if (matched >= skip + limit) {
            more = true;
            break;
          }
          if (matched >= skip) {
            found.push(presentDialog(dialog));
          }
          matched += 1;
        }
      }
      return { found, more };
    });
    return {
      peerId: null,
      value: fitList(page.found, (dialogs, cut) => ({
        dialogs,
        next_offset: cut || page.more ? skip + dialogs.length : null,
      })),
    };
  });

  /**
   * A page of one chat. Newest first by default, back from `before_id` or
   * `to`, stopping at `from`; oldest first forward from `after_id`. mtcute
   * pages history by id and date only, so `from` is a cutoff read here.
   */
  const getHistory = Effect.fnUntraced(function* (
    input: ArgsOf<"get_history">
  ) {
    if (
      input.after_id !== undefined &&
      (input.before_id !== undefined || input.to !== undefined)
    ) {
      return yield* badInput(
        "after_id pages forward; leave out before_id and to with it."
      );
    }
    const peer = yield* resolve(input.chat);
    const limit = boundedLimit(input.limit, DEFAULT_HISTORY, MAX_HISTORY);
    const from = Option.getOrUndefined(yield* parseDate(input.from));
    const to = Option.getOrUndefined(yield* parseDate(input.to));
    const afterId = input.after_id;
    const fetched = yield* account.use(
      "getHistory",
      async (client) =>
        await client.getHistory(
          peer.id,
          afterId === undefined
            ? {
                limit,
                maxId: input.before_id,
                offset:
                  to === undefined
                    ? undefined
                    : {
                        date: Math.floor(to.getTime() / MS_PER_SECOND),
                        id: 0,
                      },
              }
            : { limit, offset: { date: 0, id: afterId + 1 }, reverse: true }
        )
    );
    yield* markRead.afterHistory(
      peer,
      fetched,
      input.before_id === undefined && afterId === undefined && to === undefined
    );
    const kept =
      from === undefined
        ? fetched
        : fetched.filter((message) => message.date >= from);
    const chat = presentPeer(peer);
    if (afterId !== undefined) {
      // A page `from` emptied still moves on past what it fetched.
      const pageEnd =
        fetched.length >= limit ? (fetched.at(-1)?.id ?? null) : null;
      return {
        peerId: peer.id,
        value: fitList(kept.map(presentMessage), (messages, cut) => ({
          chat,
          messages,
          next_after_id: cut ? (messages.at(-1)?.id ?? null) : pageEnd,
          order: "oldest_first",
        })),
      };
    }
    const reachedFrom = kept.length < fetched.length;
    const full = fetched.length >= limit && !reachedFrom;
    return {
      peerId: peer.id,
      value: fitList(kept.map(presentMessage), (messages, cut) => ({
        chat,
        messages,
        next_before_id: cut || full ? (messages.at(-1)?.id ?? null) : null,
        order: "newest_first",
        reached_from: reachedFrom,
      })),
    };
  });

  const searchMessages = Effect.fnUntraced(function* (
    input: ArgsOf<"search_messages">
  ) {
    const query = input.query?.trim() === "" ? undefined : input.query;
    if (
      query === undefined &&
      input.filter === undefined &&
      input.from_user === undefined &&
      input.thread_id === undefined
    ) {
      return yield* badInput(
        "Give query, filter, from_user or thread_id: an empty search finds nothing."
      );
    }
    const limit = boundedLimit(input.limit, DEFAULT_SEARCH, MAX_SEARCH);
    const minDate = Option.getOrUndefined(yield* parseDate(input.from));
    const maxDate = Option.getOrUndefined(yield* parseDate(input.to));
    const filter =
      input.filter === undefined ? undefined : SEARCH_FILTER[input.filter];
    if (input.chat === undefined) {
      if (input.from_user !== undefined || input.thread_id !== undefined) {
        return yield* badInput(
          "from_user and thread_id need chat: a search across all chats cannot narrow by them."
        );
      }
      const cursor = yield* decodeCursor(GlobalCursor, input.cursor);
      const found = yield* account.use("searchGlobal", async (client) => {
        const offset = Option.isNone(cursor)
          ? undefined
          : {
              id: cursor.value.id,
              peer: await client.resolvePeer(cursor.value.peer),
              rate: cursor.value.rate,
            };
        return await client.searchGlobal({
          filter,
          limit,
          maxDate,
          minDate,
          offset,
          query,
        });
      });
      const { next } = found;
      return {
        peerId: null,
        value: fitList(found, (kept, cut) => {
          const last = kept.at(-1);
          const cutCursor =
            last === undefined
              ? null
              : encodeCursor({
                  id: last.id,
                  peer: last.chat.id,
                  rate: last.raw.date,
                });
          const fullCursor =
            next === undefined || found.length < limit
              ? null
              : encodeCursor({
                  id: next.id,
                  peer: getMarkedPeerId(next.peer),
                  rate: next.rate,
                });
          return {
            messages: kept.map(presentMessage),
            next_cursor: cut ? cutCursor : fullCursor,
            total: found.total,
          };
        }),
      };
    }
    const offset = Option.getOrUndefined(yield* chatCursor(input.cursor));
    const peer = yield* resolve(input.chat);
    const fromUser =
      input.from_user === undefined
        ? undefined
        : (yield* resolve(input.from_user)).id;
    const found = yield* account.use(
      "searchMessages",
      async (client) =>
        await client.searchMessages({
          chatId: peer.id,
          filter,
          fromUser,
          limit,
          maxDate,
          minDate,
          offset,
          query,
          threadId: input.thread_id,
        })
    );
    return {
      peerId: peer.id,
      value: fitList(found, (kept, cut) => {
        const last = kept.at(-1);
        const more = cut || found.length >= limit;
        return {
          messages: kept.map(presentMessage),
          next_cursor: more && last !== undefined ? String(last.id) : null,
          total: found.total,
        };
      }),
    };
  });

  const getChat = Effect.fnUntraced(function* (input: ArgsOf<"get_chat">) {
    const peer = yield* resolve(input.chat);
    const about = yield* account.use("getFull", async (client) => {
      if (peer.type === "user") {
        const full = await client.getFullUser(peer.id);
        return { bio: full.bio, members: null };
      }
      const full = await client.getFullChat(peer.id);
      return { bio: full.bio, members: full.membersCount };
    });
    return {
      peerId: peer.id,
      value: { ...presentPeer(peer), about: about.bio, members: about.members },
    };
  });

  /**
   * Every message of the album one message belongs to, oldest first, however
   * history paging split it. mtcute's `getMessageGroup` throws on a message
   * outside an album, so that case is answered with the message alone.
   */
  const getAlbum = Effect.fnUntraced(function* (input: ArgsOf<"get_album">) {
    const peer = yield* resolve(input.chat);
    const message = yield* oneMessage({ account, id: input.message_id, peer });
    const members =
      message.groupedId === null
        ? [message]
        : yield* account.use(
            "getMessageGroup",
            async (client) =>
              await client.getMessageGroup({
                chatId: peer.id,
                message: input.message_id,
              })
          );
    // oxlint-disable-next-line unicorn/no-array-sort -- a local copy; nothing shared is mutated
    const ordered = [...members].sort((a, b) => a.id - b.id);
    return {
      peerId: peer.id,
      value: {
        chat: presentPeer(peer),
        message_ids: ordered.map((member) => member.id),
        messages: ordered.map(presentMessage),
      },
    };
  });

  const downloadMedia = Effect.fnUntraced(function* (
    input: ArgsOf<"download_media">
  ) {
    const peer = yield* resolve(input.chat);
    const message = yield* oneMessage({ account, id: input.message_id, peer });
    const { media } = message;
    if (!(media instanceof FileLocation)) {
      return yield* badInput("That message has no downloadable media.");
    }
    if ((media.fileSize ?? 0) > MAX_DOWNLOAD_BYTES) {
      return yield* badInput(`The file is larger than ${MAX_DOWNLOAD_MB} MB.`);
    }
    const stored = media instanceof RawDocument ? media.fileName : null;
    const name = stored === null ? `${media.type}.bin` : path.basename(stored);
    const target = path.join(
      MEDIA_DIR,
      `${peer.id}-${input.message_id}-${name}`
    );
    yield* account.use("downloadToFile", async (client) => {
      // Retention is best effort; it never fails the download it precedes.
      await pruneOlderThan(MEDIA_DIR, MEDIA_KEEP_MS);
      await mkdir(MEDIA_DIR, { recursive: true });
      await client.downloadToFile(target, media);
    });
    yield* markRead.afterDownload(peer, message);
    return { peerId: peer.id, value: { path: target, type: media.type } };
  });

  /** Every draft the owner left, across chats and forum topics. */
  const listDrafts = Effect.fnUntraced(function* () {
    const res = yield* account.use(
      "getAllDrafts",
      async (client) => await client.call({ _: "messages.getAllDrafts" })
    );
    const drafts =
      res._ === "updates" || res._ === "updatesCombined"
        ? res.updates.flatMap((update) => {
            if (
              update._ !== "updateDraftMessage" ||
              update.draft._ !== "draftMessage"
            ) {
              return [];
            }
            const { draft } = update;
            const index = PeersIndex.from(res);
            return [
              {
                chat: peerIn(update.peer, index),
                date: new Date(draft.date * MS_PER_SECOND).toISOString(),
                reply_to:
                  draft.replyTo?._ === "inputReplyToMessage"
                    ? draft.replyTo.replyToMsgId
                    : null,
                text: draft.message,
                topic_id: update.topMsgId ?? null,
              },
            ];
          })
        : [];
    return {
      peerId: null,
      value: fitList(drafts, (kept) => ({ drafts: kept })),
    };
  });

  const listTopics = Effect.fnUntraced(function* (
    input: ArgsOf<"list_topics">
  ) {
    const peer = yield* resolve(input.chat);
    if (peer.type !== "chat" || !peer.isForum) {
      return yield* badInput("That chat has no topics.");
    }
    const limit = boundedLimit(input.limit, DEFAULT_TOPICS, MAX_TOPICS);
    const cursor = yield* decodeCursor(TopicCursor, input.cursor);
    const topics = yield* account.use(
      "getForumTopics",
      async (client) =>
        await client.getForumTopics(peer.id, {
          limit,
          offset: Option.getOrUndefined(cursor),
          query: input.query,
        })
    );
    const { next } = topics;
    return {
      peerId: peer.id,
      value: {
        chat: presentPeer(peer),
        next_cursor:
          next === undefined || topics.length < limit
            ? null
            : encodeCursor(next),
        topics: topics.map(presentTopic),
      },
    };
  });

  const getMessages = Effect.fnUntraced(function* (
    input: ArgsOf<"get_messages">
  ) {
    yield* exactlyOne({
      comments_of: input.comments_of !== undefined,
      link: input.link !== undefined,
      message_ids: input.message_ids !== undefined,
      reply_chain_of: input.reply_chain_of !== undefined,
    });
    if (input.link !== undefined) {
      const { link } = input;
      if (!TME_LINK.test(link.trim())) {
        return yield* badInput("link must be a t.me message link.");
      }
      const message = yield* account.use(
        "getMessageByLink",
        async (client) => await client.getMessageByLink(link.trim())
      );
      if (message === null) {
        return yield* badInput("No message at that link.");
      }
      return {
        peerId: message.chat.id,
        value: {
          chat: presentPeer(message.chat),
          messages: [presentMessage(message)],
        },
      };
    }
    if (input.chat === undefined) {
      return yield* badInput("chat is needed with this mode.");
    }
    const peer = yield* resolve(input.chat);
    const chat = presentPeer(peer);
    if (input.message_ids !== undefined) {
      const ids = yield* checkIds(input.message_ids, MAX_IDS);
      const found = yield* account.use(
        "getMessages",
        async (client) => await client.getMessages(peer.id, [...ids])
      );
      const split = splitFound(ids, found);
      const { missing } = split;
      const messages = split.messages.map(presentMessage);
      return {
        peerId: peer.id,
        value: fitList(messages, (kept) => ({ chat, messages: kept, missing })),
      };
    }
    if (input.reply_chain_of !== undefined) {
      const start = yield* oneMessage({
        account,
        id: input.reply_chain_of,
        peer,
      });
      const { chain, complete } = yield* account.use(
        "getReplyTo",
        async (client) => await replyChain(client, start)
      );
      return {
        peerId: peer.id,
        value: fitList(chain.map(presentMessage), (kept, cut) => ({
          chat,
          complete: complete && !cut,
          messages: kept,
          order: "message_first_then_what_it_replies_to",
        })),
      };
    }
    const postId = input.comments_of ?? 0;
    const discussion = yield* account.use(
      "getDiscussionMessage",
      async (client) =>
        await client.getDiscussionMessage({ chatId: peer.id, message: postId })
    );
    if (discussion === null) {
      return yield* badInput("That post has no comments.");
    }
    return {
      peerId: peer.id,
      value: {
        discussion_chat: presentPeer(discussion.chat),
        hint: `Read the comments with search_messages {"chat": ${discussion.chat.id}, "thread_id": ${discussion.id}}.`,
        message: presentMessage(discussion),
      },
    };
  });

  const listContacts = Effect.fnUntraced(function* (
    input: ArgsOf<"list_contacts">
  ) {
    const limit = boundedLimit(input.limit, DEFAULT_CONTACTS, MAX_CONTACTS);
    const query = input.query?.trim() ?? "";
    if (query === "") {
      const skip = input.offset ?? 0;
      const all = yield* account.use(
        "getContacts",
        async (client) => await client.getContacts()
      );
      const page = all.slice(skip, skip + limit).map(presentPeer);
      return {
        peerId: null,
        value: fitList(page, (contacts, cut) => ({
          contacts,
          next_offset:
            cut || skip + limit < all.length ? skip + contacts.length : null,
          total: all.length,
        })),
      };
    }
    const res = yield* account.use(
      "contactsSearch",
      async (client) =>
        await client.call({ _: "contacts.search", limit, q: query })
    );
    const index = PeersIndex.from(res);
    return {
      peerId: null,
      value: {
        global: res.results.map((peer) => peerIn(peer, index)),
        mine: res.myResults.map((peer) => peerIn(peer, index)),
      },
    };
  });

  const getCommonChats = Effect.fnUntraced(function* (
    input: ArgsOf<"get_common_chats">
  ) {
    const peer = yield* resolve(input.user);
    if (peer.type !== "user") {
      return yield* badInput("user must name a person, not a chat.");
    }
    const chats = yield* account.use(
      "getCommonChats",
      async (client) => await client.getCommonChats(peer.id)
    );
    return {
      peerId: peer.id,
      value: { chats: chats.map(presentPeer), user: presentPeer(peer) },
    };
  });

  /**
   * Members of a basic group, filtered here: Telegram hands back the whole
   * list at once and mtcute ignores `type` and `query` for one. Only the
   * types such a group has are taken.
   */
  const basicGroupMembers = Effect.fnUntraced(function* (input: {
    readonly peer: Peer;
    readonly query: string | undefined;
    readonly type: (typeof MEMBER_TYPES)[number];
  }) {
    const { peer, type } = input;
    if (!BASIC_GROUP_MEMBER_TYPES.has(type)) {
      return yield* badInput(
        `A basic group has no ${type} list; use type ${[...BASIC_GROUP_MEMBER_TYPES].join(", ")}.`
      );
    }
    const all = yield* account.use(
      "getChatMembers",
      // A limit of 0 is mtcute's "no slice": the whole list.
      async (client) => await client.getChatMembers(peer.id, { limit: 0 })
    );
    const needle = input.query?.toLowerCase();
    const members = all.filter(
      (member) =>
        (type !== "admins" ||
          member.status === "creator" ||
          member.status === "admin") &&
        (type !== "bots" || member.user.isBot) &&
        (needle === undefined ||
          member.user.displayName.toLowerCase().includes(needle) ||
          (member.user.username?.toLowerCase().includes(needle) ?? false))
    );
    return { members, total: members.length };
  });

  const listMembers = Effect.fnUntraced(function* (
    input: ArgsOf<"list_members">
  ) {
    const peer = yield* resolve(input.chat);
    if (peer.type !== "chat") {
      return yield* badInput("chat must be a group or a channel.");
    }
    const limit = boundedLimit(input.limit, DEFAULT_MEMBERS, MAX_MEMBERS);
    const skip = input.offset ?? 0;
    const query = input.query?.trim() === "" ? undefined : input.query?.trim();
    // Telegram's recent list is the default, but it takes no name; a query
    // alone searches everyone.
    const type = input.type ?? (query === undefined ? "recent" : "all");
    if (query !== undefined && !QUERY_MEMBER_TYPES.has(type)) {
      return yield* badInput(
        `query works with type ${[...QUERY_MEMBER_TYPES].join(", ")}; leave it out for ${type}.`
      );
    }
    const { members, total } =
      peer.chatType === "group"
        ? yield* basicGroupMembers({ peer, query, type })
        : yield* account
            .use(
              "getChatMembers",
              async (client) =>
                await client.getChatMembers(peer.id, {
                  limit,
                  offset: skip,
                  query,
                  type,
                })
            )
            .pipe(Effect.map((page) => ({ members: page, total: page.total })));
    const page =
      peer.chatType === "group" ? members.slice(skip, skip + limit) : members;
    return {
      peerId: peer.id,
      value: fitList(page.map(presentMember), (kept, cut) => ({
        members: kept,
        next_offset: cut || page.length >= limit ? skip + kept.length : null,
        total,
      })),
    };
  });

  const listScheduled = Effect.fnUntraced(function* (
    input: ArgsOf<"list_scheduled">
  ) {
    const peer = yield* resolve(input.chat);
    const scheduled = yield* account.use(
      "getAllScheduledMessages",
      async (client) => await client.getAllScheduledMessages(peer.id)
    );
    const messages = scheduled.map((message) => ({
      ...presentMessage(message),
      scheduled_for: message.date.toISOString(),
    }));
    return {
      peerId: peer.id,
      value: fitList(messages, (kept) => ({
        chat: presentPeer(peer),
        messages: kept,
      })),
    };
  });

  const getReactions = Effect.fnUntraced(function* (
    input: ArgsOf<"get_reactions">
  ) {
    const peer = yield* resolve(input.chat);
    const emoji = Option.getOrUndefined(yield* parseReaction(input.emoji));
    const [reactions] = yield* account.use(
      "getMessageReactionsById",
      async (client) =>
        await client.getMessageReactionsById(peer.id, [input.message_id])
    );
    if (reactions === null || reactions === undefined) {
      return {
        peerId: peer.id,
        value: { reactions: [], users: null, users_hidden_reason: null },
      };
    }
    const counts = presentReactions(reactions);
    if (!reactions.usersVisible) {
      return {
        peerId: peer.id,
        value: {
          reactions: counts,
          users: null,
          users_hidden_reason:
            "Telegram does not show who reacted here (a channel, or a group that hides it).",
        },
      };
    }
    const limit = boundedLimit(
      input.limit,
      DEFAULT_REACTION_USERS,
      MAX_REACTION_USERS
    );
    const users = yield* account.use(
      "getReactionUsers",
      async (client) =>
        await client.getReactionUsers({
          chatId: peer.id,
          emoji,
          limit,
          message: input.message_id,
          offset: input.cursor,
        })
    );
    return {
      peerId: peer.id,
      value: {
        next_cursor: users.next ?? null,
        reactions: counts,
        users: users.map((reaction) => ({
          emoji: reactionName(reaction.emoji),
          user: presentPeer(reaction.peer),
        })),
      },
    };
  });

  /** The unread mentions and reactions of one chat; neither is marked read. */
  const unreadIn = (
    peer: Peer,
    input: {
      readonly limit: number;
      readonly mentions: boolean;
      readonly reactions: boolean;
    }
  ) =>
    account.use("getUnreadMentions", async (client) => {
      const inputPeer = await client.resolvePeer(peer.id);
      const page = {
        addOffset: 0,
        limit: input.limit,
        maxId: 0,
        minId: 0,
        offsetId: 0,
        peer: inputPeer,
      };
      const [mentions, reactions] = await Promise.all([
        input.mentions
          ? client.call({ _: "messages.getUnreadMentions", ...page })
          : null,
        input.reactions
          ? client.call({ _: "messages.getUnreadReactions", ...page })
          : null,
      ]);
      return {
        chat: presentPeer(peer),
        mentions:
          mentions === null ? [] : messagesOf(mentions).map(presentMessage),
        reactions:
          reactions === null ? [] : messagesOf(reactions).map(presentMessage),
      };
    });

  const unreadMentions = Effect.fnUntraced(function* (
    input: ArgsOf<"unread_mentions">
  ) {
    const limit = boundedLimit(input.limit, DEFAULT_MENTIONS, MAX_MENTIONS);
    if (input.chat !== undefined) {
      const peer = yield* resolve(input.chat);
      const one = yield* unreadIn(peer, {
        limit,
        mentions: true,
        reactions: true,
      });
      return {
        peerId: peer.id,
        value: fitList([one], (chats) => ({ chats })),
      };
    }
    const pending = yield* account.use("iterDialogs", async (client) => {
      const found = [];
      for await (const dialog of client.iterDialogs({
        archived: "keep",
        limit: MAX_DIALOG_SCAN,
      })) {
        if (dialog.unreadMentionsCount > 0 || dialog.unreadReactionsCount > 0) {
          found.push({
            mentions: dialog.unreadMentionsCount > 0,
            peer: dialog.peer,
            reactions: dialog.unreadReactionsCount > 0,
          });
        }
        if (found.length >= MAX_MENTION_CHATS) {
          break;
        }
      }
      return found;
    });
    const chats = yield* Effect.forEach(
      pending,
      (entry) =>
        unreadIn(entry.peer, {
          limit,
          mentions: entry.mentions,
          reactions: entry.reactions,
        }),
      { concurrency: MENTION_CONCURRENCY }
    );
    return { peerId: null, value: fitList(chats, (kept) => ({ chats: kept })) };
  });

  /**
   * Whether the other side read one of the owner's messages. The chat's read
   * mark answers most of it without asking; only a private chat with a person
   * has a read time, and their privacy settings may hide it.
   */
  const readDate = Effect.fnUntraced(function* (input: ArgsOf<"read_date">) {
    const peer = yield* resolve(input.chat);
    const message = yield* oneMessage({ account, id: input.message_id, peer });
    if (!isOwn(peer, message)) {
      return yield* badInput("read_date works on your own messages only.");
    }
    // A note in Saved Messages has no other side; it counts as read.
    if (peer.type === "user" && peer.isSelf) {
      return { peerId: peer.id, value: { read: true, read_at: null } };
    }
    const [dialog] = yield* account.use(
      "getPeerDialogs",
      async (client) => await client.getPeerDialogs(peer.id)
    );
    const answer = <Value>(value: Value) => ({ peerId: peer.id, value });
    if (dialog === null || dialog === undefined) {
      return answer({ read: "unknown", reason: "No dialog with that chat." });
    }
    if (input.message_id > dialog.lastReadOutgoing) {
      return answer({ read: false });
    }
    if (peer.type !== "user" || peer.isBot) {
      return answer({ read: true, read_at: null });
    }
    return yield* account
      .use("getOutboxReadDate", async (client) => {
        const res = await client.call({
          _: "messages.getOutboxReadDate",
          msgId: input.message_id,
          peer: await client.resolvePeer(peer.id),
        });
        return answer({
          read: true,
          read_at: new Date(res.date * MS_PER_SECOND).toISOString(),
        });
      })
      .pipe(
        Effect.catchIf(
          (error) => error.rpc === "MESSAGE_NOT_READ_YET",
          () => Effect.succeed(answer({ read: false }))
        ),
        Effect.catchIf(
          (error) =>
            error.rpc !== undefined && READ_DATE_UNKNOWN.has(error.rpc),
          (error) =>
            Effect.succeed(
              answer({ read: true, read_at: null, reason: error.rpc })
            )
        )
      );
  });

  /**
   * Telegram's own transcript of a voice note or round video. Updates are
   * off, so a transcript still in the works is asked for again a couple of
   * times before what there is goes back.
   */
  const transcribeVoice = Effect.fnUntraced(function* (
    input: ArgsOf<"transcribe_voice">
  ) {
    const peer = yield* resolve(input.chat);
    const message = yield* oneMessage({ account, id: input.message_id, peer });
    const { media } = message;
    if (
      media?.type !== "voice" &&
      !(media?.type === "video" && media.isRound)
    ) {
      return yield* badInput(
        "That message is not a voice note or a round video."
      );
    }
    const ask = account.use(
      "transcribeAudio",
      async (client) =>
        await client.call({
          _: "messages.transcribeAudio",
          msgId: input.message_id,
          peer: await client.resolvePeer(peer.id),
        })
    );
    const done = (pending: boolean, text: string) => ({
      peerId: peer.id,
      value: { pending, text },
    });
    return yield* ask.pipe(
      Effect.flatMap((first) =>
        first.pending === true
          ? ask.pipe(
              Effect.delay(TRANSCRIBE_POLL),
              Effect.repeat({
                times: TRANSCRIBE_RETRIES - 1,
                until: (next) => next.pending !== true,
              }),
              Effect.map((last) => done(last.pending === true, last.text))
            )
          : Effect.succeed(done(false, first.text))
      ),
      Effect.catchIf(
        (error) => error.rpc === "PREMIUM_ACCOUNT_REQUIRED",
        () =>
          Effect.succeed({
            peerId: peer.id,
            value: {
              pending: false,
              reason:
                "Telegram transcription needs Premium on this account; use download_media and transcribe the file instead.",
              text: null,
            },
          })
      )
    );
  });

  const translate = Effect.fnUntraced(function* (input: ArgsOf<"translate">) {
    const toLanguage = input.to_language.trim();
    if (!LANGUAGE.test(toLanguage)) {
      return yield* badInput(
        `to_language must be a language code like "en" or "ru" (got ${input.to_language}).`
      );
    }
    yield* exactlyOne({
      "chat with message_id":
        input.chat !== undefined || input.message_id !== undefined,
      text: input.text !== undefined,
    });
    if (input.text !== undefined) {
      const text = yield* checkText(input.text);
      const result = yield* account.use(
        "translateText",
        async (client) => await client.translateText(text, toLanguage)
      );
      return {
        peerId: null,
        value: { text: result.text, to_language: toLanguage },
      };
    }
    if (input.chat === undefined || input.message_id === undefined) {
      return yield* badInput("Give both chat and message_id.");
    }
    const peer = yield* resolve(input.chat);
    const messageId = input.message_id;
    const result = yield* account.use(
      "translateMessage",
      async (client) =>
        await client.translateMessage({
          chatId: peer.id,
          message: messageId,
          toLanguage,
        })
    );
    return {
      peerId: peer.id,
      value: { text: result.text, to_language: toLanguage },
    };
  });

  const listFolders = Effect.fnUntraced(function* () {
    const res = yield* account.use(
      "getFolders",
      async (client) => await client.getFolders()
    );
    return { peerId: null, value: { folders: res.filters.map(presentFolder) } };
  });

  return {
    downloadMedia,
    getAlbum,
    getChat,
    getCommonChats,
    getHistory,
    getMessages,
    getReactions,
    listContacts,
    listDialogs,
    listDrafts,
    listFolders,
    listMembers,
    listScheduled,
    listTopics,
    readDate,
    searchMessages,
    transcribeVoice,
    translate,
    unreadMentions,
  } as const;
});

/** The read-only `telegram_account` tools. */
export class ReadTools extends Context.Service<
  ReadTools,
  Effect.Success<typeof make>
>()("@workspace/ReadTools") {
  static readonly layer = Layer.effect(ReadTools, make);
}
