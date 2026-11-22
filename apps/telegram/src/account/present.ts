import { FileLocation, Long, RawDocument } from "@mtcute/bun";
import type {
  ChatMember,
  Dialog,
  DraftMessage,
  ForumTopic,
  InputPeerLike,
  Message,
  MessageReactions,
  Peer,
  PeerSender,
  ReactionEmoji,
  tl,
} from "@mtcute/bun";
import { absurd } from "effect/Function";

/**
 * What the account tools hand a run: plain JSON built from mtcute objects,
 * bounded in size. Every text field here is written by someone other than the
 * owner and is untrusted; the tool descriptions and the run prompt say so.
 */

/** What one tool produced: the JSON the run reads and the chat it touched. */
export interface ToolOutput {
  /**
   * How the call's ledger line names it, when the tool's own class cannot:
   * a `tg_call` is `read` or `local` by the method's class, and recorded as
   * `tg_call:<method>`.
   */
  readonly ledger?: {
    readonly access: "local" | "read";
    readonly tool: string;
  };
  readonly peerId: number | null;
  readonly value: object;
}

/** Longest message text a tool returns; longer text is cut with an ellipsis. */
export const MAX_TEXT_CHARS = 2000;
/** Preview length of a chat's last message in the dialog list. */
const LAST_MESSAGE_CHARS = 200;
/** Longest text a run may send or put in an edit, to fit one message. */
export const MAX_WRITE_CHARS = 3500;
/** Most ids a forward or a delete may name. */
export const MAX_IDS = 100;
/** Preview length of a draft in the dialog list. */
const DRAFT_CHARS = 200;
/**
 * Most bytes of JSON one tool answer carries, so a page of long messages
 * never floods the run's context.
 */
const BYTES_PER_KIB = 1024;
const MAX_OUTPUT_KIB = 48;
export const MAX_OUTPUT_BYTES = MAX_OUTPUT_KIB * BYTES_PER_KIB;

export const clip = (text: string, max = MAX_TEXT_CHARS) =>
  text.length <= max ? text : `${text.slice(0, max)}…`;

/** A limit from the run, clamped to `[1, max]`, `fallback` when absent. */
export const boundedLimit = (
  value: number | undefined,
  fallback: number,
  max: number
) => Math.max(1, Math.min(Math.trunc(value ?? fallback), max));

const NUMERIC_ID = /^-?\d+$/u;
const USERNAME = /^@?[a-zA-Z][\w]{3,31}$/u;

/**
 * A chat as a run names it: `"me"`, a numeric (marked) id, or a username with
 * or without `@`. Undefined for anything else, so a phone number or a link
 * never reaches the resolver.
 */
export const parsePeer = (raw: string): InputPeerLike | undefined => {
  const value = raw.trim();
  if (value === "me" || value === "self") {
    return "me";
  }
  if (NUMERIC_ID.test(value)) {
    const id = Number(value);
    return Number.isSafeInteger(id) ? id : undefined;
  }
  return USERNAME.test(value) ? value.replace(/^@/u, "") : undefined;
};

const kindOf = (peer: Peer) => {
  if (peer.type === "user") {
    return peer.isBot ? "bot" : "user";
  }
  return peer.chatType;
};

export const presentPeer = (peer: Peer) => ({
  id: peer.id,
  name: peer.displayName,
  type: kindOf(peer),
  username: peer.username,
});

/** How a chat is named to the owner in a confirmation: name, @username, id. */
export const peerLabel = (peer: Peer) =>
  peer.username === null
    ? `${peer.displayName} (id ${peer.id})`
    : `${peer.displayName} (@${peer.username}, id ${peer.id})`;

const presentSender = (sender: PeerSender) =>
  sender.type === "anonymous"
    ? { id: null, name: sender.displayName, username: null }
    : { id: sender.id, name: sender.displayName, username: sender.username };

/**
 * The album (media group) a message belongs to, as a decimal string every
 * member shares; null outside an album.
 */
const albumIdOf = (message: Message) => message.groupedId?.toString() ?? null;

