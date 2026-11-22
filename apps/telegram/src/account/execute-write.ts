import { InputMedia } from "@mtcute/bun";
import type { AccountActionPayload } from "@workspace/db";
import { Effect } from "effect";
import { absurd } from "effect/Function";

import { TelegramAccountError } from "../telegram/telegram-account";
import type { TelegramAccountHandle } from "../telegram/telegram-account";
import { toReaction } from "./inputs";

/**
 * How each kind of write is carried out on the account, once the owner
 * pressed its button or `direct` let it through. Each answers the ids of the
 * messages it made or touched; a write on a chat (archive, mute) answers none.
 */

export type PayloadOf<Kind extends AccountActionPayload["kind"]> = Extract<
  AccountActionPayload,
  { kind: Kind }
>;

/** What a carried-out write answers: the messages it made or touched. */
export interface Executed {
  readonly messageIds: readonly number[];
}

type Execution = Effect.Effect<Executed, TelegramAccountError>;

/** Telegram's "muted for good": the largest 32-bit timestamp. */
export const MUTE_FOREVER = 2_147_483_647;

/** How a message goes out: reply, topic, sound and schedule. */
const commonOf = (
  payload: PayloadOf<"media"> | PayloadOf<"poll"> | PayloadOf<"send">
) => ({
  replyTo: payload.replyTo,
  schedule: payload.schedule?.at,
  silent: payload.silent,
  threadId: payload.topic?.id,
});

export type MediaItem = PayloadOf<"media">["items"][number];

/** One staged file as mtcute uploads it, under the name the owner was shown. */
const inputMediaOf = (item: MediaItem, caption: string | undefined) => {
  const file = Bun.file(item.path);
  const params = { caption, fileName: item.name };
  switch (item.as) {
    case "photo": {
      return InputMedia.photo(file, params);
    }
    case "video": {
      return InputMedia.video(file, params);
    }
    case "document": {
      return InputMedia.document(file, params);
    }
    case "voice": {
      return InputMedia.voice(file, params);
    }
    case "audio": {
      return InputMedia.audio(file, params);
    }
    default: {
      return absurd<never>(item.as);
    }
  }
};

const sendText = (
  account: TelegramAccountHandle,
  payload: PayloadOf<"send">
): Execution =>
  account
    .use(
      "sendText",
      async (client) =>
        await client.sendText(payload.peer.id, payload.text, {
          ...commonOf(payload),
          clearDraft: payload.clearDraft,
        })
    )
    .pipe(Effect.map((sent) => ({ messageIds: [sent.id] })));

const forward = (
  account: TelegramAccountHandle,
  payload: PayloadOf<"forward">
): Execution =>
  account
    .use(
      "forwardMessagesById",
      async (client) =>
        await client.forwardMessagesById({
          fromChatId: payload.from.id,
          messages: [...payload.messageIds],
          toChatId: payload.to.id,
          toThreadId: payload.toTopic?.id,
        })
    )
    .pipe(
      Effect.map((sent) => ({ messageIds: sent.map((message) => message.id) }))
    );

const edit = (
  account: TelegramAccountHandle,
  payload: PayloadOf<"edit">
): Execution =>
  account
    .use(
      "editMessage",
      async (client) =>
        await client.editMessage({
          chatId: payload.peer.id,
          message: payload.messageId,
          text: payload.text,
        })
    )
    .pipe(Effect.map((edited) => ({ messageIds: [edited.id] })));

const deleteMessages = (
  account: TelegramAccountHandle,
  payload: PayloadOf<"delete">
): Execution =>
  account
    .use("deleteMessagesById", async (client) => {
      await client.deleteMessagesById(
        payload.peer.id,
        [...payload.messageIds],
        { revoke: payload.revoke ?? true }
      );
    })
    .pipe(Effect.as({ messageIds: payload.messageIds }));

