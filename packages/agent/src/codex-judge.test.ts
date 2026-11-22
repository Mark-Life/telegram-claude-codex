import { describe, expect, test } from "bun:test";

import { buildJudgePrompt, judgeWith, parseVerdict } from "./codex-judge";
import type { JudgeArgs, JudgeClient } from "./codex-judge";

const ARGS: JudgeArgs = {
  botName: "Саша",
  messages: [
    { from: "Ivan", text: "кто посмотрит отчёт" },
    { from: "Kate", text: "Саша, посмотри пожалуйста" },
  ],
  surface: { kind: "group" },
  workingDirectory: "/tmp",
};

/** A client that answers with a fixed string, or refuses to answer at all. */
const answering = (answer: string | Error) => {
  const prompts: string[] = [];
  const client: JudgeClient = {
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

describe("buildJudgePrompt", () => {
  test("carries the recent messages and names the bot", () => {
    const prompt = buildJudgePrompt(ARGS);

    expect(prompt).toContain("Саша");
    expect(prompt).toContain("Kate: Саша, посмотри пожалуйста");
    expect(prompt).toContain("Ivan: кто посмотрит отчёт");
  });
});

describe("parseVerdict", () => {
  test("only a leading yes means the bot was addressed", () => {
    expect(parseVerdict("YES")).toBe(true);
    expect(parseVerdict(" yes\n")).toBe(true);
    expect(parseVerdict("NO")).toBe(false);
    expect(parseVerdict("Probably yes")).toBe(false);
    expect(parseVerdict("")).toBe(false);
  });
});

describe("judgeWith", () => {
  test("a yes lets the bot answer", async () => {
    const { client, prompts } = answering("YES");

    expect(await judgeWith(client, ARGS)).toBe(true);
    expect(prompts).toHaveLength(1);
  });

  test("a no keeps it silent", async () => {
    const { client } = answering("NO");
    expect(await judgeWith(client, ARGS)).toBe(false);
  });

  test("a judge that fails keeps it silent", async () => {
    const { client } = answering(new Error("codex is down"));
    expect(await judgeWith(client, ARGS)).toBe(false);
  });

  test("no context, no run at all", async () => {
    const { client, prompts } = answering("YES");

    expect(await judgeWith(client, { ...ARGS, messages: [] })).toBe(false);
    expect(prompts).toHaveLength(0);
  });
});
