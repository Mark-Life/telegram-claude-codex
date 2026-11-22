import { describe, expect, test } from "bun:test";

import { AppConfig } from "@workspace/env/bot";
import { Exit, Layer, ManagedRuntime, Option, Queue, Redacted } from "effect";

import {
  AgentInterrupted,
  AtCapacity,
  classifyOutcome,
  ProviderCrashed,
} from "./errors";
import {
  hasRun,
  runKeyOf,
  RunRegistry,
  startRun,
  stopRun,
} from "./run-registry";
import { LIGHT_ACCESS, OWNER_ACCESS } from "./types";
import type { AgentEvent, EventQueue, ProviderSpec, RunOptions } from "./types";

/**
 * Builds an isolated RunRegistry runtime backed by a literal AppConfig so tests
 * never touch env or a real provider CLI. `maxConcurrentRuns`
 * sizes the shared semaphore under test.
 */
const makeRuntime = (maxConcurrentRuns: number) => {
  const cfg = {
    allowedUserId: 1,
    api: Option.none(),
    botToken: Redacted.make("x"),
    bwrapBin: Option.none(),
    claudeBin: Option.none(),
    codexBin: Option.none(),
    defaultTz: "Europe/Sofia",
    elevenLabsApiKey: Option.none(),
    eventLogPath: ".data/events.jsonl",
    executorApiKey: Option.none(),
    executorMcpUrl: Option.none(),
    executorVersion: "v1",
    groqApiKey: Redacted.make("x"),
    maxBackgroundRuns: 20,
    maxConcurrentRuns,
    piBin: Option.none(),
    projectsDir: "/tmp",
    socatBin: Option.none(),
    telegramAccount: Option.none(),
    typesafeApiKey: Option.none(),
    workDir: Option.none(),
  } satisfies typeof AppConfig.Service;
  const layer = RunRegistry.layer.pipe(
    Layer.provide(Layer.succeed(AppConfig, cfg))
  );
  return ManagedRuntime.make(layer);
};

const HOLD_POLL_MS = 10;

/** Hold until the run is cancelled — the fake's stand-in for "still working". */
const untilAborted = async (signal: AbortSignal) => {
  while (!signal.aborted) {
    // oxlint-disable-next-line no-await-in-loop -- polling is sequential by nature
    await Bun.sleep(HOLD_POLL_MS);
  }
};

/**
 * Fake provider: yields one `text_message`, then does what `after` says — hold
 * until the run is cancelled (a run that is still working), end the turn (a
 * natural exit), or throw (a provider crash). Same shape as Codex — one
 * AsyncGenerator cancelled through an AbortSignal — so these tests drive the
 * registry exactly as production does, without a model. A first event taken
 * from the queue proves the run cleared the semaphore and is streaming.
 */
const makeSpec = (args: {
  text: string;
  after?: "crash" | "end" | "hold";
}): ProviderSpec => ({
  id: "codex",
  run: async function* run(_opts, _ctx, signal) {
    yield { kind: "text_message", text: args.text } satisfies AgentEvent;
    if (args.after === "crash") {
      throw new Error(args.text);
    }
    if (args.after === "end") {
      return;
    }
    await untilAborted(signal);
  },
});

const makeOpts = (userId: number, threadId?: number): RunOptions => ({
  access: OWNER_ACCESS,
  chatId: userId,
  persona: { callName: "Assistant", gender: "male", ownerName: undefined },
  projectDir: process.cwd(),
  prompt: "",
  threadId,
  userId,
});

const groupOpts = (userId: number): RunOptions => ({
  ...makeOpts(userId),
  access: LIGHT_ACCESS,
});

/** Take one queued event, asserting the producer offered one (not just ended). */
const takeEvent = async (
  rt: ReturnType<typeof makeRuntime>,
  { queue }: { queue: EventQueue }
) => {
  const exit = await rt.runPromiseExit(Queue.take(queue));
  if (Exit.isFailure(exit)) {
    throw new Error("queue ended before yielding an event");
  }
  return exit.value;
};

