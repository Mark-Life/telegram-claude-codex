import { dirname } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { AppConfig } from "./config";

/** Marker tag stamped on every wide run event; the sole filter key for `bun run logs`. */
export const RUN_EVENT_MARKER = "telegram.run";

/**
 * Outcome taxonomy for a single prompt run. Superset of the phase-2
 * `classifyOutcome` results plus queue/registry states, so every return path in
 * the bot maps to exactly one literal.
 */
export const RunOutcome = Schema.Literals([
  "done",
  "errored",
  "interrupted",
  "timeout",
  "already_running",
  "at_capacity",
]);

const NullableNumber = Schema.NullOr(Schema.Number);

/**
 * Canonical wide event: exactly one per prompt run. Economics
 * (costUsd/turns/totalTokens/durationMs) are NULL on degraded outcomes
 * (interrupted/timeout/already_running/at_capacity) — never a fabricated 0 — and
 * only populated on done/errored when the provider actually reported them.
 */
export class RunEvent extends Schema.Class<RunEvent>("RunEvent")({
  ts: Schema.String,
  event: Schema.tag(RUN_EVENT_MARKER),
  runId: Schema.String,
  userId: Schema.Number,
  provider: Schema.String,
  project: Schema.String,
  sessionId: Schema.NullOr(Schema.String),
  promptChars: Schema.Number,
  outcome: RunOutcome,
  costUsd: NullableNumber,
  turns: NullableNumber,
  totalTokens: NullableNumber,
  durationMs: NullableNumber,
  queueDepth: Schema.Number,
  errorClass: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
  version: Schema.String,
  host: Schema.String,
}) {}

const encodeRunEvent = Schema.encodeEffect(RunEvent);

/** Secret shapes stripped from any error copy before it reaches the log. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /Bearer\s+[\w.-]+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]+/g,
  /\b\d{6,}:[A-Za-z0-9_-]{20,}/g,
];

/**
 * Sanitizes an error string for durable storage: collapses all whitespace to
 * single spaces, redacts common secret shapes (Bearer/sk-/xox-/bot-token), then
 * caps at 240 chars. Pure and unit-testable; never returns a secret substring.
 */
export const clipError = (msg: string): string => {
  const collapsed = msg.replace(/\s+/g, " ").trim();
  const redacted = SECRET_PATTERNS.reduce(
    (acc, pattern) => acc.replace(pattern, "[redacted]"),
    collapsed
  );
  return redacted.length > 240 ? redacted.slice(0, 240) : redacted;
};

const make = Effect.gen(function* () {
  const config = yield* AppConfig;
  const fs = yield* FileSystem;
  const logDir = dirname(config.eventLogPath);

  const recordRun = (event: RunEvent) =>
    Effect.gen(function* () {
      const encoded = yield* encodeRunEvent(event);
      const line = `${JSON.stringify(encoded)}\n`;
      yield* fs.makeDirectory(logDir, { recursive: true }).pipe(Effect.ignore);
      yield* fs.writeFile(config.eventLogPath, new TextEncoder().encode(line), {
        flag: "a",
      });
      yield* Effect.logInfo("run complete").pipe(
        Effect.annotateLogs({ ...encoded, event: RUN_EVENT_MARKER })
      );
      // catchAllCause (not Effect.ignore) so a defect/interrupt is swallowed
      // too — recordRun is self-safe and can never abort or mask a chat.
    }).pipe(Effect.catchCause(() => Effect.void));

  return { recordRun } as const;
});

/**
 * Observability service: best-effort durable run ledger. `recordRun` appends one
 * JSON line to `eventLogPath` (creating the parent dir on demand) and mirrors the
 * record through the json logger. The whole body is `Effect.ignore`d so a
 * serializer or disk error can never abort or mask a user's chat.
 */
export class Observability extends Context.Service<
  Observability,
  Effect.Success<typeof make>
>()("@telegram-claude/Observability") {
  static readonly layer = Layer.effect(Observability, make);
}
