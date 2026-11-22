import { isStale } from "../db";
import type { GroupEntry } from "../db";

/**
 * Whether the owner is in a group, which is the only thing that entitles the
 * bot to be there. Checked on the first update from a chat (a `my_chat_member`
 * add included) and again once the cached answer goes stale, so a bot dragged
 * into a stranger's group leaves on its first update.
 */
export type Presence = "absent" | "present" | "unknown";

/** Chat-member statuses that mean the owner is actually in the chat. */
export const PRESENT_STATUSES = [
  "administrator",
  "creator",
  "member",
  "restricted",
] as const;

/** True for a status that puts the owner inside the chat. */
export const isPresentStatus = (status: string) =>
  PRESENT_STATUSES.some((present) => present === status);

/** Whether a group id is in the owner's comma-separated trusted list. */
export const isTrustedGroup = (input: {
  chatId: number;
  storedIds: string | undefined;
}) =>
  (input.storedIds ?? "")
    .split(",")
    .some((storedId) => Number(storedId.trim()) === input.chatId);

/** The slice of the Telegram API the gate needs; a test hands it a stub. */
export interface PresenceApi {
  getChatMember: (
    chatId: number,
    userId: number
  ) => Promise<{ status: string }>;
}

/**
 * The slice of the groups table the gate needs. Neither side is expected to
 * reject: the caller decides what a failed read or write means (the pipeline
 * reads a miss and keeps the answer), so the gate only handles Telegram.
 */
export interface PresenceCache {
  get: (chatId: number) => Promise<GroupEntry | undefined>;
  remember: (entry: { chatId: number; ownerPresent: boolean }) => Promise<void>;
}

const asPresence = (present: boolean): Presence =>
  present ? "present" : "absent";

/**
 * Build the cached owner-presence check. A fresh cached answer is used as is;
 * otherwise Telegram is asked and the answer stored. When the call fails only a
 * cached `present` stands; anything else is `unknown` — the bot then stays
 * silent rather than leaving a group over a network blip.
 */
export const createOwnerPresence = (deps: {
  api: PresenceApi;
  cache: PresenceCache;
  now?: () => number;
  ownerId: number;
}) => {
  const now = deps.now ?? Date.now;
  return async (chatId: number): Promise<Presence> => {
    const cached = await deps.cache.get(chatId);
    // A negative answer must not lock the bot out after it is promoted and
    // re-added. Telegram only guarantees lookups of other users while the bot
    // is an administrator, so retry negative answers on every fresh update.
    if (cached?.ownerPresent === true && !isStale(cached, now())) {
      return asPresence(cached.ownerPresent);
    }
    let present: boolean;
    try {
      const member = await deps.api.getChatMember(chatId, deps.ownerId);
      present = isPresentStatus(member.status);
    } catch {
      // A failed lookup is not an answer. Only a cached `present` survives it;
      // a cached negative would read as "the owner left" and make the bot leave
      // the group over a network blip.
      return cached?.ownerPresent === true ? "present" : "unknown";
    }
    // Outside the try on purpose: only Telegram's failure means "no answer".
    await deps.cache.remember({ chatId, ownerPresent: present });
    return asPresence(present);
  };
};
