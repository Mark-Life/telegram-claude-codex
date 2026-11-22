import { describe, expect, test } from "bun:test";

import { callNameStem, mentionsCallName } from "./call-name";
import { detectTrigger } from "./trigger";

const SASHA = "Саша";
const DANYA = "Даня";

describe("callNameStem", () => {
  test("drops the trailing vowel a name declines away from", () => {
    expect(callNameStem(SASHA)).toBe("Саш");
    expect(callNameStem("Женя")).toBe("Жен");
  });

  test("keeps a name that does not end in a vowel", () => {
    expect(callNameStem("Макс")).toBe("Макс");
  });
});

describe("mentionsCallName", () => {
  test("matches the nominative and the declensions", () => {
    for (const text of [
      "Саша, посмотри пожалуйста",
      "Саш, посмотри пожалуйста",
      "спроси у Саши",
      "передай Саше документ",
      "позови Сашу",
      "с Сашей всё ок",
      "САША!!!",
      "сашка знает",
    ]) {
      expect(mentionsCallName(text, SASHA)).toBe(true);
    }
  });

  test("does not match a longer word that starts the same", () => {
    for (const text of [
      "закажи сашими",
      "Сашкевич звонил",
      "the sashimi is fresh",
      "Сашь, привет",
    ]) {
      expect(mentionsCallName(text, SASHA)).toBe(false);
    }
  });

  test("matches the soft-sign vocative and the declensions of «Даня»", () => {
    for (const text of [
      "Дань, привет",
      "Даня, посмотри",
      "позови Даню",
      "с Даней всё ок",
    ]) {
      expect(mentionsCallName(text, DANYA)).toBe(true);
    }
  });

  test("matches the diminutives of «Даня»", () => {
    for (const text of [
      "Данька, глянь",
      "спроси у Даньки",
      "Данечка, привет",
      "передай Данечке",
      "с Данечкой договорились",
    ]) {
      expect(mentionsCallName(text, DANYA)).toBe(true);
    }
  });

  test("does not match a longer name that shares the stem of «Даня»", () => {
    for (const text of ["Даниил звонил", "позови Даниила", "Данила тут"]) {
      expect(mentionsCallName(text, DANYA)).toBe(false);
    }
  });

  test("no call name configured means no match", () => {
    expect(mentionsCallName("Саша, привет")).toBe(false);
  });

  test("a name too short to be a stem never matches", () => {
    expect(mentionsCallName("да", "да")).toBe(false);
  });
});

describe("detectTrigger", () => {
  const base = {
    botId: 7,
    botUsername: "owner_bot",
    callNames: [SASHA],
    replyToUserId: undefined,
    text: "",
  };

  test("an @mention wins", () => {
    expect(detectTrigger({ ...base, text: "@Owner_Bot ping" })).toBe("mention");
  });

  test("a reply to the bot counts as being addressed", () => {
    expect(detectTrigger({ ...base, replyToUserId: 7, text: "и ещё" })).toBe(
      "reply"
    );
  });

  test("the call name is only a candidate", () => {
    expect(detectTrigger({ ...base, text: "Саша, что там" })).toBe("call_name");
  });

  test("plain chatter triggers nothing", () => {
    expect(detectTrigger({ ...base, replyToUserId: 9, text: "ок" })).toBe(
      "none"
    );
  });
});
