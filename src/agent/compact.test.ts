import { describe, expect, test } from "bun:test";
import { Exit, Layer, ManagedRuntime, Option, Queue, Redacted } from "effect";
import { AppConfig } from "../config";
import { compactSpec, foldCompactEvents } from "./compact";
import { listProviders } from "./registry";
import { RunRegistry, startRun, stopRun } from "./run-registry";
import type {
  AgentEvent,
  AgentProvider,
  EventQueue,
  RunOptions,
} from "./types";

/** Yield the given events in order, as a provider's compaction would. */
const emitting = (...events: AgentEvent[]) =>
  async function* () {
    for (const event of events) {
      yield event;
    }
  };

describe("foldCompactEvents", () => {
  test("returns the terminal compact_done, token counts intact", async () => {
    const outcome = await foldCompactEvents(
      emitting({ kind: "compact_done", preTokens: 23_871, postTokens: 5393 })()
    );
    expect(outcome).toEqual({
      kind: "compact_done",
      preTokens: 23_871,
      postTokens: 5393,
    });
  });

  test("returns the provider's refusal verbatim", async () => {
    const outcome = await foldCompactEvents(
      emitting({
        kind: "compact_failed",
        reason: "Not enough messages to compact.",
      })()
    );
    expect(outcome).toEqual({
      kind: "compact_failed",
      reason: "Not enough messages to compact.",
    });
  });

  test("a run that only errors fails with the error's copy", async () => {
    const outcome = await foldCompactEvents(
      emitting({ kind: "error", message: "Stopped." })()
    );
    expect(outcome).toEqual({ kind: "compact_failed", reason: "Stopped." });
  });

  test("a stream with no terminal event still yields words", async () => {
    const outcome = await foldCompactEvents(emitting()());
    expect(outcome).toEqual({
      kind: "compact_failed",
      reason: "Compaction ended without a result.",
    });
  });

  test("compaction that ran wins over a later error", async () => {
    const outcome = await foldCompactEvents(
      emitting(
        { kind: "compact_done", preTokens: 10, postTokens: 2 },
        { kind: "error", message: "teardown blew up" }
      )()
    );
    expect(outcome.kind).toBe("compact_done");
  });
});

describe("provider capability flags", () => {
  test("capabilities.compaction is true exactly when compact exists", () => {
    for (const provider of listProviders()) {
      expect([provider.id, provider.capabilities.compaction]).toEqual([
        provider.id,
        Boolean(provider.compact),
      ]);
    }
  });
});

/** Isolated RunRegistry runtime (mirrors run-registry.test.ts). */
const makeRuntime = () => {
  const cfg = {
    botToken: Redacted.make("x"),
    allowedUserId: 1,
    groqApiKey: Redacted.make("x"),
    projectsDir: "/tmp",
    anthropicApiKey: Option.none(),
    executorMcpUrl: Option.none(),
    executorApiKey: Option.none(),
    draftIntervalMs: 300,
    splitAt: 4000,
    runTimeoutMs: Option.none(),
    maxConcurrentRuns: 4,
    eventLogPath: ".data/events.jsonl",
    claudeSettings: {},
  } satisfies typeof AppConfig.Service;
  return ManagedRuntime.make(
    RunRegistry.layer.pipe(Layer.provide(Layer.succeed(AppConfig, cfg)))
  );
};

const makeOpts = (userId: number): RunOptions => ({
  chatId: userId,
  projectDir: "/tmp",
  prompt: "",
  sessionId: "session-1",
  threadId: null,
  userId,
});

/** Drain a run's queue as events (what agent/index.ts does on the global runtime). */
async function* drainQueue(
  rt: ReturnType<typeof makeRuntime>,
  queue: EventQueue
): AsyncGenerator<AgentEvent> {
  while (true) {
    const exit = await rt.runPromiseExit(Queue.take(queue));
    if (Exit.isFailure(exit)) {
      return;
    }
    yield exit.value;
  }
}

/** Poll a predicate until true or timeout (ms). */
const waitUntil = async (pred: () => boolean, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

describe("compaction driven through the run registry", () => {
  test("a provider's compact runs and its outcome comes back", async () => {
    const rt = makeRuntime();
    try {
      const seen: RunOptions[] = [];
      const compact: NonNullable<AgentProvider["compact"]> = async function* (
        opts
      ) {
        seen.push(opts);
        yield* emitting({
          kind: "compact_done",
          preTokens: 100,
          postTokens: 10,
        })();
      };
      const opts = makeOpts(5001);
      const queue = await rt.runPromise(
        startRun(compactSpec("claude", compact), opts)
      );
      const outcome = await foldCompactEvents(drainQueue(rt, queue));
      expect(outcome).toEqual({
        kind: "compact_done",
        preTokens: 100,
        postTokens: 10,
      });
      // The session id reaches the provider — compaction resumes, never restarts.
      expect(seen[0]?.sessionId).toBe("session-1");
    } finally {
      await rt.dispose();
    }
  }, 15_000);

  test("/stop mid-compaction fails with the interrupt copy", async () => {
    const rt = makeRuntime();
    try {
      let started = false;
      const compact: NonNullable<AgentProvider["compact"]> =
        async function* () {
          started = true;
          await new Promise(() => undefined);
        };
      const queue = await rt.runPromise(
        startRun(compactSpec("claude", compact), makeOpts(5002))
      );
      const folded = foldCompactEvents(drainQueue(rt, queue));
      expect(await waitUntil(() => started)).toBe(true);

      expect(await rt.runPromise(stopRun(makeOpts(5002), "stopped"))).toBe(
        true
      );
      expect(await folded).toEqual({
        kind: "compact_failed",
        reason: "Stopped.",
      });
    } finally {
      await rt.dispose();
    }
  }, 15_000);

  test("a provider that throws fails with the crash message", async () => {
    const rt = makeRuntime();
    try {
      const compact: NonNullable<AgentProvider["compact"]> =
        async function* () {
          // Dies before emitting anything.
          yield* emitting()();
          throw new Error("session file vanished");
        };
      const queue = await rt.runPromise(
        startRun(compactSpec("claude", compact), makeOpts(5003))
      );
      expect(await foldCompactEvents(drainQueue(rt, queue))).toEqual({
        kind: "compact_failed",
        reason: "session file vanished",
      });
    } finally {
      await rt.dispose();
    }
  }, 15_000);
});
