import { describe, expect, test } from "bun:test";

import {
  AgentInterrupted,
  AtCapacity,
  classifyOutcome,
  ProviderCrashed,
} from "./errors";

describe("classifyOutcome", () => {
  test("interrupt -> Stopped.", () => {
    expect(
      classifyOutcome(new AgentInterrupted({ reason: "stopped" }))
    ).toEqual({
      copy: "Stopped.",
      outcome: "interrupted",
    });
    expect(
      classifyOutcome(new AgentInterrupted({ reason: "switched" })).copy
    ).toBe("Stopped.");
    expect(
      classifyOutcome(new AgentInterrupted({ reason: "new_prompt" })).copy
    ).toBe("Stopped.");
  });
  test("at_capacity", () => {
    expect(classifyOutcome(new AtCapacity({}))).toEqual({
      copy: "Busy, try again shortly.",
      outcome: "at_capacity",
    });
  });
  test("provider crashed uses message", () => {
    expect(
      classifyOutcome(new ProviderCrashed({ message: "spawn ENOENT" }))
    ).toEqual({
      copy: "spawn ENOENT",
      outcome: "errored",
    });
  });
});
