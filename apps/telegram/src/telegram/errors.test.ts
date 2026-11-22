import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  AgentInterrupted,
  AtCapacity,
  ProviderCrashed,
} from "@workspace/agent";

import { DEFAULT_LANGUAGE, switchLanguage } from "../i18n";
import { errorCopy, genericErrorCopy } from "./errors";

/** These cases check the Russian source copy. */
beforeAll(() => {
  switchLanguage("ru");
});
afterAll(() => {
  switchLanguage(DEFAULT_LANGUAGE);
});

describe("errorCopy", () => {
  test("an interrupt says it was stopped", () => {
    expect(errorCopy(new AgentInterrupted({ reason: "stopped" }))).toBe(
      "Остановлено."
    );
  });

  test("a full queue asks to wait", () => {
    expect(errorCopy(new AtCapacity({}))).toContain("через минуту");
  });

  test("a provider crash quotes the first line of its message", () => {
    const copy = errorCopy(
      new ProviderCrashed({
        message: "TypeError: undefined is not a function\n    at run (x.ts:1)",
      })
    );
    expect(copy).toStartWith(genericErrorCopy());
    expect(copy).toContain("«TypeError: undefined is not a function»");
    expect(copy).not.toContain("x.ts");
  });

  test("an empty provider message adds no quote", () => {
    expect(errorCopy(new ProviderCrashed({ message: " \n" }))).toBe(
      genericErrorCopy()
    );
  });

  test("an untagged failure still says something", () => {
    expect(errorCopy()).toBe(genericErrorCopy());
  });
});
