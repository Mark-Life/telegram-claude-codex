import { describe, expect, test } from "bun:test";

import { commandTarget } from "./users";

const OWNER = { first_name: "Owner", id: 111, is_bot: false };
const KATE = { first_name: "Kate", id: 222, is_bot: false, username: "kate" };

/** A message in a private-chat topic: Telegram points it at the topic root. */
const inTopic = {
  message_thread_id: 50,
  reply_to_message: {
    forum_topic_created: { icon_color: 0, name: "Работа" },
    from: OWNER,
    message_id: 50,
  },
};

describe("commandTarget", () => {
  test("a typed id applies to that id even inside a topic", () => {
    expect(
      commandTarget({
        arg: "333",
        message: inTopic,
        ownerId: OWNER.id,
        senderId: OWNER.id,
      })
    ).toEqual({ kind: "target", userId: 333, username: undefined });
  });

  test("the topic root is not a reply, so no argument means usage", () => {
    expect(
      commandTarget({
        arg: "",
        message: inTopic,
        ownerId: OWNER.id,
        senderId: OWNER.id,
      })
    ).toEqual({ kind: "usage" });
  });

  test("an @username is not accepted", () => {
    expect(
      commandTarget({
        arg: "@kate",
        message: undefined,
        ownerId: OWNER.id,
        senderId: OWNER.id,
      })
    ).toEqual({ kind: "usage" });
  });

  test("a real reply to another person targets them", () => {
    expect(
      commandTarget({
        arg: "",
        message: {
          message_thread_id: 50,
          reply_to_message: { from: KATE, message_id: 77 },
        },
        ownerId: OWNER.id,
        senderId: OWNER.id,
      })
    ).toEqual({ kind: "target", userId: KATE.id, username: "kate" });
  });

  test("the owner's own id is refused", () => {
    expect(
      commandTarget({
        arg: String(OWNER.id),
        message: undefined,
        ownerId: OWNER.id,
        senderId: OWNER.id,
      })
    ).toEqual({ kind: "owner" });
  });
});
