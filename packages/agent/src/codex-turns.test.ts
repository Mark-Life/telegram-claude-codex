import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CodexOptions } from "@openai/codex-sdk";

import { appServerLaunch } from "./codex-launch";
import { newCodex } from "./codex-sdk";
import { codexOptions } from "./codex-thread";
import {
  helperCodexOptions,
  oneTurnThreadOptions,
  turnOn,
} from "./codex-turns";
import type { OneTurnClient } from "./codex-turns";
import { LIGHT_ACCESS } from "./types";

const root = mkdtempSync(path.join(tmpdir(), "helper-turn-"));
const workspace = path.join(root, "workspace");
/** Codex's home for these turns, so the developer's own `~/.codex` stays out. */
const home = path.join(root, "codex-home");
mkdirSync(workspace);
mkdirSync(home);
const OWNER_RULE = "The owner's name is Testy McTestface.";
const CONFIG_RULE = "Always answer in Georgian.";
writeFileSync(path.join(workspace, "AGENTS.md"), `# Rules\n\n${OWNER_RULE}\n`);
writeFileSync(
  path.join(home, "config.toml"),
  `developer_instructions = ${JSON.stringify(CONFIG_RULE)}\n`
);

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

/**
 * What the model would be sent for one turn in `workspace`, as Codex itself
 * renders it offline: no model call and no login.
 */
const promptInput = (options: CodexOptions) => {
  const { launch } = appServerLaunch(
    options,
    oneTurnThreadOptions({ workingDirectory: workspace }),
    []
  );
  const done = Bun.spawnSync({
    cmd: [launch.bin, "debug", "prompt-input", ...launch.args.slice(1), "hi"],
    cwd: workspace,
    env: { ...launch.env, CODEX_HOME: home },
  });
  expect(done.exitCode).toBe(0);
  return done.stdout.toString();
};

describe("helper turn context", () => {
  test("a light run's context carries the workspace (the control)", () => {
    const input = promptInput(codexOptions({ access: LIGHT_ACCESS }));
    expect(input).toContain(OWNER_RULE);
    expect(input).toContain(CONFIG_RULE);
    expect(input).toContain("<environment_context>");
  });

  test("a helper turn's context carries none of it", () => {
    const input = promptInput(helperCodexOptions());
    expect(input).not.toContain(OWNER_RULE);
    expect(input).not.toContain(CONFIG_RULE);
    expect(input).not.toContain("AGENTS.md");
    expect(input).not.toContain("<environment_context>");
    expect(input).not.toContain("<skills_instructions>");
    expect(input).not.toContain("<multi_agent_role>");
    expect(input).toContain('"hi"');
  });
});

describe("turnOn", () => {
  test("a helper thread asks Codex for no rollout", async () => {
    // A stand-in for the CLI that only records what the patched SDK ran.
    const argvFile = path.join(root, "argv");
    const fake = path.join(root, "fake-codex");
    writeFileSync(
      fake,
      '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$ARGV_FILE"\ncat > /dev/null\n',
      { mode: 0o755 }
    );
    const client = await newCodex({
      codexPathOverride: fake,
      env: { ARGV_FILE: argvFile, PATH: process.env.PATH ?? "" },
    });
    await turnOn(client)({ prompt: "hi", workingDirectory: workspace });
    expect(readFileSync(argvFile, "utf-8").split("\n")).toContain(
      "--ephemeral"
    );
  });

  test("an abort frees the turn even when the run never ends", async () => {
    const hung: OneTurnClient = {
      startThread: () => ({
        run: async () => await Promise.withResolvers<never>().promise,
      }),
    };
    const turn = turnOn(hung)({
      prompt: "hi",
      signal: AbortSignal.timeout(10),
      workingDirectory: workspace,
    });
    const outcome = await turn.then(() => "answered").catch(() => "rejected");
    expect(outcome).toBe("rejected");
  });
});
