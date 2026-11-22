import path from "node:path";

import { PROVIDER_IDS } from "@workspace/agent/registry";
import { AppConfig } from "@workspace/env/bot";
import { Context, Effect, Layer, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";

/** Marker tag stamped on every wide run event; the sole filter key when querying the ledger. */
export const RUN_EVENT_MARKER = "telegram.run";

/**
 * Outcome taxonomy for a single prompt run. Covers both agent results and
 * queue/registry states, so every return path in the bot maps to exactly one
 * literal.
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
  costUsd: NullableNumber,
  durationMs: NullableNumber,
  /** Reasoning effort the run actually started with; absent on older lines. */
  effort: Schema.optional(Schema.String),
  errorClass: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
  event: Schema.tag(RUN_EVENT_MARKER),
  host: Schema.String,
  /** Model slug the run actually started with; absent on older lines. */
  model: Schema.optional(Schema.String),
  /** Model class the run was granted (`light` or `main`); absent on older lines. */
  modelClass: Schema.optional(Schema.Literals(["light", "main"])),
  outcome: RunOutcome,
  project: Schema.String,
  promptChars: Schema.Number,
  provider: Schema.String,
  queueDepth: Schema.Number,
  runId: Schema.String,
  sessionId: Schema.NullOr(Schema.String),
  /** Messages sent mid-run that the agent took into this run (steering); absent when none. */
  steered: Schema.optional(Schema.Number),
  /** Forum topic the run belonged to; NULL outside a topic. Topics run in parallel. */
  threadId: NullableNumber,
  totalTokens: NullableNumber,
  ts: Schema.String,
  turns: NullableNumber,
  userId: Schema.Number,
  version: Schema.String,
}) {}

/** Marker tag of an access-management event; the audit trail of who let whom in. */
export const USER_EVENT_MARKER = "telegram.user";

/** What was done to a user's access. */
export const UserAction = Schema.Literals(["grant", "revoke", "set_tier"]);

/**
 * One access mutation, written to the same ledger as runs. `addedBy` is the
 * owner (or whoever the owner acted as) and `actor` says whether the change
 * came from the chat commands or the users CLI a codex run drove.
 */
export class UserEvent extends Schema.Class<UserEvent>("UserEvent")({
  action: UserAction,
  actor: Schema.Literals(["cli", "telegram"]),
  addedBy: Schema.Number,
  event: Schema.tag(USER_EVENT_MARKER),
  host: Schema.String,
  targetUserId: Schema.Number,
  tier: Schema.NullOr(Schema.String),
  ts: Schema.String,
  username: Schema.NullOr(Schema.String),
  version: Schema.String,
}) {}

/** Marker tag of a judgment; how a probability threshold is tuned on real traffic. */
export const JUDGE_EVENT_MARKER = "telegram.judge";

/** Which question was asked. One event serves all four. */
export const JudgeKind = Schema.Literals([
  "address",
  "model_route",
  "reminder_intent",
  "task_success",
]);

/**
 * Every number the model router read, kept whole: a threshold is only ever
 * retuned against the raw scores that produced a pick, never against the pick.
 */
const RouteScores = Schema.Struct({
  costOfError: Schema.Number,
  depthConfidence: Schema.Number,
  isSmallTalk: Schema.Number,
  needsCodeChanges: Schema.Number,
  needsHeavyConnector: Schema.Number,
  proseQualityMatters: Schema.Number,
  reasoningDepth: Schema.Number,
  workSize: Schema.Number,
});

/**
 * One judgment: what `kind` asked, and the `decision` code then acted on — the
 * bot spoke, the prompt gained the reminders CLI, the owner got a notice.
 * `probability`, `model` and `inputTokens` are NULL on the provider fallback,
 * which returns a bare yes/no — `via` says which judge answered, `none` when
 * no provider could. `chatKind` is
 * the address surface, NULL elsewhere; `subjectId` is the task id on
 * `task_success`, NULL elsewhere.
 *
 * `model_route` is the one judgment with no yes or no to report: `decision` is
 * NULL there and the answer is the pair `tier`/`pickedEffort`, with every raw
 * `scores` reading that produced it. Those three are NULL on every other kind.
 * With the owner's routing switch off (or a provider that is never routed) it
 * says `via: "default"`: no judgment was asked, `tier` and `scores` are NULL
 * and `pickedEffort` is the provider's default effort.
 */
