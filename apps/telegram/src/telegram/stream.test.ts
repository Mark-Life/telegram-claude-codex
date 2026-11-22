import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { AgentInterrupted } from "@workspace/agent";
import type { AgentEvent, ProviderCapabilities } from "@workspace/agent/types";
import { Effect, Stream } from "effect";

import { DEFAULT_LANGUAGE, switchLanguage } from "../i18n";
import { splitText } from "./format";
import {
  FULL_POLICY,
  parseVerbosity,
  policyFor,
  QUIET_POLICY,
} from "./render-policy";
import type { RenderPolicy } from "./render-policy";
import type { Route } from "./route";
import { streamToTelegram as renderStream } from "./stream";
import type { StreamArgs } from "./stream";
import { TelegramBot } from "./telegram-bot";
import type { TelegramBotHandle } from "./telegram-bot";

/** These cases check the Russian source copy. */
beforeAll(() => {
  switchLanguage("ru");
});
afterAll(() => {
  switchLanguage(DEFAULT_LANGUAGE);
});

const FULL_CAPS: ProviderCapabilities = {
  compaction: true,
  cost: true,
  planMode: true,
  thinking: true,
};

/** Rich message bodies are either raw markdown or pre-rendered Telegram HTML. */
type RichInput = { markdown: string } | { html: string };
const bodyOf = (input: RichInput) =>
  "markdown" in input ? input.markdown : input.html;

/** What the running test's chat received: persisted, drafted or plain fallback. */
interface Sent {
  drafts: RichInput[];
  plain: string[];
  rich: RichInput[];
}
let sent: Sent = { drafts: [], plain: [], rich: [] };
let idSeq = 100;
const nextMessage = () => {
  idSeq += 1;
  return { message_id: idSeq };
};

// streamToTelegram reaches Telegram only through the TelegramBot service: a
// recording fake of it, no network, captures every send into the running
// test's `sent`.
// SAFETY: the renderer only calls sendRichDraftTo, sendRichTo, sendTo and use,
// and reads only `message_id` of a sent message; the rest of the handle and of
// grammy's Message is unreachable from these tests.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- the handle carries the grammy bot no fake can supply
const fakeBot = {
  sendRichDraftTo: (_route: Route, _draftId: number, input: RichInput) =>
    Effect.sync(() => {
      sent.drafts.push(input);
      return true as const;
    }),
  sendRichTo: (_route: Route, input: RichInput) =>
    Effect.sync(() => {
      sent.rich.push(input);
      return nextMessage();
    }),
  sendTo: (_route: Route, text: string) =>
    Effect.sync(() => {
      sent.plain.push(text);
      return nextMessage();
    }),
  use: () => Effect.void,
} as unknown as TelegramBotHandle;

const streamToTelegram = async (args: StreamArgs) =>
  await Effect.runPromise(
    renderStream(args).pipe(Effect.provideService(TelegramBot, fakeBot))
  );

/** A fresh chat for one test: empty recordings and the route it streams to. */
const makeFakeChat = (chatId = 1) => {
  sent = { drafts: [], plain: [], rich: [] };
  const route: Route = { chatId, threadId: null };
  return { ...sent, route };
};

/** Replay a fixed event list as the agent stream. */
const scripted = (events: AgentEvent[]) => Stream.fromIterable(events);

const run = async (
  events: AgentEvent[],
  caps: ProviderCapabilities = FULL_CAPS,
  policy: RenderPolicy = FULL_POLICY,
  projectName = "proj"
) => {
  const fake = makeFakeChat();
  const result = await streamToTelegram({
    capabilities: caps,
    events: scripted(events),
    policy,
    projectName,
    route: fake.route,
  });
  return { ...fake, result };
};

/** Every body the run put in the chat: persisted, drafted or plain fallback. */
const allBodies = (out: Awaited<ReturnType<typeof run>>) =>
  [...out.rich.map(bodyOf), ...out.drafts.map(bodyOf), ...out.plain].join("\n");

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
  test("reports a session as soon as its init event arrives", async () => {
    const fake = makeFakeChat();
    const sessions: string[] = [];
    await streamToTelegram({
      capabilities: FULL_CAPS,
      events: scripted([{ kind: "session_init", sessionId: "s-early" }]),
      onSessionInit: (sessionId) =>
        Effect.sync(() => {
          sessions.push(sessionId);
        }),
      policy: FULL_POLICY,
      projectName: "proj",
      route: fake.route,
    });

    expect(sessions).toEqual(["s-early"]);
  });

  test("persists an assistant message and records its session", async () => {
    const { rich, result } = await run([
      { kind: "session_init", sessionId: "s-1" },
      { kind: "text_message", text: "Hello, world!" },
    ]);
    const bodies = rich.map(bodyOf).join("\n");
    expect(bodies).toContain("Hello, world!");
    expect(result.sessionId).toBe("s-1");
    expect(result.text).toBe("Hello, world!");
  });

  test("an interrupt renders friendly copy, never a raw exit code", async () => {
    const { rich, plain, result } = await run([
      {
        class: new AgentInterrupted({ reason: "stopped" }),
        kind: "error",
        message: "Process exited with code 143",
      },
    ]);
    const all = [...rich.map(bodyOf), ...plain].join("\n");
    expect(all).toContain("Остановлено.");
    expect(all).not.toContain("143");
    expect(result.errorClass?._tag).toBe("AgentInterrupted");
  });

  test("thinking UI is gated on the provider capability", async () => {
    const thinkingEvents: AgentEvent[] = [
      { kind: "thinking_start" },
      { kind: "thinking_delta", text: "brainstorm-token" },
      { durationMs: 10, kind: "thinking_done" },
    ];

    const on = await run(thinkingEvents, { ...FULL_CAPS, thinking: true });
    expect(on.rich.map(bodyOf).join("\n")).toContain("brainstorm-token");

    const off = await run(thinkingEvents, { ...FULL_CAPS, thinking: false });
    const offBodies = [...off.rich.map(bodyOf), ...off.drafts.map(bodyOf)].join(
      "\n"
    );
    expect(offBodies).not.toContain("brainstorm-token");
  });

  test("populates the result footer economics from the result event", async () => {
    const { result } = await run([
      { kind: "text_message", text: "done" },
      {
        cost: 0.02,
        durationMs: 1500,
        kind: "result",
        sessionId: "s-9",
        text: "done",
        totalTokens: 900,
        turns: 3,
      },
    ]);
    expect(result.cost).toBe(0.02);
    expect(result.turns).toBe(3);
    expect(result.totalTokens).toBe(900);
    expect(result.sessionId).toBe("s-9");
  });
});

