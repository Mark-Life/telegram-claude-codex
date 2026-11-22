import { describe, expect, test } from "bun:test";

import {
  buildFormatPrompt,
  formatThreadOptions,
  formatWith,
  MAX_FORMAT_INPUT,
} from "./codex-format";
import type { FormatArgs, FormatClient } from "./codex-format";

const ARGS: FormatArgs = {
  result: '{"unread":3,"from":"ops"}',
  title: "Inbox digest",
  workingDirectory: "/tmp",
};

/** A client that answers with a fixed string, or refuses to answer at all. */
const answering = (answer: string | Error) => {
  const prompts: string[] = [];
  const client: FormatClient = {
    startThread: () => ({
      run: async (input: string) => {
        prompts.push(input);
        if (answer instanceof Error) {
          throw answer;
        }
        return await Promise.resolve({ finalResponse: answer });
      },
    }),
  };
  return { client, prompts };
};

describe("buildFormatPrompt", () => {
  test("names the task and carries the raw result", () => {
    const prompt = buildFormatPrompt(ARGS);
    expect(prompt).toContain("Inbox digest");
    expect(prompt).toContain('{"unread":3,"from":"ops"}');
  });

  test("an over-long result is clipped and marked", () => {
    const prompt = buildFormatPrompt({ ...ARGS, result: "x".repeat(20_000) });
    expect(prompt).toContain("[truncated]");
    expect(prompt.length).toBeLessThan(MAX_FORMAT_INPUT * 2);
  });
});

describe("formatThreadOptions", () => {
  test("the pass is read-only and throwaway", () => {
    expect(formatThreadOptions("/tmp/scratch")).toMatchObject({
      sandboxMode: "read-only",
      webSearchEnabled: false,
      workingDirectory: "/tmp/scratch",
    });
  });
});

describe("formatWith", () => {
  test("a formatted answer replaces the raw result", async () => {
    const { client, prompts } = answering("3 unread from ops");
    expect(await formatWith(client, ARGS)).toBe("3 unread from ops");
    expect(prompts).toHaveLength(1);
  });

  test("a failed pass falls back instead of throwing", async () => {
    const { client } = answering(new Error("codex is down"));
    expect(await formatWith(client, ARGS)).toBeUndefined();
  });

  test("an empty answer falls back", async () => {
    const { client } = answering("   ");
    expect(await formatWith(client, ARGS)).toBeUndefined();
  });

  test("an empty result is never sent to the model", async () => {
    const { client, prompts } = answering("anything");
    expect(await formatWith(client, { ...ARGS, result: "  " })).toBeUndefined();
    expect(prompts).toHaveLength(0);
  });
});
