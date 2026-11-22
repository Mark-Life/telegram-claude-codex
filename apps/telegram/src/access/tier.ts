import type { Tier } from "@workspace/db";

import { t } from "../i18n";

// The tiers and their one resolution rule live with the users table, so the
// HTTP API and the CLIs read a tier exactly as the chat does.
export { resolveTier, TIERS } from "@workspace/db";
export type { Tier } from "@workspace/db";

/** A tier as the chat names it, in the language in use. */
export const tierLabel = (tier: Tier) => t().tiers[tier];

/** Where a message was written, which decides how much a tier buys. */
export type Surface = "group" | "private" | "workspace";

/**
 * Where an update landed. The owner's workspace forum is a supergroup that
 * behaves like the private chat, so it is its own surface rather than a group.
 */
export const surfaceOf = (input: {
  chatId: number;
  chatType: string;
  workspaceChatId: number | undefined;
}): Surface => {
  if (input.chatType === "private") {
    return "private";
  }
  return input.chatId === input.workspaceChatId ? "workspace" : "group";
};

/** Owner-only surfaces: user management and anything that writes access. */
export const isOwner = (tier: Tier) => tier === "owner";

/** Executors share the owner's operational tools, but never access control. */
export const canManageTasks = (tier: Tier) =>
  tier === "owner" || tier === "executor";

/**
 * Owner and executor: the tiers trusted with state every conversation shares —
 * the machine's session history and the run defaults in the state file.
 */
export const isOperator = (tier: Tier) =>
  tier === "owner" || tier === "executor";

/**
 * Owner and executor may hold HTTP API keys, each their own. A key acts as its
 * holder in their private chat, so it is never offered below that.
 */
export { canHoldApiKey } from "@workspace/db";
