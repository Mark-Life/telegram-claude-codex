import type { AccountActionPayload } from "@workspace/db";
import { Predicate } from "effect";
import type { Json } from "effect/Schema";

import { t } from "../i18n";
import { isJsonArray, objectOf } from "./raw-params";

/**
 * The confirmation of a raw write: a danger header, the method and its own
 * description, then each argument, a peer by the name the owner knows it by
 * and bytes by their size, short ones by their text or hex too. A few
 * common methods read as one plain sentence instead. Built from the stored
 * payload alone, so the same text can be drawn again when the write ends,
 * after a restart too.
 */

type RawPayload = Extract<AccountActionPayload, { kind: "raw" }>;

interface Marks {
  readonly bytes: ReadonlySet<string>;
  readonly peers: ReadonlyMap<string, string>;
}

/** Bytes up to this size are shown, not only counted. */
const MAX_SHOWN_BYTES = 32;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const CONTROL = /\p{Cc}/u;

/** Text the owner can read off bytes, if they are printable UTF-8. */
const printable = (bytes: Buffer) => {
  try {
    const text = utf8.decode(bytes);
    return CONTROL.test(text) ? null : text;
  } catch {
    return null;
  }
};

/**
 * Short bytes as the owner can check them, such as a poll answer or a report
 * reason: their text when it is printable UTF-8, else hex. Longer ones are
 * only counted.
 */
const bytesShown = (bytes: Buffer) => {
  if (bytes.length === 0 || bytes.length > MAX_SHOWN_BYTES) {
    return null;
  }
  const text = printable(bytes);
  return text === null ? bytes.toString("hex") : JSON.stringify(text);
};

/**
 * A stored value as the owner reads it: a peer by its label, bytes by their
 * size (and short ones by their content), everything else as it is.
 */
const displayOf = (value: Json, path: string, marks: Marks): Json => {
  const label = marks.peers.get(path);
  if (label !== undefined) {
    return label;
  }
  if (marks.bytes.has(path) && Predicate.isString(value)) {
    const bytes = Buffer.from(value, "base64");
    return t().accountActions.rawBytes(bytes.length, bytesShown(bytes));
  }
  if (isJsonArray(value)) {
    return value.map((item, at) => displayOf(item, `${path}[${at}]`, marks));
  }
  const object = objectOf(value);
  return object === undefined
    ? value
    : Object.fromEntries(
        Object.entries(object).map(([key, field]) => [
          key,
          displayOf(field, `${path}.${key}`, marks),
        ])
      );
};

/**
 * One argument's line. A peer label and a size are shown as they are; any
 * other value as compact JSON, so a string with line breaks cannot pass for
 * more lines of the confirmation. Never clipped: the owner approves exactly
 * what they read, and a call too long to show is refused before it is
 * stored.
 */
const argLine = (key: string, value: Json, marks: Marks) => {
  const shown = displayOf(value, key, marks);
  const plain =
    (marks.peers.has(key) || marks.bytes.has(key)) && Predicate.isString(shown);
  return t().accountActions.rawArg({
    name: key,
    value: plain ? shown : JSON.stringify(shown),
  });
};

const labelAt = (payload: RawPayload, path: string) =>
  payload.peers.find((peer) => peer.path === path)?.peer.label;

/** A reaction of `messages.sendReaction` as the owner reads it. */
const reactionLabel = (reaction: Json) => {
  const object = objectOf(reaction);
  const emoticon = object?.emoticon;
  if (object?._ === "reactionEmoji" && Predicate.isString(emoticon)) {
    return emoticon;
  }
  const documentId = object?.documentId;
  if (object?._ === "reactionCustomEmoji" && Predicate.isString(documentId)) {
    return t().accountActions.customEmoji(documentId);
  }
  return JSON.stringify(reaction);
};

/**
 * The arguments a hand-written sentence covers, per method. `big` is left
 * out of `messages.sendReaction`: the sentence does not say the reaction
 * plays big for the whole chat, so such a call shows its argument list.
 */
const COVERED = new Map<string, ReadonlySet<string>>([
  ["channels.joinChannel", new Set(["channel"])],
  ["channels.leaveChannel", new Set(["channel"])],
  ["contacts.block", new Set(["id"])],
  ["contacts.unblock", new Set(["id"])],
  ["messages.importChatInvite", new Set(["hash"])],
  [
    "messages.sendReaction",
    new Set(["addToRecent", "msgId", "peer", "reaction"]),
  ],
]);

const sendReaction = (payload: RawPayload) => {
  const peer = labelAt(payload, "peer");
  const { msgId, reaction } = payload.params;
  if (peer === undefined || !Predicate.isNumber(msgId)) {
    return null;
  }
  const reactions = reaction === undefined ? [] : reaction;
  if (!isJsonArray(reactions)) {
    return null;
  }
  return t().accountActions.rawReaction({
    id: msgId,
    peer,
    reactions: reactions.map(reactionLabel).join(" "),
  });
};

/** A sentence about one peer, or null when the peer was given raw. */
const aboutPeer = (
  label: string | undefined,
  render: (peer: string) => string
) => (label === undefined ? null : render(label));

/** The plain sentence of a common method; null for any other. */
const sentenceOf = (payload: RawPayload) => {
  const covered = COVERED.get(payload.method);
  if (
    covered === undefined ||
    Object.keys(payload.params).some((key) => !covered.has(key))
  ) {
    return null;
  }
  const copy = t().accountActions;
  const channel = labelAt(payload, "channel");
  const user = labelAt(payload, "id");
  const { hash } = payload.params;
  switch (payload.method) {
    case "messages.sendReaction": {
      return sendReaction(payload);
    }
    case "channels.joinChannel": {
      return aboutPeer(channel, copy.rawJoin);
    }
    case "channels.leaveChannel": {
      return aboutPeer(channel, copy.rawLeave);
    }
    case "contacts.block": {
      return aboutPeer(user, copy.rawBlock);
    }
    case "contacts.unblock": {
      return aboutPeer(user, copy.rawUnblock);
    }
    case "messages.importChatInvite": {
      return Predicate.isString(hash) ? copy.rawImportInvite(hash) : null;
    }
    default: {
      return null;
    }
  }
};

/** The confirmation text of a raw write, without the requester line. */
export const describeRaw = (payload: RawPayload) => {
  const copy = t().accountActions;
  const marks: Marks = {
    bytes: new Set(payload.bytes),
    peers: new Map(payload.peers.map((peer) => [peer.path, peer.peer.label])),
  };
  const entries = Object.entries(payload.params);
  const args =
    entries.length === 0
      ? copy.rawNoArgs
      : entries.map(([key, value]) => argLine(key, value, marks)).join("\n");
  return copy.raw({
    body: sentenceOf(payload) ?? args,
    method: payload.method,
    summary: payload.summary,
  });
};
