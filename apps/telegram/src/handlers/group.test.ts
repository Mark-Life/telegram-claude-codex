import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { DEFAULT_LANGUAGE, switchLanguage } from "../i18n";
import { becameActiveInGroup, groupReadyText } from "./group";

/** These cases check the Russian source copy. */
beforeAll(() => {
  switchLanguage("ru");
});
afterAll(() => {
  switchLanguage(DEFAULT_LANGUAGE);
});

test("the group introduction explains how to address the bot by name", () => {
  expect(
    groupReadyText({ callName: "Саша", gender: "female", ownerName: "Иван" })
  ).toBe(
    "Меня зовут Саша. Я ассистент Ивана и готова работать. Чтобы я вам отвечала, обращайтесь ко мне по имени — Саша. Также можно упомянуть меня или ответить на моё сообщение."
  );
});

describe("becameActiveInGroup", () => {
  test("recognizes a bot added as a member or administrator", () => {
    expect(
      becameActiveInGroup({ newStatus: "member", oldStatus: "left" })
    ).toBe(true);
    expect(
      becameActiveInGroup({ newStatus: "administrator", oldStatus: "kicked" })
    ).toBe(true);
  });

  test("does not announce ordinary permission changes or removal", () => {
    expect(
      becameActiveInGroup({ newStatus: "administrator", oldStatus: "member" })
    ).toBe(false);
    expect(
      becameActiveInGroup({ newStatus: "left", oldStatus: "member" })
    ).toBe(false);
  });
});
