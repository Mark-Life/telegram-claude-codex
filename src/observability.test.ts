import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import {
  Effect,
  Layer,
  Logger,
  ManagedRuntime,
  Option,
  Redacted,
} from "effect";
import { AppConfig } from "./config";
import {
  clipError,
  Observability,
  RUN_EVENT_MARKER,
  RunEvent,
} from "./observability";

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "observability-"));
  logPath = join(dir, "events.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Isolated Observability runtime writing to `eventLogPath`, real Bun FS, no env. */
const makeRuntime = (eventLogPath: string) => {
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
    eventLogPath,
    claudeSettings: {},
  } satisfies typeof AppConfig.Service;
  // Logger.layer([]) is exposed in the runtime context (merged, not provided
  // away) so recordRun's run-complete mirror log resolves to no sink and test
  // output stays quiet.
  const layer = Layer.mergeAll(Observability.layer, Logger.layer([])).pipe(
    Layer.provide(
      Layer.mergeAll(Layer.succeed(AppConfig, cfg), BunFileSystem.layer)
    )
  );
  return ManagedRuntime.make(layer);
};

const baseEvent = (over: Partial<ConstructorParameters<typeof RunEvent>[0]>) =>
  new RunEvent({
    ts: "2026-07-08T00:00:00.000Z",
    event: RUN_EVENT_MARKER,
    runId: "r-1",
    userId: 1,
    provider: "claude",
    project: "proj",
    sessionId: "s-1",
    promptChars: 42,
    outcome: "done",
    costUsd: 0.01,
    turns: 2,
    totalTokens: 1234,
    durationMs: 5000,
    queueDepth: 0,
    version: "0.0.0",
    host: "test-host",
    ...over,
  });

const record = async (rt: ReturnType<typeof makeRuntime>, event: RunEvent) =>
  await rt.runPromise(Effect.flatMap(Observability, (o) => o.recordRun(event)));

const readLines = (path: string) =>
  readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));

describe("clipError", () => {
  test("collapses whitespace to single spaces and trims", () => {
    expect(clipError("  a\n\n b\t c  ")).toBe("a b c");
  });

  test("redacts common secret shapes, never returns the secret", () => {
    const redacted = clipError(
      "auth Bearer abc.def-123 key sk-abcd1234EFGH slack xoxb-123-abcDEF tok 123456:AAaaBBbbCCccDDddEEeeFFff00"
    );
    expect(redacted).toContain("[redacted]");
    expect(redacted).not.toContain("abc.def-123");
    expect(redacted).not.toContain("sk-abcd1234EFGH");
    expect(redacted).not.toContain("xoxb-123-abcDEF");
    expect(redacted).not.toContain("123456:AAaaBBbb");
  });

  test("caps at 240 chars", () => {
    expect(clipError("x".repeat(1000)).length).toBe(240);
  });
});

describe("Observability.recordRun", () => {
  test("appends exactly one JSON line per call, tagged + populated on done", async () => {
    const rt = makeRuntime(logPath);
    try {
      await record(rt, baseEvent({}));
      const rows = readLines(logPath);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row.event).toBe(RUN_EVENT_MARKER);
      expect(row.outcome).toBe("done");
      expect(row.costUsd).toBe(0.01);
      expect(row.totalTokens).toBe(1234);
    } finally {
      await rt.dispose();
    }
  });

  test("two calls append two lines (each run is one row)", async () => {
    const rt = makeRuntime(logPath);
    try {
      await record(rt, baseEvent({ runId: "r-1" }));
      await record(rt, baseEvent({ runId: "r-2" }));
      const rows = readLines(logPath);
      expect(rows.map((r) => r.runId)).toEqual(["r-1", "r-2"]);
    } finally {
      await rt.dispose();
    }
  });

  test("degraded outcomes serialize null economics — never a fabricated 0", async () => {
    const rt = makeRuntime(logPath);
    try {
      await record(
        rt,
        baseEvent({
          outcome: "interrupted",
          costUsd: null,
          turns: null,
          totalTokens: null,
          durationMs: null,
        })
      );
      const [row] = readLines(logPath);
      expect(row.outcome).toBe("interrupted");
      expect(row.costUsd).toBeNull();
      expect(row.turns).toBeNull();
      expect(row.totalTokens).toBeNull();
      expect(row.durationMs).toBeNull();
    } finally {
      await rt.dispose();
    }
  });

  test("best-effort: a write fault never rejects the chat", async () => {
    // Make logPath a real FILE, then nest the event path under it: makeDirectory
    // and writeFile both fail with ENOTDIR, so only catchCause lets recordRun
    // resolve. Deleting the catchCause guard would make this reject.
    writeFileSync(logPath, "");
    const rt = makeRuntime(join(logPath, "nope", "events.jsonl"));
    try {
      await expect(record(rt, baseEvent({}))).resolves.toBeUndefined();
      // the guard held: logPath is untouched and no directory was created under it
      expect(statSync(logPath).isFile()).toBe(true);
      expect(existsSync(join(logPath, "nope"))).toBe(false);
    } finally {
      await rt.dispose();
    }
  });
});
