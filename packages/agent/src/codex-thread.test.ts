import { describe, expect, test } from "bun:test";

import {
  AUTO_COMPACT_TOKENS_DEFAULT,
  autoCompactTokenLimit,
  buildCodexPrompt,
  codexOptions,
  threadOptions,
} from "./codex-thread";
import { MEMORY_FILE } from "./run-prompt";
import { LIGHT_ACCESS, OWNER_ACCESS } from "./types";
import type { RunAccess, RunOptions } from "./types";

const optsWith = (access: RunAccess, extra?: Partial<RunOptions>) =>
  ({
    access,
    chatId: 111,
    persona: { callName: "Саша", gender: "female", ownerName: "Иван" },
    projectDir: "/home/agent/projects/app",
    prompt: "do the thing",
    userId: 111,
    ...extra,
  }) satisfies RunOptions;

describe("threadOptions", () => {
  test("the owner's run keeps full access in the chosen directory", () => {
    const options = threadOptions(optsWith(OWNER_ACCESS));

    expect(options.sandboxMode).toBe("danger-full-access");
    expect(options.workingDirectory).toBe("/home/agent/projects/app");
    expect(options.webSearchEnabled).toBe(true);
    expect(options.webSearchMode).toBe("live");
  });

  test("a lightweight run is read-only wherever it is pointed", () => {
    const options = threadOptions(
      optsWith(LIGHT_ACCESS, { projectDir: "/data/scratch/222" })
    );

    expect(options.sandboxMode).toBe("read-only");
    expect(options.workingDirectory).toBe("/data/scratch/222");
    expect(options.webSearchEnabled).toBe(true);
  });

  test("a member writes only inside the directory it was given", () => {
    const options = threadOptions(
      optsWith({ ...OWNER_ACCESS, sandbox: "workspace-write" })
    );

    expect(options.sandboxMode).toBe("workspace-write");
  });
});

describe("codexOptions", () => {
  test("group memory tools run without an approval prompt nobody can answer", () => {
    const options = codexOptions({
      access: { ...LIGHT_ACCESS, groupMemory: "current" },
      groupMemory: { chatId: -100, userId: 111 },
    });
    expect(options.config).toMatchObject({
      mcp_servers: { group_memory: { default_tools_approval_mode: "approve" } },
    });
  });

  test("the owner's shell gets BOT_TOKEN from the env, never from argv", () => {
    const saved = process.env.BOT_TOKEN;
    process.env.BOT_TOKEN = "123:secret-bot-token";
    try {
      const options = codexOptions({ access: OWNER_ACCESS });
      expect(options.env?.BOT_TOKEN).toBe("123:secret-bot-token");
      expect(options.config?.shell_environment_policy).toEqual({
        ignore_default_excludes: true,
        inherit: "all",
      });
      expect(JSON.stringify(options.config)).not.toContain("secret-bot-token");
    } finally {
      process.env.BOT_TOKEN = saved;
    }
  });
});

describe("autoCompactTokenLimit", () => {
  test("defaults to 150k when unset or not a positive integer", () => {
    expect(AUTO_COMPACT_TOKENS_DEFAULT).toBe(150_000);
    for (const raw of [undefined, "", " ", "abc", "0", "-5", "1.5"]) {
      expect(autoCompactTokenLimit(raw)).toBe(AUTO_COMPACT_TOKENS_DEFAULT);
    }
  });

  test("a positive integer overrides the default", () => {
    expect(autoCompactTokenLimit(" 200000 ")).toBe(200_000);
  });

  test("every run's config carries the threshold", () => {
    const options = codexOptions({ access: LIGHT_ACCESS });
    expect(options.config).toMatchObject({
      model_auto_compact_token_limit: autoCompactTokenLimit(),
    });
  });
});

describe("buildCodexPrompt", () => {
  test("an owner's first turn learns the bot's skills", () => {
    const prompt = buildCodexPrompt(optsWith(OWNER_ACCESS));

    expect(prompt).toContain("bot-send-file");
    expect(prompt).toContain("bot-access");
    expect(prompt).toContain("self-update");
    expect(prompt).toContain(`/home/agent/projects/app/${MEMORY_FILE}`);
    expect(prompt).toContain("/home/agent/projects/app/.agents/skills");
    expect(prompt).toContain("do the thing");
  });

  test("no lesser run is ever told where the skills are", () => {
    const prompt = buildCodexPrompt(
      optsWith({ ...OWNER_ACCESS, adminScripts: false })
    );

    expect(prompt).not.toContain("bot-access");
    expect(prompt).not.toContain("bot-send-file");
    expect(prompt).not.toContain("self-update");
    expect(prompt).not.toContain(MEMORY_FILE);
    expect(prompt).toContain(
      "Your name is Саша, and you are Иван's assistant."
    );
    expect(prompt).toContain("Your grammatical gender is feminine");
    expect(prompt.endsWith("\n\ndo the thing")).toBe(true);
  });

  test("a resumed session receives its current file route", () => {
    const prompt = buildCodexPrompt(
      optsWith(OWNER_ACCESS, { sessionId: "session-1", threadId: 222 })
    );

    expect(prompt).toContain("bot-send-file");
    expect(prompt).toContain("--chat 111 --thread 222");
    expect(prompt).toContain("do the thing");
    expect(prompt).not.toContain("bot-access");
  });
});
