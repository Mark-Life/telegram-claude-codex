import { describe, expect, test } from "bun:test";
import { Exit, Layer, ManagedRuntime, Option, Queue, Redacted } from "effect";
import { AppConfig } from "../config";
import {
  AgentInterrupted,
  AgentTimedOut,
  AtCapacity,
  classifyOutcome,
  ProcessFailed,
  ProviderCrashed,
} from "./errors";
import { hasRun, RunRegistry, startRun, stopRun } from "./run-registry";
import type { AgentEvent, EventQueue, ProviderSpec, RunOptions } from "./types";

/**
 * Builds an isolated RunRegistry runtime backed by a literal AppConfig so tests
 * never touch env, the global runtime, or a real provider CLI. `maxConcurrentRuns`
 * sizes the shared semaphore under test.
 */
const makeRuntime = (maxConcurrentRuns: number) => {
  const cfg = {
    botToken: Redacted.make("x"),
    allowedUserId: 1,
    groqApiKey: Redacted.make("x"),
    projectsDir: "/tmp",
    anthropicApiKey: Option.none(),
    draftIntervalMs: 300,
    splitAt: 4000,
    runTimeoutMs: Option.none(),
    maxConcurrentRuns,
    eventLogPath: ".data/events.jsonl",
  } satisfies typeof AppConfig.Service;
  const layer = RunRegistry.layer.pipe(
    Layer.provide(Layer.succeed(AppConfig, cfg))
  );
  return ManagedRuntime.make(layer);
};

/**
 * Fake provider whose "CLI" is `/bin/sh -c <script>`. The parser turns every
 * non-blank stdout line into a `text_delta`, so a script that `echo`s then
 * `sleep`s proves the run cleared the semaphore and is actively streaming.
 */
const makeSpec = (script: string): ProviderSpec => ({
  id: "claude",
  command: "/bin/sh",
  buildArgs: () => ["-c", script],
  buildEnv: () => ({}),
  createParser: () =>
    function* (lines: string[]) {
      for (const line of lines) {
        if (line.trim()) {
          yield { kind: "text_delta", text: line } satisfies AgentEvent;
        }
      }
    },
});

const makeOpts = (userId: number): RunOptions => ({
  chatId: userId,
  projectDir: process.cwd(),
  prompt: "",
  userId,
});