/** Poll a predicate until true or timeout (ms). */
const waitUntil = async (pred: () => Promise<boolean>, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- polling is sequential by nature
    if (await pred()) {
      return true;
    }
    // oxlint-disable-next-line no-await-in-loop -- ditto: wait, then re-poll
    await Bun.sleep(20);
  }
  return false;
};

describe("classifyOutcome — every AgentError tag (adversarial)", () => {
  test("interrupt maps to interrupted for every reason", () => {
    for (const reason of ["stopped", "switched", "new_prompt"] as const) {
      expect(classifyOutcome(new AgentInterrupted({ reason }))).toEqual({
        copy: "Stopped.",
        outcome: "interrupted",
      });
    }
  });

  test("at_capacity", () => {
    expect(classifyOutcome(new AtCapacity({}))).toEqual({
      copy: "Busy, try again shortly.",
      outcome: "at_capacity",
    });
  });

  test("provider crashed passes message through verbatim (incl. multiline)", () => {
    const message = "spawn ENOENT\n  at Object.<anonymous>";
    expect(classifyOutcome(new ProviderCrashed({ message }))).toEqual({
      copy: message,
      outcome: "errored",
    });
    expect(classifyOutcome(new ProviderCrashed({ message: "" })).copy).toBe("");
  });
});

describe("RunRegistry.stop on unknown user", () => {
  test("returns false when no run is active (backs stopAgent)", async () => {
    const rt = makeRuntime(4);
    try {
      // stopAgent() in index.ts is this same registry path; here it runs
      // without the app runtime.
      const stopped = await rt.runPromise(
        stopRun(makeOpts(424_242), "stopped")
      );
      expect(stopped).toBe(false);
    } finally {
      await rt.dispose();
    }
  });
});

