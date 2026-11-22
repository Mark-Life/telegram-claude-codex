import type { BusinessMemoryMessage, BusinessSenderRole } from "@workspace/db";

import { heardCallName } from "../access/call-name";
import type { BotContext } from "../access/context";
import { ensureScratchDir } from "../access/scratch";
import {
  deleteBusinessMessages,
  getBusinessMessage,
  listRecentBusinessMessages,
  recordBusinessMessage,
  rememberBusinessChat,
} from "../db/bridge";
import { t } from "../i18n";
import { loadHeardNames, loadPersona } from "../persona";
import { tg, tgBestEffort } from "../telegram/bridge";
import { judgeAddressedFor } from "./address-judge";
import {
  alreadyAnswered,
  BUSINESS_CONTEXT_WINDOW_MS,
  chatTitle,
  claimRequest,
  deliverBusinessAnswer,
  TELEGRAM_SECONDS_TO_MS,
} from "./business-reply";
import type { TelegramBusinessMessage } from "./business-reply";
import type { HandlerDeps } from "./deps";
import { logRejection, logUnlessTelegram } from "./helpers";
import { transcribeAudio } from "./messages";

/** Turns of the Business chat the address judge reads before the owner message. */
const JUDGE_CONTEXT_MESSAGES = 6;
const JUDGE_CONTEXT_MESSAGE_MAX_CHARS = 1500;

/**
 * How many Business connections stay cached. Any Telegram user may connect the
 * bot to their own Business account, so both caches are keyed by something an
 * outsider controls; the owner has a handful of connections at most, and the
 * rest are negative entries worth nothing once they fall out.
 */
const MAX_TRACKED_CONNECTIONS = 64;

/**
 * Drop the oldest entries until the collection fits. Map and Set both iterate
 * in insertion order, so the first key is the least recently added.
 */
const capOldest = (tracked: Map<string, unknown> | Set<string>) => {
  while (tracked.size > MAX_TRACKED_CONNECTIONS) {
    const [oldest] = tracked.keys();
    if (oldest === undefined) {
      return;
    }
    tracked.delete(oldest);
  }
};

/** Connections the owner was already told the bot cannot reply through. */
const reportedConnections = new Set<string>();
/** Whether a connection belongs to the owner; spares one API call per message. */
const ownerConnections = new Map<string, boolean>();

const displayName = (user: TelegramBusinessMessage["from"]) => {
  if (user === undefined) {
    return "Unknown sender";
  }
  const full = [user.first_name, user.last_name].filter(Boolean).join(" ");
  return full.length > 0 ? full : (user.username ?? String(user.id));
};

const senderRole = (
  message: TelegramBusinessMessage,
  ownerId: number
): BusinessSenderRole => {
  if (message.sender_business_bot !== undefined) {
    return "assistant";
  }
  return message.from?.id === ownerId ? "owner" : "peer";
};

const messageKind = (message: TelegramBusinessMessage) => {
  if (message.text !== undefined) {
    return "text";
  }
  if (message.voice !== undefined) {
    return "voice";
  }
  if (message.photo !== undefined) {
    return "photo";
  }
  if (message.document !== undefined) {
    return "document";
  }
  if (message.video !== undefined) {
    return "video";
  }
  if (message.video_note !== undefined) {
    return "video_note";
  }
  if (message.audio !== undefined) {
    return "audio";
  }
  if (message.animation !== undefined) {
    return "animation";
  }
  if (message.sticker !== undefined) {
    return "sticker";
  }
  if (message.contact !== undefined) {
    return "contact";
  }
  if (message.location !== undefined) {
    return "location";
  }
  if (message.poll !== undefined) {
    return "poll";
  }
  return "service";
};

const messageText = (message: TelegramBusinessMessage) => {
  if (message.text !== undefined || message.caption !== undefined) {
    return message.text ?? message.caption ?? "";
  }
  if (message.contact !== undefined) {
    const name = [message.contact.first_name, message.contact.last_name]
      .filter(Boolean)
      .join(" ");
    return `[Contact] ${name}: ${message.contact.phone_number}`;
  }
  if (message.location !== undefined) {
    return `[Location] ${message.location.latitude}, ${message.location.longitude}`;
  }
  if (message.poll !== undefined) {
    return `[Poll] ${message.poll.question}; ${message.poll.options.map((option) => option.text).join("; ")}`;
  }
  if (message.sticker?.emoji !== undefined) {
    return `[Sticker] ${message.sticker.emoji}`;
  }
  return "";
};

const mediaFileId = (message: TelegramBusinessMessage) =>
  message.voice?.file_id ??
  message.document?.file_id ??
  message.video?.file_id ??
  message.video_note?.file_id ??
  message.audio?.file_id ??
  message.animation?.file_id ??
  message.sticker?.file_id ??
  message.photo?.at(-1)?.file_id;

