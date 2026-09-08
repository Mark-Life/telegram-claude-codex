import { describe, expect, test } from "bun:test";
import type { Context } from "grammy";
import { AgentInterrupted } from "./agent/errors";
import type { AgentEvent, ProviderCapabilities } from "./agent/types";
import { splitText, streamToTelegram } from "./telegram";
import type { RenderPolicy } from "./telegram/render-policy";
import { FULL_POLICY, QUIET_POLICY } from "./telegram/render-policy";
import type { Route } from "./telegram/route";

const FULL_CAPS: ProviderCapabilities = {
  compaction: true,
  cost: true,
  planMode: true,
  subagents: true,
  thinking: true,
};

/** Rich message bodies are either raw markdown or pre-rendered Telegram HTML. */
type RichInput = { markdown: string } | { html: string };
const bodyOf = (input: RichInput) =>
  "markdown" in input ? input.markdown : input.html;

/** One captured outbound call: what was sent, where it landed. */
interface Sent {
  body: string;
  chatId: number;
  threadId?: number;
}

/** A recording fake of the grammy ctx/api — no network, captures every send. */
const makeFakeCtx = (chatId = 1) => {
  const rich: Sent[] = [];
  const drafts: Sent[] = [];
  const plain: Sent[] = [];
  const actions: Sent[] = [];
  let idSeq = 100;
  const api = {
    sendRichMessage: (
      id: number,
      input: RichInput,
      other?: { message_thread_id?: number }
    ) => {
      rich.push({
        body: bodyOf(input),
        chatId: id,
        threadId: other?.message_thread_id,
      });
      idSeq += 1;
      return Promise.resolve({ message_id: idSeq });
    },
    sendRichMessageDraft: (
      id: number,
      _draftId: number,
      input: RichInput,
      other?: { message_thread_id?: number }
    ) => {
      drafts.push({
        body: bodyOf(input),
        chatId: id,
        threadId: other?.message_thread_id,
      });
      return Promise.resolve(undefined);
    },
    sendMessage: (
      id: number,
      text: string,
      other?: { message_thread_id?: number }
    ) => {
      plain.push({
        body: text,
        chatId: id,
        threadId: other?.message_thread_id,
      });
      idSeq += 1;
      return Promise.resolve({ message_id: idSeq });
    },
    sendChatAction: (
      id: number,
      action: string,
      other?: { message_thread_id?: number }
    ) => {
      actions.push({
        body: action,
        chatId: id,
        threadId: other?.message_thread_id,
      });
      return Promise.resolve(true);
    },
  };
  const ctx = { chat: { id: chatId }, api } as unknown as Context;
  return { ctx, rich, drafts, plain, actions };
};

async function* scripted(events: AgentEvent[]) {
  for (const event of events) {
    yield event;
  }
}

interface RunArgs {
  caps?: ProviderCapabilities;
  onSessionInit?: (sessionId: string) => Promise<void> | void;
  policy?: RenderPolicy;
  projectName?: string;
  route?: Route;
}

const run = (events: AgentEvent[], args: RunArgs = {}) => {
  const route = args.route ?? { chatId: 1, threadId: null };
  const fake = makeFakeCtx(route.chatId);
  return streamToTelegram({
    capabilities: args.caps ?? FULL_CAPS,
    ctx: fake.ctx,
    events: scripted(events),
    onSessionInit: args.onSessionInit,
    policy: args.policy ?? FULL_POLICY,
    projectName: args.projectName ?? "proj",
    route,
  }).then((result) => ({ ...fake, result }));
};

const bodies = (sent: Sent[]) => sent.map((s) => s.body).join("\n");

