---
name: observability
description: "Observability for TypeScript services: one wide event per request or job, high-cardinality fields, span and metric design, OTel export, tail sampling. Use when adding or reviewing logging, tracing, telemetry, metrics or OTel wiring, deciding what a request or job should record, or debugging production from what a service already emits. Owns instrumentation decisions — prefer over general TypeScript-quality guidance. Triggers on 'add logging', 'instrument this', 'add tracing', 'wire up OTel', 'I can't tell what happened in prod'."
version: 1.1.0
---

# Observability

**Record what happened to this request, not what the code is doing.** One
canonical record per unit of work, carrying every dimension you would want to
group by later. Run each section's **Check** before calling the instrumentation
done.

## One wide event per unit of work

**A request, job, or run emits exactly one rich record — a wide event, or
canonical log line.** Capture the immutable facts before the work starts,
accumulate the outcome into a mutable record as it runs, emit where every path
converges. In imperative code that is `finally`, over an accumulator declared
beside the frozen context (`telegram-claude`, `src/bot.ts`):

```ts
// Wide-event context captured up front so every return path emits once.
const meta: RunEventMeta = { runId: crypto.randomUUID(), userId, provider,
  project, promptChars: prompt.length, queueDepth: state.queue.length };
const rec: RunRecord = { outcome: "done", costUsd: null, turns: null,
  totalTokens: null, durationMs: null, sessionId: sessionId ?? null };

try {
  /* … the work, folding results into `rec` … */
} catch (e) {
  rec.outcome = "errored";
  rec.errorClass =
    (e as { _tag?: string })?._tag ?? (e as Error)?.name ?? "ProviderCrashed";
  rec.errorMessage = clipError(String((e as Error)?.message ?? e));
} finally {
  await emitRunEvent(rec, meta);
}
```

In Effect, `Effect.onExit` is the equivalent and covers interrupts too, reading
the accumulated Refs so a SIGINT still emits a complete row (`factory`,
`packages/orchestrator/src/orchestrator.ts`, restyled from nested `flatMap`):

```ts
Effect.onExit((exit) =>
  Effect.gen(function* () {
    yield* recordRun({
      ctx,
      result: yield* Ref.get(outcomeRef),
      parked: yield* Ref.get(parkedRef),
      interrupted: Exit.hasInterrupts(exit),
    });
  })
)
```

**Stamp a marker so sinks, tests, and log tooling can select the event** among
everything else the process prints — `event: "factory.run"`,
`event: "telegram.run"` — one exported constant, the single filter key.

**Units longer than a few seconds emit a start row too.** Write one
`phase: "start"` record carrying the ids and the immutable context before the
work begins, and the terminal record on exit with the same `runId`. A start with
no terminus is a `lost` run — that reconciliation turns an OOM kill, a SIGKILL
after the platform's grace period, or an evicted isolate from silence into a
countable outcome, and it is what makes an in-flight run queryable. Under a few
seconds, one row is enough.

**One record per hop, joined by an id you carry yourself.** Where the work
crosses a process or a response boundary — a webhook that acks then finishes in
`waitUntil`, a job handed to a worker — each side emits its own row and both
carry the same `correlationId`, minted at the entry hop and passed in the
payload. The first hop's row is emitted before its response returns. Where the
caller is HTTP, take the id from `traceparent`; where it is a third-party webhook
with no trace context, mint it from a stable field of the payload (Telegram's
`update_id`) so a retry joins the original.

**Check:** grep the module for the emit function — one call site, inside
`finally` / `Effect.onExit`. Walk every `return` and every `throw` in the handler
and confirm each passes through it, and that a run killed with `SIGKILL` mid-work
still leaves a queryable start row.

## Fields carry the payload

**Cardinality — how many distinct values a field takes — is what lets you debug
one user**: `runId`, `userId`, `sessionId`, `repo`, `taskId` answer a support
ticket about one person. **Dimensionality — how many fields the row carries — is
how many questions you can ask without redeploying**; twenty to a hundred is the
target, each field a question you can ask next month against data already stored.

