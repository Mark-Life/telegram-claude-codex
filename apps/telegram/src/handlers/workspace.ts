import { parseChatId } from "@workspace/db";

import { syncAccessSnapshot } from "../access/audit";
import { accessOf } from "../access/context";
import { isOwner } from "../access/tier";
import { applySettings, getSetting, getWorkspace } from "../db/bridge";
import { t } from "../i18n";
import { noticeRoute, sendNotice, tgBestEffort } from "../telegram/bridge";
import type { Route } from "../telegram/route";
import { routeOf } from "../telegram/route";
import type { SendMessageOther } from "../telegram/telegram-bot";
import type { HandlerDeps } from "./deps";

/**
 * The forum supergroup the owner works in. It is chosen by the owner with
 * /setworkspace, never learned from a message: that chat skips the group gate
 * and gives executors near-owner access, so posting in a foreign forum must not
 * be enough to hand it the privilege. A chat stored by an earlier version keeps
 * working — the command writes the same setting.
 */

/** A stored chat id, or the fallback when nothing usable is stored. */
export { parseChatId } from "@workspace/db";

/**
 * The workspace supergroup, if one has been set. It is the one group chat that
 * keeps full capability, so the access layer asks for it on every update: one
 * read, the chat alone.
 */
export const workspaceChatId = async () => {
  const parsed = parseChatId(await getSetting("workspace_chat_id"), Number.NaN);
  return Number.isNaN(parsed) ? undefined : parsed;
};

/**
 * Where unprompted messages go: the workspace once the owner has set one — in
 * the topic they set it from — else their private chat, which has no topic.
 */
export const notifyRoute = async (ownerId: number): Promise<Route> =>
  (await noticeRoute({ kind: "notify", ownerId })) ?? {
    chatId: ownerId,
    threadId: null,
  };

/** Chat that unprompted notices go to: the workspace once set, else the owner. */
export const notifyChatId = async (ownerId: number) => {
  const route = await notifyRoute(ownerId);
  return route.chatId;
};

/**
 * Send one unprompted message to the notify route through `NotifyService`,
 * which falls back on the chat itself when the workspace topic is gone. Any
 * other failure rejects as is, logged once by the TelegramBot service.
 */
export const sendToNotifyRoute = async (input: {
  opts?: SendMessageOther;
  ownerId: number;
  text: string;
}) =>
  await sendNotice({
    opts: input.opts,
    target: { kind: "notify", ownerId: input.ownerId },
    text: input.text,
  });

/** Record a chat, and the topic the command came from, as the workspace. */
export const setWorkspace = async (route: Route) => {
  // One transaction: the access watcher never sees the new chat with the old
  // topic.
  await applySettings([
    { key: "workspace_chat_id", value: String(route.chatId) },
    {
      key: "workspace_thread_id",
      value: route.threadId === null ? null : String(route.threadId),
    },
  ]);
  // The bot's own write is the new baseline for the access watcher.
  await syncAccessSnapshot();
};

/**
 * The workspace as the owner recognises it: the group's title (and the topic
 * id), else its id when Telegram cannot say. Undefined when none is set.
 */
export const workspaceLabel = async () => {
  const workspace = await getWorkspace();
  const chatId = workspace?.chatId;
  const chat =
    chatId === undefined
      ? undefined
      : await tgBestEffort(
          "getChat",
          async (api) => await api.getChat(chatId),
          { retry: false }
        );
  const title =
    chat !== undefined && "title" in chat && chat.title !== undefined
      ? chat.title
      : String(chatId);
  const threadId = workspace?.threadId ?? null;
  if (chatId === undefined || threadId === null) {
    return chatId === undefined ? undefined : title;
  }
  return t().settings.workspace.topic({ threadId, title });
};

/** /setworkspace: the owner's one way to hand a group the workspace surface. */
export const registerWorkspaceHandlers = ({ bot }: HandlerDeps) => {
  bot.command("setworkspace", async (ctx) => {
    if (!isOwner(accessOf(ctx).tier)) {
      await ctx.reply(t().notForYou);
      return;
    }
    const route = routeOf(ctx);
    const type = ctx.chat?.type;
    if (route === null || !(type === "group" || type === "supergroup")) {
      await ctx.reply(t().workspace.onlyInGroup);
      return;
    }
    await setWorkspace(route);
    await ctx.reply(
      route.threadId === null ? t().workspace.groupSet : t().workspace.topicSet
    );
  });
};