export class JudgeEvent extends Schema.Class<JudgeEvent>("JudgeEvent")({
  chatKind: Schema.NullOr(Schema.Literals(["business", "group"])),
  decision: Schema.NullOr(Schema.Boolean),
  durationMs: Schema.Number,
  event: Schema.tag(JUDGE_EVENT_MARKER),
  host: Schema.String,
  inputTokens: NullableNumber,
  kind: JudgeKind,
  model: Schema.NullOr(Schema.String),
  /** The routed reasoning effort; NULL on every kind but `model_route`. */
  pickedEffort: Schema.NullOr(Schema.String),
  probability: NullableNumber,
  scores: Schema.NullOr(RouteScores),
  subjectId: NullableNumber,
  /** The routed model tier; NULL on every kind but `model_route`. */
  tier: Schema.NullOr(Schema.String),
  ts: Schema.String,
  userId: Schema.Number,
  version: Schema.String,
  via: Schema.Literals([...PROVIDER_IDS, "default", "none", "typesafe"]),
}) {}

/** Marker tag of an agent turn starting or ending; what a restart waited on. */
export const TURN_EVENT_MARKER = "telegram.turn";

/**
 * One agent process this bot spawned, at its start and again at its end. Every
 * kind is covered — a streamed run, a compaction, a task's format pass and the
 * side turns (address judge, topic title) — so the ledger answers what was
 * running when the bot stopped. `durationMs` and `outcome` are NULL on `start`;
 * `runKey` is the `user:chat:topic` slot, NULL for a turn outside one.
 */
export class TurnEvent extends Schema.Class<TurnEvent>("TurnEvent")({
  durationMs: NullableNumber,
  event: Schema.tag(TURN_EVENT_MARKER),
  host: Schema.String,
  kind: Schema.Literals(["compact", "format", "run", "side_turn"]),
  label: Schema.String,
  outcome: Schema.NullOr(Schema.Literals(["aborted", "done", "failed"])),
  phase: Schema.Literals(["end", "start"]),
  pid: Schema.Number,
  /** Which provider ran it; absent on lines written before it was recorded. */
  provider: Schema.optional(Schema.Literals(PROVIDER_IDS)),
  runKey: Schema.NullOr(Schema.String),
  ts: Schema.String,
  turnId: Schema.String,
  version: Schema.String,
}) {}

/** Marker tag of a call on the owner's own Telegram account. */
export const ACCOUNT_EVENT_MARKER = "telegram.account";

/**
 * How one account call ended. A read is `ok` or `failed`. A write under
 * `confirm` is `pending` when asked for, then `confirmed` (carried out),
 * `rejected`, `expired` or `failed`; under `direct` it is `direct` or
 * `failed`.
 */
export const AccountOutcome = Schema.Literals([
  "ok",
  "pending",
  "direct",
  "confirmed",
  "rejected",
  "expired",
  "failed",
]);

/**
 * One call a run made on the owner's Telegram account, or one step in the
 * life of a write it asked for. Ids only, never message text: the ledger may
 * leave the machine through OTLP. `peerId` is the marked chat id when the call
 * named one, `actionId` the `account_actions` row of a write, `errorReason`
 * the `TelegramAccountError` reason (or `rpc` text) of a failure. `access`
 * is `read`, `local` (a change only the owner sees: read marks, the unread
 * flag, a draft) or `write`.
 */
export class AccountEvent extends Schema.Class<AccountEvent>("AccountEvent")({
  access: Schema.Literals(["read", "local", "write"]),
  actionId: NullableNumber,
  errorReason: Schema.NullOr(Schema.String),
  event: Schema.tag(ACCOUNT_EVENT_MARKER),
  host: Schema.String,
  outcome: AccountOutcome,
  peerId: NullableNumber,
  tool: Schema.String,
  ts: Schema.String,
  version: Schema.String,
}) {}

/** Marker tag of an HTTP API key or request event. */
export const API_EVENT_MARKER = "telegram.api";

/**
 * One API key made or revoked, or one API request that changed something.
 * `actor` is the door it came through, `keyId` the key concerned (the one
 * made or revoked, or the one the request used), `holderId` whose key it is
 * and `byUserId` who acted. `op` is the endpoint's operationId and `status`
 * its HTTP status, or the error `_tag` it failed with; both NULL for key
 * events. Never a body, a token or a secret.
 */
export class ApiEvent extends Schema.Class<ApiEvent>("ApiEvent")({
  action: Schema.Literals(["key_issue", "key_revoke", "request"]),
  actor: Schema.Literals(["api", "cli", "telegram"]),
  byUserId: Schema.Number,
  event: Schema.tag(API_EVENT_MARKER),
  holderId: Schema.Number,
  host: Schema.String,
  keyId: Schema.String,
  op: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.String),
  ts: Schema.String,
  version: Schema.String,
}) {}

