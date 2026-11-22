import type { Bot } from "grammy";

import type { BotContext } from "../access/context";
import { isTrustedGroup, createOwnerPresence } from "../access/group-gate";
import { createAccessMiddleware } from "../access/middleware";
import { readToggle } from "../bot-settings";
import type { GroupEntry } from "../db";
import { getGroup, getSetting, getUser, rememberGroup } from "../db/bridge";
import { logRejection } from "../handlers/helpers";
import { workspaceChatId } from "../handlers/workspace";
import { logInfo } from "../log";
import { tg } from "./bridge";

/**
 * The access boundary fails closed: a db read that rejects answers with the
 * least privilege — guest tier, no workspace surface, not a trusted group, no
 * cached presence — and says so in the log. The owner's tier comes from the
 * env, so it never depends on these.
 */
const failClosed = async <A>(input: {
  fallback: A;
  label: string;
  read: () => Promise<A>;
}): Promise<A> => {
  try {
    return await input.read();
  } catch (error) {
    logRejection(input.label)(error);
    return input.fallback;
  }
};

const workspaceOrNone = async () =>
  await failClosed({
    fallback: undefined,
    label: "Workspace read failed, no workspace surface",
    read: workspaceChatId,
  });

const trustedGroupIds = async () =>
  await failClosed({
    fallback: undefined,
    label: "Trusted groups read failed, none trusted",
    read: async () => await getSetting("trusted_group_ids"),
  });

/**
 * The owner's guest switch. A failed read shuts guests out like the rest of
 * this boundary; a guest let in costs tokens, one shut out costs nothing.
 * A member whose tier read failed is a guest here too, so with guests off a
 * db failure drops them; the "Tier lookup failed" line just before says so.
 */
const guestsAllowed = async (userId: number) => {
  const allowed = await failClosed({
    fallback: false,
    label: "Guest switch read failed, ignoring guests",
    read: async () => await readToggle("guests"),
  });
  if (!allowed) {
    logInfo(`Ignored a private update from guest ${userId}: guests are off`);
  }
  return allowed;
};

/**
 * A stored tier, or guest when the row cannot be read. A stored tier this
 * build does not know is already a guest at the bridge (`getUser` logs it);
 * this fallback covers the storage failures.
 */
const tierOrGuest = async (userId: number) =>
  await failClosed({
    fallback: undefined,
    label: "Tier lookup failed, treating as guest",
    read: async () => {
      const user = await getUser(userId);
      return user?.tier;
    },
  });

/** A cached presence check, or a miss that sends the gate to Telegram. */
const cachedPresence = async (chatId: number) =>
  await failClosed<GroupEntry | undefined>({
    fallback: undefined,
    label: "Presence cache read failed, asking Telegram",
    read: async () => await getGroup(chatId),
  });

/**
 * Record a presence check. A write that fails is logged and the answer stands
 * as Telegram gave it: a cache miss next time costs one more lookup, but a
 * `present` must never read as `unknown` and silence the bot.
 */
const rememberPresence = async (entry: {
  chatId: number;
  ownerPresent: boolean;
}) => {
  await rememberGroup(entry).catch(
    logRejection("Presence cache write failed, keeping the answer")
  );
};

/**
 * Access control, installed on the bot before any command handler.
 *
 * Middleware order is the whole design here: the owner's presence in a group is
 * recorded first, then tiers and the owner-presence gate decide whether the
 * update goes any further.
 */
export const installAccessPipeline = (
  bot: Bot<BotContext>,
  config: { botId: number; ownerId: number }
) => {
  const ownerPresence = createOwnerPresence({
    api: {
      // No retry: the update waits on this answer, and a failure only reads
      // as `unknown` until the next update asks again. Expected when the bot
      // is not an administrator, hence debug.
      getChatMember: async (chatId, userId) =>
        await tg(
          "getChatMember",
          async (api) => await api.getChatMember(chatId, userId),
          { logLevel: "debug", retry: false }
        ),
    },
    cache: { get: cachedPresence, remember: rememberPresence },
    ownerId: config.ownerId,
  });

  bot.use(async (ctx, proceed) => {
    const isGroup =
      ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
    if (ctx.from?.id === config.ownerId && isGroup && ctx.chat !== undefined) {
      // The owner sending the update (including adding the bot) is stronger
      // evidence than getChatMember, which Telegram only guarantees for an
      // administrator bot.
      await rememberPresence({ chatId: ctx.chat.id, ownerPresent: true });
    }
    await proceed();
  });

  bot.use(
    createAccessMiddleware({
      botId: config.botId,
      guestsAllowed,
      leaveChat: async (chatId) => {
        logInfo(`Leaving ${chatId}: owner is not a member`);
        // No retry: the middleware awaits this, and the next update from the
        // chat asks to leave again anyway.
        return await tg(
          "leaveChat",
          async (api) => await api.leaveChat(chatId),
          {
            // Already gone or no rights to leave: expected, hence debug.
            logLevel: "debug",
            retry: false,
          }
        );
      },
      lookupTier: tierOrGuest,
      ownerId: config.ownerId,
      ownerPresence: async (chatId) =>
        isTrustedGroup({
          chatId,
          storedIds: await trustedGroupIds(),
        })
          ? "present"
          : await ownerPresence(chatId),
      workspaceChatId: workspaceOrNone,
    })
  );
};
