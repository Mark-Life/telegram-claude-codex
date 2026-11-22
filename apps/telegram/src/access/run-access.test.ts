import { describe, expect, test } from "bun:test";

import { runAccessFor } from "./run-access";
import type { Surface, Tier } from "./tier";

const decide = (tier: Tier, surface: Surface) =>
  runAccessFor({ surface, tier });

describe("private and workspace runs", () => {
  test("the owner keeps full access, external tools and admin scripts privately", () => {
    const decision = decide("owner", "private");
    expect(decision.agent.sandbox).toBe("danger-full-access");
    expect(decision.agent.externalTools).toBe(true);
    expect(decision.agent.adminScripts).toBe(true);
    expect(decision.agent.priority).toBe("normal");
    expect(decision.scratch).toBe(false);
    expect(decision.agent.persistSession).toBe(true);
  });

  test("executor tier gets owner execution access without admin identity", () => {
    const decision = decide("executor", "private");
    expect(decision.agent.sandbox).toBe("danger-full-access");
    expect(decision.agent.externalTools).toBe(true);
    expect(decision.agent.adminScripts).toBe(false);
    expect(decision.agent.priority).toBe("normal");
    expect(decision.scratch).toBe(false);
    expect(decision.agent.persistSession).toBe(true);
  });

  test("a member builds in their scratch dir with no external tools", () => {
    const decision = decide("member", "private");
    expect(decision.agent.externalTools).toBe(false);
    expect(decision.agent.sandbox).toBe("workspace-write");
    expect(decision.scratch).toBe("user");
    expect(decision.agent.adminScripts).toBe(false);
    expect(decision.agent.persistSession).toBe(true);
  });

  test("no tier below owner is ever told about the admin scripts", () => {
    for (const tier of ["executor", "member", "guest"] as const) {
      expect(decide(tier, "private").agent.adminScripts).toBe(false);
    }
  });
});

describe("group runs", () => {
  test("are lightweight for every tier, the owner included", () => {
    for (const tier of ["owner", "executor", "member", "guest"] as const) {
      const decision = decide(tier, "group");
      expect(decision.agent.sandbox).toBe("read-only");
      expect(decision.agent.externalTools).toBe(false);
      expect(decision.agent.adminScripts).toBe(false);
      expect(decision.agent.webSearch).toBe(true);
      expect(decision.agent.persistSession).toBe(false);
      expect(decision.agent.priority).toBe("low");
      expect(decision.scratch).toBe("chat");
      expect(decision.forceQuiet).toBe(true);
    }
  });

  test("the owner's workspace keeps filesystem access but no external tools", () => {
    const decision = decide("owner", "workspace");
    expect(decision.agent.sandbox).toBe("danger-full-access");
    expect(decision.agent.externalTools).toBe(false);
  });
});