const isOwnerConnection = async (ownerId: number, connectionId: string) => {
  const cached = ownerConnections.get(connectionId);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const connection = await tg(
      "getBusinessConnection",
      async (api) => await api.getBusinessConnection(connectionId),
      { retry: "all" }
    );
    const allowed = connection.user.id === ownerId;
    ownerConnections.set(connectionId, allowed);
    capOldest(ownerConnections);
    return allowed;
  } catch (error) {
    logUnlessTelegram("Business connection lookup failed")(error);
    return false;
  }
};

const downloadVoice = async (token: string, fileId: string) => {
  const file = await tg("getFile", async (api) => await api.getFile(fileId), {
    retry: "all",
  });
  if (file.file_path === undefined) {
    throw new Error("Telegram returned a voice without file_path");
  }
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Telegram voice download failed with ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
};

const notifyOwnerOnce = async (
  deps: Pick<HandlerDeps, "ownerId">,
  connectionId: string
) => {
  if (reportedConnections.has(connectionId)) {
    return;
  }
  reportedConnections.add(connectionId);
  capOldest(reportedConnections);
  const persona = await loadPersona();
  // The Business chat must stay silent when even the private notice fails.
  await tgBestEffort(
    "sendMessage",
    async (api) =>
      await api.sendMessage(deps.ownerId, t().business.cannotReply(persona))
  );
};

const canReplyThrough = async (
  deps: Pick<HandlerDeps, "ownerId">,
  connectionId: string
) => {
  try {
    const connection = await tg(
      "getBusinessConnection",
      async (api) => await api.getBusinessConnection(connectionId),
      { retry: "all" }
    );
    const allowed =
      connection.is_enabled &&
      connection.user.id === deps.ownerId &&
      connection.rights?.can_reply === true;
    if (!allowed) {
      await notifyOwnerOnce(deps, connectionId);
    }
    return allowed;
  } catch (error) {
    // Telegram said nothing, so the rights are unknown rather than missing: a
    // network blip must not burn the once-per-connection notice.
    logUnlessTelegram("Business rights lookup failed")(error);
    return false;
  }
};

const prepareVoice = async (input: {
  ctx: BotContext;
  deps: HandlerDeps;
  existing?: BusinessMemoryMessage;
  message: TelegramBusinessMessage;
  role: BusinessSenderRole;
}) => {
  const voiceFileId = input.message.voice?.file_id;
  let voiceData = input.existing?.voiceData;
  let transcript = input.existing?.transcript;
  let transcriptStatus = input.existing?.transcriptStatus ?? "none";
  if (voiceFileId !== undefined && voiceData === undefined) {
    try {
      voiceData = await downloadVoice(input.deps.token, voiceFileId);
      transcriptStatus = "pending";
    } catch {
      transcriptStatus = "failed";
    }
  }
  if (
    voiceData !== undefined &&
    input.role === "owner" &&
    transcriptStatus !== "ready"
  ) {
    try {
      transcript = await transcribeAudio(
        Buffer.from(voiceData),
        "business-owner-voice.ogg"
      );
      transcriptStatus = "ready";
    } catch {
      transcriptStatus = "failed";
    }
  }
  return { transcript, transcriptStatus, voiceData, voiceFileId } as const;
};

/**
 * The turns before an owner message, as the judge reads them. Archive only: a
 * peer voice not yet transcribed stays a placeholder, since the judge must stay
 * cheap and only needs to see that a human conversation is going on.
 */
const judgeContext = async (input: {
  connectionId: string;
  message: TelegramBusinessMessage;
}) => {
  const recent = await listRecentBusinessMessages({
    businessConnectionId: input.connectionId,
    chatId: input.message.chat.id,
    from:
      input.message.date * TELEGRAM_SECONDS_TO_MS - BUSINESS_CONTEXT_WINDOW_MS,
    limit: JUDGE_CONTEXT_MESSAGES + 1,
  });
  return recent
    .filter((row) => row.messageId !== input.message.message_id)
    .slice(-JUDGE_CONTEXT_MESSAGES)
    .map((row) => {
      const body = [row.text, row.transcript]
        .filter(
          (part): part is string => part !== undefined && part.trim().length > 0
        )
        .join("\n");
      const text = body.length > 0 ? body : `[${row.kind}]`;
      return {
        from: row.senderName,
        text:
          text.length <= JUDGE_CONTEXT_MESSAGE_MAX_CHARS
            ? text
            : `${text.slice(0, JUDGE_CONTEXT_MESSAGE_MAX_CHARS)}…`,
      };
    });
};

