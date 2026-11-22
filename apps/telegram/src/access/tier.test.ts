import { describe, expect, test } from "bun:test";

import { canManageTasks, isOwner, resolveTier, surfaceOf } from "./tier";

const OWNER_ID = 111;

describe("resolveTier", () => {
  test("the env owner outranks anything the db says", () => {
    expect(
      resolveTier({ ownerId: OWNER_ID, stored: "member", userId: OWNER_ID })
    ).toBe("owner");
  });

  test("a stored tier is the user's tier", () => {
    expect(
      resolveTier({ ownerId: OWNER_ID, stored: "executor", userId: 222 })
    ).toBe("executor");
  });

  test("no row means guest", () => {
    expect(
      resolveTier({ ownerId: OWNER_ID, stored: undefined, userId: 222 })
    ).toBe("guest");
  });
});

describe("surfaceOf", () => {
  test("a private chat is private whatever its id", () => {
    expect(
      surfaceOf({ chatId: 222, chatType: "private", workspaceChatId: -100 })
    ).toBe("private");
  });

  test("the stored workspace supergroup is its own surface", () => {
    expect(
      surfaceOf({
        chatId: -100,
        chatType: "supergroup",
        workspaceChatId: -100,
      })
    ).toBe("workspace");
  });

  test("any other group is a group, including before a workspace is known", () => {
    expect(
      surfaceOf({ chatId: -200, chatType: "supergroup", workspaceChatId: -100 })
    ).toBe("group");
    expect(
      surfaceOf({
        chatId: -200,
        chatType: "group",
        workspaceChatId: undefined,
      })
    ).toBe("group");
  });
});

describe("tier predicates", () => {
  test("only the owner is the owner", () => {
    expect(isOwner("owner")).toBe(true);
    expect(isOwner("executor")).toBe(false);
  });

  test("owner and executor may manage recurring tasks", () => {
    expect(canManageTasks("owner")).toBe(true);
    expect(canManageTasks("executor")).toBe(true);
    expect(canManageTasks("member")).toBe(false);
    expect(canManageTasks("guest")).toBe(false);
  });
});
