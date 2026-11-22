import { describe, expect, test } from "bun:test";

import { PRESENCE_TTL_MS } from "../db";
import type { GroupEntry } from "../db";
import { isPresentStatus, createOwnerPresence } from "./group-gate";

const OWNER_ID = 111;
const GROUP_ID = -100;
const NOW = 1_000_000;

/** An in-memory stand-in for the groups table. */
const makeCache = (seed?: GroupEntry) => {
  const rows = new Map<number, GroupEntry>(
    seed ? [[seed.chatId, seed]] : undefined
  );
  return {
    get: async (chatId: number) => await Promise.resolve(rows.get(chatId)),
    remember: async (entry: { chatId: number; ownerPresent: boolean }) => {
      rows.set(entry.chatId, { ...entry, checkedAt: NOW });
      await Promise.resolve();
    },
    rows,
  };
};

describe("isPresentStatus", () => {
  test("membership statuses count, leaving ones do not", () => {
    expect(isPresentStatus("member")).toBe(true);
    expect(isPresentStatus("administrator")).toBe(true);
    expect(isPresentStatus("creator")).toBe(true);
    expect(isPresentStatus("left")).toBe(false);
    expect(isPresentStatus("kicked")).toBe(false);
  });
});

describe("createOwnerPresence", () => {
  test("asks Telegram once and caches the answer", async () => {
    const cache = makeCache();
    const asked: number[] = [];
    const presence = createOwnerPresence({
      api: {
        getChatMember: async (chatId) => {
          asked.push(chatId);
          return await Promise.resolve({ status: "member" });
        },
      },
      cache,
      now: () => NOW,
      ownerId: OWNER_ID,
    });

    expect(await presence(GROUP_ID)).toBe("present");
    expect(await presence(GROUP_ID)).toBe("present");
    expect(asked).toEqual([GROUP_ID]);
  });

  test("an owner who has left reads as absent", async () => {
    const cache = makeCache();
    const presence = createOwnerPresence({
      api: {
        getChatMember: async () => await Promise.resolve({ status: "left" }),
      },
      cache,
      now: () => NOW,
      ownerId: OWNER_ID,
    });

    expect(await presence(GROUP_ID)).toBe("absent");
    expect(cache.rows.get(GROUP_ID)?.ownerPresent).toBe(false);
  });

  test("a stale answer is checked again", async () => {
    const cache = makeCache({
      chatId: GROUP_ID,
      checkedAt: NOW - PRESENCE_TTL_MS,
      ownerPresent: true,
    });
    let asked = 0;
    const presence = createOwnerPresence({
      api: {
        getChatMember: async () => {
          asked += 1;
          return await Promise.resolve({ status: "left" });
        },
      },
      cache,
      now: () => NOW,
      ownerId: OWNER_ID,
    });

    expect(await presence(GROUP_ID)).toBe("absent");
    expect(asked).toBe(1);
  });

  test("a failed check falls back to the stale answer, never to leaving", async () => {
    const cache = makeCache({
      chatId: GROUP_ID,
      checkedAt: NOW - PRESENCE_TTL_MS,
      ownerPresent: true,
    });
    const presence = createOwnerPresence({
      api: {
        getChatMember: () => {
          throw new Error("network");
        },
      },
      cache,
      now: () => NOW,
      ownerId: OWNER_ID,
    });

    expect(await presence(GROUP_ID)).toBe("present");
  });

  test("a failed check with nothing cached is unknown, so the bot stays put", async () => {
    const presence = createOwnerPresence({
      api: {
        getChatMember: () => {
          throw new Error("network");
        },
      },
      cache: makeCache(),
      now: () => NOW,
      ownerId: OWNER_ID,
    });

    expect(await presence(GROUP_ID)).toBe("unknown");
  });
});