/** Take one queued event, asserting the producer offered one (not just ended). */
const takeEvent = async (
  rt: ReturnType<typeof makeRuntime>,
  queue: EventQueue
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
    if (await pred()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

describe("classifyOutcome — every AgentError tag (adversarial)", () => {
  test("interrupt maps to interrupted for every reason", () => {
    for (const reason of ["stopped", "switched", "new_prompt"] as const) {
      expect(classifyOutcome(new AgentInterrupted({ reason }))).toEqual({
        outcome: "interrupted",
        copy: "Stopped.",
      });
    }
  });

  test("timeout maps to interrupted", () => {
    expect(classifyOutcome(new AgentTimedOut({}))).toEqual({
      outcome: "interrupted",
      copy: "Timed out.",
    });
  });

  test("at_capacity", () => {
    expect(classifyOutcome(new AtCapacity({}))).toEqual({
      outcome: "at_capacity",
      copy: "Busy, try again shortly.",
    });
  });

  test("process failed: trims stderr, tolerates negative/large codes", () => {
    expect(
      classifyOutcome(new ProcessFailed({ code: 137, stderr: "\n oom \n" }))
    ).toEqual({ outcome: "errored", copy: "oom" });
    // Empty/whitespace stderr falls back to the exit-code sentence.
    expect(
      classifyOutcome(new ProcessFailed({ code: -1, stderr: "" })).copy
    ).toBe("Process failed (exit -1).");
    expect(
      classifyOutcome(new ProcessFailed({ code: 0, stderr: "\t  \n" })).copy
    ).toBe("Process failed (exit 0).");
  });

  test("provider crashed passes message through verbatim (incl. multiline)", () => {
    const message = "spawn ENOENT\n  at Object.<anonymous>";
    expect(classifyOutcome(new ProviderCrashed({ message }))).toEqual({
      outcome: "errored",
      copy: message,
    });
    expect(classifyOutcome(new ProviderCrashed({ message: "" })).copy).toBe("");
  });
});

describe("RunRegistry.stop on unknown user", () => {
  test("returns false when no run is active (backs stopAgent)", async () => {
    const rt = makeRuntime(4);
    try {
      // stopAgent() in agent/index.ts is `runtime.runSync(stopRun(...))`; this
      // exercises the same registry path without the global runtime.
      const stopped = await rt.runPromise(stopRun(424_242, "stopped"));
      expect(stopped).toBe(false);
    } finally {
      await rt.dispose();
    }
  });
});

describe("RunRegistry — subprocess lifecycle (fake sh provider)", () => {
  test("(a) interrupt yields an AgentInterrupted-classified error, not an exit code", async () => {
    const rt = makeRuntime(4);
    try {
      const queue = await rt.runPromise(
        startRun(makeSpec("echo go; sleep 30"), makeOpts(1001))
      );
      // Wait for the stream to actually start (permit acquired, process live).
      expect((await takeEvent(rt, queue)).kind).toBe("text_delta");
      expect(await rt.runPromise(hasRun(1001))).toBe(true);

      const stopped = await rt.runPromise(stopRun(1001, "stopped"));
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

  test("(b) a non-zero exit yields ProcessFailed carrying the code + stderr", async () => {
    const rt = makeRuntime(4);
    try {
      const queue = await rt.runPromise(
        startRun(makeSpec("echo boom 1>&2; exit 7"), makeOpts(1002))
      );
      const terminal = await takeEvent(rt, queue);
      expect(terminal.kind).toBe("error");
      if (terminal.kind === "error") {
        expect(terminal.class?._tag).toBe("ProcessFailed");
        if (terminal.class?._tag === "ProcessFailed") {
          expect(terminal.class.code).toBe(7);
          expect(terminal.class.stderr).toContain("boom");
        }
      }
    } finally {
      await rt.dispose();
    }
  }, 15_000);

  test("(c) hasRun tracks the map lifecycle: false → true → false on natural exit", async () => {
    const rt = makeRuntime(4);
    try {
      expect(await rt.runPromise(hasRun(1003))).toBe(false);
      await rt.runPromise(
        startRun(makeSpec("echo hi; sleep 0.1"), makeOpts(1003))
      );
      expect(await rt.runPromise(hasRun(1003))).toBe(true);
      // Fiber completes on natural exit → FiberMap auto-removes the entry.
      const cleared = await waitUntil(
        async () => !(await rt.runPromise(hasRun(1003)))
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
        startRun(makeSpec("echo one; sleep 30"), makeOpts(2001))
      );
      const q2 = await rt.runPromise(
        startRun(makeSpec("echo two; sleep 30"), makeOpts(2002))
      );
      // Both stream a first event => both cleared the 2-permit semaphore and
      // are running at the same time.
      expect((await takeEvent(rt, q1)).kind).toBe("text_delta");
      expect((await takeEvent(rt, q2)).kind).toBe("text_delta");
      expect(await rt.runPromise(hasRun(2001))).toBe(true);
      expect(await rt.runPromise(hasRun(2002))).toBe(true);

      await rt.runPromise(stopRun(2001, "stopped"));
      await rt.runPromise(stopRun(2002, "stopped"));
    } finally {
      await rt.dispose();
    }
  }, 15_000);

  test("(d') a 3rd run past the cap fails AtCapacity, not by killing an active run", async () => {
    const rt = makeRuntime(1);
    try {
      const q1 = await rt.runPromise(
        startRun(makeSpec("echo hold; sleep 30"), makeOpts(3001))
      );
      // Confirm user 3001 owns the single permit before contending for it.
      expect((await takeEvent(rt, q1)).kind).toBe("text_delta");

      const q2 = await rt.runPromise(
        startRun(makeSpec("echo late; sleep 30"), makeOpts(3002))
      );
      // 3002 waits the bounded window, never gets a permit, ends AtCapacity.
      const terminal = await takeEvent(rt, q2);
      expect(terminal.kind).toBe("error");
      if (terminal.kind === "error") {
        expect(terminal.class?._tag).toBe("AtCapacity");
        expect(terminal.message).toBe("Busy, try again shortly.");
      }
      // The incumbent run was untouched by the capacity rejection.
      expect(await rt.runPromise(hasRun(3001))).toBe(true);

      await rt.runPromise(stopRun(3001, "stopped"));
    } finally {
      await rt.dispose();
    }
  }, 15_000);
});