Aim the field list at four groups: **identity** (the high-cardinality ids),
**economics** (`costUsd`, `turns`, `totalTokens`, `durationMs`, `queueDepth`),
**outcome** (a closed literal union plus `errorClass` / `errorMessage`), and
**environment** captured once at startup (`version`, `host`, commit sha,
deployment id). Add whichever feature flag is mid-rollout — that is what makes a
bad release a `GROUP BY` rather than an afternoon.

**Each field names a query.** State the question before adding it — "which media
kind fails", "does cost scale with prompt size", "is this user's failure rate
different".

**Type the event so a bad emit fails in a test** rather than shipping a half-row.
The schema is also the shared field vocabulary the whole service agrees on — one
place that fixes the names and the casing (`telegram-claude`,
`src/observability.ts`):

```ts
export class RunEvent extends Schema.Class<RunEvent>("RunEvent")({
  ts: Schema.String,
  event: Schema.tag(RUN_EVENT_MARKER),
  runId: Schema.String,
  userId: Schema.Number,
  outcome: RunOutcome,
  costUsd: NullableNumber,
  durationMs: NullableNumber,
  // … the rest of identity and economics, the caller's tier, the flags in play
  version: Schema.String,
  host: Schema.String,
}) {}
```

**Report the degraded shape, not a fabricated zero.** An interrupted run did not
cost $0.00 and did not take 0ms — type the economics nullable and null them on
every outcome that did not produce them, because a `0` is a number someone will
later average.

**Content is measured, never carried.** Prompts, transcripts, message bodies and
file contents go on the row as `promptChars`, `transcriptChars`, or a hash.
Personal data stays limited to the stable ids that answer a support ticket
(`userId`, `taskId`) — a name, an email, or a message body on a row you keep for
a year is a deletion request you cannot service.

**Bound the row.** Cap each string field (240 chars is a reasonable default) and
keep the encoded event under ~4 KB: fields are cheap, unbounded values are not. A
subprocess span labelled `command: commandLabel(args)` carries the full argv of a
`git` or `gh` invocation — unbounded, and a credential waiting to be exported.
Label it with the subcommand instead of the command line.

**Metrics are a second, bounded projection of the same event.** Derive counters
and histograms from the identical object at the emit site, keeping unbounded ids
on the event and only low-cardinality tags on the metric, every tag mapped
through a sentinel so an absent value ships as `"none"` (`factory`,
`packages/orchestrator/src/observability.ts`):

```ts
yield* Metric.update(
  Metric.withAttributes(rateLimitTotal, {
    status: event.rateLimitStatus,
    rateLimitType: orNone(event.rateLimitType ?? ""),
    provider,
  }),
  1
);

const orNone = (value: string) => (value.trim().length > 0 ? value : "none");
```

Each metric tag draws from a set you can write down — under ~20 known values —
and the product of the sets stays under a few hundred series per metric. Write
the allowed values as a `const` tuple beside the metric and derive the tag type
from it, so an unlisted value is a type error rather than a new series. Anything
you cannot enumerate (repo, user, task) belongs on the event only:
`factory_runs_total` carries a `repo` tag today, and that is the failure this
rule exists to prevent, not a pattern to copy.

**In-process metrics need a process.** On a long-lived runtime (systemd, a
container) derive them at the emit site as above. On a per-invocation runtime,
skip `Metric` and derive the counters from the stored events at the backend — a
fresh isolate's cumulative series is exported late or never, and cannot be summed
across isolates.

