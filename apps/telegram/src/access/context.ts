import type { Context } from "grammy";

import type { Surface, Tier } from "./tier";

/** Who is talking and where, as resolved once per update by the middleware. */
export interface AccessInfo {
  surface: Surface;
  tier: Tier;
}

/**
 * Context flavor carrying the access decision. It is optional on the type
 * because it exists only after the access middleware has run — which is the
 * first thing registered, so every handler downstream can demand it.
 */
export interface AccessFlavor {
  access?: AccessInfo;
}

export type BotContext = Context & AccessFlavor;

/** Access of the update being handled; throws when the middleware never ran. */
export const accessOf = (ctx: BotContext) => {
  if (!ctx.access) {
    throw new Error("No access context");
  }
  return ctx.access;
};