describe("splitText", () => {
  test("returns the text unchanged when within the limit", () => {
    expect(splitText("hello", 100)).toEqual(["hello"]);
  });

  test("splits oversized text into chunks that each fit, losslessly", () => {
    const text = Array.from({ length: 400 }, (_, i) => `line-${i}`).join("\n");
    const chunks = splitText(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
    expect(chunks.join("")).toBe(text);
  });
});

describe("streamToTelegram", () => {
  test("accumulates text deltas into a persisted message", async () => {
    const { rich, result } = await run([
      { kind: "session_init", sessionId: "s-1" },
      { kind: "text_delta", text: "Hello, " },
      { kind: "text_delta", text: "world!" },
    ]);
    expect(bodies(rich)).toContain("Hello, world!");
    expect(result.sessionId).toBe("s-1");
  });

  test("an interrupt renders friendly copy, never a raw exit code", async () => {
    const { rich, plain, result } = await run([
      {
        kind: "error",
        message: "Process exited with code 143",
        class: new AgentInterrupted({ reason: "stopped" }),
      },
    ]);
    const all = [bodies(rich), bodies(plain)].join("\n");
    expect(all).toContain("Stopped.");
    expect(all).not.toContain("143");
    expect(result.errorClass?._tag).toBe("AgentInterrupted");
  });

  test("thinking UI is gated on the provider capability", async () => {
    const thinkingEvents: AgentEvent[] = [
      { kind: "thinking_start" },
      { kind: "thinking_delta", text: "brainstorm-token" },
      { kind: "thinking_done", durationMs: 10 },
    ];

    const on = await run(thinkingEvents, {
      caps: { ...FULL_CAPS, thinking: true },
    });
    expect(bodies(on.rich)).toContain("brainstorm-token");

    const off = await run(thinkingEvents, {
      caps: { ...FULL_CAPS, thinking: false },
    });
    expect([bodies(off.rich), bodies(off.drafts)].join("\n")).not.toContain(
      "brainstorm-token"
    );
  });

  test("populates the result footer economics from the result event", async () => {
    const { result } = await run([
      { kind: "text_delta", text: "done" },
      {
        kind: "result",
        text: "done",
        sessionId: "s-9",
        cost: 0.02,
        durationMs: 1500,
        turns: 3,
        totalTokens: 900,
      },
    ]);
    expect(result.cost).toBe(0.02);
    expect(result.turns).toBe(3);
    expect(result.totalTokens).toBe(900);
    expect(result.sessionId).toBe("s-9");
  });

  test("the quiet policy emits exactly one message for text, tools and thinking", async () => {
    const { rich, drafts, plain, actions } = await run(
      [
        { kind: "session_init", sessionId: "s-2" },
        { kind: "thinking_start" },
        { kind: "thinking_delta", text: "brainstorm-token" },
        { kind: "thinking_done", durationMs: 10 },
        { kind: "tool_use", name: "Read", input: "src/telegram.ts" },
        { kind: "text_delta", text: "Answer " },
        { kind: "tool_use", name: "Bash", input: "ls" },
        { kind: "text_delta", text: "here." },
        {
          kind: "result",
          text: "Answer here.",
          sessionId: "s-2",
          cost: 0.01,
          durationMs: 1200,
          turns: 2,
          totalTokens: 500,
        },
      ],
      { policy: QUIET_POLICY }
    );
    expect(rich).toHaveLength(1);
    expect(rich[0]?.body).toBe("Answer here.");
    expect(drafts).toHaveLength(0);
    expect(plain).toHaveLength(0);
    // No footer, no tool lines, no thinking — but the typing indicator still ran.
    expect(rich[0]?.body).not.toContain("Cost");
    expect(rich[0]?.body).not.toContain("brainstorm-token");
    expect(actions.length).toBeGreaterThan(0);
  });

  test("the quiet policy still reports errors", async () => {
    const { rich } = await run(
      [
        {
          kind: "error",
          message: "Process exited with code 143",
          class: new AgentInterrupted({ reason: "stopped" }),
        },
      ],
      { policy: QUIET_POLICY }
    );
    expect(bodies(rich)).toContain("Stopped.");
  });

  test("every outbound call carries the topic it answers", async () => {
    const route = { chatId: 42, threadId: 7 };
    const { rich, drafts, actions } = await run(
      [
        { kind: "text_delta", text: "in-topic" },
        { kind: "tool_use", name: "Read", input: "a.ts" },
      ],
      { route }
    );
    for (const sent of [...rich, ...drafts, ...actions]) {
      expect(sent.chatId).toBe(42);
      expect(sent.threadId).toBe(7);
    }
    expect(actions.length).toBeGreaterThan(0);
    expect(drafts.length).toBeGreaterThan(0);
  });

  test("awaits onSessionInit before dispatching further events", async () => {
    const order: string[] = [];
    const { rich } = await run(
      [
        { kind: "session_init", sessionId: "s-3" },
        { kind: "text_delta", text: "after" },
      ],
      {
        onSessionInit: async (sessionId) => {
          await Promise.resolve();
          order.push(`init:${sessionId}`);
        },
      }
    );
    order.push("finalized");
    expect(order).toEqual(["init:s-3", "finalized"]);
    expect(bodies(rich)).toContain("after");
  });
});
