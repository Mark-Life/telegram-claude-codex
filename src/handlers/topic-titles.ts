import type { Context } from "grammy";
import { generateTopicTitle } from "../agent/topic-title";
import type { ProviderId } from "../agent/types";
import { routeKey, threadIdOf } from "../telegram/route";
import type { HandlerDeps } from "./deps";

/** Topics whose Telegram-generated names may be replaced from first content. */
const implicitTopics = new Set<string>();

/**
 * Key of the topic an update belongs to, or null when it is not a topic
 * message. Any forum topic qualifies — a private chat's topics as much as a
 * supergroup's — so the gate is the update, never the chat type.
 */
const implicitTopicKey = (ctx: Context) => {
  const threadId = threadIdOf(ctx);
  if (threadId === null || ctx.chat === undefined) {
    return null;
  }
  return routeKey({ chatId: ctx.chat.id, threadId });
};

/** Remember only Telegram's implicit names, never a title chosen by the user. */
export const registerTopicTitleHandlers = ({ bot }: HandlerDeps) => {
  bot.on("message:forum_topic_created", (ctx) => {
    const key = implicitTopicKey(ctx);
    if (key === null) {
      return;
    }
    if (ctx.message.forum_topic_created.is_name_implicit === true) {
      implicitTopics.add(key);
    } else {
      implicitTopics.delete(key);
    }
  });

  // A manual edit before the first content message always wins.
  bot.on("message:forum_topic_edited", (ctx) => {
    const key = implicitTopicKey(ctx);
    if (key !== null) {
      implicitTopics.delete(key);
    }
  });
};

export interface TopicTitleInput {
  content: string;
  ctx: Context;
  provider: ProviderId;
  /** Existing directory the title run is started in. */
  workingDirectory: string;
}

/**
 * Rename a newly implicit topic from its first text or voice transcript. Runs
 * outside the run registry and swallows every failure: the title is chrome, so
 * it must never delay or break the prompt it was taken from.
 */
export const titleImplicitTopic = async ({
  content,
  ctx,
  provider,
  workingDirectory,
}: TopicTitleInput) => {
  const key = implicitTopicKey(ctx);
  if (key === null || !implicitTopics.delete(key)) {
    return;
  }
  const threadId = threadIdOf(ctx);
  if (threadId === null || ctx.chat === undefined) {
    return;
  }
  const title = await generateTopicTitle({
    content,
    provider,
    workingDirectory,
  });
  if (title === null) {
    return;
  }
  try {
    await ctx.api.editForumTopic(ctx.chat.id, threadId, { name: title });
  } catch (error) {
    console.warn(`Could not rename implicit topic ${key}`, error);
  }
};
