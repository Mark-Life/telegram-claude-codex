import type { Context } from "grammy";

import { logError } from "../log";
import { TelegramBotError, tgBestEffort } from "../telegram/bridge";

/** `model:<id>`, or on pi `model:<version>:<index>`, `model:all`. */
export const MODEL_CALLBACK_RE = /^model:(?<value>.+)$/u;
export const MODEL_ROUTING_CALLBACK_RE = /^model_routing:(?<value>auto|off)$/u;
export const SETTINGS_CALLBACK_RE =
  /^settings:(?<key>[a-z_]+):(?<value>[a-z0-9]+)$/u;
/**
 * `defaults:new:<field>` opens a picker, `defaults:new:<field>:<value>` sets
 * the value: a word, or a pi model's `<version>_<index>`.
 */
export const DEFAULTS_CALLBACK_RE =
  /^defaults:new:(?<field>back|effort|model|provider)(?::(?<value>[a-z0-9_]+))?$/u;
/** `light:<field>` opens a picker, `light:<field>:<value>` sets the value. */
export const LIGHT_CALLBACK_RE =
  /^light:(?<field>back|effort|model|provider)(?::(?<value>[a-z0-9_]+))?$/u;
/**
 * `help:<use>:<field>` opens a helper pass's picker,
 * `help:<use>:<field>:<value>` sets the value: a word, or a pi model's
 * `<version>_<index>`.
 */
export const HELPER_CALLBACK_RE =
  /^help:(?<use>format|judge|title):(?<field>back|effort|model|provider)(?::(?<value>[a-z0-9_]+))?$/u;
/**
 * `menu:<screen>[:<arg>]` opens one screen of `/settings`; the argument is
 * a provider under `prov`, a helper pass under `help`.
 */
export const MENU_CALLBACK_RE =
  /^menu:(?<screen>bot|help|home|light|my|prov|voice)(?::(?<arg>[a-z]+))?$/u;
/**
 * `voice:<field>:<value>` stores a voice reply's model or voice: a model id,
 * or an ElevenLabs voice id, which is mixed case.
 */
export const VOICE_CALLBACK_RE =
  /^voice:(?<field>model|voice):(?<value>[A-Za-z0-9_]{1,40})$/u;
/**
 * `pset:<provider>:<key>` opens a provider setting's picker,
 * `pset:<provider>:<key>:<value>` sets it (`unset` forgets it).
 */
export const PROVIDER_SETTING_CALLBACK_RE =
  /^pset:(?<provider>[a-z]+):(?<key>[A-Za-z_]+)(?::(?<value>[A-Za-z0-9]+))?$/u;
/** `login:<entry>:<verb>`, a press in the `/login` menu. */
export const LOGIN_CALLBACK_RE = /^login:(?<key>[a-z]+):(?<verb>[a-z]+)$/u;
export const PROVIDER_CALLBACK_RE = /^provider:(?<value>[a-z]+)$/u;
export const EFFORT_CALLBACK_RE = /^effort:(?<value>.+)$/u;
export const COMPOSE_SEND_RE = /^compose_send:(?<value>\d+)$/u;
export const COMPOSE_CANCEL_RE = /^compose_cancel:(?<value>\d+)$/u;
export const HISTORY_PAGE_RE = /^history:(?<value>\d+)$/u;
export const HISTORY_TASKS_RE = /^history_tasks:(?<value>\d+)$/u;
/** `session:<provider>:<id>`; a button from before providers were named has no provider. */
export const SESSION_CALLBACK_RE =
  /^session:(?:(?<provider>[a-z]+):)?(?<value>[^:]+)$/u;
export const FORCE_SEND_RE = /^force_send:(?<value>\d+)$/u;
export const CLEAR_QUEUE_RE = /^clear_queue:(?<value>\d+)$/u;
export const PLAN_NEW_RE = /^plan_new:(?<value>\d+)$/u;
export const PLAN_RESUME_RE = /^plan_resume:(?<value>\d+)$/u;
export const PLAN_MODIFY_RE = /^plan_modify:(?<value>\d+)$/u;
export const PLAN_CANCEL_RE = /^plan_cancel:(?<value>\d+)$/u;
/** `/context`'s buttons, for the user it was sent to. */
export const CONTEXT_COMPACT_RE = /^context_compact:(?<value>\d+)$/u;
export const CONTEXT_NEW_RE = /^context_new:(?<value>\d+)$/u;