const maybeAnswerBusinessRequest = async (
  ctx: BotContext,
  deps: HandlerDeps,
  message: TelegramBusinessMessage,
  request: string
) => {
  const connectionId = message.business_connection_id;
  if (
    connectionId === undefined ||
    message.from?.id !== deps.ownerId ||
    message.sender_business_bot !== undefined ||
    message.is_from_offline === true ||
    // An edit is the owner fixing a typo, never a second request: the archive
    // takes the new text, the peer keeps the one answer already sent.
    message.edit_date !== undefined
  ) {
    return;
  }

  // Gate 1 is deterministic and free. No judge runs without a whole-word match
  // for the configured call name and its declensions.
  const callName = heardCallName(request, await loadHeardNames());
  if (callName === undefined) {
    return;
  }

  if (
    !claimRequest(`${connectionId}:${message.chat.id}:${message.message_id}`) ||
    (await alreadyAnswered({ connectionId, message }))
  ) {
    return;
  }

  // Gate 2 distinguishes an address from the owner discussing the bot with the
  // peer. It needs the preceding turns: alone, a voice reply full of "you" and
  // the bot's name reads as a request to the bot. The full model is Gate 3, on yes only.
  const ownerName = displayName(message.from);
  const addressed = await judgeAddressedFor({
    botName: callName,
    messages: [
      ...(await judgeContext({ connectionId, message })),
      { from: ownerName, text: request },
    ],
    surface: {
      kind: "business",
      ownerName,
      peerName: chatTitle(message.chat),
    },
    userId: deps.ownerId,
    // The helper fallback runs a turn, which needs a directory.
    workingDirectory: ensureScratchDir(deps.ownerId),
  });
  if (!addressed) {
    return;
  }

  if (!(await canReplyThrough(deps, connectionId))) {
    return;
  }

  await deliverBusinessAnswer({ connectionId, deps, message, request });
};

const archiveBusinessMessage = async (
  ctx: BotContext,
  deps: HandlerDeps,
  message: TelegramBusinessMessage
) => {
  const connectionId = message.business_connection_id;
  if (
    connectionId === undefined ||
    !(await isOwnerConnection(deps.ownerId, connectionId))
  ) {
    return;
  }

  await rememberBusinessChat({
    businessConnectionId: connectionId,
    chatId: message.chat.id,
    peerId: message.chat.id,
    title: chatTitle(message.chat),
    username: message.chat.username,
  });

  const role = senderRole(message, deps.ownerId);
  const existing = await getBusinessMessage({
    businessConnectionId: connectionId,
    chatId: message.chat.id,
    messageId: message.message_id,
  });
  const { transcript, transcriptStatus, voiceData, voiceFileId } =
    await prepareVoice({ ctx, deps, existing, message, role });
  const { callName } = await loadPersona();

  // Archived before any reply: the answer's context and the answered check
  // both read this row back.
  await recordBusinessMessage({
    businessConnectionId: connectionId,
    chatId: message.chat.id,
    editedAt:
      message.edit_date === undefined
        ? undefined
        : message.edit_date * TELEGRAM_SECONDS_TO_MS,
    ingestedAt: Date.now(),
    kind: messageKind(message),
    mediaFileId: mediaFileId(message),
    messageId: message.message_id,
    replyToMessageId: message.reply_to_message?.message_id,
    senderId: message.from?.id,
    senderName: role === "assistant" ? callName : displayName(message.from),
    senderRole: role,
    senderUsername: message.from?.username,
    sentAt: message.date * TELEGRAM_SECONDS_TO_MS,
    text: messageText(message),
    transcript,
    transcriptStatus,
    voiceData,
    voiceFileId,
  });

  const request = [messageText(message), transcript]
    .filter(
      (part): part is string => part !== undefined && part.trim().length > 0
    )
    .join("\n");
  if (request.length > 0) {
    await maybeAnswerBusinessRequest(ctx, deps, message, request);
  }
};

const handleDeletedBusinessMessages = async (
  ctx: BotContext,
  deps: HandlerDeps
) => {
  const deleted = ctx.deletedBusinessMessages;
  if (
    deleted === undefined ||
    !(await isOwnerConnection(deps.ownerId, deleted.business_connection_id))
  ) {
    return;
  }
  await deleteBusinessMessages({
    businessConnectionId: deleted.business_connection_id,
    chatId: deleted.chat.id,
    messageIds: deleted.message_ids,
  });
};

/** Archive every owner Business update; only manual owner messages can pass the three reply gates. */
export const registerBusinessHandlers = (deps: HandlerDeps) => {
  deps.bot.on("business_connection", (ctx) => {
    const connection = ctx.businessConnection;
    if (connection === undefined) {
      return;
    }
    // Telegram just told us what this connection is, so both caches start over:
    // a reconnect or a rights change must be able to clear an old complaint.
    ownerConnections.set(connection.id, connection.user.id === deps.ownerId);
    capOldest(ownerConnections);
    reportedConnections.delete(connection.id);
  });
  deps.bot.on("business_message", (ctx) => {
    const message = ctx.businessMessage;
    if (message === undefined) {
      return;
    }
    deps.pendingWork
      .track(archiveBusinessMessage(ctx, deps, message))
      .catch(logRejection("Business message handling failed"));
  });
  deps.bot.on("edited_business_message", (ctx) => {
    const message = ctx.editedBusinessMessage;
    if (message === undefined) {
      return;
    }
    deps.pendingWork
      .track(archiveBusinessMessage(ctx, deps, message))
      .catch(logRejection("Edited Business message handling failed"));
  });
  deps.bot.on("deleted_business_messages", (ctx) => {
    deps.pendingWork
      .track(handleDeletedBusinessMessages(ctx, deps))
      .catch(logRejection("Deleted Business message handling failed"));
  });
};