describe("RunRegistry — run lifecycle (fake provider)", () => {
  test("(a) interrupt yields an AgentInterrupted-classified error, not an exit code", async () => {
    const rt = makeRuntime(4);
    try {
      const queue = await rt.runPromise(
        startRun(makeSpec({ text: "go" }), makeOpts(1001))
      );
      // Wait for the stream to actually start (permit acquired, process live).
      const first = await takeEvent(rt, queue);
      expect(first.kind).toBe("text_message");
      expect(await rt.runPromise(hasRun(makeOpts(1001)))).toBe(true);

      const stopped = await rt.runPromise(stopRun(makeOpts(1001), "stopped"));
      expect(stopped).toBe(true);

      const terminal = await takeEvent(rt, queue);
      expect(terminal.kind).toBe("error");
      if (terminal.kind === "error") {
        expect(terminal.class?._tag).toBe("AgentInterrupted");
        expect(terminal.message).toBe("Stopped.");
      }
    } finally {
      await rt.dispose();
    }
  }, 15_000);

  test("(b) a provider that throws ends the run as ProviderCrashed", async () => {
    const rt = makeRuntime(4);
    try {
      const queue = await rt.runPromise(
        startRun(makeSpec({ after: "crash", text: "boom" }), makeOpts(1002))
      );
      // The event yielded before the throw still reaches the chat.
      const yielded = await takeEvent(rt, queue);
      expect(yielded.kind).toBe("text_message");
      const terminal = await takeEvent(rt, queue);
      expect(terminal.kind).toBe("error");
      if (terminal.kind === "error") {
        expect(terminal.class?._tag).toBe("ProviderCrashed");
        expect(terminal.message).toContain("boom");
      }
    } finally {
      await rt.dispose();
    }
  }, 15_000);

  test("(c) hasRun tracks the map lifecycle: false → true → false on natural exit", async () => {
    const rt = makeRuntime(4);
    try {
      expect(await rt.runPromise(hasRun(makeOpts(1003)))).toBe(false);
      await rt.runPromise(
        startRun(makeSpec({ after: "end", text: "hi" }), makeOpts(1003))
      );
      expect(await rt.runPromise(hasRun(makeOpts(1003)))).toBe(true);
      // Fiber completes on natural exit → FiberMap auto-removes the entry.
      const cleared = await waitUntil(
        async () => !(await rt.runPromise(hasRun(makeOpts(1003))))
      );
      expect(cleared).toBe(true);
    } finally {
      await rt.dispose();
    }
  }, 15_000);

  test("(d) two users run concurrently up to MAX_CONCURRENT_RUNS", async () => {
    const rt = makeRuntime(2);
    try {
      const q1 = await rt.runPromise(
        startRun(makeSpec({ text: "one" }), makeOpts(2001))
      );
      const q2 = await rt.runPromise(
        startRun(makeSpec({ text: "two" }), makeOpts(2002))
      );
      // Both stream a first event => both cleared the 2-permit semaphore and
      // are running at the same time.
      const firstOfQ1 = await takeEvent(rt, q1);
      const firstOfQ2 = await takeEvent(rt, q2);
      expect(firstOfQ1.kind).toBe("text_message");
      expect(firstOfQ2.kind).toBe("text_message");
      expect(await rt.runPromise(hasRun(makeOpts(2001)))).toBe(true);
      expect(await rt.runPromise(hasRun(makeOpts(2002)))).toBe(true);

      await rt.runPromise(stopRun(makeOpts(2001), "stopped"));
      await rt.runPromise(stopRun(makeOpts(2002), "stopped"));
    } finally {
      await rt.dispose();
    }
  }, 15_000);

  test("(d') a 3rd run past the cap fails AtCapacity, not by killing an active run", async () => {
    const rt = makeRuntime(1);
    try {
      const q1 = await rt.runPromise(
        startRun(makeSpec({ text: "hold" }), makeOpts(3001))
      );
      // Confirm user 3001 owns the single permit before contending for it.
      const held = await takeEvent(rt, q1);
      expect(held.kind).toBe("text_message");

      const q2 = await rt.runPromise(
        startRun(makeSpec({ text: "late" }), makeOpts(3002))
      );
      // 3002 waits the bounded window, never gets a permit, ends AtCapacity.
      const terminal = await takeEvent(rt, q2);
      expect(terminal.kind).toBe("error");
      if (terminal.kind === "error") {
        expect(terminal.class?._tag).toBe("AtCapacity");
        expect(terminal.message).toBe("Busy, try again shortly.");
      }
      // The incumbent run was untouched by the capacity rejection.
      expect(await rt.runPromise(hasRun(makeOpts(3001)))).toBe(true);

      await rt.runPromise(stopRun(makeOpts(3001), "stopped"));
    } finally {
      await rt.dispose();
    }
  }, 15_000);

  test("(e) group runs leave the last slot for the owner", async () => {
    const rt = makeRuntime(2);
    try {
      const q1 = await rt.runPromise(
        startRun(makeSpec({ text: "group" }), groupOpts(4001))
      );
      const first = await takeEvent(rt, q1);
      expect(first.kind).toBe("text_message");

      // A second group run would fit the global cap, but not the smaller pool
      // group runs share: the free permit is the owner's.
      const q2 = await rt.runPromise(
        startRun(makeSpec({ text: "group" }), groupOpts(4002))
      );
      const refused = await takeEvent(rt, q2);
      expect(refused.kind).toBe("error");
      if (refused.kind === "error") {
        expect(refused.class?._tag).toBe("AtCapacity");
      }

      // The owner takes that slot straight away.
      const q3 = await rt.runPromise(
        startRun(makeSpec({ text: "owner" }), makeOpts(4003))
      );
      const ownerEvent = await takeEvent(rt, q3);
      expect(ownerEvent.kind).toBe("text_message");

      await rt.runPromise(stopRun(makeOpts(4001), "stopped"));
      await rt.runPromise(stopRun(makeOpts(4003), "stopped"));
    } finally {
      await rt.dispose();
    }
  }, 15_000);
});