/** Longest quoted slice of the replied-to message added to a prompt. */
const REPLY_QUOTE_MAX_CHARS = 2000;

/** Escape HTML special characters for Telegram. */
export const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** No-op that swallows errors from best-effort work that is not a Telegram call. */
export const swallow = () => {
  // Best-effort operations: failures here are non-critical and ignored.
};

/**
 * Fire-and-forget rejection sink: logs `label` plus the reason instead of
 * letting an unhandled rejection escape the update loop. A rejection reason is
 * `unknown` by construction, so this is the one place that accepts it.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a rejection reason has no domain type; this is the single boundary that logs it
export const logRejection = (label: string) => (error: unknown) => {
  logError(label, error);
};

/**
 * `logRejection` for work that may fail on a Telegram call: a
 * `TelegramBotError` was already logged once by TelegramBot with its label and
 * reason, so only anything else is logged here.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a rejection reason has no domain type; this sink only narrows it
export const logUnlessTelegram = (label: string) => (error: unknown) => {
  if (!(error instanceof TelegramBotError)) {
    logRejection(label)(error);
  }
};

/** Chat id from context; message/callback updates always carry a chat. */
export const requireChat = (ctx: Context) => {
  if (!ctx.chat) {
    throw new Error("No chat context");
  }
  return ctx.chat.id;
};

/** User id from context (safe after the access-control middleware). */
export const getUserId = (ctx: Context) => {
  if (!ctx.from) {
    throw new Error("No user context");
  }
  return ctx.from.id;
};

type ForwardOrigin = NonNullable<
  NonNullable<Context["message"]>["forward_origin"]
>;

/** Display name for a forwarded message origin. */
export const forwardSenderName = (origin: ForwardOrigin) => {
  if (origin.type === "user") {
    return origin.sender_user.first_name;
  }
  if (origin.type === "channel") {
    return origin.chat.title;
  }
  if (origin.type === "hidden_user") {
    return origin.sender_user_name;
  }
  if (origin.type === "chat") {
    return origin.sender_chat.title ?? "unknown";
  }
  return "unknown";
};

/** Unpin existing pins and pin the given edited message (best-effort). */
export const repinMessage = async (
  ctx: Context,
  chatId: number,
  msg: Awaited<ReturnType<Context["editMessageText"]>>
) => {
  await tgBestEffort(
    "unpinAllChatMessages",
    async (api) => await api.unpinAllChatMessages(chatId),
    { retry: false }
  );
  const pinnedId = msg === true ? undefined : msg.message_id;
  if (pinnedId !== undefined) {
    await tgBestEffort(
      "pinChatMessage",
      async (api) =>
        await api.pinChatMessage(chatId, pinnedId, {
          disable_notification: true,
        }),
      { retry: false }
    );
  }
};

/** Remove the legacy persistent command keyboard from the chat. */
export const removedKeyboard = { remove_keyboard: true } as const;

/** Prepend the replied-to message as context (skipping the bot's own). */
export const buildPromptWithReplyContext = (
  ctx: Context,
  userText: string,
  botId?: number,
  repliedAttachment?: string
) => {
  const replied = ctx.message?.reply_to_message;
  const replyText = replied?.text ?? replied?.caption ?? "";
  if (replyText.length === 0 && repliedAttachment === undefined) {
    return userText;
  }
  if (
    repliedAttachment === undefined &&
    botId !== undefined &&
    replied?.from?.id === botId
  ) {
    return userText;
  }
  const truncated =
    replyText.length > REPLY_QUOTE_MAX_CHARS
      ? `${replyText.slice(0, REPLY_QUOTE_MAX_CHARS)}...`
      : replyText;
  const parts = [
    "[Telegram message being replied to]",
    ...(truncated.length === 0 ? [] : [`text=${JSON.stringify(truncated)}`]),
    ...(repliedAttachment === undefined ? [] : [repliedAttachment]),
    "[/Telegram message being replied to]",
  ];
  return `${parts.join("\n")}\n\n${userText}`;
};
