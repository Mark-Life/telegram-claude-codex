import { getBasicPeerType } from "@mtcute/bun";
import type { Message, Peer } from "@mtcute/bun";
import { SettingsRepo } from "@workspace/db";
import type { TaskStamp } from "@workspace/db";
import { AppConfig } from "@workspace/env/bot";
import { Context, Effect, Layer, Option } from "effect";

import { t } from "../i18n";
import { resolveZone } from "../reminders/zone";
import {
  TelegramAccount,
  TelegramAccountError,
} from "../telegram/telegram-account";
import { AccountActions } from "./actions";
import { MUTE_FOREVER } from "./execute-write";
import {
  badInput,
  checkIds,
  allMessages,
  checkText,
  forumTopic,
  isOwn,
  MS_PER_SECOND,
  oneMessage,
  parseReactionName,
  parseSchedule,
  ref,
  resolveChat,
} from "./inputs";
import {
  checkAlbum,
  checkFile,
  discardStaged,
  stageFiles,
} from "./media-files";
import {
  chatProtected,
  clip,
  messageProtected,
  parseCustomReaction,
} from "./present";
import type { ArgsOf } from "./tool-call-schema";

/**
 * The `telegram_account` tools that act as the owner where others see it.
 * Each one checks what it can before it asks (the target message, scheduled
 * message or poll exists, a file may be sent), so the owner is never shown a
 * button for a write Telegram would refuse, then goes through
 * `AccountActions`, which decides between the owner's button and `direct`.
 * Kept out on purpose: deleting a whole history, kicking or banning, handing
 * over ownership, profile edits and importing contacts.
 */

/** How much of an edited message's old text the confirmation shows. */
const PREVIOUS_TEXT_CHARS = 500;
/** How much of the message a write acts on the confirmation shows. */
const EXCERPT_CHARS = 300;
/** Most files of one album, as Telegram takes them. */
const MAX_ALBUM = 10;
const MAX_CAPTION_CHARS = 1024;
const MAX_POLL_QUESTION_CHARS = 255;
const MIN_POLL_ANSWERS = 2;
const MAX_POLL_ANSWERS = 10;
const MAX_POLL_ANSWER_CHARS = 100;

/** Media whose text is a caption an edit can change; the rest have none. */
const CAPTIONED_MEDIA: ReadonlySet<string> = new Set([
  "audio",
  "document",
  "photo",
  "video",
  "voice",
]);

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

/**
 * Whether a reaction name can be one: a single emoji, or `custom:<id>`, so a
 * word never reaches the owner's button only for Telegram to refuse it.
 */
const isReactionName = (name: string) =>
  parseCustomReaction(name) !== undefined ||
  ([...graphemes.segment(name)].length === 1 && PICTOGRAPHIC.test(name));

/** When a mute ends, in Telegram's unix seconds; for good without a time. */
const muteEnd = (at: number | undefined) =>
  at === undefined ? MUTE_FOREVER : Math.floor(at / MS_PER_SECOND);

/** The text of a message a write acts on, clipped; absent when it has none. */
const excerptOf = (message: Message) => {
  const text = message.text.trim();
  return text === "" ? undefined : clip(text, EXCERPT_CHARS);
};

/** A forward Telegram would refuse, stopped before any button is shown. */
const forwardRestricted = () =>
  new TelegramAccountError({
    cause: undefined,
    method: "forwardMessagesById",
    reason: "forward-restricted",
  });

/** What a write answers the run; a pending one says not to try again. */
export const writeAnswer = <A extends { readonly status: "done" | "pending" }>(
  outcome: A
) =>
  outcome.status === "pending"
    ? {
        ...outcome,
        note: "Waiting for the owner's confirmation button in the bot chat. Do not retry.",
      }
    : outcome;