const encodeRunEvent = Schema.encodeEffect(RunEvent);
const encodeUserEvent = Schema.encodeEffect(UserEvent);
const encodeJudgeEvent = Schema.encodeEffect(JudgeEvent);
const encodeTurnEvent = Schema.encodeEffect(TurnEvent);
const encodeAccountEvent = Schema.encodeEffect(AccountEvent);
const encodeApiEvent = Schema.encodeEffect(ApiEvent);

/** A record as it is written to the ledger: one encoded event, any kind. */
type LedgerRecord =
  | Effect.Success<ReturnType<typeof encodeRunEvent>>
  | Effect.Success<ReturnType<typeof encodeUserEvent>>
  | Effect.Success<ReturnType<typeof encodeJudgeEvent>>
  | Effect.Success<ReturnType<typeof encodeTurnEvent>>
  | Effect.Success<ReturnType<typeof encodeAccountEvent>>
  | Effect.Success<ReturnType<typeof encodeApiEvent>>;

/**
 * The one place a recording failure dies. Encoding and appending are wrapped
 * together, so a cause is reported once, at warn, with the marker that names
 * what was lost — then swallowed, because the ledger must never abort or mask
 * a user's chat. catchCause (not Effect.ignore) so a defect or an interrupt is
 * covered too; the second catch exists only for a logger that itself fails, and
 * has nothing left to report.
 */
const swallow =
  (marker: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("ledger write failed", cause).pipe(
          Effect.annotateLogs({ event: marker })
        )
      ),
      Effect.catchCause(() => Effect.void)
    );

const make = Effect.gen(function* make() {
  const config = yield* AppConfig;
  const fs = yield* FileSystem;
  const logDir = path.dirname(config.eventLogPath);

  /** Append one already-encoded record and mirror it through the logger. */
  const append = (encoded: LedgerRecord, marker: string, message: string) =>
    Effect.gen(function* () {
      const line = `${JSON.stringify(encoded)}\n`;
      yield* fs.makeDirectory(logDir, { recursive: true }).pipe(Effect.ignore);
      yield* fs.writeFile(config.eventLogPath, new TextEncoder().encode(line), {
        flag: "a",
      });
      yield* Effect.logInfo(message).pipe(
        Effect.annotateLogs({ ...encoded, event: marker })
      );
    });

  const recordRun = Effect.fn("Observability.recordRun")(function* (
    event: RunEvent
  ) {
    const encoded = yield* encodeRunEvent(event);
    yield* append(encoded, RUN_EVENT_MARKER, "run complete");
  }, swallow(RUN_EVENT_MARKER));

  const recordUser = Effect.fn("Observability.recordUser")(function* (
    event: UserEvent
  ) {
    const encoded = yield* encodeUserEvent(event);
    yield* append(encoded, USER_EVENT_MARKER, "access changed");
  }, swallow(USER_EVENT_MARKER));

  const recordJudge = Effect.fn("Observability.recordJudge")(function* (
    event: JudgeEvent
  ) {
    const encoded = yield* encodeJudgeEvent(event);
    yield* append(encoded, JUDGE_EVENT_MARKER, "judgment recorded");
  }, swallow(JUDGE_EVENT_MARKER));

  const recordTurn = Effect.fn("Observability.recordTurn")(function* (
    event: TurnEvent
  ) {
    const encoded = yield* encodeTurnEvent(event);
    yield* append(
      encoded,
      TURN_EVENT_MARKER,
      event.phase === "start" ? "codex turn started" : "codex turn ended"
    );
  }, swallow(TURN_EVENT_MARKER));

  const recordAccount = Effect.fn("Observability.recordAccount")(function* (
    event: AccountEvent
  ) {
    const encoded = yield* encodeAccountEvent(event);
    yield* append(encoded, ACCOUNT_EVENT_MARKER, "account call recorded");
  }, swallow(ACCOUNT_EVENT_MARKER));

  const recordApi = Effect.fn("Observability.recordApi")(function* (
    event: ApiEvent
  ) {
    const encoded = yield* encodeApiEvent(event);
    yield* append(encoded, API_EVENT_MARKER, "api event recorded");
  }, swallow(API_EVENT_MARKER));

  return {
    recordAccount,
    recordApi,
    recordJudge,
    recordRun,
    recordTurn,
    recordUser,
  } as const;
});

/**
 * Observability service: best-effort durable ledger. `recordRun`, `recordUser`,
 * `recordJudge`, `recordTurn`, `recordAccount` and `recordApi` append one JSON line to `eventLogPath`
 * (creating the parent dir on demand) and mirror the record through the logger. A serializer or disk
 * error is logged once at warn and then swallowed, so recording can never abort
 * or mask a user's chat — but a silently missing ledger line is still visible.
 */
export class Observability extends Context.Service<
  Observability,
  Effect.Success<typeof make>
>()("@workspace/Observability") {
  static readonly layer = Layer.effect(Observability, make);
}
