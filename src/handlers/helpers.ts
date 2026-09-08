import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { type Context, InlineKeyboard, Keyboard } from "grammy";
import type { UserState } from "./user-state";

/** Escape HTML special characters for Telegram */
export function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** No-op that swallows errors from best-effort Telegram calls (edits/deletes/pins) */
export const swallow = () => {
  // Best-effort operations: failures here are non-critical and intentionally ignored.
};

/** Human-readable label for the active project (general / basename / none) */
export const describeProject = (activeProject: string, projectsDir: string) => {
  if (!activeProject) {
    return "(none)";
  }
  return activeProject === projectsDir ? "general" : basename(activeProject);
};

type ForwardOrigin = NonNullable<
  NonNullable<Context["message"]>["forward_origin"]
>;

/** Display name for a forwarded message origin */
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
  return "unknown";
};

/** Unpin existing pins and pin the given edited-message result (best-effort) */
export const repinMessage = async (
  ctx: Context,
  chatId: number,
  msg: Awaited<ReturnType<Context["editMessageText"]>>
) => {
  await ctx.api.unpinAllChatMessages(chatId).catch(swallow);
  const pinnedId =
    typeof msg === "object" && "message_id" in msg ? msg.message_id : undefined;
  if (pinnedId) {
    await ctx.api
      .pinChatMessage(chatId, pinnedId, { disable_notification: true })
      .catch(swallow);
  }
};

export const PROVIDER_CALLBACK_RE = /^provider:(.+)$/;
export const MODEL_CALLBACK_RE = /^model:(.+)$/;
export const EFFORT_CALLBACK_RE = /^effort:(.+)$/;
export const PROJECTS_PAGE_RE = /^projects:(\d+)$/;
export const PROJECT_CALLBACK_RE = /^project:(.+)$/;
export const COMPOSE_SEND_RE = /^compose_send:(\d+)$/;
export const COMPOSE_CANCEL_RE = /^compose_cancel:(\d+)$/;
export const HISTORY_PAGE_RE = /^history:(\d+)$/;
export const SESSION_CALLBACK_RE = /^session:(.+)$/;
export const FORCE_SEND_RE = /^force_send:(\d+)$/;
export const CLEAR_QUEUE_RE = /^clear_queue:(\d+)$/;
export const PLAN_NEW_RE = /^plan_new:(\d+)$/;
export const PLAN_RESUME_RE = /^plan_resume:(\d+)$/;
export const PLAN_MODIFY_RE = /^plan_modify:(\d+)$/;
export const PLAN_CANCEL_RE = /^plan_cancel:(\d+)$/;

/** Persistent reply keyboard with all commands */
export const mainKeyboard = new Keyboard()
  .text("Projects")
  .text("History")
  .row()
  .text("Stop")
  .text("New")
  .row()
  .text("Compact")
  .text("Compose")
  .row()
  .resized()
  .persistent();

/** Extract reply-to-message text and prepend it as context (skip bot's own messages) */
export function buildPromptWithReplyContext(
  ctx: Context,
  userText: string,
  botId?: number
) {
  const replyText = ctx.message?.reply_to_message?.text;
  if (!replyText) {
    return userText;
  }
  if (botId && ctx.message?.reply_to_message?.from?.id === botId) {
    return userText;
  }
  const truncated =
    replyText.length > 2000 ? `${replyText.slice(0, 2000)}...` : replyText;
  return `[Replying to: ${truncated}]\n\n${userText}`;
}

/** List project directories */
export function listProjects(projectsDir: string) {
  try {
    return readdirSync(projectsDir)
      .filter((name) => {
        try {
          return statSync(join(projectsDir, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/** Format an ISO timestamp as a compact relative time (e.g. "5m ago", "Mar 3") */
export const formatRelativeTime = (isoTimestamp: string) => {
  const date = new Date(isoTimestamp);
  const diffMin = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (diffMin < 1) {
    return "just now";
  }
  if (diffMin < 60) {
    return `${diffMin}m ago`;
  }
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) {
    return `${diffHour}h ago`;
  }
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) {
    return `${diffDay}d ago`;
  }
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
};

/** Notify the user that a queued message is now being processed */
export async function notifyQueuedProcessing(
  ctx: Context,
  prompt: string,
  state: UserState
) {
  const remaining = state.queue.length;
  const queueInfo = remaining > 0 ? ` | ${remaining} more in queue` : "";
  const preview = prompt.length > 200 ? `${prompt.slice(0, 200)}...` : prompt;
  await ctx
    .reply(
      `<b>▶ Processing queued message</b>${queueInfo}\n<pre>${escapeHtml(preview)}</pre>`,
      { parse_mode: "HTML" }
    )
    .catch(swallow);
}

/**
 * Send or update the "Message queued" status message with a Force Send button.
 * Ids come from the state, not the context, so the message stays in the
 * conversation that queued it.
 */
export async function sendOrUpdateQueueStatus(ctx: Context, state: UserState) {
  const text = `Message queued (${state.queue.length} in queue)`;
  const keyboard = new InlineKeyboard()
    .text("Force Send — stops current task", `force_send:${state.userId}`)
    .row()
    .text("Clear Queue", `clear_queue:${state.userId}`);
  if (state.queueStatusMessageId) {
    await ctx.api
      .editMessageText(state.chatId, state.queueStatusMessageId, text, {
        reply_markup: keyboard,
      })
      .catch(swallow);
  } else {
    const msg = await ctx.reply(text, { reply_markup: keyboard });
    state.queueStatusMessageId = msg.message_id;
  }
}

/** Delete the queue status message if it exists */
export async function cleanupQueueStatus(state: UserState, ctx: Context) {
  if (state.queueStatusMessageId) {
    await ctx.api
      .deleteMessage(state.chatId, state.queueStatusMessageId)
      .catch(swallow);
    state.queueStatusMessageId = undefined;
  }
}

/** Send or update compose mode status message with inline buttons */
export async function updateComposeStatus(ctx: Context, state: UserState) {
  const count = state.composeMessages?.length ?? 0;
  const text = `Composing (${count} message${count !== 1 ? "s" : ""})`;
  const keyboard = new InlineKeyboard()
    .text("Send", `compose_send:${state.userId}`)
    .text("Cancel", `compose_cancel:${state.userId}`);
  if (state.composeStatusMessageId) {
    await ctx.api
      .editMessageText(state.chatId, state.composeStatusMessageId, text, {
        reply_markup: keyboard,
      })
      .catch(swallow);
  } else {
    const msg = await ctx.reply(text, { reply_markup: keyboard });
    state.composeStatusMessageId = msg.message_id;
  }
}

/** Delete the compose status message if it exists */
export async function cleanupComposeStatus(state: UserState, ctx: Context) {
  if (state.composeStatusMessageId) {
    await ctx.api
      .deleteMessage(state.chatId, state.composeStatusMessageId)
      .catch(swallow);
    state.composeStatusMessageId = undefined;
  }
}