/**
 * The forum topic a message was sent in; null outside a forum and in its
 * General topic.
 */
export const topicIdOf = (message: Message) =>
  message.isTopicMessage ? (message.replyToMessage?.threadId ?? null) : null;

/** Whether a chat protects its content: Telegram forwards nothing from it. */
export const chatProtected = (peer: Peer) =>
  peer.type === "chat" && peer.hasContentProtection;

/** Whether Telegram refuses to forward a message: it or its chat is protected. */
export const messageProtected = (message: Message) =>
  message.isContentProtected || chatProtected(message.chat);

/**
 * The t.me link of a message. Only a supergroup or a channel has one: mtcute
 * throws for a private chat, a basic group or a bot, so it is checked first.
 */
const linkOf = (message: Message) => {
  const { chat } = message;
  return chat.type === "chat" &&
    (chat.chatType === "supergroup" || chat.chatType === "channel")
    ? message.link
    : null;
};

/** A reaction as a run names it: the emoji, or `custom:<id>` for a custom one. */
export const reactionName = (emoji: ReactionEmoji) =>
  Long.isLong(emoji) ? `custom:${emoji.toString()}` : emoji;

const CUSTOM_REACTION = /^custom:(?<id>\d{1,20})$/u;

/**
 * The custom emoji id in a reaction name `reactionName` hands out, as its
 * digits; undefined for a plain emoji or anything else.
 */
export const parseCustomReaction = (name: string) =>
  CUSTOM_REACTION.exec(name)?.groups?.id;

export const presentReactions = (reactions: MessageReactions | null) =>
  reactions === null
    ? null
    : reactions.reactions.map((reaction) => ({
        count: reaction.count,
        emoji: reactionName(reaction.emoji),
        mine: reaction.order !== null,
      }));

/** Name, size and type of the file a message carries; null without one. */
const fileOf = (message: Message) => {
  const { media } = message;
  if (!(media instanceof FileLocation)) {
    return null;
  }
  const document = media instanceof RawDocument ? media : null;
  return {
    mime: document?.mimeType ?? null,
    name: document?.fileName ?? null,
    size: media.fileSize ?? null,
  };
};

/**
 * The poll a message carries, its answers by the 0-based index `vote` takes;
 * null for any other message.
 */
const pollOf = (message: Message) => {
  const { media } = message;
  if (media?.type !== "poll") {
    return null;
  }
  return {
    answers: media.answers.map((answer, index) => ({
      chosen: answer.chosen,
      index,
      text: clip(answer.text, LAST_MESSAGE_CHARS),
      voters: answer.voters,
    })),
    closed: media.isClosed,
    multiple: media.isMultiple,
    question: clip(media.question, LAST_MESSAGE_CHARS),
    quiz: media.isQuiz,
  };
};

export const presentMessage = (message: Message) => ({
  album_id: albumIdOf(message),
  chat_id: message.chat.id,
  content_protected: messageProtected(message),
  date: message.date.toISOString(),
  edited: message.editDate === null ? null : message.editDate.toISOString(),
  file: fileOf(message),
  forwarded_from:
    message.forward === null
      ? null
      : presentSender(message.forward.sender).name,
  from: presentSender(message.sender),
  id: message.id,
  link: linkOf(message),
  media: message.media === null ? null : message.media.type,
  outgoing: message.isOutgoing,
  poll: pollOf(message),
  reactions: presentReactions(message.reactions),
  reply_to: message.replyToMessage?.id ?? null,
  service: message.isService,
  text: clip(message.text),
  topic_id: topicIdOf(message),
});

/** A draft the owner left in a chat's input; null when there is none. */
const presentDraft = (draft: DraftMessage | null) =>
  draft === null
    ? null
    : { date: draft.date.toISOString(), text: clip(draft.text, DRAFT_CHARS) };

