import { hostname } from "node:os";

import {
  AccountActionsRepo,
  ApiKeysRepo,
  ApiRunsRepo,
  UsersRepo,
} from "@workspace/db";
import type {
  AccountActionEntry,
  AccountActionPayload,
  AccountMediaKind,
  AccountRequester,
  TaskStamp,
} from "@workspace/db";
import { AppConfig } from "@workspace/env/bot";
import {
  Context,
  Data,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Result,
  Schedule,
} from "effect";
import { absurd } from "effect/Function";
import { InlineKeyboard, InputFile, InputMediaBuilder } from "grammy";

import { APP_VERSION } from "../handlers/run-event";
import { t } from "../i18n";
import {
  ACCOUNT_EVENT_MARKER,
  AccountEvent,
  Observability,
} from "../observability";
import {
  TelegramAccount,
  TelegramAccountError,
} from "../telegram/telegram-account";
import { TelegramBot } from "../telegram/telegram-bot";
import { executeRaw } from "./execute-raw";
import { ALREADY_SENT, executeWrite, MUTE_FOREVER } from "./execute-write";
import type { MediaItem, PayloadOf } from "./execute-write";
import { badInput, MIN_SCHEDULE_MS, MS_PER_SECOND } from "./inputs";
import { discardStaged } from "./media-files";
import { clip, parseCustomReaction } from "./present";
import { describeRaw } from "./raw-confirm";
import { RawSchema } from "./raw-schema";
import { BYTES_PER_MB } from "./scratch";
import { WritesMode } from "./writes-mode";

/**
 * Writes a run makes on the owner's Telegram account. The mode is read per
 * request (`writes-mode.ts`). Under `confirm` a write is stored as `pending`
 * and shown to the owner, in their private chat only, with the exact
 * recipient and text; only a press by `ALLOWED_USER_ID` carries it out, and
 * it expires after 24 h. Under `direct` it is carried out at once. Every
 * write is a row in `account_actions` and a ledger line, whichever way it
 * went. A `media` write's files are staged copies (`media-files.ts`): under
 * `confirm` they are first sent to the owner as they would go out, with the
 * confirmation as a reply, and the copies are removed once the write is done,
 * failed, cancelled or expired. A scheduled write approved too late to go
 * out at its time fails instead of going out at once. A raw API write
 * (`kind: "raw"`) always asks, even under `direct`: its class comes from a
 * heuristic on the method's name (`raw-policy.ts`).
 */

const EXPIRE_AFTER_HOURS = 24;
const EXPIRE_AFTER = Duration.hours(EXPIRE_AFTER_HOURS);
const EXPIRY_PASS_MINUTES = 10;
const EXPIRY_PASS = Duration.minutes(EXPIRY_PASS_MINUTES);

/** The longest text Telegram takes in one message. */
const TELEGRAM_TEXT_MAX = 4096;
/** Room kept for the outcome line `settle` adds below a confirmation. */
const OUTCOME_ROOM = 200;
/** The longest confirmation shown, so its outcome still fits below it. */
const CONFIRMATION_MAX = TELEGRAM_TEXT_MAX - OUTCOME_ROOM;

/** Callback data of the two buttons: `acct:ok:<id>` and `acct:no:<id>`. */
export const ACCOUNT_ACTION_CALLBACK = /^acct:(?<verb>ok|no):(?<id>\d+)$/u;

type LedgerFields = Omit<
  ConstructorParameters<typeof AccountEvent>[0],
  "event" | "host" | "ts" | "version"
>;

/**
 * A write that failed inside `AccountActions`, which already wrote its ledger
 * line; the caller answers the run with `message` and records nothing more.
 */
export class AccountWriteFailed extends Data.TaggedError("AccountWriteFailed")<{
  readonly message: string;
}> {}

/** One ledger line; a ledger that cannot be written never changes a call. */
export const recordAccountCall = (fields: LedgerFields) =>
  Effect.suspend(() =>
    Effect.flatMap(Observability, (observability) =>
      observability.recordAccount(
        new AccountEvent({
          ...fields,
          event: ACCOUNT_EVENT_MARKER,
          host: hostname(),
          ts: new Date().toISOString(),
          version: APP_VERSION,
        })
      )
    )
  ).pipe(Effect.catchCause(() => Effect.void));

