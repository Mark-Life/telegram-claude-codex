import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CLAUDE_SETTINGS,
  mergeClaudeSettings,
  parseClaudeSettings,
} from "./claude-settings";

describe("claude-settings", () => {
  test("defaults harden the headless agent without denying plan mode", () => {
    expect(DEFAULT_CLAUDE_SETTINGS.disableBundledSkills).toBe(true);
    expect(DEFAULT_CLAUDE_SETTINGS.effortLevel).toBe("high");
    const deny = DEFAULT_CLAUDE_SETTINGS.permissions?.deny ?? [];
    expect(deny).toContain("AskUserQuestion");
    expect(deny).not.toContain("ExitPlanMode");
    expect(deny).not.toContain("EnterPlanMode");
  });

  test("top-level override keys replace wholesale", () => {
    const merged = mergeClaudeSettings(DEFAULT_CLAUDE_SETTINGS, {
      effortLevel: "low",
      disableArtifact: false,
    });
    expect(merged.effortLevel).toBe("low");
    expect(merged.disableArtifact).toBe(false);
    expect(merged.disableBundledSkills).toBe(true);
  });

  test("permissions merge one level deep so deny can be redefined", () => {
    const merged = mergeClaudeSettings(DEFAULT_CLAUDE_SETTINGS, {
      permissions: { deny: ["ExitPlanMode"] },
    });
    expect(merged.permissions?.deny).toEqual(["ExitPlanMode"]);
  });

  test("parseClaudeSettings round-trips JSON", () => {
    expect(parseClaudeSettings('{"effortLevel":"xhigh"}').effortLevel).toBe(
      "xhigh"
    );
    expect(() => parseClaudeSettings("{not json")).toThrow();
  });
});