/** One file as one message; several as one album, the caption on the first. */
const sendMediaItems = (
  account: TelegramAccountHandle,
  payload: PayloadOf<"media">
): Execution => {
  const [first, ...rest] = payload.items;
  if (first !== undefined && rest.length === 0) {
    return account
      .use(
        "sendMedia",
        async (client) =>
          await client.sendMedia(
            payload.peer.id,
            inputMediaOf(first, payload.caption),
            commonOf(payload)
          )
      )
      .pipe(Effect.map((sent) => ({ messageIds: [sent.id] })));
  }
  return account
    .use(
      "sendMediaGroup",
      async (client) =>
        await client.sendMediaGroup(
          payload.peer.id,
          payload.items.map((item, index) =>
            inputMediaOf(item, index === 0 ? payload.caption : undefined)
          ),
          commonOf(payload)
        )
    )
    .pipe(
      Effect.map((sent) => ({ messageIds: sent.map((message) => message.id) }))
    );
};

const react = (
  account: TelegramAccountHandle,
  payload: PayloadOf<"react">
): Execution =>
  account
    .use("sendReaction", async (client) => {
      await client.sendReaction({
        big: payload.big,
        chatId: payload.peer.id,
        emoji: payload.emoji === null ? null : toReaction(payload.emoji),
        message: payload.messageId,
      });
    })
    .pipe(Effect.as({ messageIds: [payload.messageId] }));

const pin = (
  account: TelegramAccountHandle,
  payload: PayloadOf<"pin">
): Execution =>
  account
    .use("pinMessage", async (client) => {
      await client.pinMessage({
        bothSides: payload.bothSides,
        chatId: payload.peer.id,
        message: payload.messageId,
        notify: payload.notify ?? false,
      });
    })
    .pipe(Effect.as({ messageIds: [payload.messageId] }));

const unpin = (
  account: TelegramAccountHandle,
  payload: PayloadOf<"unpin">
): Execution =>
  account
    .use("unpinMessage", async (client) => {
      await client.unpinMessage({
        chatId: payload.peer.id,
        message: payload.messageId,
      });
    })
    .pipe(Effect.as({ messageIds: [payload.messageId] }));

const archive = (
  account: TelegramAccountHandle,
  payload: PayloadOf<"archive">
): Execution =>
  account
    .use(
      payload.archived ? "archiveChats" : "unarchiveChats",
      async (client) => {
        await (payload.archived
          ? client.archiveChats(payload.peer.id)
          : client.unarchiveChats(payload.peer.id));
      }
    )
    .pipe(Effect.as({ messageIds: [] }));

/**
 * Through raw TL: mtcute has no high-level call for a chat's notifications.
 * The chat's current settings are read first and sent back with only
 * `muteUntil` changed: `updateNotifySettings` replaces them all, and a field
 * left out reads as the default, so a bare mute would reset the chat's sound,
 * previews and story settings. The stored settings carry one sound per
 * platform; the one for other clients (desktop) is kept, as tdesktop does.
 */
const mute = (
  account: TelegramAccountHandle,
  payload: PayloadOf<"mute">
): Execution =>
  account
    .use("account.updateNotifySettings", async (client) => {
      const peer = await client.resolvePeer(payload.peer.id);
      const notifyPeer = { _: "inputNotifyPeer", peer } as const;
      const current = await client.call({
        _: "account.getNotifySettings",
        peer: notifyPeer,
      });
      await client.call({
        _: "account.updateNotifySettings",
        peer: notifyPeer,
        settings: {
          _: "inputPeerNotifySettings",
          muteUntil: payload.muteUntil,
          showPreviews: current.showPreviews,
          silent: current.silent,
          sound: current.otherSound ?? current.androidSound ?? current.iosSound,
          storiesHideSender: current.storiesHideSender,
          storiesMuted: current.storiesMuted,
          storiesSound:
            current.storiesOtherSound ??
            current.storiesAndroidSound ??
            current.storiesIosSound,
        },
      });
    })
    .pipe(Effect.as({ messageIds: [] }));

/**
 * The rpc a cancel answers when a scheduled message already went out.
 * Telegram itself accepts deleting ids that are no longer scheduled, so the
 * executor looks them up first and raises this on its own.
 */