/**
 * The chat a write targets, for the ledger: the destination of a forward,
 * the first peer of a raw call, none for a raw call that names none.
 */
const peerIdOf = (payload: AccountActionPayload) => {
  switch (payload.kind) {
    case "forward": {
      return payload.to.id;
    }
    case "send":
    case "edit":
    case "delete":
    case "media":
    case "react":
    case "pin":
    case "unpin":
    case "archive":
    case "mute":
    case "delete_scheduled":
    case "send_scheduled":
    case "poll":
    case "vote": {
      return payload.peer.id;
    }
    case "raw": {
      return payload.peers[0]?.peer.id ?? null;
    }
    default: {
      return absurd<number | null>(payload);
    }
  }
};

/** The tool a write came from, as its ledger line names it. */
const toolOf = (payload: AccountActionPayload) => {
  switch (payload.kind) {
    case "send": {
      return "send_message";
    }
    case "forward": {
      return "forward_messages";
    }
    case "edit": {
      return "edit_message";
    }
    case "delete": {
      return "delete_messages";
    }
    case "media": {
      return "send_media";
    }
    case "send_scheduled": {
      return "send_scheduled_now";
    }
    case "poll": {
      return "create_poll";
    }
    case "react":
    case "pin":
    case "unpin":
    case "archive":
    case "mute":
    case "delete_scheduled":
    case "vote": {
      return payload.kind;
    }
    case "raw": {
      return `tg_call:${payload.method}`;
    }
    default: {
      return absurd<string>(payload);
    }
  }
};

/**
 * The line that names an executor behind a write, so the owner never mistakes
 * it for their own run's; empty for the owner's own run and for a write
 * stored before requesters were kept.
 */
const requesterLine = (requester: AccountRequester | undefined) => {
  const copy = t().accountActions;
  const lines: string[] = [];
  if (requester?.author === "executor") {
    const who =
      requester.username === undefined
        ? String(requester.userId)
        : `@${requester.username} (${requester.userId})`;
    lines.push(copy.requestedBy(who));
  }
  // A program behind an API key asked, not a person in a chat: the owner
  // sees which key, whoever holds it.
  if (requester?.apiKey !== undefined) {
    lines.push(copy.requestedVia(requester.apiKey));
  }
  return lines.length === 0 ? "" : `\n\n${lines.join("\n")}`;
};

/** How a message goes out, as a send, a file or a poll keeps it. */
interface SendOptions {
  readonly clearDraft?: boolean;
  readonly schedule?: { readonly label: string };
  readonly silent?: boolean;
  readonly topic?: { readonly id: number; readonly title: string };
}

/** Each option line of a send, each on its own line; empty without any. */
const sendOptions = (payload: SendOptions) => {
  const copy = t().accountActions;
  const lines = [
    payload.topic === undefined ? undefined : copy.inTopic(payload.topic),
    payload.schedule === undefined
      ? undefined
      : copy.scheduledFor(payload.schedule.label),
    payload.silent === true ? copy.silent : undefined,
    payload.clearDraft === true ? copy.clearsDraft : undefined,
  ];
  return lines
    .flatMap((line) => (line === undefined ? [] : [`\n${line}`]))
    .join("");
};

/** The reply line of a send, a file or a poll; empty outside a reply. */
const replyLine = (replyTo: number | undefined) =>
  replyTo === undefined ? "" : `\n${t().accountActions.inReplyTo(replyTo)}`;

/** The text of the message a write acts on, below the rest; empty without. */
const excerptLine = (excerpt: string | undefined) =>
  excerpt === undefined || excerpt === ""
    ? ""
    : `\n\n${t().accountActions.excerpt(excerpt)}`;

/** A reaction as the owner reads it: the emoji, or a custom one by id. */
const emojiLabel = (name: string) => {
  const custom = parseCustomReaction(name);
  return custom === undefined ? name : t().accountActions.customEmoji(custom);
};

