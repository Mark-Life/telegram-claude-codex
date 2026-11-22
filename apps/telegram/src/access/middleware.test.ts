import { describe, expect, test } from "bun:test";

import type { StoredTier } from "../db";
import type { Presence } from "./group-gate";
import { createAccessMiddleware, decideAccess } from "./middleware";
import type { AccessContext } from "./middleware";
import type { Surface, Tier } from "./tier";

const OWNER_ID = 111;
const GUEST_ID = 222;
const GROUP_ID = -100;

const decide = (tier: Tier, surface: Surface, presence: Presence = "present") =>
  decideAccess({ guestsAllowed: true, presence, surface, tier });

describe("decideAccess", () => {
  test("a guest may start a private chat but is ignored in the workspace", () => {
    expect(decide("guest", "private")).toBe("proceed");
    expect(decide("guest", "workspace")).toBe("ignore");
  });

  test("every other tier passes one-to-one", () => {
    for (const tier of ["owner", "executor", "member"] as const) {
      expect(decide(tier, "private")).toBe("proceed");
      expect(decide(tier, "workspace")).toBe("proceed");
    }
  });

  test("a group without the owner is left, whoever wrote", () => {
    expect(decide("member", "group", "absent")).toBe("leave");
    expect(decide("owner", "group", "absent")).toBe("leave");
  });

  test("an unknown presence keeps the bot silent instead of leaving", () => {
    expect(decide("member", "group", "unknown")).toBe("ignore");
  });

  test("in an owner-present group every tier is equal, guests included", () => {
    for (const tier of ["owner", "executor", "member", "guest"] as const) {
      expect(decide(tier, "group", "present")).toBe("proceed");
    }
  });
});

/** A context stub with just the fields the middleware reads and writes. */
const makeCtx = (input: {
  chatId: number;
  chatType: string;
  userId: number;
}) => {
  const replies: string[] = [];
  const ctx: AccessContext = {
    chat: { id: input.chatId, type: input.chatType },
    from: { id: input.userId },
    reply: async (text: string) => {
      replies.push(text);
      return await Promise.resolve({ message_id: replies.length });
    },
  };
  return { ctx, replies };
};

/** Middleware deps with no db and no Telegram behind them. */
const makeDeps = (input: {
  presence?: Presence;
  tiers?: Map<number, StoredTier>;
  workspaceChatId?: number;
}) => {
  const left: number[] = [];
  const deps = {
    botId: 9,
    guestsAllowed: async () => await Promise.resolve(true),
    leaveChat: async (chatId: number) => {
      left.push(chatId);
      return await Promise.resolve(true);
    },
    lookupTier: async (userId: number) =>
      await Promise.resolve(input.tiers?.get(userId)),
    ownerId: OWNER_ID,
    ownerPresence: async () =>
      await Promise.resolve(input.presence ?? "present"),
    workspaceChatId: async () => await Promise.resolve(input.workspaceChatId),
  };
  return { deps, left };
};

describe("createAccessMiddleware", () => {
  test("attaches tier and surface, then proceeds", async () => {
    const { ctx } = makeCtx({
      chatId: OWNER_ID,
      chatType: "private",
      userId: OWNER_ID,
    });
    const { deps } = makeDeps({});
    let proceeded = false;
    await createAccessMiddleware(deps)(ctx, async () => {
      proceeded = true;
      await Promise.resolve();
    });

    expect(ctx.access).toEqual({ surface: "private", tier: "owner" });
    expect(proceeded).toBe(true);
  });

  test("a guest's first private message proceeds without /start", async () => {
    const { ctx, replies } = makeCtx({
      chatId: GUEST_ID,
      chatType: "private",
      userId: GUEST_ID,
    });
    const { deps } = makeDeps({});
    let proceeded = false;
    await createAccessMiddleware(deps)(ctx, async () => {
      proceeded = true;
      await Promise.resolve();
    });

    expect(proceeded).toBe(true);
    expect(replies).toHaveLength(0);
    expect(ctx.access?.tier).toBe("guest");
  });

  test("a stored tier lets someone through", async () => {
    const { ctx } = makeCtx({
      chatId: GUEST_ID,
      chatType: "private",
      userId: GUEST_ID,
    });
    const { deps } = makeDeps({
      tiers: new Map<number, StoredTier>([[GUEST_ID, "member"]]),
    });
    let proceeded = false;
    await createAccessMiddleware(deps)(ctx, async () => {
      proceeded = true;
      await Promise.resolve();
    });

    expect(ctx.access?.tier).toBe("member");
    expect(proceeded).toBe(true);
  });

  test("a group the owner has left is left, silently", async () => {
    const { ctx, replies } = makeCtx({
      chatId: GROUP_ID,
      chatType: "supergroup",
      userId: GUEST_ID,
    });
    const { deps, left } = makeDeps({ presence: "absent" });
    let proceeded = false;
    await createAccessMiddleware(deps)(ctx, async () => {
      proceeded = true;
      await Promise.resolve();
    });

    expect(left).toEqual([GROUP_ID]);
    expect(replies).toHaveLength(0);
    expect(proceeded).toBe(false);
  });

  test("the workspace supergroup reads as workspace, not group", async () => {
    const { ctx } = makeCtx({
      chatId: GROUP_ID,
      chatType: "supergroup",
      userId: OWNER_ID,
    });
    const { deps } = makeDeps({ workspaceChatId: GROUP_ID });
    await createAccessMiddleware(deps)(ctx, async () => {
      await Promise.resolve();
    });

    expect(ctx.access).toEqual({ surface: "workspace", tier: "owner" });
  });

  test("the bot's own messages stop dead", async () => {
    const { ctx } = makeCtx({
      chatId: GROUP_ID,
      chatType: "supergroup",
      userId: 9,
    });
    const { deps } = makeDeps({});
    let proceeded = false;
    await createAccessMiddleware(deps)(ctx, async () => {
      proceeded = true;
      await Promise.resolve();
    });

    expect(proceeded).toBe(false);
    expect(ctx.access).toBeUndefined();
  });
});
