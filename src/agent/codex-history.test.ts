import { describe, expect, test } from "bun:test";
import { userPromptFromResponseItem } from "./codex-history";

/**
 * Lines captured verbatim from a rollout written by the bundled Codex CLI
 * 0.155.1. That release stopped emitting the `event_msg`/`user_message` event
 * the reader used to key on, so the prompt survives only here — without this
 * fallback every 0.155.x session vanishes from `/sessions`.
 */
const promptItem = {
  type: "response_item",
  payload: {
    type: "message",
    id: "msg_01a0ca5e-cd53-72f0-9272-1a1220271291",
    role: "user",
    content: [{ type: "input_text", text: "hi" }],
  },
};

/** The scaffolding turn Codex injects ahead of the real prompt. */
const environmentContextItem = {
  type: "response_item",
  payload: {
    type: "message",
    id: "msg_01a0ca5e-cd3d-7f40-b940-ddc56021fae4",
    role: "user",
    content: [
      {
        type: "input_text",
        text: "<environment_context>\n  <cwd>/tmp</cwd>\n  <shell>bash</shell>\n</environment_context>",
      },
    ],
  },
};

describe("userPromptFromResponseItem", () => {
  test("reads the prompt out of a 0.155.x user response_item", () => {
    expect(userPromptFromResponseItem(promptItem)).toBe("hi");
  });

  test("joins multi-part input_text content", () => {
    expect(
      userPromptFromResponseItem({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "send " },
            { type: "input_text", text: "a file" },
          ],
        },
      })
    ).toBe("send a file");
  });

  test("skips Codex's injected context blocks", () => {
    expect(userPromptFromResponseItem(environmentContextItem)).toBe("");
    expect(
      userPromptFromResponseItem({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<user_instructions>x" }],
        },
      })
    ).toBe("");
  });

  test("ignores everything that is not a user response_item message", () => {
    for (const obj of [
      { type: "event_msg", payload: { type: "task_started" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hello" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "skills" }],
        },
      },
      { type: "response_item", payload: { type: "reasoning" } },
      { type: "session_meta", payload: { id: "abc", cwd: "/tmp" } },
      {},
    ]) {
      expect(userPromptFromResponseItem(obj)).toBe("");
    }
  });

  test("tolerates malformed content parts", () => {
    expect(
      userPromptFromResponseItem({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [null, { text: 7 }, { type: "input_text", text: " ok " }],
        },
      })
    ).toBe("ok");
  });
});
