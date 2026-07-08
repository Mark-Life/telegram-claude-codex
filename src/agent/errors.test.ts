import { describe, expect, test } from "bun:test";
import {
  AgentInterrupted,
  AgentTimedOut,
  AtCapacity,
  classifyOutcome,
  ProcessFailed,
  ProviderCrashed,
} from "./errors";

describe("classifyOutcome", () => {
  test("interrupt -> Stopped.", () => {
    expect(
      classifyOutcome(new AgentInterrupted({ reason: "stopped" }))
    ).toEqual({
      outcome: "interrupted",
      copy: "Stopped.",
    });
    expect(
      classifyOutcome(new AgentInterrupted({ reason: "switched" })).copy
    ).toBe("Stopped.");
    expect(
      classifyOutcome(new AgentInterrupted({ reason: "new_prompt" })).copy
    ).toBe("Stopped.");
  });
  test("timeout -> interrupted/Timed out.", () => {
    expect(classifyOutcome(new AgentTimedOut({}))).toEqual({
      outcome: "interrupted",
      copy: "Timed out.",
    });
  });
  test("at_capacity", () => {
    expect(classifyOutcome(new AtCapacity({}))).toEqual({
      outcome: "at_capacity",
      copy: "Busy, try again shortly.",
    });
  });
  test("process failed uses stderr, falls back to exit code", () => {
    expect(
      classifyOutcome(new ProcessFailed({ code: 2, stderr: "  boom  " }))
    ).toEqual({
      outcome: "errored",
      copy: "boom",
    });
    expect(
      classifyOutcome(new ProcessFailed({ code: 2, stderr: "   " })).copy
    ).toBe("Process failed (exit 2).");
  });
  test("provider crashed uses message", () => {
    expect(
      classifyOutcome(new ProviderCrashed({ message: "spawn ENOENT" }))
    ).toEqual({
      outcome: "errored",
      copy: "spawn ENOENT",
    });
  });
});
