import { InlineKeyboard } from "grammy";
import type { Message } from "grammy/types";

import { syncAccessSnapshot } from "../access/audit";
import { accessOf } from "../access/context";
import type { BotContext } from "../access/context";
import { isOwner, tierLabel } from "../access/tier";
import { isStoredTier } from "../db";
import type { StoredTier, UserEntry } from "../db";
import {
  getSetting,
  getUser,
  grantUser,
  listUsers,
  revokeUser,
  setSetting,
} from "../db/bridge";
import { t } from "../i18n";
import { tgBestEffort } from "../telegram/bridge";
import { syncPrivateCommands } from "../telegram/commands";
import type { HandlerDeps } from "./deps";
import { escapeHtml } from "./helpers";
import { recordUserMutation } from "./user-event";

/**
 * Access management from the chat. Everything here is the owner's alone: the
 * commands are hidden from other tiers and refused if guessed, and the owner
 * tier itself lives in the env, so nothing in this file can create one.
 */

/**
 * Rename the bot in Telegram to its call name, so the two never differ. The
 * current name is read first: setMyName is rate-limited, and a repeat is free.
 * No retry, because this runs on grammy's update path and a 429 on setMyName
 * can ask for hours.
 */
const renameBot = async (name: string) => {
  const current = await tgBestEffort(
    "getMyName",
    async (api) => await api.getMyName(),
    {
      retry: false,
    }
  );
  if (current?.name === name) {
    return true;
  }
  const done = await tgBestEffort(
    "setMyName",
    async (api) => await api.setMyName(name),
    {
      logLevel: "warn",
      retry: false,
    }
  );
  return done === true;
};

export const USER_TIER_RE = /^usertier:(?<value>-?\d+:\w+)$/u;
export const USER_REVOKE_RE = /^userdel:(?<value>-?\d+)$/u;

/** One line of the /users list. */
const describeUser = (entry: UserEntry) =>
  `<code>${entry.userId}</code> — ${tierLabel(entry.tier)}${
    entry.username === undefined ? "" : ` (@${escapeHtml(entry.username)})`
  }`;

/** Buttons for one managed user: the other tier, or drop them entirely. */
const userButtons = (entry: UserEntry) => {
  const other: StoredTier = entry.tier === "executor" ? "member" : "executor";
  return new InlineKeyboard()
    .text(
      t().users.makeTier(tierLabel(other)),
      `usertier:${entry.userId}:${other}`
    )
    .text(t().users.remove, `userdel:${entry.userId}`);
};

/** The whole list, one message per user so each carries its own buttons. */
const sendUserList = async (ctx: BotContext) => {
  const users = await listUsers();
  if (users.length === 0) {
    await ctx.reply(t().users.empty);
    return;
  }
  await ctx.reply(`<b>${t().users.count(users.length)}</b>`, {
    parse_mode: "HTML",
  });
  for (const entry of users) {
    // oxlint-disable-next-line no-await-in-loop -- one message per user, in list order
    await ctx.reply(describeUser(entry), {
      parse_mode: "HTML",
      reply_markup: userButtons(entry),
    });
  }
};

