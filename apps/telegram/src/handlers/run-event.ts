import { readFileSync } from "node:fs";
import { hostname } from "node:os";

import { classifyOutcome, runOutcomeOf } from "@workspace/agent";
import type { RunAccess } from "@workspace/agent/types";
import { clipError } from "@workspace/core/errors";
import { Effect, Option, Schema } from "effect";

import { Observability, RUN_EVENT_MARKER, RunEvent } from "../observability";
import type { StreamResult } from "../telegram/format";

const FALLBACK_VERSION = "0.0.0";

/** Only field of the app manifest the ledger needs. */
const decodeManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String }))
);

/** Read package.json once at load to stamp a version onto every wide event. */
const readVersion = () => {
  try {
    const raw = readFileSync(
      new URL("../../package.json", import.meta.url),
      "utf-8"
    );
    return Option.getOrElse(
      Option.map(decodeManifest(raw), (pkg) => pkg.version),
      () => FALLBACK_VERSION
    );
  } catch {
    return FALLBACK_VERSION;
  }
};

/** App version stamped onto every wide event. */
export const APP_VERSION = readVersion();

/** Mutable outcome/economics accumulator for a single prompt run. */
export interface RunRecord {
  costUsd: number | null;
  durationMs: number | null;
  errorClass?: string;
  errorMessage?: string;
  outcome:
    | "done"
    | "errored"
    | "interrupted"
    | "timeout"
    | "already_running"
    | "at_capacity";
  sessionId: string | null;
  /** Messages sent mid-run that the agent took into this run; absent when none. */
  steered?: number;
  totalTokens: number | null;
  turns: number | null;
}

/** Immutable per-run context captured before streaming starts. */
export interface RunEventMeta {
  /** Reasoning effort the run started with; absent on a provider-default run. */
  effort?: string;
  /** Model slug the run started with; absent on a provider-default run. */
  model?: string;
  modelClass: RunAccess["modelClass"];
  project: string;
  promptChars: number;
  provider: string;
  queueDepth: number;
  runId: string;
  threadId: number | null;
  userId: number;
}

/**
 * Fold a completed stream result into the run record: economics are populated
 * only when the provider reported them, and an in-stream error (surfaced on the
 * result rather than thrown) is mapped to its outcome, nulling economics on any
 * degraded (non-errored) outcome.
 */
export const applyResultEconomics = (result: StreamResult, rec: RunRecord) => {
  rec.costUsd = result.cost ?? null;
  rec.turns = result.turns ?? null;
  rec.totalTokens = result.totalTokens ?? null;
  rec.durationMs = result.durationMs ?? null;
  if (!result.errorClass) {
    return;
  }
  rec.outcome = runOutcomeOf(result.errorClass);
  if (rec.outcome === "errored") {
    rec.errorClass = result.errorClass._tag;
    rec.errorMessage = clipError(classifyOutcome(result.errorClass).copy);
  } else {
    rec.costUsd = null;
    rec.turns = null;
    rec.totalTokens = null;
    rec.durationMs = null;
  }
};

/**
 * Record the single wide event for a run. NULLs economics on any non-terminal
 * outcome; a failure of any kind is swallowed so observability can never break
 * a user's chat.
 */
export const recordRunEvent = (rec: RunRecord, meta: RunEventMeta) => {
  if (rec.outcome !== "done" && rec.outcome !== "errored") {
    rec.costUsd = null;
    rec.turns = null;
    rec.totalTokens = null;
    rec.durationMs = null;
  }
  return Effect.gen(function* () {
    // RunEvent construction validates synchronously and can throw; keep it
    // inside the guard so the record is fully best-effort on every path.
    const evt = yield* Effect.sync(
      () =>
        new RunEvent({
          costUsd: rec.costUsd,
          durationMs: rec.durationMs,
          effort: meta.effort,
          errorClass: rec.errorClass,
          errorMessage: rec.errorMessage,
          event: RUN_EVENT_MARKER,
          host: hostname(),
          model: meta.model,
          modelClass: meta.modelClass,
          outcome: rec.outcome,
          project: meta.project,
          promptChars: meta.promptChars,
          provider: meta.provider,
          queueDepth: meta.queueDepth,
          runId: meta.runId,
          sessionId: rec.sessionId,
          steered: rec.steered,
          threadId: meta.threadId,
          totalTokens: rec.totalTokens,
          ts: new Date().toISOString(),
          turns: rec.turns,
          userId: meta.userId,
          version: APP_VERSION,
        })
    );
    const observability = yield* Observability;
    yield* observability.recordRun(evt);
  }).pipe(Effect.catchCause(() => Effect.void));
};