const BYTES_PER_KIB = 1024;
/** The smallest size shown, so a tiny file never reads "0 KB". */
const MIN_KIB = 0.1;

/** A file size in the bot's language: kilobytes below a megabyte. */
const sizeLabel = (bytes: number) => {
  const [value, unit] =
    bytes >= BYTES_PER_MB
      ? [bytes / BYTES_PER_MB, "megabyte"]
      : [Math.max(bytes / BYTES_PER_KIB, MIN_KIB), "kilobyte"];
  return new Intl.NumberFormat(t().dateLocale, {
    maximumFractionDigits: 1,
    style: "unit",
    unit,
    unitDisplay: "short",
  }).format(value);
};

const describeSend = (payload: PayloadOf<"send">) =>
  t().accountActions.send({
    options: sendOptions(payload),
    peer: payload.peer.label,
    reply: replyLine(payload.replyTo),
    text: payload.text,
  });

const describeForward = (payload: PayloadOf<"forward">) => {
  const copy = t().accountActions;
  const topic =
    payload.toTopic === undefined ? "" : `\n${copy.inTopic(payload.toTopic)}`;
  return copy.forward({
    from: payload.from.label,
    ids: payload.messageIds.join(", "),
    to: payload.to.label,
    topic,
  });
};

const describeMedia = (payload: PayloadOf<"media">) => {
  const copy = t().accountActions;
  return copy.media({
    caption: payload.caption,
    count: payload.items.length,
    files: payload.items
      .map((item) =>
        copy.fileLine({
          kind: copy.mediaKinds[item.as],
          name: item.name,
          size: sizeLabel(item.size),
        })
      )
      .join("\n"),
    options: sendOptions(payload),
    peer: payload.peer.label,
    reply: replyLine(payload.replyTo),
  });
};

const describeReact = (payload: PayloadOf<"react">) => {
  const copy = t().accountActions;
  const target = {
    excerpt: excerptLine(payload.excerpt),
    id: payload.messageId,
    peer: payload.peer.label,
  };
  return payload.emoji === null
    ? copy.reactRemove(target)
    : copy.react({
        ...target,
        big: payload.big === true,
        emoji: emojiLabel(payload.emoji),
      });
};

const describeMute = (payload: PayloadOf<"mute">) => {
  const copy = t().accountActions;
  if (payload.muteUntil === 0) {
    return copy.unmute(payload.peer.label);
  }
  return payload.muteUntil === MUTE_FOREVER
    ? copy.muteForever(payload.peer.label)
    : copy.mute({ label: payload.label, peer: payload.peer.label });
};

const describeScheduled = (
  payload: PayloadOf<"delete_scheduled"> | PayloadOf<"send_scheduled">
) => {
  const copy = t().accountActions;
  const input = {
    excerpt: excerptLine(payload.excerpt),
    ids: payload.messageIds.join(", "),
    peer: payload.peer.label,
  };
  return payload.kind === "delete_scheduled"
    ? copy.deleteScheduled(input)
    : copy.sendScheduled(input);
};

const describePoll = (payload: PayloadOf<"poll">) =>
  t().accountActions.poll({
    answers: payload.answers,
    multiple: payload.multiple === true,
    options: sendOptions(payload),
    peer: payload.peer.label,
    public: payload.public === true,
    question: payload.question,
    reply: replyLine(payload.replyTo),
  });

const describeVote = (payload: PayloadOf<"vote">) => {
  const copy = t().accountActions;
  const target = {
    id: payload.messageId,
    peer: payload.peer.label,
    question: payload.question,
  };
  return payload.options.length === 0
    ? copy.voteRetract(target)
    : copy.vote({
        ...target,
        options: payload.optionTexts
          .map(
            (text, index) => `«${text}» (${(payload.options[index] ?? 0) + 1})`
          )
          .join(", "),
      });
};

