import { describe, expect, test } from "bun:test";
import { parseOtlpHeaders } from "./telemetry";

describe("parseOtlpHeaders", () => {
  test("parses a single header", () => {
    expect(parseOtlpHeaders("X-Axiom-Dataset=telegram-claude")).toEqual({
      "X-Axiom-Dataset": "telegram-claude",
    });
  });

  test("parses multiple comma-separated headers (Axiom recipe)", () => {
    expect(
      parseOtlpHeaders(
        "Authorization=Bearer xaat-abc,X-Axiom-Dataset=telegram-claude"
      )
    ).toEqual({
      Authorization: "Bearer xaat-abc",
      "X-Axiom-Dataset": "telegram-claude",
    });
  });

  test("splits on the FIRST '=' so values may contain '='", () => {
    expect(parseOtlpHeaders("Authorization=Bearer abc=def==")).toEqual({
      Authorization: "Bearer abc=def==",
    });
  });

  test("trims whitespace around keys and values", () => {
    expect(parseOtlpHeaders("  A = b  ,  C =d ")).toEqual({ A: "b", C: "d" });
  });

  test("skips blank and malformed (no '=') entries", () => {
    expect(parseOtlpHeaders("A=1,,   ,no-equals,B=2")).toEqual({
      A: "1",
      B: "2",
    });
  });

  test("empty input yields an empty record", () => {
    expect(parseOtlpHeaders("")).toEqual({});
    expect(parseOtlpHeaders("   ")).toEqual({});
  });

  test("an empty value is preserved (key present, value '')", () => {
    expect(parseOtlpHeaders("A=")).toEqual({ A: "" });
  });
});