export const presentDialog = (dialog: Dialog) => ({
  archived: dialog.isArchived,
  chat: presentPeer(dialog.peer),
  draft: presentDraft(dialog.draftMessage),
  last_message:
    dialog.lastMessage === null
      ? null
      : {
          date: dialog.lastMessage.date.toISOString(),
          id: dialog.lastMessage.id,
          outgoing: dialog.lastMessage.isOutgoing,
          text: clip(dialog.lastMessage.text, LAST_MESSAGE_CHARS),
        },
  pinned: dialog.isPinned,
  unread: dialog.unreadCount,
});

/** A forum topic, by the id `thread_id` and `to_thread_id` take. */
export const presentTopic = (topic: ForumTopic) => ({
  closed: topic.isClosed,
  id: topic.id,
  // The id alone: `lastMessage` throws when the page left it out.
  last_message_id: topic.raw.topMessage,
  pinned: topic.isPinned,
  title: topic.title,
  unread: topic.unreadCount,
  unread_mentions: topic.unreadMentionsCount,
});

export const presentMember = (member: ChatMember) => ({
  joined: member.joinedDate?.toISOString() ?? null,
  status: member.status,
  title: member.title,
  user: presentPeer(member.user),
});

/** A chat folder; the default "All chats" one has no title of its own. */
export const presentFolder = (folder: tl.TypeDialogFilter) => {
  switch (folder._) {
    case "dialogFilterDefault": {
      return { emoticon: null, id: 0, kind: "all_chats", title: null };
    }
    case "dialogFilter": {
      return {
        emoticon: folder.emoticon ?? null,
        id: folder.id,
        kind: "folder",
        title: folder.title.text,
      };
    }
    case "dialogFilterChatlist": {
      return {
        emoticon: folder.emoticon ?? null,
        id: folder.id,
        kind: "shared_folder",
        title: folder.title.text,
      };
    }
    default: {
      return absurd<never>(folder);
    }
  }
};

/** Whether one answer, as JSON text, fits the output cap. */
const fits = (json: string) => Buffer.byteLength(json) <= MAX_OUTPUT_BYTES;

const HALVES = 2;

/**
 * A list answer cut to the output cap. `wrap` builds the answer from the items
 * kept and whether any were dropped, so a cursor it sets points at the last
 * item kept; a cut answer says `truncated: true`. Items are dropped from the
 * end, so what is left is the start of the page.
 */
export const fitList = <T, R extends object>(
  items: readonly T[],
  wrap: (kept: readonly T[], cut: boolean) => R
): R | (R & { readonly truncated: true }) => {
  const whole = wrap(items, false);
  if (fits(JSON.stringify(whole))) {
    return whole;
  }
  const cutTo = (count: number) => ({
    ...wrap(items.slice(0, count), true),
    truncated: true as const,
  });
  // The largest count that fits, by bisection: each probe is one stringify.
  let under = 0;
  let over = items.length;
  while (over - under > 1) {
    const middle = Math.floor((under + over) / HALVES);
    if (fits(JSON.stringify(cutTo(middle)))) {
      under = middle;
    } else {
      over = middle;
    }
  }
  return cutTo(under);
};

/**
 * The text of one tool answer: compact JSON within the output cap. An answer
 * over the cap that `fitList` could not cut is clipped as text, the last
 * resort, and says so. Escaping makes the wrapped text longer than the cut,
 * so the cut shrinks by the excess until the whole answer fits.
 */
export const outputText = (output: ToolOutput) => {
  const text = JSON.stringify(output.value);
  const bytes = Buffer.from(text);
  if (bytes.length <= MAX_OUTPUT_BYTES) {
    return text;
  }
  const wrapAt = (keep: number) =>
    JSON.stringify({
      partial: bytes.subarray(0, keep).toString("utf-8"),
      truncated: true,
    });
  let keep = MAX_OUTPUT_BYTES;
  let wrapped = wrapAt(keep);
  while (Buffer.byteLength(wrapped) > MAX_OUTPUT_BYTES) {
    keep -= Buffer.byteLength(wrapped) - MAX_OUTPUT_BYTES;
    wrapped = wrapAt(keep);
  }
  return wrapped;
};
