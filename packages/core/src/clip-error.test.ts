import { describe, expect, test } from "bun:test";

import { clipError } from "./clip-error";

describe("clipError", () => {
  test("collapses whitespace to single spaces and trims", () => {
    expect(clipError("  a\n\n b\t c  ")).toBe("a b c");
  });

  test("redacts common secret shapes, never returns the secret", () => {
    const redacted = clipError(
      "auth Bearer abc.def-123 key sk-abcd1234EFGH slack xoxb-123-abcDEF tok 123456:AAaaBBbbCCccDDddEEeeFFff00"
    );
    expect(redacted).toContain("[redacted]");
    expect(redacted).not.toContain("abc.def-123");
    expect(redacted).not.toContain("sk-abcd1234EFGH");
    expect(redacted).not.toContain("xoxb-123-abcDEF");
    expect(redacted).not.toContain("123456:AAaaBBbb");
  });

  test("caps at 240 chars", () => {
    expect(clipError("x".repeat(1000)).length).toBe(240);
  });
});