describe("render policy", () => {
  test("verbosity defaults to quiet unless the setting says full", () => {
    expect(parseVerbosity()).toBe("quiet");
    expect(parseVerbosity("quiet")).toBe("quiet");
    expect(parseVerbosity("chatty")).toBe("quiet");
    expect(parseVerbosity("full")).toBe("full");
    expect(policyFor("quiet")).toEqual(QUIET_POLICY);
    expect(policyFor("full")).toEqual(FULL_POLICY);
  });
});

describe("streamToTelegram under the quiet policy", () => {
  const technicalEvents: AgentEvent[] = [
    { input: "src/index.ts", kind: "tool_use", name: "read_file" },
    { kind: "thinking_start" },
    { kind: "thinking_delta", text: "brainstorm-token" },
    { durationMs: 10, kind: "thinking_done" },
  ];

  test("technical events send nothing at all", async () => {
    const out = await run(technicalEvents, FULL_CAPS, QUIET_POLICY);
    expect(out.rich).toHaveLength(0);
    expect(out.drafts).toHaveLength(0);
    expect(out.plain).toHaveLength(0);
  });

  test("full mode still renders those same events", async () => {
    const out = await run(technicalEvents, FULL_CAPS, FULL_POLICY);
    const bodies = allBodies(out);
    expect(bodies).toContain("read_file");
    expect(bodies).toContain("brainstorm-token");
  });

  test("only the final text is persisted, with no drafts and no footer", async () => {
    const out = await run(
      [
        { input: "x", kind: "tool_use", name: "shell" },
        { kind: "text_message", text: "All done." },
        {
          cost: 0.02,
          durationMs: 1500,
          kind: "result",
          sessionId: "s-9",
          text: "All done.",
          totalTokens: 900,
          turns: 3,
        },
      ],
      FULL_CAPS,
      QUIET_POLICY
    );
    expect(out.drafts).toHaveLength(0);
    expect(out.rich).toHaveLength(1);
    expect(out.rich.map(bodyOf).join("")).toBe("All done.");
    const bodies = allBodies(out);
    expect(bodies).not.toContain("Cost:");
    expect(bodies).not.toContain("Time:");
    expect(bodies).not.toContain("Turns:");
    expect(bodies).not.toContain("proj");
    // The economics are still recorded for the run ledger, just not shown.
    expect(out.result.cost).toBe(0.02);
    expect(out.result.turns).toBe(3);
  });

  test("keeps complete Codex replies as separate Telegram messages", async () => {
    const out = await run(
      [
        { kind: "text_message", text: "Сначала проверю код." },
        { input: "src/index.ts", kind: "tool_use", name: "read_file" },
        { kind: "text_message", text: "Причина найдена." },
        {
          durationMs: 1500,
          kind: "result",
          sessionId: "s-9",
          text: "Причина найдена.",
          turns: 1,
        },
      ],
      FULL_CAPS,
      QUIET_POLICY
    );

    expect(out.rich.map(bodyOf)).toEqual([
      "Сначала проверю код.",
      "Причина найдена.",
    ]);
    expect(out.result.text).toBe("Сначала проверю код.\n\nПричина найдена.");
  });

  test("full mode keeps the dev footer", async () => {
    const out = await run(
      [
        { kind: "text_message", text: "All done." },
        {
          cost: 0.02,
          durationMs: 1500,
          kind: "result",
          sessionId: "s-9",
          text: "All done.",
          totalTokens: 900,
          turns: 3,
        },
      ],
      FULL_CAPS,
      FULL_POLICY
    );
    const bodies = allBodies(out);
    expect(bodies).toContain("Cost: $0.0200");
    expect(bodies).toContain("Project: proj");
  });

  test("errors still reach the chat", async () => {
    const out = await run(
      [
        {
          class: new AgentInterrupted({ reason: "stopped" }),
          kind: "error",
          message: "Process exited with code 143",
        },
      ],
      FULL_CAPS,
      QUIET_POLICY
    );
    expect(allBodies(out)).toContain("Остановлено.");
  });

  test("a long answer is still split across messages", async () => {
    const long = Array.from({ length: 600 }, (_, i) => `line-${i}`).join("\n");
    const out = await run(
      [{ kind: "text_message", text: long }],
      FULL_CAPS,
      QUIET_POLICY
    );
    expect(out.rich.length).toBeGreaterThan(1);
    expect(out.drafts).toHaveLength(0);
    expect(out.rich.map(bodyOf).join("")).toBe(long);
  });
});
