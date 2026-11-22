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
import path from "node:path";

import { BunFileSystem } from "@effect/platform-bun";
import { AppConfig } from "@workspace/env/bot";
import {
  Effect,
  Layer,
  Logger,
  ManagedRuntime,
  Option,
  Redacted,
  Schema,
} from "effect";

import { Observability, RUN_EVENT_MARKER, RunEvent } from "./observability";

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "observability-"));
  logPath = path.join(dir, "events.jsonl");
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

/** Isolated Observability runtime writing to `eventLogPath`, real Bun FS, no env. */
const makeRuntime = (eventLogPath: string) => {
  const cfg = {
    allowedUserId: 1,
    api: Option.none(),
    botToken: Redacted.make("x"),
    bwrapBin: Option.none(),
    claudeBin: Option.none(),
    codexBin: Option.none(),
    defaultTz: "Europe/Sofia",
    elevenLabsApiKey: Option.none(),
    eventLogPath,
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
    costUsd: 0.01,
    durationMs: 5000,
    event: RUN_EVENT_MARKER,
    host: "test-host",
    outcome: "done",
    project: "proj",
    promptChars: 42,
    provider: "codex",
    queueDepth: 0,
    runId: "r-1",
    sessionId: "s-1",
    threadId: null,
    totalTokens: 1234,
    ts: "2026-07-08T00:00:00.000Z",
    turns: 2,
    userId: 1,
    version: "0.0.0",
    ...over,
  });

const record = async (rt: ReturnType<typeof makeRuntime>, event: RunEvent) => {
  await rt.runPromise(Effect.flatMap(Observability, (o) => o.recordRun(event)));
};

const decodeRow = Schema.decodeUnknownOption(RunEvent);

/**
 * Reads the ledger back through the same schema that wrote it, so a row that no
 * longer round-trips fails the test instead of silently typing as `any`.
 */
const readRows = (file: string) =>
  readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) =>
      Option.getOrThrowWith(
        decodeRow(JSON.parse(line)),
        () => new Error(`row is not a RunEvent: ${line}`)
      )
    );

describe("Observability.recordRun", () => {
  test("appends exactly one JSON line per call, tagged + populated on done", async () => {
    const rt = makeRuntime(logPath);
    try {
      await record(rt, baseEvent({}));
      const rows = readRows(logPath);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row?.event).toBe(RUN_EVENT_MARKER);
      expect(row?.outcome).toBe("done");
      expect(row?.costUsd).toBe(0.01);
      expect(row?.totalTokens).toBe(1234);
    } finally {
      await rt.dispose();
    }
  });

  test("two calls append two lines (each run is one row)", async () => {
    const rt = makeRuntime(logPath);
    try {
      await record(rt, baseEvent({ runId: "r-1" }));
      await record(rt, baseEvent({ runId: "r-2" }));
      expect(readRows(logPath).map((r) => r.runId)).toEqual(["r-1", "r-2"]);
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
          costUsd: null,
          durationMs: null,
          outcome: "interrupted",
          totalTokens: null,
          turns: null,
        })
      );
      const [row] = readRows(logPath);
      expect(row?.outcome).toBe("interrupted");
      expect(row?.costUsd).toBeNull();
      expect(row?.turns).toBeNull();
      expect(row?.totalTokens).toBeNull();
      expect(row?.durationMs).toBeNull();
    } finally {
      await rt.dispose();
    }
  });

  test("best-effort: a write fault never rejects the chat", async () => {
    // Make logPath a real FILE, then nest the event path under it: makeDirectory
    // and writeFile both fail with ENOTDIR, so only catchCause lets recordRun
    // resolve. Deleting the catchCause guard would make this reject.
    writeFileSync(logPath, "");
    const rt = makeRuntime(path.join(logPath, "nope", "events.jsonl"));
    try {
      // resolves instead of rejecting: only catchCause can get us here
      await record(rt, baseEvent({}));
      // the guard held: logPath is untouched and no directory was created under it
      expect(statSync(logPath).isFile()).toBe(true);
      expect(existsSync(path.join(logPath, "nope"))).toBe(false);
    } finally {
      await rt.dispose();
    }
  });
});
