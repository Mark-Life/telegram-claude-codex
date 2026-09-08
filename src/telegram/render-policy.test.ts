import { describe, expect, test } from "bun:test";
import {
  FULL_POLICY,
  parseVerbosity,
  policyFor,
  QUIET_POLICY,
  VERBOSITY_LEVELS,
  type Verbosity,
} from "./render-policy";

describe("parseVerbosity", () => {
  const cases: [string | undefined, Verbosity][] = [
    ["full", "full"],
    ["quiet", "quiet"],
    [undefined, "quiet"],
    ["", "quiet"],
    ["FULL", "quiet"],
    ["verbose", "quiet"],
  ];
  for (const [raw, expected] of cases) {
    test(`${JSON.stringify(raw)} -> ${expected}`, () =>
      expect(parseVerbosity(raw)).toBe(expected));
  }
});

describe("policyFor", () => {
  test("full renders everything", () =>
    expect(policyFor("full")).toEqual(FULL_POLICY));
  test("quiet renders nothing but the answer", () =>
    expect(policyFor("quiet")).toEqual(QUIET_POLICY));
  test("quiet is the default level", () =>
    expect(policyFor(parseVerbosity())).toEqual(QUIET_POLICY));
  test("every level maps to a policy", () => {
    for (const level of VERBOSITY_LEVELS) {
      expect(Object.values(policyFor(level))).toHaveLength(3);
    }
  });
});
