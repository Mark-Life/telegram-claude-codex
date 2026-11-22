import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { DEFAULT_LANGUAGE, switchLanguage } from "../i18n";
import {
  deviceAuthMessage,
  isCompleteDeviceAuth,
  meaningfulLines,
  parseDeviceAuth,
} from "./login-parse";

/** These cases check the Russian source copy. */
beforeAll(() => {
  switchLanguage("ru");
});
afterAll(() => {
  switchLanguage(DEFAULT_LANGUAGE);
});

const ESC = "\u001B";

/**
 * What `codex login --device-auth` actually prints, colours and all, captured
 * from codex-cli 0.153.4. The code sits four lines below the link, and both
 * are wrapped in SGR escapes even when stdout is a pipe.
 */
const REAL_OUTPUT = [
  "",
  `Welcome to Codex [v${ESC}[90m0.153.4${ESC}[0m]`,
  `${ESC}[90mOpenAI's command-line coding agent${ESC}[0m`,
  "",
  "Follow these steps to sign in with ChatGPT using device code authorization:",
  "",
  "1. Open this link in your browser and sign in to your account",
  `   ${ESC}[94mhttps://auth.openai.com/codex/device${ESC}[0m`,
  "",
  `2. Enter this one-time code ${ESC}[90m(expires in 15 minutes)${ESC}[0m`,
  `   ${ESC}[94mYIWP-SFRB3${ESC}[0m`,
  "",
  `${ESC}[90mContinue only if you started this login in Codex.${ESC}[0m`,
].join("\n");

/** The same run, cut where the reader would have stopped at the link. */
const UP_TO_THE_LINK = REAL_OUTPUT.slice(
  0,
  REAL_OUTPUT.indexOf("2. Enter this one-time code")
);

describe("parseDeviceAuth", () => {
  test("reads the real CLI output, escapes and all", () => {
    expect(parseDeviceAuth(REAL_OUTPUT)).toEqual({
      code: "YIWP-SFRB3",
      url: "https://auth.openai.com/codex/device",
    });
  });

  test("the colour reset never reaches the link", () => {
    const { url } = parseDeviceAuth(
      `   ${ESC}[94mhttps://auth.openai.com/codex/device${ESC}[0m`
    );
    expect(url).toBe("https://auth.openai.com/codex/device");
    expect(url).not.toContain("[0m");
  });

  test("finds the link and the code in the usual output", () => {
    const out = [
      "Starting device authorization...",
      "",
      "Open https://auth.openai.com/device and enter code: WDJB-MJHT",
      "",
      "Waiting for approval...",
    ].join("\n");
    expect(parseDeviceAuth(out)).toEqual({
      code: "WDJB-MJHT",
      url: "https://auth.openai.com/device",
    });
  });

  test("a link ending a sentence keeps no punctuation", () => {
    const { url } = parseDeviceAuth("Visit https://example.com/device.");
    expect(url).toBe("https://example.com/device");
  });

  test("a code inside the link is not mistaken for the user code", () => {
    const { code, url } = parseDeviceAuth(
      "Go to https://auth.openai.com/DEVICE-CODE now"
    );
    expect(url).toBe("https://auth.openai.com/DEVICE-CODE");
    expect(code).toBeUndefined();
  });

  test("prose alone yields neither", () => {
    expect(parseDeviceAuth("Waiting for the browser to open")).toEqual({
      code: undefined,
      url: undefined,
    });
  });

  test("an unhyphenated code is still read", () => {
    expect(parseDeviceAuth("code: ABC123 (expires in 15m)").code).toBe(
      "ABC123"
    );
  });
});

describe("meaningfulLines", () => {
  test("drops blank lines and caps the rest", () => {
    const out = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n\n");
    const lines = meaningfulLines(out, 3);
    expect(lines).toEqual(["line 0", "line 1", "line 2"]);
  });
});

describe("deviceAuthMessage", () => {
  test("the owner gets both steps from the real output", () => {
    const message = deviceAuthMessage(REAL_OUTPUT);
    expect(message).toContain(
      "1. Откройте https://auth.openai.com/codex/device"
    );
    expect(message).toContain("2. Введите код: YIWP-SFRB3");
    expect(message).not.toContain("[0m");
  });

  test("names the link and the code", () => {
    const text = deviceAuthMessage(
      "Open https://auth.openai.com/device and enter code: WDJB-MJHT"
    );
    expect(text).toContain("https://auth.openai.com/device");
    expect(text).toContain("WDJB-MJHT");
  });

  test("forwards the raw output when there is no link", () => {
    const text = deviceAuthMessage("Something unexpected happened\n\n");
    expect(text).toContain("Something unexpected happened");
  });

  test("says so when there is nothing at all", () => {
    expect(deviceAuthMessage("   \n \n")).toContain("/login");
  });
});

describe("isCompleteDeviceAuth", () => {
  test("the link alone is not enough to stop reading", () => {
    expect(UP_TO_THE_LINK).toContain("https://");
    expect(isCompleteDeviceAuth(UP_TO_THE_LINK)).toBe(false);
  });

  test("link and code together end the read", () => {
    expect(isCompleteDeviceAuth(REAL_OUTPUT)).toBe(true);
  });

  test("nothing useful yet keeps the reader waiting", () => {
    expect(isCompleteDeviceAuth("Welcome to Codex")).toBe(false);
  });
});
