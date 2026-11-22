import type { StoredTier } from "../db";
import type { AccessInfo } from "./context";
import type { Presence } from "./group-gate";
import { resolveTier, surfaceOf } from "./tier";
import type { Surface, Tier } from "./tier";

/** What the bot does with one update once it knows who sent it and from where. */
export type AccessAction = "ignore" | "leave" | "proceed";

/**
 * The access rule, as data.
 *
 * A group the owner has left is not the bot's business, so it leaves; while the
 * answer is unknown it stays quiet rather than acting on a guess. Inside an
 * owner-present group everyone is equal — group runs are lightweight for all of
 * them anyway. Anyone may start a one-to-one conversation with an ordinary
 * message; an ungranted guest receives the least-privileged run profile, unless
 * the owner turned guests off in `/settings`. In the owner's workspace forum
 * guests are ignored, because it is a private surface.
 */
export const decideAccess = (input: {
  guestsAllowed: boolean;
  presence: Presence;
  surface: Surface;
  tier: Tier;
}): AccessAction => {
  if (input.surface === "group") {
    if (input.presence === "absent") {
      return "leave";
    }
    return input.presence === "present" ? "proceed" : "ignore";
  }
  if (input.surface === "private") {
    return input.tier === "guest" && !input.guestsAllowed
      ? "ignore"
      : "proceed";
  }
  return input.tier === "guest" ? "ignore" : "proceed";
};

/**
 * The context the rule reads and writes: grammy's is a superset, so a test can
 * drive the middleware with a plain object instead of a whole bot.
 */
export interface AccessContext {
  access?: AccessInfo;
  /** A Business connection was added, changed or switched off. */
  businessConnection?: { id: string };
  /** Set on a message a Business connection carries: the owner's own chat. */
  businessConnectionId?: string;
  chat?: { id: number; type: string };
  /** Business messages deleted in a peer's chat: Telegram names no sender. */
  deletedBusinessMessages?: { business_connection_id: string };
  from?: { id: number };
  /** Only what a sent message has to carry here: grammy's reply returns more. */
  reply: (text: string) => Promise<{ message_id: number }>;
}

/** Everything the middleware needs from the outside world. */
export interface AccessDeps {
  botId: number;
  /** The owner's `/settings` switch for guests; asked only about a guest. */
  guestsAllowed: (userId: number) => Promise<boolean>;
  leaveChat: (chatId: number) => Promise<boolean>;
  lookupTier: (userId: number) => Promise<StoredTier | undefined>;
  ownerId: number;
  ownerPresence: (chatId: number) => Promise<Presence>;
  workspaceChatId: () => Promise<number | undefined>;
}

/**
 * Resolve the sender's tier and the surface they wrote from, attach both to the
 * context, and stop the update here unless it is allowed through. Registered
 * first, so every later handler can read `ctx.access`.
 */
export const createAccessMiddleware =
  (deps: AccessDeps) =>
  async (ctx: AccessContext, proceed: () => Promise<void>) => {
    // Two Business updates name a connection instead of a sender, so there is
    // no tier to resolve here; their handlers gate on the owner's own
    // connection id and nothing else in the bot listens for them.
    if (
      ctx.businessConnection !== undefined ||
      ctx.deletedBusinessMessages !== undefined
    ) {
      await proceed();
      return;
    }
    const { chat, from } = ctx;
    if (!(chat && from) || from.id === deps.botId) {
      return;
    }
    const info = {
      surface: surfaceOf({
        chatId: chat.id,
        chatType: chat.type,
        workspaceChatId: await deps.workspaceChatId(),
      }),
      tier: resolveTier({
        ownerId: deps.ownerId,
        stored: await deps.lookupTier(from.id),
        userId: from.id,
      }),
    };
    ctx.access = info;
    const presence =
      info.surface === "group"
        ? await deps.ownerPresence(chat.id)
        : ("present" as const);
    // A Business message from a stranger is the owner's correspondence, not a
    // guest talking to the bot, so the guest switch never silences it.
    const asksAboutGuest =
      info.tier === "guest" &&
      info.surface === "private" &&
      ctx.businessConnectionId === undefined;
    const guestsAllowed = asksAboutGuest
      ? await deps.guestsAllowed(from.id)
      : true;
    const action = decideAccess({ ...info, guestsAllowed, presence });
    if (action === "leave") {
      await deps.leaveChat(chat.id).catch(() => {
        // Already gone, or no rights to leave; nothing to do either way.
      });
      return;
    }
    if (action !== "proceed") {
      return;
    }
    await proceed();
  };