**Check:** name a real query the event answers ("checkout failures for premium
users in the last hour, grouped by error code") and confirm every field it needs
is on the row. Every `Schema.String` on the event is a bounded enum, an id, or
sanitizer-wrapped, and each metric lives in a process that outlives its export
interval.

## Errors are fields, not prose

**Model outcome as a literal union, so every return path maps to exactly one
value** and a group-by over `outcome` is exhaustive by construction
(`telegram-claude`, `src/observability.ts`):

```ts
export const RunOutcome = Schema.Literals([
  "done",
  "errored",
  "interrupted",
  "timeout",
  "already_running",
  "at_capacity",
]);
```

**Every free-text field passes one pure, unit-tested sanitizer before it lands** —
error message, title, label, any string whose value came from a user, a model, or
a subprocess. Collapse whitespace so it stays one field, redact the secret shapes,
cap the length, and apply it in the schema (a transformed `Schema.String`) so a
new field cannot skip it (`telegram-claude`, `src/observability.ts`):

```ts
const SECRET_PATTERNS: readonly RegExp[] = [
  /Bearer\s+[\w.-]+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]+/g,
  /\b\d{6,}:[A-Za-z0-9_-]{20,}/g,
];

export const clipError = (msg: string): string => {
  const collapsed = msg.replace(/\s+/g, " ").trim();
  const redacted = SECRET_PATTERNS.reduce(
    (acc, pattern) => acc.replace(pattern, "[redacted]"),
    collapsed
  );
  return redacted.length > 240 ? redacted.slice(0, 240) : redacted;
};
```

A tagged error's `cause` is raw third-party text: sanitize it at the emit site
rather than annotating a span with it directly.

**Record the classification wherever a failure becomes user-facing copy.** The
tag is in hand exactly at the point it picks the reply, and that is the moment to
put it on the event — otherwise the record stays green while the user watched an
error (`telegram-claude`, `src/bot.ts`):

```ts
rec.outcome = runOutcomeOf(result.errorClass);
if (rec.outcome === "errored") {
  rec.errorClass = result.errorClass._tag;
  rec.errorMessage = clipError(classifyOutcome(result.errorClass).copy);
}
```

The inverse is `telegram-transcriber`, `packages/core/src/handle-media.ts`: the
failure branch holds `e._tag` and `e.reason`, picks `REJECT_COPY[e.reason]`,
replies and returns — and the allow-list reject, the unsupported kind, and the
oversize reject leave no row at all. Silent drops are outcomes too; give each one
a value in the union so a dropped request is distinguishable from no request.

**Check:** every branch producing a non-success reply sets `outcome` and
`errorClass`, every literal in the union is reachable from some branch, and the
sanitizer has a test asserting the secret substring is absent from its output.

## The event and the span are the same record

**Put the event on the span, not only in the log.** The wide event *is* the trace
span: call `Effect.annotateCurrentSpan(toAnnotations(event))` alongside the log
emit and stamp `traceId` / `spanId` onto the event, so the stored row and the
trace join. `Effect.currentSpan` fails with `NoSuchElementError` when no span is
active — and an `onExit` emit often runs after the span closed — so capture the
ids at the top of the unit alongside the immutable context:

```ts
const span = yield* Effect.currentSpan.pipe(
  Effect.orElseSucceed(() => undefined)
);
const ids = { traceId: span?.traceId ?? null, spanId: span?.spanId ?? null };
```

**Name spans on a two-tier convention and keep the name low-cardinality.**
Service methods get `Service.method` — `Effect.fn("LeaseStore.stampRetry")`,
`Effect.fn("NotionTasks.getByStatus")` gives it for free. Infrastructure
wrappers get lowercase `noun.verb`: `git.run`, `transcribe.audio`. Where one
wrapper fronts many operations, put the operation in the name
(`` `notion.${fn.name || "use"}` ``, the `effect-client-wrapper` pattern — guard
with `||`, since an inline arrow's `name` is `""` and `??` will not catch it) and
the identifying id in an attribute. `factory` spends one static `notion.use` span
on every Notion call, which is the failure this rule names.

**Annotate the request scope once, at the top of the unit.** Effect propagates it
through the fiber, so everything below inherits the ids (`factory`,
`packages/orchestrator/src/orchestrator.ts`):

```ts
Effect.annotateLogs({
  taskId: task.id,
  stage: task.status,
  repo: task.repo,
})
```

**Check:** for every span name you added or touched, name what distinguishes two
invocations of it; where nothing does, add an attribute or a more specific name.
And the wide event carries `traceId`, or the span carries the event's fields.

## Emission never masks the work

**Wrap every emit so it swallows its own failures**, construction included.
Observability is a side-channel: a throwing serializer, a full disk, or a metric
error stays invisible to the request it describes. `Effect.ignore` discards a
typed failure only — a throwing serializer or a `Schema.Class` constructor is a
defect and still kills the run — so reach for `Effect.ignoreCause` or
`Effect.catchCause(() => Effect.void)` (`factory`,
`packages/orchestrator/src/observability.ts`, with `ignore` hardened):

```ts
const emit = (event: RunEvent) =>
  Effect.logInfo("run complete").pipe(
    Effect.annotateLogs(toAnnotations(event)),
    Effect.andThen(recordMetrics(event)),
    Effect.ignoreCause
  );
```

Outside Effect that is a bare `try/catch {}` enclosing the event construction.

**The canonical record is not narration and does not answer to `LOG_LEVEL`.** The
`logInfo` above disappears the day an operator quiets the service to `Warn`, and
takes the whole wide event and its OTLP export with it. Emit above the
configurable floor — `logWarning`, or a dedicated logger outside the level gate.

**Give every deliberate swallow a name** — a labelled, greppable helper like
`bestEffort("notion.setLock")(…)` that logs the failure and then ignores it,
keeping the loss visible.

**Check:** the emit path ends in `ignoreCause`, `catchCause`, or a `try/catch {}`
that encloses the event construction — a bare `.ignore` does not count. Every
other swallow in the module is that helper, or carries a comment saying why the
loss is intended.

## Narration stays a line, analytics becomes a field

**Plain log lines earn their place in two roles**: live narration a human watches
under `journalctl -f`, and operator alerts naming a state change someone must act
on — `"lease held by a live run — skipping"`, `"retries exhausted — parked"`.
Anything you would count, average, group by, or chart is a field on the event.

**Configure one logger at startup and import it everywhere** — pretty on a TTY,
structured otherwise (`logfmt` for a journal, JSON for a collector), minimum
level from env. Raw `console.*` fits exactly two places: entrypoint plumbing
outside the runtime where no logger exists yet, and human-facing ops CLIs.

### On the edge

An edge logger touches no Node builtin at module scope. Keep
`process.stdout.isTTY` and `node:os` `hostname()` out of the shared module — pass
the format in, source the environment fields from the platform
(`RAILWAY_GIT_COMMIT_SHA`, `VERCEL_GIT_COMMIT_SHA`, a `version` binding on
Workers), and leave `host` absent where there is no host. Config on Workers comes
from the bindings object, not `process.env`: provide
`ConfigProvider.layer(ConfigProvider.fromUnknown(env))` under the telemetry layer
or every `Config.string` read returns none. `telegram-transcriber`'s worker
composes no logger today for exactly this reason.

**Check:** every deploy target composes a logging layer — including the
serverless and edge ones, which are the easy ones to leave dark — and the edge
bundle imports no `node:*` module; grep its imports to confirm. In the code you
touched, each `console.` is an entrypoint or a CLI, and every field you wanted a
throwaway line for exists on the event.

## OTel is delivery, not observability

**OpenTelemetry standardizes transport and decides nothing about content.**
Flawless OTLP wiring with two span names and no attributes is a service with no
observability — the content is yours to choose.

**Gate the exporter on config and no-op when it is unset**, so dev needs no
collector and an unset endpoint builds no client (`telegram-claude`,
`src/telemetry.ts`):

```ts
const endpoint = yield* Config.option(
  Config.string("OTEL_EXPORTER_OTLP_ENDPOINT")
);
return Option.match(endpoint, {
  onNone: () => Layer.empty,
  onSome: (baseUrl) =>
    Otlp.layerJson({
      baseUrl,
      resource: { serviceName: "telegram-claude" },
    }).pipe(Layer.provide(FetchHttpClient.layer)),
});
```

`Otlp.layerJson` from `effect/observability/Otlp` ships logs, metrics
and traces with no `@opentelemetry/*` dependency on Effect v4. Credentials ride
`OTEL_EXPORTER_OTLP_HEADERS`, parsed splitting on the **first** `=` so a `Bearer`
or base64 value survives, and `OtlpLogger` merges with the loggers present in its
own build scope — so build it over the configured logger,
`telemetryLayer.pipe(Layer.provide(loggerLayer))`.

**On a short-lived runtime, flush is your job.** The exporter buffers on
`exportInterval` and only ships on scope finalization (`OtlpExporter.ts`). A
long-lived process finalizes on shutdown and needs nothing; a per-invocation
runtime does not. Dispose the `ManagedRuntime` inside the platform's
post-response hook — `exec.waitUntil(runtime.runPromise(work).finally(() =>
runtime.dispose()))` on Workers, `await runtime.dispose()` before the handler
returns on Vercel — and set `loggerExportInterval: "0 millis"` with
`maxBatchSize: 1` so the record leaves on the first tick.
`telegram-transcriber`'s Vercel webhook builds its runtime at module scope and
never disposes it: the canonical record for every request dies in the buffer.

**Check:** with the endpoint unset the process makes no network call, and for
each deploy target you can name the line that finalizes the layer scope.

## The record survives the backend

**The durable sink is whatever the platform captures.** On a host you own
(systemd, a container with a mounted volume) that is one JSON line appended per
run — give it a rotation policy the day you create it (`logrotate`, or a size
check in the append path). On a managed platform, stdout *is* the ledger: emit
the structured line and let Railway, Vercel or Workers retain it, rather than
writing to a path a redeploy wipes. The exporter is additive, and every sink
carries the identical annotated record so they never diverge.

**Ship a query path beside the event.** A `scripts/logs.sh` over the JSONL or
`journalctl -o cat` giving `runs | errors | stats | follow`.

**Store where high cardinality is cheap** — columnar stores (ClickHouse,
BigQuery, and the OTLP vendors built on them), not systems built for
low-cardinality string search.

**Check:** name the thing that still holds yesterday's events after a redeploy. A
file path with no volume behind it is not a sink.

## Sample at the tail

**Decide what to keep after the outcome is known.** Sampling up front at 1% —
before the outcome is known — throws away the request that explains the outage;
tail sampling keeps everything interesting and thins only the boring remainder,
which is what makes fifty fields per request affordable at rate.

**A dropped event leaves its weight behind.** Put `sampleRate` on every kept
event and multiply by it when counting, and update metrics *above* the predicate:
the counters describe every unit of work, the stored events a sample of them.
Where spans export too, the drop belongs in the collector's tail-sampling
processor keyed on trace id — a call-site drop leaves the spans orphaned.

Adapted from loggingsucks.com — the shape is the rule, the thresholds are yours:

```ts
const shouldSample = (event: RunEvent) => {
  if (event.outcome !== "done") return true;
  if ((event.durationMs ?? 0) > 2000) return true; // above p99
  if (event.tier === "enterprise") return true; // whoever you cannot lose
  if (event.flags.newCheckoutFlow) return true; // rollout debugging
  return Math.random() < 0.05; // 5% of the rest
};
```

**At single-operator volume, keep everything and say so.** State the volume the
retention assumes — events/day × bytes/event × retention days, against the
backend's per-GB price — in the comment beside the predicate, and treat a 10x
rise in volume as the trigger to turn the predicate on.

**Check:** the sampling predicate takes the finished event as its argument, kept
events carry `sampleRate`, metric updates sit above the predicate, and the
retention plus rotation policy for every local ledger is written down where the
sink is created.

## Test the event, not the plumbing

**Assert the emitted record.** Install a capture logger keyed on the marker and
drive each terminus — success, error, timeout, interrupt — asserting exactly one
captured event apiece (`factory`,
`packages/orchestrator/src/observability.test.ts`):

```ts
const captureLayer = (sink: Record<string, unknown>[]) =>
  Logger.layer([
    Logger.make((opts) => {
      const annotations = opts.fiber.getRef(References.CurrentLogAnnotations);
      if (annotations.event === RUN_EVENT_MARKER) {
        sink.push({ ...annotations });
      }
    }),
  ]);
```

**Pin the metric tag boundary.** Diff `Metric.snapshot` around the work and
assert the exact attribute key set, so an unbounded tag fails CI the day it is
added (`factory`, `packages/orchestrator/src/observability.test.ts`):

```ts
expect(Object.keys(counters.rateLimit?.attributes ?? {}).sort()).toEqual([
  "provider",
  "rateLimitType",
  "status",
]);
```

**Check:** one test per terminus asserting `sink` has length 1, one asserting a
degraded outcome serializes `null` economics, one per metric asserting its
attribute key set, and one that sets `MinimumLogLevel` to `Warn` and still
captures exactly one event.

---

Sources for each principle: [`README.md`](README.md).
