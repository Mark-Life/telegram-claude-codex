import type { Context } from "grammy";

/**
 * Where an update lives. `threadId` is the forum topic it was posted in,
 * including private chats with the bot's topic mode enabled. It is null in a
 * plain chat and the General topic, which keep the old single-conversation
 * behavior.
 */
export interface Route {
  chatId: number;
  threadId: number | null;
}

/**
 * The forum topic an update belongs to, or null when it is not a topic message.
 * Only `is_topic_message` distinguishes a real topic from a reply thread in a
 * non-forum supergroup, which carries a `message_thread_id` too.
 */
export const threadIdOf = (ctx: Context) => {
  const { msg } = ctx;
  if (msg?.is_topic_message !== true) {
    return null;
  }
  return msg.message_thread_id ?? null;
};

/** Route of the update being handled, or null when it carries no chat. */
export const routeOf = (ctx: Context): Route | null =>
  ctx.chat ? { chatId: ctx.chat.id, threadId: threadIdOf(ctx) } : null;

/** Route of the update being handled; throws when it carries no chat. */
export const requireRoute = (ctx: Context) => {
  const route = routeOf(ctx);
  if (!route) {
    throw new Error("No chat context");
  }
  return route;
};

/**
 * Payload fields that keep an outgoing message inside the topic it answers.
 * `ctx.reply` and the bridge's `sendTo`/`sendRichTo` add them by themselves;
 * every raw `tg`/`use` call that targets a chat needs this.
 */
export const threadOpts = (route: Route) =>
  route.threadId === null ? {} : { message_thread_id: route.threadId };

/** Stable map key for a route: one conversation per chat and topic. */
export const routeKey = (route: Route) =>
  `${route.chatId}:${route.threadId ?? "main"}`;