const describeWrite = (payload: AccountActionPayload) => {
  const copy = t().accountActions;
  switch (payload.kind) {
    case "send": {
      return describeSend(payload);
    }
    case "forward": {
      return describeForward(payload);
    }
    case "edit": {
      return copy.edit({
        id: payload.messageId,
        peer: payload.peer.label,
        previous: payload.previous,
        text: payload.text,
      });
    }
    case "delete": {
      return copy.delete({
        foreign: (payload.foreignIds ?? []).join(", "),
        ids: payload.messageIds.join(", "),
        peer: payload.peer.label,
        revoke: payload.revoke ?? true,
      });
    }
    case "media": {
      return describeMedia(payload);
    }
    case "react": {
      return describeReact(payload);
    }
    case "pin": {
      return copy.pin({
        bothSides: payload.bothSides === true,
        excerpt: excerptLine(payload.excerpt),
        id: payload.messageId,
        notify: payload.notify === true,
        peer: payload.peer.label,
      });
    }
    case "unpin": {
      return copy.unpin({
        excerpt: excerptLine(payload.excerpt),
        id: payload.messageId,
        peer: payload.peer.label,
      });
    }
    case "archive": {
      return payload.archived
        ? copy.archive(payload.peer.label)
        : copy.unarchive(payload.peer.label);
    }
    case "mute": {
      return describeMute(payload);
    }
    case "delete_scheduled":
    case "send_scheduled": {
      return describeScheduled(payload);
    }
    case "poll": {
      return describePoll(payload);
    }
    case "vote": {
      return describeVote(payload);
    }
    case "raw": {
      return describeRaw(payload);
    }
    default: {
      return absurd<string>(payload);
    }
  }
};

/** The confirmation the owner reads: who, where, the exact text, who asked. */
export const describeAction = (payload: AccountActionPayload) =>
  `${describeWrite(payload)}${requesterLine(payload.requestedBy)}`;

/**
 * The write as its confirmation fits one message, outcome line included: an
 * edit's old text is cut to the room left, or dropped. None when even that
 * does not fit, so the run is asked for less.
 */
const fitConfirmation = (
  payload: AccountActionPayload
): Option.Option<AccountActionPayload> => {
  const over = describeAction(payload).length - CONFIRMATION_MAX;
  if (over <= 0) {
    return Option.some(payload);
  }
  if (payload.kind !== "edit" || payload.previous === undefined) {
    return Option.none();
  }
  // One more for the ellipsis `clip` adds.
  const room = payload.previous.length - over - 1;
  const fitted = {
    ...payload,
    previous: room > 0 ? clip(payload.previous, room) : undefined,
  };
  return describeAction(fitted).length <= CONFIRMATION_MAX
    ? Option.some(fitted)
    : Option.none();
};

/**
 * Whether a scheduled send's time has come by the time it is carried out:
 * Telegram would send it at once or refuse it, neither what was approved. A
 * raw call's `scheduleDate` is unix seconds, as Telegram takes it. A timed
 * mute whose end has come counts too: Telegram would read a past
 * `mute_until` as not muted, and unmute a chat muted for good.
 */
const schedulePassed = (payload: AccountActionPayload) => {
  const deadline = Date.now() + MIN_SCHEDULE_MS;
  if (payload.kind === "raw") {
    const at = payload.params.scheduleDate;
    return Predicate.isNumber(at) && at * MS_PER_SECOND <= deadline;
  }
  if (payload.kind === "mute") {
    return (
      payload.muteUntil !== 0 &&
      payload.muteUntil !== MUTE_FOREVER &&
      payload.muteUntil * MS_PER_SECOND <= deadline
    );
  }
  return (
    (payload.kind === "send" ||
      payload.kind === "media" ||
      payload.kind === "poll") &&
    payload.schedule !== undefined &&
    payload.schedule.at <= deadline
  );
};

