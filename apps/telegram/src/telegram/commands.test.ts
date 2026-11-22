import { describe, expect, test } from "bun:test";

import { commandsForTier, generalCommands } from "./commands";

const names = (commands: readonly { command: string }[]) =>
  commands.map(({ command }) => command);

describe("commandsForTier", () => {
  test("keeps recurring-task commands out of generic menus", () => {
    expect(names(generalCommands())).not.toContain("tasks");
    expect(names(commandsForTier("member"))).not.toContain("task");
  });

  test("lets executors manage recurring tasks without access commands", () => {
    const commands = names(commandsForTier("executor"));
    expect(commands).toContain("tasks");
    expect(commands).toContain("task");
    expect(commands).not.toContain("grant");
    expect(commands).not.toContain("revoke");
  });

  test("keeps access management owner-only", () => {
    const commands = names(commandsForTier("owner"));
    expect(commands).toContain("tasks");
    expect(commands).toContain("grant");
    expect(commands).toContain("revoke");
  });
});