const make = Effect.gen(function* make() {
  const cfg = yield* AppConfig;
  const account = yield* TelegramAccount;
  const actions = yield* AccountActions;
  const settings = yield* SettingsRepo;
  const resolve = (raw: number | string) => resolveChat(account, raw);

  /**
   * The owner's home zone, as `readHomeTz` reads it: `default_tz`, else
   * `DEFAULT_TZ`; a failed read or a zone gone bad keeps the fallback.
   */
  const homeZone = settings.get("default_tz").pipe(
    Effect.map((stored) =>
      Option.match(stored, {
        onNone: () => cfg.defaultTz,
        onSome: (zone) => resolveZone(zone) ?? cfg.defaultTz,
      })
    ),
    Effect.orElseSucceed(() => cfg.defaultTz)
  );

  /**
   * A scheduled time as the owner reads it in the confirmation: in their home
   * zone, rendered now, so the confirmation itself needs no lookup.
   */
  const scheduleLabel = (at: number) =>
    Effect.map(homeZone, (timeZone) =>
      new Intl.DateTimeFormat(t().dateLocale, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone,
        timeZoneName: "short",
      }).format(new Date(at))
    );

  /**
   * Where and how a new message goes out (a text, a file or a poll): its
   * reply, its forum topic, checked, its sound and its schedule with the time
   * the owner reads.
   */
  const sending = Effect.fnUntraced(function* (input: {
    readonly peer: Peer;
    readonly replyTo: number | undefined;
    readonly schedule: string | undefined;
    readonly silent: boolean | undefined;
    readonly threadId: number | undefined;
  }) {
    const at = Option.getOrUndefined(yield* parseSchedule(input.schedule));
    const topic =
      input.threadId === undefined
        ? undefined
        : yield* forumTopic({
            account,
            chat: input.peer,
            id: input.threadId,
            param: "thread_id",
          });
    return {
      replyTo: input.replyTo,
      schedule:
        at === undefined ? undefined : { at, label: yield* scheduleLabel(at) },
      silent: input.silent,
      topic:
        topic === undefined ? undefined : { id: topic.id, title: topic.title },
    };
  });

  const sendMessage = Effect.fnUntraced(function* (
    input: ArgsOf<"send_message">,
    requester: TaskStamp
  ) {
    const text = yield* checkText(input.text);
    const peer = yield* resolve(input.chat);
    const options = yield* sending({
      peer,
      replyTo: input.reply_to,
      schedule: input.schedule,
      silent: input.silent,
      threadId: input.thread_id,
    });
    const outcome = yield* actions.request(
      {
        ...options,
        clearDraft: input.clear_draft,
        kind: "send",
        peer: ref(peer),
        text,
      },
      requester
    );
    return { peerId: peer.id, value: writeAnswer(outcome) };
  });

  const forwardMessages = Effect.fnUntraced(function* (
    input: ArgsOf<"forward_messages">,
    requester: TaskStamp
  ) {
    const messageIds = yield* checkIds(input.message_ids);
    const from = yield* resolve(input.from_chat);
    const to = yield* resolve(input.to_chat);
    // Checked before the write is stored, so the owner is never asked to
    // approve a forward Telegram would refuse.
    if (chatProtected(from)) {
      return yield* forwardRestricted();
    }
    const found = yield* allMessages({
      account,
      ids: messageIds,
      peer: from,
      where: "in the source chat",
    });
    if (found.some(messageProtected)) {
      return yield* forwardRestricted();
    }
    const topic =
      input.to_thread_id === undefined
        ? undefined
        : yield* forumTopic({
            account,
            chat: to,
            id: input.to_thread_id,
            param: "to_thread_id",
          });
    const outcome = yield* actions.request(
      {
        from: ref(from),
        kind: "forward",
        messageIds,
        to: ref(to),
        toTopic:
          topic === undefined
            ? undefined
            : { id: topic.id, title: topic.title },
      },
      requester
    );
    return { peerId: to.id, value: writeAnswer(outcome) };
  });

  /**
   * Only the owner's own message can be edited, and only its text or caption;
   * checked before asking, with a caption held to Telegram's caption limit.
   */
  const editMessage = Effect.fnUntraced(function* (
    input: ArgsOf<"edit_message">,
    requester: TaskStamp
  ) {
    const text = yield* checkText(input.text);
    const peer = yield* resolve(input.chat);
    const message = yield* oneMessage({
      account,
      id: input.message_id,
      peer,
    });
    if (message.isService) {
      return yield* badInput(
        "That is a service message; it has no text to edit."
      );
    }
    if (!isOwn(peer, message)) {
      return yield* badInput("Only your own messages can be edited.");
    }
    const { media } = message;
    if (media !== null && media.type !== "webpage") {
      if (!CAPTIONED_MEDIA.has(media.type)) {
        return yield* badInput(
          "That message's media has no text or caption to edit."
        );
      }
      if (text.length > MAX_CAPTION_CHARS) {
        return yield* badInput(
          `text is a caption here; it is ${text.length} characters and the limit is ${MAX_CAPTION_CHARS}.`
        );
      }
    }
    const outcome = yield* actions.request(
      {
        kind: "edit",
        messageId: input.message_id,
        peer: ref(peer),
        previous: clip(message.text, PREVIOUS_TEXT_CHARS),
        text,
      },
      requester
    );
    return { peerId: peer.id, value: writeAnswer(outcome) };
  });

  /**
   * Every id must exist before the owner is asked; the confirmation names the
   * ones someone else wrote and whether they go for everyone. `revoke: false`
   * is refused in a supergroup or channel: Telegram's `channels.deleteMessages`
   * has no such flag and always deletes for everyone there.
   */
  const deleteMessages = Effect.fnUntraced(function* (
    input: ArgsOf<"delete_messages">,
    requester: TaskStamp
  ) {
    const messageIds = yield* checkIds(input.message_ids);
    const peer = yield* resolve(input.chat);
    if (input.revoke === false && getBasicPeerType(peer.id) === "channel") {
      return yield* badInput(
        "revoke: false is not possible in a supergroup or channel; Telegram deletes there for everyone."
      );
    }
    const found = yield* allMessages({ account, ids: messageIds, peer });
    const foreignIds = found.flatMap((message) =>
      isOwn(peer, message) ? [] : [message.id]
    );
    const outcome = yield* actions.request(
      {
        foreignIds: foreignIds.length === 0 ? undefined : foreignIds,
        kind: "delete",
        messageIds,
        peer: ref(peer),
        revoke: input.revoke,
      },
      requester
    );
    return { peerId: peer.id, value: writeAnswer(outcome) };
  });

  /**
   * Files the run made or the user sent, checked, staged and shown to the
   * owner before anything goes out (`media-files.ts`).
   */
  const sendMedia = Effect.fnUntraced(function* (
    input: ArgsOf<"send_media">,
    requester: TaskStamp
  ) {
    if (input.files.length === 0 || input.files.length > MAX_ALBUM) {
      return yield* badInput(`Give between 1 and ${MAX_ALBUM} files.`);
    }
    const caption = input.caption?.trim() === "" ? undefined : input.caption;
    if (caption !== undefined && caption.length > MAX_CAPTION_CHARS) {
      return yield* badInput(
        `caption is ${caption.length} characters; the limit is ${MAX_CAPTION_CHARS}.`
      );
    }
    const peer = yield* resolve(input.chat);
    const options = yield* sending({
      peer,
      replyTo: input.reply_to,
      schedule: input.schedule,
      silent: input.silent,
      threadId: input.thread_id,
    });
    const files = yield* Effect.forEach(input.files, (file) =>
      checkFile({ as: file.as, cfg, path: file.path })
    );
    yield* checkAlbum(files.map((file) => file.as));
    const items = yield* stageFiles(files);
    const outcome = yield* actions
      .request(
        { ...options, caption, items, kind: "media", peer: ref(peer) },
        requester
      )
      // A write that never got stored or shown leaves no staged copy behind.
      .pipe(
        Effect.onError(() => discardStaged(items.map((item) => item.path)))
      );
    return { peerId: peer.id, value: writeAnswer(outcome) };
  });

  /** Put a reaction on a message, or take the owner's off. */
  const react = Effect.fnUntraced(function* (
    input: ArgsOf<"react">,
    requester: TaskStamp
  ) {
    const emoji = Option.getOrNull(yield* parseReactionName(input.emoji));
    if (emoji !== null && !isReactionName(emoji)) {
      return yield* badInput(
        'emoji must be one emoji, or "custom:<id>" for a custom one.'
      );
    }
    const peer = yield* resolve(input.chat);
    const message = yield* oneMessage({ account, id: input.message_id, peer });
    if (message.isService) {
      return yield* badInput("A service message takes no reactions.");
    }
    const outcome = yield* actions.request(
      {
        big: input.big,
        emoji,
        excerpt: excerptOf(message),
        kind: "react",
        messageId: message.id,
        peer: ref(peer),
      },
      requester
    );
    return { peerId: peer.id, value: writeAnswer(outcome) };
  });

  const pin = Effect.fnUntraced(function* (
    input: ArgsOf<"pin">,
    requester: TaskStamp
  ) {
    const peer = yield* resolve(input.chat);
    if (input.both_sides === true && peer.type !== "user") {
      return yield* badInput("both_sides is for a private chat only.");
    }
    const message = yield* oneMessage({ account, id: input.message_id, peer });
    if (message.isPinned) {
      return yield* badInput("That message is pinned already.");
    }
    const outcome = yield* actions.request(
      {
        bothSides: input.both_sides,
        excerpt: excerptOf(message),
        kind: "pin",
        messageId: message.id,
        notify: input.notify,
        peer: ref(peer),
      },
      requester
    );
    return { peerId: peer.id, value: writeAnswer(outcome) };
  });

  const unpin = Effect.fnUntraced(function* (
    input: ArgsOf<"unpin">,
    requester: TaskStamp
  ) {
    const peer = yield* resolve(input.chat);
    const message = yield* oneMessage({ account, id: input.message_id, peer });
    if (!message.isPinned) {
      return yield* badInput("That message is not pinned.");
    }
    const outcome = yield* actions.request(
      {
        excerpt: excerptOf(message),
        kind: "unpin",
        messageId: message.id,
        peer: ref(peer),
      },
      requester
    );
    return { peerId: peer.id, value: writeAnswer(outcome) };
  });

  /** A chat already where the run wants it gets no button. */
  const archive = Effect.fnUntraced(function* (
    input: ArgsOf<"archive">,
    requester: TaskStamp
  ) {
    const archived = input.archived ?? true;
    const peer = yield* resolve(input.chat);
    const [dialog] = yield* account.use(
      "getPeerDialogs",
      async (client) => await client.getPeerDialogs(peer.id)
    );
    if (
      dialog !== null &&
      dialog !== undefined &&
      dialog.isArchived === archived
    ) {
      return {
        peerId: peer.id,
        value: { archived, status: "unchanged" as const },
      };
    }
    const outcome = yield* actions.request(
      { archived, kind: "archive", peer: ref(peer) },
      requester
    );
    return { peerId: peer.id, value: writeAnswer(outcome) };
  });

  /** Mute until a time, for good, or unmute. */
  const mute = Effect.fnUntraced(function* (
    input: ArgsOf<"mute">,
    requester: TaskStamp
  ) {
    if (input.unmute === true && input.until !== undefined) {
      return yield* badInput("Give until or unmute, not both.");
    }
    const at = Option.getOrUndefined(
      yield* parseSchedule(input.until, "until")
    );
    const peer = yield* resolve(input.chat);
    const muteUntil = input.unmute === true ? 0 : muteEnd(at);
    const label = at === undefined ? "" : yield* scheduleLabel(at);
    const outcome = yield* actions.request(
      { kind: "mute", label, muteUntil, peer: ref(peer) },
      requester
    );
    return { peerId: peer.id, value: writeAnswer(outcome) };
  });

  /**
   * Scheduled messages of one chat, every id checked, and what they say for
   * the confirmation.
   */
  const scheduledTargets = Effect.fnUntraced(function* (
    raw: number | string,
    ids: readonly number[]
  ) {
    const messageIds = yield* checkIds(ids);
    const peer = yield* resolve(raw);
    const found = yield* allMessages({
      account,
      ids: messageIds,
      peer,
      scheduled: true,
    });
    const texts = found.flatMap((message) =>
      message.text.trim() === "" ? [] : [message.text]
    );
    return {
      excerpt:
        texts.length === 0 ? undefined : clip(texts.join(" / "), EXCERPT_CHARS),
      messageIds,
      peer,
    };
  });

  const deleteScheduled = Effect.fnUntraced(function* (
    input: ArgsOf<"delete_scheduled">,
    requester: TaskStamp
  ) {
    const target = yield* scheduledTargets(input.chat, input.message_ids);
    const outcome = yield* actions.request(
      {
        excerpt: target.excerpt,
        kind: "delete_scheduled",
        messageIds: target.messageIds,
        peer: ref(target.peer),
      },
      requester
    );
    return { peerId: target.peer.id, value: writeAnswer(outcome) };
  });

  const sendScheduledNow = Effect.fnUntraced(function* (
    input: ArgsOf<"send_scheduled_now">,
    requester: TaskStamp
  ) {
    const target = yield* scheduledTargets(input.chat, input.message_ids);
    const outcome = yield* actions.request(
      {
        excerpt: target.excerpt,
        kind: "send_scheduled",
        messageIds: target.messageIds,
        peer: ref(target.peer),
      },
      requester
    );
    return { peerId: target.peer.id, value: writeAnswer(outcome) };
  });

  const createPoll = Effect.fnUntraced(function* (
    input: ArgsOf<"create_poll">,
    requester: TaskStamp
  ) {
    const question = input.question.trim();
    if (question === "" || question.length > MAX_POLL_QUESTION_CHARS) {
      return yield* badInput(
        `question must be 1 to ${MAX_POLL_QUESTION_CHARS} characters.`
      );
    }
    const answers = input.answers.map((answer) => answer.trim());
    if (
      answers.length < MIN_POLL_ANSWERS ||
      answers.length > MAX_POLL_ANSWERS
    ) {
      return yield* badInput(
        `Give between ${MIN_POLL_ANSWERS} and ${MAX_POLL_ANSWERS} answers.`
      );
    }
    if (
      answers.some(
        (answer) => answer === "" || answer.length > MAX_POLL_ANSWER_CHARS
      )
    ) {
      return yield* badInput(
        `Each answer must be 1 to ${MAX_POLL_ANSWER_CHARS} characters.`
      );
    }
    const peer = yield* resolve(input.chat);
    const options = yield* sending({
      peer,
      replyTo: input.reply_to,
      schedule: input.schedule,
      silent: input.silent,
      threadId: input.thread_id,
    });
    const outcome = yield* actions.request(
      {
        ...options,
        answers,
        kind: "poll",
        multiple: input.multiple,
        peer: ref(peer),
        public: input.public,
        question,
      },
      requester
    );
    return { peerId: peer.id, value: writeAnswer(outcome) };
  });

  /** A vote checked against the poll as it stands: open, in range, allowed. */
  const vote = Effect.fnUntraced(function* (
    input: ArgsOf<"vote">,
    requester: TaskStamp
  ) {
    const peer = yield* resolve(input.chat);
    const message = yield* oneMessage({ account, id: input.message_id, peer });
    const poll = message.media;
    if (poll?.type !== "poll") {
      return yield* badInput("That message is not a poll.");
    }
    if (poll.isClosed) {
      return yield* badInput("That poll is closed.");
    }
    const { options } = input;
    const voted = poll.answers.some((answer) => answer.chosen);
    if (options.length === 0 && !voted) {
      return yield* badInput("You have not voted in that poll.");
    }
    if (poll.isQuiz && voted) {
      return yield* badInput("A quiz answer cannot be changed.");
    }
    if (poll.isRevotingDisabled && voted) {
      return yield* badInput("That poll does not allow changing a vote.");
    }
    if (
      options.some(
        (index) =>
          !Number.isInteger(index) || index < 0 || index >= poll.answers.length
      )
    ) {
      return yield* badInput(
        `options are 0-based answer indexes below ${poll.answers.length}.`
      );
    }
    if (new Set(options).size !== options.length) {
      return yield* badInput("Give each option once.");
    }
    if (options.length > 1 && !poll.isMultiple) {
      return yield* badInput("That poll takes one answer only.");
    }
    const chosen = options.flatMap((index) => {
      const answer = poll.answers[index];
      return answer === undefined ? [] : [answer];
    });
    const outcome = yield* actions.request(
      {
        kind: "vote",
        messageId: message.id,
        // The answers' own bytes: a poll whose answers changed since refuses
        // the vote instead of moving it to an answer the owner never saw.
        optionData: chosen.map((answer) =>
          Buffer.from(answer.data).toString("base64")
        ),
        optionTexts: chosen.map((answer) => answer.text),
        options,
        peer: ref(peer),
        question: poll.question,
      },
      requester
    );
    return { peerId: peer.id, value: writeAnswer(outcome) };
  });

  return {
    archive,
    createPoll,
    deleteMessages,
    deleteScheduled,
    editMessage,
    forwardMessages,
    mute,
    pin,
    react,
    sendMedia,
    sendMessage,
    sendScheduledNow,
    unpin,
    vote,
  } as const;
});

/** The `telegram_account` tools that write as the owner, through `AccountActions`. */
export class WriteTools extends Context.Service<
  WriteTools,
  Effect.Success<typeof make>
>()("@workspace/WriteTools") {
  static readonly layer = Layer.effect(WriteTools, make);
}