/** The button that carries a write out, named for what it does. */
const confirmLabel = (payload: AccountActionPayload) => {
  const copy = t().accountActions.buttons;
  switch (payload.kind) {
    case "edit": {
      return copy.edit;
    }
    case "delete":
    case "delete_scheduled": {
      return copy.delete;
    }
    case "forward":
    case "send":
    case "media":
    case "poll": {
      return copy.send;
    }
    case "react": {
      return payload.emoji === null ? copy.delete : copy.react;
    }
    case "pin": {
      return copy.pin;
    }
    case "unpin": {
      return copy.unpin;
    }
    case "archive": {
      return payload.archived ? copy.archive : copy.unarchive;
    }
    case "mute": {
      return payload.muteUntil === 0 ? copy.unmute : copy.mute;
    }
    case "send_scheduled": {
      return copy.sendNow;
    }
    case "vote": {
      return payload.options.length === 0 ? copy.retract : copy.vote;
    }
    case "raw": {
      return copy.raw;
    }
    default: {
      return absurd<string>(payload);
    }
  }
};

/** Remove a `media` write's staged copies; nothing for any other write. */
const discard = (payload: AccountActionPayload) =>
  payload.kind === "media"
    ? discardStaged(payload.items.map((item) => item.path))
    : Effect.void;

/** A staged file as the Bot API uploads it, under the name it goes out as. */
const fileOf = (item: MediaItem) => new InputFile(item.path, item.name);

/**
 * An album as the preview sends it, the caption on the first file. One kind
 * of group, as `checkAlbum` let it through: documents, audio, or photos and
 * videos.
 */
const albumPreview = (
  items: readonly MediaItem[],
  caption: string | undefined
) => {
  const optionsAt = (index: number) => ({
    caption: index === 0 ? caption : undefined,
  });
  if (items.every((item) => item.as === "document")) {
    return items.map((item, index) =>
      InputMediaBuilder.document(fileOf(item), optionsAt(index))
    );
  }
  if (items.every((item) => item.as === "audio" || item.as === "voice")) {
    return items.map((item, index) =>
      InputMediaBuilder.audio(fileOf(item), optionsAt(index))
    );
  }
  return items.map((item, index) =>
    item.as === "video"
      ? InputMediaBuilder.video(fileOf(item), optionsAt(index))
      : InputMediaBuilder.photo(fileOf(item), optionsAt(index))
  );
};

/** A cancel refused because a scheduled message already went out. */
const alreadySent = (error: TelegramAccountError) =>
  error.method === "deleteScheduledMessages" && error.rpc === ALREADY_SENT;

/** One plain sentence per failure class; the class itself goes to the log. */
const failureText = (error: TelegramAccountError) => {
  const copy = t().accountActions.failed;
  if (alreadySent(error)) {
    return copy.alreadySent;
  }
  switch (error.reason) {
    case "flood": {
      return copy.flood;
    }
    case "forward-restricted": {
      return copy.forwardRestricted;
    }
    case "not-logged-in":
    case "off": {
      return copy.loggedOut;
    }
    case "peer-not-found": {
      return copy.peerNotFound;
    }
    case "rpc":
    case "unknown": {
      return copy.refused;
    }
    default: {
      return absurd<string>(error.reason);
    }
  }
};

/**
 * What a run reads when a call on the account failed. A protected source gets
 * its own sentence, so the run reports it instead of rebuilding the post from
 * downloaded media.
 */
export const accountErrorText = (error: TelegramAccountError) => {
  if (error.reason === "forward-restricted") {
    return "Telegram does not allow forwarding these messages: the source chat protects its content. Do not download and re-send them; report that the forward is not possible.";
  }
  if (alreadySent(error)) {
    return "Some of these messages are no longer scheduled: they were already sent or cancelled. Nothing was deleted.";
  }
  return error.message;
};

/** A failure class as the table and the ledger keep it. */
const errorReasonOf = (error: TelegramAccountError) =>
  error.rpc === undefined ? error.reason : `${error.reason}:${error.rpc}`;