describe("run keys", () => {
  test("a slot per topic, one shared slot outside topics", () => {
    const base = { chatId: -100, userId: 1 };
    expect(runKeyOf({ ...base, threadId: 7 })).not.toBe(
      runKeyOf({ ...base, threadId: 8 })
    );
    expect(runKeyOf({ ...base, threadId: null })).toBe(runKeyOf(base));
    expect(runKeyOf({ ...base, threadId: 7 })).not.toBe(runKeyOf(base));
    expect(runKeyOf({ ...base, userId: 2 })).not.toBe(runKeyOf(base));
    expect(runKeyOf({ ...base, chatId: -200 })).not.toBe(runKeyOf(base));
  });
});

describe("RunRegistry — parallel topics (fake provider)", () => {
  test("two topics of one user run at the same time", async () => {
    const rt = makeRuntime(2);
    const topicA = makeOpts(4001, 11);
    const topicB = makeOpts(4001, 12);
    try {
      const qa = await rt.runPromise(startRun(makeSpec({ text: "a" }), topicA));
      const qb = await rt.runPromise(startRun(makeSpec({ text: "b" }), topicB));
      // Both stream a first event => both hold a permit at the same time, even
      // though they belong to one user.
      const firstOfA = await takeEvent(rt, qa);
      const firstOfB = await takeEvent(rt, qb);
      expect(firstOfA.kind).toBe("text_message");
      expect(firstOfB.kind).toBe("text_message");
      expect(await rt.runPromise(hasRun(topicA))).toBe(true);
      expect(await rt.runPromise(hasRun(topicB))).toBe(true);

      // Stopping one topic leaves the other running.
      expect(await rt.runPromise(stopRun(topicA, "stopped"))).toBe(true);
      const terminal = await takeEvent(rt, qa);
      expect(terminal.kind).toBe("error");
      expect(await rt.runPromise(hasRun(topicB))).toBe(true);

      await rt.runPromise(stopRun(topicB, "stopped"));
    } finally {
      await rt.dispose();
    }
  }, 15_000);

  test("a second run in the same topic still pre-empts the first", async () => {
    const rt = makeRuntime(4);
    const topic = makeOpts(4002, 11);
    try {
      const first = await rt.runPromise(
        startRun(makeSpec({ text: "one" }), topic)
      );
      const started = await takeEvent(rt, first);
      expect(started.kind).toBe("text_message");

      await rt.runPromise(startRun(makeSpec({ text: "two" }), topic));
      // The displaced run ends as an interrupt, not by exit code.
      const terminal = await takeEvent(rt, first);
      expect(terminal.kind).toBe("error");
      if (terminal.kind === "error") {
        expect(terminal.class?._tag).toBe("AgentInterrupted");
      }
      expect(await rt.runPromise(hasRun(topic))).toBe(true);

      await rt.runPromise(stopRun(topic, "stopped"));
    } finally {
      await rt.dispose();
    }
  }, 15_000);

  test("the General topic keeps the chat's single slot", async () => {
    const rt = makeRuntime(4);
    const general = makeOpts(4003);
    const topic = makeOpts(4003, 11);
    try {
      const q = await rt.runPromise(
        startRun(makeSpec({ text: "general" }), general)
      );
      const started = await takeEvent(rt, q);
      expect(started.kind).toBe("text_message");
      expect(await rt.runPromise(hasRun(general))).toBe(true);
      // A topic of the same chat is a different slot, so it reads as idle.
      expect(await rt.runPromise(hasRun(topic))).toBe(false);
      expect(await rt.runPromise(stopRun(topic, "stopped"))).toBe(false);
      expect(await rt.runPromise(hasRun(general))).toBe(true);

      await rt.runPromise(stopRun(general, "stopped"));
    } finally {
      await rt.dispose();
    }
  }, 15_000);
});