/** Trusted-group and workspace lines of /access, as the db has them. */
const describeSurfaces = async () => {
  const trusted = ((await getSetting("trusted_group_ids")) ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const chatId = await getSetting("workspace_chat_id");
  const threadId = await getSetting("workspace_thread_id");
  const copy = t().users.overview;
  const workspace =
    chatId === undefined
      ? copy.noWorkspace
      : `<code>${escapeHtml(chatId)}</code>${
          threadId === undefined ? "" : `, ${copy.topic(escapeHtml(threadId))}`
        }`;
  return [
    copy.workspace(workspace),
    copy.trusted(
      trusted.length === 0
        ? copy.none
        : trusted.map((id) => `<code>${escapeHtml(id)}</code>`).join(", ")
    ),
  ];
};

/**
 * Everything that decides who the bot obeys, in one read-only message: the
 * groups that skip the owner-presence gate, the workspace, and every managed
 * tier. The tables behind them are plain sqlite rows, so this is how an edit
 * made outside the bot becomes visible on demand.
 */
const sendAccessOverview = async (ctx: BotContext) => {
  const users = await listUsers();
  const lines = [
    `<b>${t().users.overview.title}</b>`,
    ...(await describeSurfaces()),
    users.length === 0
      ? t().users.overview.noPeople
      : t().users.overview.people(users.length),
    ...users.map(describeUser),
  ];
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
};

/** The fields of a command message that can name its target. */
interface CommandMessage {
  message_thread_id?: number;
  reply_to_message?: Pick<
    NonNullable<Message["reply_to_message"]>,
    "forum_topic_created" | "from" | "message_id"
  >;
}

/** A typed target: a positive safe integer and nothing else. */
const typedId = (arg: string) => {
  const id = /^\d+$/u.test(arg) ? Number(arg) : Number.NaN;
  return Number.isSafeInteger(id) && id > 0
    ? { userId: id, username: undefined }
    : null;
};

/**
 * The author of the message the command replies to, when that is a real reply
 * to another person. Telegram fills `reply_to_message` on every message in a
 * topic with the topic's root — a `forum_topic_created` service message, or
 * the first message of a private-chat topic, whose id is the thread id — and
 * the owner wrote it, so neither counts.
 */
const repliedPerson = (
  message: CommandMessage | undefined,
  senderId: number
) => {
  const replied = message?.reply_to_message;
  const author = replied?.from;
  if (
    replied === undefined ||
    author === undefined ||
    replied.message_id === message?.message_thread_id ||
    replied.forum_topic_created !== undefined ||
    author.is_bot ||
    author.id === senderId
  ) {
    return null;
  }
  return { userId: author.id, username: author.username };
};

/**
 * Who a management command applies to, or why it applies to no one. A typed
 * argument always wins and must be a numeric id: the Bot API cannot turn a
 * private user's @username into an id. Only with no argument does a reply to
 * another person's message name them.
 */
export const commandTarget = (input: {
  arg: string;
  message: CommandMessage | undefined;
  ownerId: number;
  senderId: number;
}):
  | { kind: "target"; userId: number; username: string | undefined }
  | { kind: "owner" }
  | { kind: "usage" } => {
  const arg = input.arg.trim();
  const target =
    arg.length > 0
      ? typedId(arg)
      : repliedPerson(input.message, input.senderId);
  if (target === null) {
    return { kind: "usage" };
  }
  return target.userId === input.ownerId
    ? { kind: "owner" }
    : { kind: "target", ...target };
};

/** Grant a tier and write the mutation to the ledger. */
const applyGrant = async (input: {
  addedBy: number;
  tier: StoredTier;
  userId: number;
  username: string | undefined;
}) => {
  const existing = await getUser(input.userId);
  await grantUser(input);
  // The bot's own write is the new baseline, so the access watcher reports
  // only what changed behind its back.
  await syncAccessSnapshot();
  await recordUserMutation({
    action: existing ? "set_tier" : "grant",
    addedBy: input.addedBy,
    targetUserId: input.userId,
    tier: input.tier,
    username: input.username ?? existing?.username ?? null,
  });
};

/** Owner-only guard; anything else is told the command does not exist. */
const ownerOnly = async (ctx: BotContext) => {
  if (isOwner(accessOf(ctx).tier)) {
    return true;
  }
  await ctx.reply(t().notForYou);
  return false;
};

export const registerUserHandlers = ({ bot, ownerId }: HandlerDeps) => {
  bot.command("users", async (ctx) => {
    if (await ownerOnly(ctx)) {
      await sendUserList(ctx);
    }
  });

  bot.command("access", async (ctx) => {
    if (await ownerOnly(ctx)) {
      await sendAccessOverview(ctx);
    }
  });

  bot.command("grant", async (ctx) => {
    if (!(await ownerOnly(ctx))) {
      return;
    }
    const parts = ctx.match.trim().split(/\s+/u).filter(Boolean);
    // `/grant <id> <tier>`, or `/grant <tier>` in reply to the person.
    const [first = "", second, ...rest] = parts;
    const tier = second ?? first;
    const target = commandTarget({
      arg: second === undefined ? "" : first,
      message: ctx.message,
      ownerId,
      senderId: ctx.from?.id ?? ownerId,
    });
    if (target.kind === "owner") {
      await ctx.reply(t().users.ownId);
      return;
    }
    if (!(target.kind === "target" && isStoredTier(tier)) || rest.length > 0) {
      await ctx.reply(t().users.grantUsage);
      return;
    }
    await applyGrant({
      addedBy: ownerId,
      tier,
      userId: target.userId,
      username: target.username,
    });
    await syncPrivateCommands({
      retry: false,
      tier,
      userId: target.userId,
    });
    await ctx.reply(
      t().users.granted({ tier: tierLabel(tier), userId: target.userId })
    );
  });

  bot.command("revoke", async (ctx) => {
    if (!(await ownerOnly(ctx))) {
      return;
    }
    const target = commandTarget({
      arg: ctx.match,
      message: ctx.message,
      ownerId,
      senderId: ctx.from?.id ?? ownerId,
    });
    if (target.kind === "owner") {
      await ctx.reply(t().users.ownId);
      return;
    }
    if (target.kind === "usage") {
      await ctx.reply(t().users.revokeUsage);
      return;
    }
    const known = await getUser(target.userId);
    const removed = await revokeUser(target.userId);
    if (removed) {
      await syncAccessSnapshot();
      await syncPrivateCommands({
        retry: false,
        tier: "guest",
        userId: target.userId,
      });
      await recordUserMutation({
        action: "revoke",
        addedBy: ownerId,
        targetUserId: target.userId,
        tier: null,
        username: target.username ?? known?.username ?? null,
      });
    }
    await ctx.reply(
      removed
        ? t().users.revoked(target.userId)
        : t().users.notListed(target.userId)
    );
  });

  bot.command("callname", async (ctx) => {
    if (!(await ownerOnly(ctx))) {
      return;
    }
    const name = ctx.match.trim();
    if (name.length === 0) {
      const current = await getSetting("call_name");
      await ctx.reply(
        current === undefined
          ? t().users.callName.unset
          : t().users.callName.current(escapeHtml(current))
      );
      return;
    }
    await setSetting({ key: "call_name", value: name });
    const renamed = await renameBot(name);
    await ctx.reply(
      renamed
        ? t().users.callName.set(escapeHtml(name))
        : t().users.callName.setNotRenamed(escapeHtml(name))
    );
  });

  bot.callbackQuery(USER_TIER_RE, async (ctx) => {
    if (!isOwner(accessOf(ctx).tier)) {
      await ctx.answerCallbackQuery({ text: t().notForYou });
      return;
    }
    const [rawId = "", tier = ""] = (ctx.match[1] ?? "").split(":");
    const userId = Number(rawId);
    if (!(Number.isSafeInteger(userId) && isStoredTier(tier))) {
      await ctx.answerCallbackQuery({ text: t().users.noSuchTier });
      return;
    }
    const known = await getUser(userId);
    await applyGrant({
      addedBy: ownerId,
      tier,
      userId,
      username: known?.username,
    });
    await syncPrivateCommands({ retry: false, tier, userId });
    await ctx.answerCallbackQuery({ text: t().users.nowTier(tierLabel(tier)) });
    const updated = await getUser(userId);
    if (updated) {
      await ctx.editMessageText(describeUser(updated), {
        parse_mode: "HTML",
        reply_markup: userButtons(updated),
      });
    }
  });

  bot.callbackQuery(USER_REVOKE_RE, async (ctx) => {
    if (!isOwner(accessOf(ctx).tier)) {
      await ctx.answerCallbackQuery({ text: t().notForYou });
      return;
    }
    const userId = Number(ctx.match[1] ?? "");
    if (!Number.isSafeInteger(userId)) {
      await ctx.answerCallbackQuery({ text: t().users.unknownUser });
      return;
    }
    const existing = await getUser(userId);
    if (await revokeUser(userId)) {
      await syncAccessSnapshot();
      await syncPrivateCommands({
        retry: false,
        tier: "guest",
        userId,
      });
      await recordUserMutation({
        action: "revoke",
        addedBy: ownerId,
        targetUserId: userId,
        tier: null,
        username: existing?.username ?? null,
      });
    }
    await ctx.answerCallbackQuery({ text: t().users.removed });
    await ctx.editMessageText(
      `<code>${userId}</code> — ${tierLabel("guest")}`,
      {
        parse_mode: "HTML",
      }
    );
  });
};