export const ALREADY_SENT = "MESSAGE_ID_INVALID";

/**
 * Cancel scheduled messages, but only if every one is still scheduled: one
 * that already went out cannot be cancelled, and the owner approved the set.
 */
const deleteScheduled = (
  account: TelegramAccountHandle,
  payload: PayloadOf<"delete_scheduled">
): Execution =>
  account
    .use("deleteScheduledMessages", async (client) => {
      const ids = [...payload.messageIds];
      const still = await client.getScheduledMessages(payload.peer.id, ids);
      if (still.some((message) => message === null)) {
        return false;
      }
      await client.deleteScheduledMessages(payload.peer.id, ids);
      return true;
    })
    .pipe(
      Effect.flatMap((deleted) =>
        deleted
          ? Effect.succeed({ messageIds: payload.messageIds })
          : Effect.fail(
              new TelegramAccountError({
                cause: undefined,
                method: "deleteScheduledMessages",
                reason: "rpc",
                rpc: ALREADY_SENT,
              })
            )
      )
    );

const sendScheduled = (
  account: TelegramAccountHandle,
  payload: PayloadOf<"send_scheduled">
): Execution =>
  account
    .use(
      "sendScheduled",
      async (client) =>
        await client.sendScheduled(payload.peer.id, [...payload.messageIds])
    )
    .pipe(
      Effect.map((sent) => ({ messageIds: sent.map((message) => message.id) }))
    );

const sendPoll = (
  account: TelegramAccountHandle,
  payload: PayloadOf<"poll">
): Execution =>
  account
    .use(
      "sendMedia",
      async (client) =>
        await client.sendMedia(
          payload.peer.id,
          InputMedia.poll({
            answers: [...payload.answers],
            multiple: payload.multiple,
            public: payload.public,
            question: payload.question,
          }),
          commonOf(payload)
        )
    )
    .pipe(Effect.map((sent) => ({ messageIds: [sent.id] })));

/**
 * Through raw TL, by the answers' bytes the owner was shown, so an answer
 * removed since is refused, never swapped for another. mtcute's `sendVote`
 * would parse the poll out of the reply and throw when Telegram leaves it out
 * (it does once the poll is cached), after the vote already went through.
 * No options retracts the vote.
 */
const vote = (
  account: TelegramAccountHandle,
  payload: PayloadOf<"vote">
): Execution =>
  account
    .use("messages.sendVote", async (client) => {
      const peer = await client.resolvePeer(payload.peer.id);
      const res = await client.call({
        _: "messages.sendVote",
        msgId: payload.messageId,
        options: payload.optionData.map(
          (data) => new Uint8Array(Buffer.from(data, "base64"))
        ),
        peer,
      });
      client.handleClientUpdate(res, true);
    })
    .pipe(Effect.as({ messageIds: [payload.messageId] }));

/** Every write but a raw call, which `execute-raw.ts` carries out. */
type TypedPayload = Exclude<AccountActionPayload, { kind: "raw" }>;

/** Carry one typed write out on the account. */
export const executeWrite = (
  account: TelegramAccountHandle,
  payload: TypedPayload
): Execution => {
  switch (payload.kind) {
    case "send": {
      return sendText(account, payload);
    }
    case "forward": {
      return forward(account, payload);
    }
    case "edit": {
      return edit(account, payload);
    }
    case "delete": {
      return deleteMessages(account, payload);
    }
    case "media": {
      return sendMediaItems(account, payload);
    }
    case "react": {
      return react(account, payload);
    }
    case "pin": {
      return pin(account, payload);
    }
    case "unpin": {
      return unpin(account, payload);
    }
    case "archive": {
      return archive(account, payload);
    }
    case "mute": {
      return mute(account, payload);
    }
    case "delete_scheduled": {
      return deleteScheduled(account, payload);
    }
    case "send_scheduled": {
      return sendScheduled(account, payload);
    }
    case "poll": {
      return sendPoll(account, payload);
    }
    case "vote": {
      return vote(account, payload);
    }
    default: {
      return absurd<Execution>(payload);
    }
  }
};
