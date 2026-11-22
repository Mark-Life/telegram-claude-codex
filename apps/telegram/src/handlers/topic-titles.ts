import { generateTopicTitle } from "@workspace/agent";
import type { TopicTitleSource } from "@workspace/db";

import type { BotContext } from "../access/context";
import { ensureScratchDir } from "../access/scratch";
import { nameTopic } from "../db/bridge";
import { t } from "../i18n";
import { tgBestEffort } from "../telegram/bridge";
import { routeKey, threadIdOf } from "../telegram/route";
import type { HandlerDeps } from "./deps";
import { logRejection } from "./helpers";
import { helperFor } from "./light-defaults";

/** Topics whose Telegram-generated names may be replaced from first content. */
const implicitTopics = new Set<string>();

const implicitTopicKey = (ctx: BotContext) => {
  if (ctx.chat?.type !== "private") {
    return null;
  }
  const threadId = threadIdOf(ctx);
  return threadId === null ? null : routeKey({ chatId: ctx.chat.id, threadId });
};

/**
 * Keep the name a topic has now, in any chat, for `/history`. Never fails: a
 * lost name leaves `/history` showing the session's first message instead.
 */
const keepTopicName = async (input: {
  chatId: number;
  source: TopicTitleSource;
  threadId: number | null;
  title: string | undefined;
}) => {
  const { threadId, title } = input;
  if (threadId === null || title === undefined || title.length === 0) {
    return;
  }
  await nameTopic({ ...input, threadId, title }).catch(
    logRejection("topic name not kept")
  );
};

/** Who named a topic in a service message: the bot itself, or a person. */
const editorOf = (ctx: BotContext): TopicTitleSource =>
  ctx.from?.id === ctx.me.id ? "bot" : "user";

/**
 * Keep every topic's name, and remember which ones Telegram named itself, so
 * the bot may replace that name and never one the user chose.
 */
export const registerTopicTitleHandlers = ({ bot }: HandlerDeps) => {
  bot.on("message:forum_topic_created", async (ctx) => {
    const created = ctx.message.forum_topic_created;
    await keepTopicName({
      chatId: ctx.chat.id,
      source: created.is_name_implicit === true ? "telegram" : editorOf(ctx),
      threadId: threadIdOf(ctx),
      title: created.name,
    });
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

  // A manual edit before the first content message always wins. An edit of
  // the icon alone carries no name.
  bot.on("message:forum_topic_edited", async (ctx) => {
    await keepTopicName({
      chatId: ctx.chat.id,
      source: editorOf(ctx),
      threadId: threadIdOf(ctx),
      title: ctx.message.forum_topic_edited.name,
    });
    const key = implicitTopicKey(ctx);
    if (key !== null) {
      implicitTopics.delete(key);
    }
  });
};

/**
 * Whether this private message is the first content of a topic Telegram just
 * opened for it: sent from the chat's main view, not into a topic it had.
 */
export const opensImplicitTopic = (ctx: BotContext) => {
  const key = implicitTopicKey(ctx);
  return key !== null && implicitTopics.has(key);
};

/** Stop treating this message's topic as new, so the next words there run. */
export const leaveImplicitTopic = (ctx: BotContext) => {
  const key = implicitTopicKey(ctx);
  if (key !== null) {
    implicitTopics.delete(key);
  }
};

/**
 * Rename a newly implicit topic from the first words the user sends: text, a
 * voice transcript, a caption or a composed batch. Content with no words
 * leaves the topic for the next message. The topic is claimed before the first
 * await, so of two messages racing the one called first names it.
 */
export const titleImplicitTopic = async (input: {
  content: string;
  ctx: BotContext;
}) => {
  const key = implicitTopicKey(input.ctx);
  if (
    key === null ||
    input.content.trim().length === 0 ||
    !implicitTopics.delete(key)
  ) {
    return;
  }
  const threadId = threadIdOf(input.ctx);
  if (threadId === null || input.ctx.chat === undefined) {
    return;
  }
  // A private chat's id is its user's, so the helper runs in their scratch dir.
  const chatId = input.ctx.chat.id;
  const { pick } = await helperFor("title");
  const title = await generateTopicTitle({
    ...pick,
    content: input.content,
    language: t().promptLanguage,
    workingDirectory: ensureScratchDir(chatId),
  });
  if (title === null) {
    return;
  }
  // A failed rename keeps Telegram's name; the service logs it with its reason.
  const renamed = await tgBestEffort(
    "editForumTopic",
    async (api) => await api.editForumTopic(chatId, threadId, { name: title }),
    { logLevel: "warn", retry: "all" }
  );
  if (renamed === true) {
    await keepTopicName({ chatId, source: "bot", threadId, title });
  }
};