const make = Effect.gen(function* make() {
  const cfg = yield* AppConfig;
  const account = yield* TelegramAccount;
  const repo = yield* AccountActionsRepo;
  const users = yield* UsersRepo;
  const apiRuns = yield* ApiRunsRepo;
  const apiKeys = yield* ApiKeysRepo;
  const telegram = yield* TelegramBot;
  const observability = yield* Observability;
  const writesMode = (yield* WritesMode).current;
  const rawSchema = yield* RawSchema;
  const provide = Effect.provideService(Observability, observability);

  /**
   * Confirmations name the recipient and carry the owner's private text, so
   * they go to the owner's private chat only, never the shared workspace.
   */
  const ownerRoute = { chatId: cfg.allowedUserId, threadId: null } as const;

  /** Carry a write out on the account. */
  const execute = (payload: AccountActionPayload) =>
    payload.kind === "raw"
      ? executeRaw({
          account,
          index: rawSchema.index.pipe(
            Effect.mapError(
              (cause) =>
                new TelegramAccountError({
                  cause,
                  method: `raw:${payload.method}`,
                  reason: "unknown",
                })
            )
          ),
          payload,
        })
      : executeWrite(account, payload);

  /**
   * The files of a `media` write sent to the owner as they would go out,
   * silently, so the confirmation can answer them. Its message id.
   */
  const sendPreview = (
    payload: Extract<AccountActionPayload, { kind: "media" }>
  ) => {
    const chatId = cfg.allowedUserId;
    const { caption } = payload;
    const [first, ...rest] = payload.items;
    if (first !== undefined && rest.length === 0) {
      const other = { caption, disable_notification: true };
      const file = fileOf(first);
      const send: Record<
        AccountMediaKind,
        (api: typeof telegram.api) => Promise<{ readonly message_id: number }>
      > = {
        audio: async (api) => await api.sendAudio(chatId, file, other),
        document: async (api) => await api.sendDocument(chatId, file, other),
        photo: async (api) => await api.sendPhoto(chatId, file, other),
        video: async (api) => await api.sendVideo(chatId, file, other),
        voice: async (api) => await api.sendVoice(chatId, file, other),
      };
      return telegram
        .use(`send_${first.as}_preview`, send[first.as])
        .pipe(Effect.map((sent) => sent.message_id));
    }
    const media = albumPreview(payload.items, caption);
    return telegram
      .use(
        "sendMediaGroup_preview",
        async (api) =>
          await api.sendMediaGroup(chatId, media, {
            disable_notification: true,
          })
      )
      .pipe(Effect.map(([sent]) => sent?.message_id));
  };

  /** Replace the confirmation's buttons with the outcome, best effort. */
  const settle = (entry: AccountActionEntry, outcome: string) => {
    const { chatId } = entry;
    const { messageId } = entry;
    if (chatId === undefined || messageId === undefined) {
      return Effect.void;
    }
    return telegram
      .use(
        "editMessageText",
        async (api) =>
          await api.editMessageText(
            chatId,
            messageId,
            `${describeAction(entry.payload)}\n\n${outcome}`
          ),
        { logLevel: "debug", retry: "all" }
      )
      .pipe(Effect.ignore);
  };

  /** Run an approved write and record how it ended. */
  const carryOut = (entry: AccountActionEntry, via: "confirmed" | "direct") =>
    execute(entry.payload).pipe(
      Effect.ensuring(discard(entry.payload)),
      // The write happened; a failure to record it must not report it failed.
      Effect.tap(() =>
        repo.complete({ id: entry.id, status: "done" }).pipe(Effect.ignore)
      ),
      Effect.tap(() =>
        recordAccountCall({
          access: "write",
          actionId: entry.id,
          errorReason: null,
          outcome: via,
          peerId: peerIdOf(entry.payload),
          tool: toolOf(entry.payload),
        })
      ),
      Effect.tapError((error) =>
        Effect.all([
          repo
            .complete({
              error: errorReasonOf(error),
              id: entry.id,
              status: "failed",
            })
            .pipe(Effect.ignore),
          recordAccountCall({
            access: "write",
            actionId: entry.id,
            errorReason: errorReasonOf(error),
            outcome: "failed",
            peerId: peerIdOf(entry.payload),
            tool: toolOf(entry.payload),
          }),
        ])
      )
    );

  /** Mark an approved write failed before it reached the account. */
  const failApproved = (entry: AccountActionEntry, reason: string) =>
    Effect.all([
      discard(entry.payload),
      repo
        .complete({ error: reason, id: entry.id, status: "failed" })
        .pipe(Effect.ignore),
      recordAccountCall({
        access: "write",
        actionId: entry.id,
        errorReason: reason,
        outcome: "failed",
        peerId: peerIdOf(entry.payload),
        tool: toolOf(entry.payload),
      }),
    ]);

  /** Mark a write failed before it reached the account, with its line. */
  const failEarly = (entry: AccountActionEntry, reason: string) =>
    repo
      .decide({ id: entry.id, status: "approved" })
      .pipe(Effect.ignore, Effect.andThen(failApproved(entry, reason)));

  /**
   * The requester as the write keeps it: an executor with the @username the
   * bot has for them. A failed lookup only costs the name.
   */
  const personOf = (stamp: TaskStamp) =>
    stamp.author === "owner"
      ? Effect.succeed<AccountRequester>(stamp)
      : users.get(stamp.userId).pipe(
          Effect.map((row): AccountRequester => ({
            ...stamp,
            username: Option.getOrUndefined(row)?.username,
          })),
          Effect.orElseSucceed((): AccountRequester => stamp)
        );

  /**
   * The name of the API key whose run asked, read from the run's row; a
   * failed lookup only costs the name.
   */
  const apiKeyNameOf = (runId: number) =>
    apiRuns.get(runId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeedNone,
          onSome: (run) => apiKeys.get(run.keyId),
        })
      ),
      Effect.map(Option.map((key) => key.name)),
      Effect.orElseSucceed(() => Option.none<string>())
    );

  /**
   * The requester as the write keeps it: an executor with the @username the
   * bot has for them, and the API key when an API run asked.
   */
  const requesterFor = (stamp: TaskStamp) =>
    Effect.gen(function* () {
      const person = yield* personOf(stamp);
      if (stamp.apiRunId === undefined) {
        return person;
      }
      const name = yield* apiKeyNameOf(stamp.apiRunId);
      return {
        ...person,
        apiKey: Option.getOrElse(name, () => `#${stamp.apiRunId}`),
        apiRunId: stamp.apiRunId,
      };
    });

  /**
   * A write a run asked for, by the user the run works for. Under `confirm`:
   * stored, shown to the owner with who asked, answered `pending` at once.
   * Under `direct`: carried out now, except a raw call, which always asks.
   * Every failure is already in the ledger when it reaches the caller,
   * except a confirmation too long to show, which is BadInput before
   * anything is stored.
   */
  const request = Effect.fn("AccountActions.request")(function* (
    write: AccountActionPayload,
    stamp: TaskStamp
  ) {
    const asked: AccountActionPayload = {
      ...write,
      requestedBy: yield* requesterFor(stamp),
    };
    // An API run always asks: its prompt came from a program, and the owner
    // sees which key's run wants to write as them before it does.
    const mode =
      asked.kind === "raw" || stamp.apiRunId !== undefined
        ? "confirm"
        : yield* writesMode;
    if (mode === "direct") {
      const payload = asked;
      const entry = yield* repo.create({ payload, status: "approved" });
      const result = yield* carryOut(entry, "direct").pipe(
        Effect.mapError(
          (error) =>
            new AccountWriteFailed({ message: accountErrorText(error) })
        )
      );
      return { ...result, id: entry.id, status: "done" } as const;
    }
    const fitted = fitConfirmation(asked);
    if (Option.isNone(fitted)) {
      return yield* badInput(
        "The confirmation would be too long to show the owner; shorten the text or caption, or send fewer files."
      );
    }
    const payload = fitted.value;
    const entry = yield* repo.create({ payload, status: "pending" });
    // The owner sees exactly the files that would go out, or no button at all.
    const preview =
      payload.kind === "media"
        ? yield* sendPreview(payload).pipe(
            Effect.tapError(() =>
              failEarly(entry, "confirmation-not-sent:preview")
            ),
            Effect.mapError(
              () =>
                new AccountWriteFailed({
                  message:
                    "Could not show the files to the owner; nothing was sent.",
                })
            )
          )
        : undefined;
    const keyboard = new InlineKeyboard()
      .text(confirmLabel(payload), `acct:ok:${entry.id}`)
      .text(t().cancel, `acct:no:${entry.id}`);
    const sent = yield* telegram
      .sendTo(ownerRoute, describeAction(payload), {
        reply_markup: keyboard,
        reply_parameters:
          preview === undefined
            ? undefined
            : { allow_sending_without_reply: true, message_id: preview },
      })
      .pipe(
        Effect.tapError((error) =>
          failEarly(entry, `confirmation-not-sent:${error.reason}`)
        ),
        Effect.mapError(
          () =>
            new AccountWriteFailed({
              message:
                "Could not show the confirmation to the owner; the write was not made.",
            })
        )
      );
    // The confirmation is live either way: its buttons carry the id, so a
    // failed link only costs the outcome edit, never the write.
    yield* repo
      .attachConfirmation({
        chatId: sent.chat.id,
        id: entry.id,
        messageId: sent.message_id,
        threadId: null,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("account confirmation link failed", error)
        )
      );
    yield* recordAccountCall({
      access: "write",
      actionId: entry.id,
      errorReason: null,
      outcome: "pending",
      peerId: peerIdOf(payload),
      tool: toolOf(payload),
    });
    return { id: entry.id, status: "pending" } as const;
  }, provide);

  /**
   * The owner's press on a confirmation. Answers the text for the button's
   * toast; the confirmation message itself is edited to show the outcome.
   */
  const decide = Effect.fn("AccountActions.decide")(function* (input: {
    readonly approve: boolean;
    readonly id: number;
  }) {
    const claimed = yield* repo.decide({
      id: input.id,
      status: input.approve ? "approved" : "rejected",
    });
    if (Option.isNone(claimed)) {
      return t().accountActions.closed;
    }
    const entry = claimed.value;
    if (!input.approve) {
      yield* recordAccountCall({
        access: "write",
        actionId: entry.id,
        errorReason: null,
        outcome: "rejected",
        peerId: peerIdOf(entry.payload),
        tool: toolOf(entry.payload),
      });
      const { cancelled } = t().accountActions;
      yield* discard(entry.payload);
      yield* settle(entry, cancelled);
      return cancelled;
    }
    if (schedulePassed(entry.payload)) {
      const { failed } = t().accountActions;
      const text =
        entry.payload.kind === "mute"
          ? failed.muteEnded
          : failed.schedulePassed;
      yield* failApproved(entry, "schedule-passed");
      yield* settle(entry, text);
      return text;
    }
    const done = yield* carryOut(entry, "confirmed").pipe(Effect.result);
    const text = Result.isSuccess(done)
      ? t().accountActions.done
      : failureText(done.failure);
    yield* settle(entry, text);
    return text;
  }, provide);

  /** Expire every write pending for a day and say so on its confirmation. */
  const expirePass = Effect.gen(function* () {
    const cutoff = Date.now() - Duration.toMillis(EXPIRE_AFTER);
    const expired = yield* repo.expireBefore(cutoff);
    yield* Effect.forEach(expired, (entry) =>
      Effect.all([
        discard(entry.payload),
        settle(entry, t().accountActions.expired),
        recordAccountCall({
          access: "write",
          actionId: entry.id,
          errorReason: null,
          outcome: "expired",
          peerId: peerIdOf(entry.payload),
          tool: toolOf(entry.payload),
        }),
      ])
    );
  }).pipe(
    provide,
    Effect.catch((error) =>
      Effect.logWarning("account action expiry failed", error)
    ),
    Effect.withSpan("AccountActions.expirePass")
  );

  if (Option.isSome(cfg.telegramAccount)) {
    yield* expirePass.pipe(
      Effect.repeat(Schedule.spaced(EXPIRY_PASS)),
      Effect.forkScoped
    );
  }

  return { decide, request } as const;
});

/**
 * AccountActions: the one path every write on the owner's Telegram account
 * takes, whatever asked for it. Owns the 24 h expiry loop, which runs in the
 * layer scope only when the account feature is on.
 */
export class AccountActions extends Context.Service<
  AccountActions,
  Effect.Success<typeof make>
>()("@workspace/AccountActions") {
  static readonly layer = Layer.effect(AccountActions, make);
}
