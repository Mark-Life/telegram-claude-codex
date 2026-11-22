import { describe, expect, test } from "bun:test";

import { AppConfig } from "@workspace/env/bot";
import {
  Effect,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
  Stream,
} from "effect";

import { compactSpec, foldCompactEvents } from "./compact";
import { listProviders } from "./registry";
import { RunRegistry, startRun, stopRun } from "./run-registry";
import { OWNER_ACCESS } from "./types";
import type { AgentEvent, AgentProvider, RunOptions } from "./types";

/** Yield the given events in order, as a provider's compaction would. */
const emitting = (...events: AgentEvent[]) =>
  async function* emit() {
    for (const event of events) {
      yield event;
    }
  };

/** Fold a fixed event list, as a finished compaction stream would deliver it. */
const foldOf = async (...events: AgentEvent[]) =>
  await Effect.runPromise(foldCompactEvents(Stream.fromIterable(events)));

describe("foldCompactEvents", () => {
  test("returns the terminal compact_done, session and counts intact", async () => {
    const outcome = await foldOf({
      kind: "compact_done",
      postTokens: 5393,
      preTokens: 23_871,
      sessionId: "session-2",
    });
    expect(outcome).toEqual({
      kind: "compact_done",
      postTokens: 5393,
      preTokens: 23_871,
      sessionId: "session-2",
    });
  });

  test("returns the provider's refusal verbatim", async () => {
    const outcome = await foldOf({
      kind: "compact_failed",
      reason: "The session produced no summary.",
    });
    expect(outcome).toEqual({
      kind: "compact_failed",
      reason: "The session produced no summary.",
    });
  });

  test("a run that only errors fails with the error's copy", async () => {
    const outcome = await foldOf({ kind: "error", message: "Stopped." });
    expect(outcome).toEqual({ kind: "compact_failed", reason: "Stopped." });
  });

  test("a stream with no terminal event still yields words", async () => {
    const outcome = await foldOf();
    expect(outcome).toEqual({
      kind: "compact_failed",
      reason: "Compaction ended without a result.",
    });
  });

  test("compaction that ran wins over a later error", async () => {
    const outcome = await foldOf(
      { kind: "compact_done", sessionId: "session-2" },
      { kind: "error", message: "teardown blew up" }
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
    maxConcurrentRuns: 4,
    piBin: Option.none(),
    projectsDir: "/tmp",
    socatBin: Option.none(),
    telegramAccount: Option.none(),
    typesafeApiKey: Option.none(),
    workDir: Option.none(),
  } satisfies typeof AppConfig.Service;
  return ManagedRuntime.make(
    RunRegistry.layer.pipe(Layer.provide(Layer.succeed(AppConfig, cfg)))
  );
};

const makeOpts = (userId: number): RunOptions => ({
  access: OWNER_ACCESS,
  chatId: userId,
  persona: { callName: "Assistant", gender: "male", ownerName: undefined },
  projectDir: "/tmp",
  prompt: "",
  sessionId: "session-1",
  userId,
});

/** Fold a started run's queue on the test runtime (what compactAgent does). */
const foldRun = async (
  rt: ReturnType<typeof makeRuntime>,
  run: Effect.Success<ReturnType<typeof startRun>>
) => await rt.runPromise(foldCompactEvents(Stream.fromQueue(run.queue)));

/** Poll a predicate until true or timeout (ms). */
const waitUntil = async (pred: () => boolean, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) {
      return true;
    }
    // oxlint-disable-next-line no-await-in-loop -- ditto: wait, then re-poll
    await Bun.sleep(20);
  }
  return false;
};

const TEST_TIMEOUT_MS = 15_000;

describe("compaction driven through the run registry", () => {
  test(
    "a provider's compact runs and its outcome comes back",
    async () => {
      const rt = makeRuntime();
      try {
        const seen: RunOptions[] = [];
        const compact: NonNullable<AgentProvider["compact"]> = async function* (
          opts
        ) {
          seen.push(opts);
          yield* emitting({
            kind: "compact_done",
            postTokens: 10,
            preTokens: 100,
            sessionId: "session-2",
          })();
        };
        const opts = makeOpts(5001);
        const run = await rt.runPromise(
          startRun(compactSpec("codex", compact), opts)
        );
        const outcome = await foldRun(rt, run);
        expect(outcome).toEqual({
          kind: "compact_done",
          postTokens: 10,
          preTokens: 100,
          sessionId: "session-2",
        });
        // The session id reaches the provider — compaction resumes, never restarts.
        expect(seen[0]?.sessionId).toBe("session-1");
      } finally {
        await rt.dispose();
      }
    },
    TEST_TIMEOUT_MS
  );

  test(
    "/stop mid-compaction fails with the interrupt copy",
    async () => {
      const rt = makeRuntime();
      try {
        let started = false;
        const compact: NonNullable<AgentProvider["compact"]> = async function* (
          _opts,
          _ctx,
          signal
        ) {
          started = true;
          yield* emitting()();
          while (!signal.aborted) {
            // oxlint-disable-next-line no-await-in-loop -- hold the run open until /stop
            await Bun.sleep(20);
          }
        };
        const run = await rt.runPromise(
          startRun(compactSpec("codex", compact), makeOpts(5002))
        );
        const folded = foldRun(rt, run);
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
    },
    TEST_TIMEOUT_MS
  );

  test(
    "a provider that throws fails with the crash message",
    async () => {
      const rt = makeRuntime();
      try {
        const compact: NonNullable<AgentProvider["compact"]> =
          async function* () {
            // Dies before emitting anything.
            yield* emitting()();
            throw new Error("session file vanished");
          };
        const run = await rt.runPromise(
          startRun(compactSpec("codex", compact), makeOpts(5003))
        );
        expect(await foldRun(rt, run)).toEqual({
          kind: "compact_failed",
          reason: "session file vanished",
        });
      } finally {
        await rt.dispose();
      }
    },
    TEST_TIMEOUT_MS
  );
});
