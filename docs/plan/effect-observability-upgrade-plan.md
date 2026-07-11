# Telegram-Claude to Factory Architecture: Phased Migration Plan (Effect + SDKs + Wide-Event Observability)

> Target: /Users/andrey-m/Code/personal/telegram-claude — a phased migration inspired by the factory repo, adapted to this single-package Bun bot.

## Decisions locked (2026-07-08)

Three open questions were resolved by the operator before implementation:

1. **Effect adoption depth → Full Effect (as written).** Stand up the Effect v4-beta composition root (ManagedRuntime + `appLayer` of `Context.Service` classes) exactly as phases 1-2 describe. grammy/bot.ts stay Promise-based and bridge into Effect via the ManagedRuntime. The "pattern-only, plain-TS" variant is rejected.
2. **Multi-user → planned.** Do NOT hard-assume a single concurrent run. Generalize Phase 2's liveness/lifecycle to a keyed run-registry now (see the new **Phase 2 addendum: multi-tenant concurrency** below), and adopt factory's `FiberSet` + `Semaphore` machinery so a bounded worker pool and per-user fairness are in place before multi-tenant traffic arrives. This overrides the "single authorized user / do not build FiberSet-Semaphore" carve-out in the Guiding Principles.
3. **SDK history files → verify first, then delete.** Before removing the CLI history readers/parsers in phases 4-5, add an integration check proving `@anthropic-ai/claude-agent-sdk@0.3.173` still writes `~/.claude/projects/**/*.jsonl` and `@openai/codex-sdk@0.139.0` still writes `~/.codex/sessions/**/rollout-*.jsonl` in the shapes claude-history.ts / codex-history.ts expect. Keep the CLI paths until that check is green. (This matches the plan as already written — now a hard gate, not a suggestion.)
4. **Run timeout → removed; opt-in only.** The operator removed the old 10-minute run timeout entirely (`runner.ts` no longer has `DEFAULT_TIMEOUT_MS`; `/stop` is the only cancellation). The plan does NOT reintroduce a default timeout. It keeps the `AgentTimedOut` tagged error + `timeout` outcome as **latent scaffolding** wired behind an opt-in `RUN_TIMEOUT_MS` config that defaults to **unbounded** — so `timedOut` is always false and every cancellation is a pure abort unless someone sets that env. **Caveat (multi-user):** with no cap, one unbounded run holds its global `Semaphore` permit forever (Phase 2 addendum), which can starve other users once `MAX_CONCURRENT_RUNS` is reached. If pool starvation shows up, enable `RUN_TIMEOUT_MS` (or a per-run idle-timeout) rather than a wall-clock cap — decide when multi-user actually ships.

> Note: the `src/agent/runner.ts` line numbers cited throughout phases 1-2 predate the timeout removal and have drifted by a few lines — re-locate by symbol (`proc.exited`, the `finally`, `hasActiveProcess`) rather than trusting the exact line.

## Overview

telegram-claude is a single-user (ALLOWED_USER_ID gates one operator), single-package Bun app: a grammy bot that spawns the `claude`/`codex` CLIs, hand-parses their stdout (stream-json / JSONL) into a normalized `AgentEvent` union in src/agent/runner.ts, and streams that to Telegram via src/telegram.ts. The `AgentEvent` seam (src/agent/types.ts:5-31) is genuinely clean — telegram.ts and bot.ts consume `AsyncGenerator<AgentEvent>` and never touch processes or JSON — so this migration can be surgical rather than a rewrite. The pain lives entirely in the process/plumbing layer: abort/timeout/exit-code classification is inferred from whether a stream reader throws (a race against SIGTERM delivery), so a `/stop` or provider-switch surfaces to the user as `[Error: Process exited with code 143]` (runner.ts:96-103 flows into telegram.ts:345). There is also no SIGKILL escalation (a hung child deadlocks every future run for the user via the pending `done` promise, runner.ts:30/111), unbounded stdout/stderr buffers, a stop/new-prompt liveness race, and zero structured observability (bare console.* plus `.catch(() => {})` throughout), with per-run economics computed in telegram.ts and then discarded.

The end state mirrors factory within a single package (NO monorepo, turbo, catalog, or workspace split): (1) an Effect v4-beta composition root — a `ManagedRuntime` built from an `appLayer` of `Context.Service` classes (Config, Logger, Observability, SessionStore, providers) — bridged into the still-grammy, still-Promise bot so behavior is preserved; (2) tagged errors + Scope/interrupt-based process lifecycle that make `/stop` (and the opt-in timeout) first-class causes rather than exit-code guesses, killing the 143 bug class; (3) one canonical wide `RunEvent` per run appended to `.data/events.jsonl`, queryable by a `bun run logs` script and directly by any LLM agent, zero infra; (4) Claude Agent SDK `query()` and (5) Codex SDK `thread.runStreamed()` replacing the raw spawns behind the unchanged `AgentEvent` seam, both reusing on-disk subscription login with NO API key; (6) hardened provider-namespaced session persistence + typed auth detection; (7) bun:test coverage locking the invariants. Each phase is independently shippable; phases 1-3 deliver most of the reliability/observability value and do NOT depend on the SDK swap.

## Guiding Principles

- Preserve the seams that already work: the `AgentEvent` discriminated union (src/agent/types.ts), the grammy bot, telegram.ts/bot.ts consumers, and the history readers (claude-history.ts/codex-history.ts) stay contract-stable. Only the CLI-string-shaped `ProviderSpec` and the process plumbing in runner.ts are meant to change.
- Keep grammy and the bot handlers Promise/async-based. Effect lives INSIDE the agent + infra layer and is reached through a thin `ManagedRuntime` bridge (runPromise / Stream-to-AsyncIterable). Do NOT rewrite bot.ts into Effect — that is high-risk, high-churn, and buys little for a single-user bot.
- Single-package, but multi-user is on the roadmap (decision 2026-07-08). Do NOT import factory's monorepo machinery (turbo.json, bun `catalog:`, packages/apps split, shared tsconfig package) — those stay out. But DO adopt factory's `FiberSet` worker-pool + `Semaphore` concurrency cap: model runs in a keyed registry (one in-flight run per user, a global bound across users) rather than a single global process. The valuable factory patterns here are Context.Service/Layer, Config service, Scope-based cleanup, interrupt-vs-failure Cause handling, the wide event, and the bounded fiber pool.
- Interruption is not failure. A user `/stop`, a new prompt, a provider switch (or the opt-in `RUN_TIMEOUT_MS`, off by default) must be modeled as a distinct cause (interrupt / timeout), never as a process-failure exit code. This is the root fix for the 143 class and the precondition for honest observability (degraded null economics, not fabricated zeros).
- One wide event per run, best-effort, exactly once. Emit a single validated `RunEvent` JSON line per prompt from ONE finalizer; wrap the append so a serializer/disk error can never crash a chat. Do NOT log every AgentEvent to the file — the wide event replaces the scattered lines; keep verbose per-event logging behind a DEBUG flag.
- Local subscription auth is the default: pass NO apiKey to either SDK and leave ANTHROPIC_API_KEY unset so the bundled binaries reuse ~/.claude and ~/.codex login. API key is strictly an opt-in fallback selected by env presence (Docker/CI).
- Pin Effect and both SDKs to the exact factory versions; import v4 platform/process/observability from `effect/unstable/*` and runtime from `@effect/platform-bun` (v3 paths will not compile). Treat the beta as churn-prone and isolate it behind the layer/service boundary.
- Ship reliability before rewrites. Phases 1-3 (foundation, 143 fix, observability) are low-risk and land most of the user-visible value without touching how agents are invoked; the SDK swaps (4-5) come after, behind the stable seam.

## Phase Overview

| Phase | Goal | Effort | Depends On |
| --- | --- | --- | --- |
| Phase 1 — Effect foundation: runtime, Config service, logger layer (zero behavior change) | Stand up an Effect v4-beta composition root (ManagedRuntime + appLayer) with a single Config service and a format-switching Logger layer, bridged into the existing grammy/Promise code so nothing changes at runtime. | M | — |
| Phase 2 — Tagged errors + graceful exit-143 handling + scoped child-process cleanup | Make interruption, timeout, and genuine process failure distinct typed causes so `/stop`/switch/timeout never surface as `Process exited with code 143`, and guarantee bounded, forced child cleanup so a hung CLI can no longer wedge future runs. | M | Phase 1 |
| Phase 3 — Wide-event observability: RunEvent + .data/events.jsonl + logs script | Emit exactly one canonical `RunEvent` per prompt to a local JSONL file that a human (`bun run logs`) or an LLM agent can query, capturing outcome + economics with honest degraded shapes, replacing the discard-after-footer pattern. | M | Phase 1, Phase 2 |
| Phase 4 — Claude Agent SDK migration behind the AgentEvent seam | Replace the `claude -p --output-format stream-json` spawn and its ~225-line hand-rolled parser with `query()` from @anthropic-ai/claude-agent-sdk, mapping typed SDK messages onto the SAME AgentEvent union so telegram.ts/bot.ts are untouched. | L | Phase 2, Phase 3 |
| Phase 5 — Codex SDK migration (thread.runStreamed) + real token usage | Replace the `codex exec --json` spawn and JSONL parser (codex.ts:8-186) with @openai/codex-sdk's `new Codex()` + `thread.runStreamed()`, mapping typed ThreadEvents to AgentEvent, and use `config.developer_instructions` to retire the prompt-prefix hack. | L | Phase 4 |
| Phase 6 — Session & auth hardening (SessionStore service + typed auth detection) | Harden state/session persistence (atomic unique-tmp writes, fail-open reads, corruption preservation instead of silent wipe) as an Effect SessionStore service, and surface auth mode (subscription vs API key) as a typed startup readout. | M | Phase 4, Phase 5 |
| Phase 7 — Testing, tooling & polish | Lock the new invariants with bun:test (no extra deps), add biome/husky ergonomics, and optionally document the Docker/subscription-auth recipe — without adding monorepo scaffolding. | M | Phase 3, Phase 6 |

## Phase 1 — Effect foundation: runtime, Config service, logger layer (zero behavior change)

### Goal

Stand up an Effect v4-beta composition root — a `ManagedRuntime` built from a single `appLayer` — carrying two services: a `Config` service (`AppConfig`) that replaces every scattered `process.env` read and hard-coded literal, and a format-switching `Logger` layer (the sink Observability annotates in phase 3). Bridge it into the existing grammy/Promise bot so **nothing changes at runtime**: same startup message, same prompt flow, same fail-fast on bad env.

This phase adds infrastructure only. `bot.ts`, `telegram.ts`, and the `agent/` runner keep their current shapes. Effect stays behind four new files (`config.ts`, `logger.ts`, `runtime.ts`, `telegram/bot-service.ts`) and is reached from `index.ts` through one `runtime.runPromise` call at boot. The grammy client is wrapped as a scoped Effect service (the **effect-client-wrapper** pattern) so its lifecycle and outbound API become first-class resources, while the message dispatcher stays imperative.

### Why

Every later phase needs a place to live and be wired:

- Phase 2 (tagged errors + scoped child-process cleanup) needs a `Scope` and a runtime to run scoped effects.
- Phase 3 (wide-event observability) annotates **this** logger layer and reads config tunables.
- Phases 4-6 (SDK providers, `SessionStore`) become `Context.Service` classes merged into **this** `appLayer`.

Establishing the composition root first, with zero behavior change, de-risks the churn-prone beta and lets each later phase add exactly one `Layer`. Config also consolidates today's spread of env reads and magic numbers into one fail-fast, redacted-secret service:

- `BOT_TOKEN` / `ALLOWED_USER_ID` / `GROQ_API_KEY` / `PROJECTS_DIR` — inline in `src/index.ts:28-50` (four separate `process.exit(1)` checks + a `Number.parseInt` NaN guard).
- `MAX_MSG_LENGTH = 4000`, `DRAFT_INTERVAL_MS = 300` — `src/telegram.ts:4,6`.
- (No run timeout — the operator removed the old `DEFAULT_TIMEOUT_MS`; `RUN_TIMEOUT_MS` is an opt-in `Config.option`, default unbounded.)
- `PROJECTS_DIR` default `"/home/agent/projects"` — `src/index.ts:31`.

These become one typed, boot-validated record.

### Changes

1. **Add deps (exact pins, matching factory).** In `package.json` add plain `dependencies` — no catalog, no workspaces:
   ```jsonc
   "effect": "4.0.0-beta.78",
   "@effect/platform-bun": "4.0.0-beta.78"
   ```
   Import core (`Effect, Layer, Config, Logger, References, ManagedRuntime, Redacted, Option`) from `effect`, `Context` from `effect/Context`, and `BunServices` from `@effect/platform-bun`. Do **not** use v3 `@effect/platform-node` paths — they will not compile against the beta.

2. **Create `src/config.ts`** — one `AppConfig` service read once at layer build, dying on invalid values so misconfig fails at boot (parity with `index.ts:33-50`). Shape is inferred from `makeConfig` via `Effect.Success`, never hand-duplicated:
   ```ts
   import { Config, Context, Effect, Layer, Option, Redacted } from "effect";

   const intWithDefault = (name: string, fallback: number) =>
     Config.int(name).pipe(Config.withDefault(fallback));

   const makeConfig = Effect.gen(function* () {
     const botToken = yield* Config.redacted("BOT_TOKEN");
     const groqApiKey = yield* Config.redacted("GROQ_API_KEY");
     const allowedUserId = yield* Config.int("ALLOWED_USER_ID");
     const projectsDir = yield* Config.string("PROJECTS_DIR").pipe(
       Config.withDefault("/home/agent/projects")
     );
     const anthropicApiKey = yield* Config.option(
       Config.redacted("ANTHROPIC_API_KEY")
     ).pipe(Effect.map(Option.filter((k) => Redacted.value(k).length > 0)));

     // Tunables previously hard-coded across the codebase.
     const draftIntervalMs = yield* intWithDefault("DRAFT_INTERVAL_MS", 300);
     const splitAt = yield* intWithDefault("SPLIT_AT", 4000);
     // Run timeout removed by the operator — OFF by default. Option.none = unbounded;
     // set RUN_TIMEOUT_MS to opt back into a cap (see Decisions #4). Consumers treat
     // Option.none as "no timeout" and skip arming the timer entirely.
     const runTimeoutMs = yield* Config.option(Config.int("RUN_TIMEOUT_MS"));

     if (Redacted.value(botToken).length === 0) {
       yield* Effect.die(new Error("BOT_TOKEN must not be empty"));
     }
     if (Number.isNaN(allowedUserId)) {
       yield* Effect.die(new Error("ALLOWED_USER_ID must be a number"));
     }

     return {
       botToken,
       groqApiKey,
       allowedUserId,
       projectsDir,
       anthropicApiKey,
       draftIntervalMs,
       splitAt,
       runTimeoutMs,
     };
   });

   export class AppConfig extends Context.Service<
     AppConfig,
     Effect.Success<typeof makeConfig>
   >()("@tg/AppConfig") {
     static readonly layer = Layer.effect(AppConfig, makeConfig);
   }
   ```
   Secrets are `Config.redacted` so they never print in logs; unwrap with `Redacted.value` only at the grammy/Groq call sites. `Config.int` on `ALLOWED_USER_ID` already fails on a non-numeric value; the explicit `Effect.die` guards preserve the exact boot-failure semantics of `index.ts` for the empty-token / NaN cases.

3. **Create `src/logger.ts`** — a `Layer.unwrap` that reads `LOG_FORMAT` (pretty | logfmt | json; default pretty on a TTY, else logfmt) and `LOG_LEVEL` (default Info) via `Config`, then installs the matching console logger authoritatively. This is the seam Observability (phase 3) annotates with the `RunEvent`:
   ```ts
   import { Config, Effect, Layer, Logger, References } from "effect";

   const formatConfig = Config.literals(["pretty", "logfmt", "json"], "LOG_FORMAT")
     .pipe(Config.withDefault(process.stdout.isTTY ? "pretty" : "logfmt"));
   const levelConfig = Config.logLevel("LOG_LEVEL").pipe(Config.withDefault("Info"));

   const loggerFor = (f: "pretty" | "logfmt" | "json") =>
     f === "pretty"
       ? Logger.consolePretty()
       : f === "json"
         ? Logger.consoleJson
         : Logger.consoleLogFmt;

   export const loggerLayer = Layer.unwrap(
     Effect.gen(function* () {
       const logger = loggerFor(yield* formatConfig);
       return Layer.mergeAll(
         Logger.layer([logger]),
         Layer.succeed(References.MinimumLogLevel, yield* levelConfig)
       );
     })
   );
   ```
   `ManagedRuntime` installs no default logger, so `Logger.layer([...])` is the sole console sink — existing `console.*` calls in `index.ts`/`bot.ts` are left untouched in this phase (migrating them is phase 3 work).

4. **Create `src/runtime.ts`** — assemble the root `appLayer` bottom-up and build a `ManagedRuntime`:
   ```ts
   import { BunServices } from "@effect/platform-bun";
   import { Layer, ManagedRuntime } from "effect";
   import { AppConfig } from "./config";
   import { loggerLayer } from "./logger";

   const appLayer = Layer.mergeAll(BotService.layer).pipe(
     Layer.provideMerge(BotService.layer),
     Layer.provideMerge(AppConfig.layer),
     Layer.provideMerge(BunServices.layer),
     Layer.provideMerge(loggerLayer)
   );

   export const runtime = ManagedRuntime.make(appLayer);
   export const runPromise = runtime.runPromise;
   export const runFork = runtime.runFork;
   ```
   `ManagedRuntime` (not `BunRuntime.runMain`) is deliberate: grammy keeps owning the process loop, so the bridge is a thin `runPromise`. A later phase can flip the entrypoint to `runMain` if we want fiber-level SIGINT handling; not needed here. `BotService` is a **scoped** layer (change 6) — `runtime.dispose()` therefore runs `bot.stop()` deterministically. As services land in later phases they are added to the `mergeAll(...)` / `provideMerge(...)` chain.

5. **Rewire `src/index.ts`** to read config + logger through the runtime once at boot, then hand plain values to `createBot(token, userId, projectsDir)` exactly as today. Force-evaluate `AppConfig` at boot so a config error surfaces synchronously (preserving `index.ts`'s fail-fast), and add `runtime.dispose()` to shutdown alongside the existing `stopAll()` / `bot.stop()`:
   ```ts
   import { Redacted } from "effect";
   import { AppConfig } from "./config";
   import { runtime } from "./runtime";

   const cfg = await runtime.runPromise(AppConfig); // dies here on bad env
   const bot = createBot(
     Redacted.value(cfg.botToken),
     cfg.allowedUserId,
     cfg.projectsDir
   );
   // ...existing SIGTERM/SIGINT handlers...
   const shutdown = () => {
     // ...existing guard + stopAll() + bot.stop()...
     runtime.dispose();
     process.exit(0);
   };
   ```
   `createBot`'s signature (`bot.ts:195-199`) is unchanged; `GROQ_API_KEY` continues to flow to `transcribe.ts` (later phases can read it from `AppConfig` too). Keep `checkCodexAvailable()` and the command registration untouched.

6. **Create `src/telegram/bot-service.ts` — wrap grammy as a scoped Effect service (effect-client-wrapper).** This is the seam that makes the bot lifecycle and every outbound Telegram call first-class in the runtime, without rewriting the dispatcher. Three surfaces, split by fit:
   - **Lifecycle → scoped resource.** `Effect.acquireRelease` starts the bot in the background and releases via `bot.stop()`. Because the layer is `Layer.scoped`, `runtime.dispose()` (change 5) now tears grammy down deterministically — the same finalizer discipline phase 2 uses to kill child processes.
   - **Outbound API → tagged-error Effects.** `send`/`edit` wrap `bot.api.*` in `Effect.tryPromise` mapped to a tagged `TelegramApiError`, so phase 3 can fold Telegram send failures into `RunEvent.outcome` instead of today's silent `.catch(() => {})` in `telegram.ts`.
   - **Inbound handlers → stay imperative.** `bot.on(...)` registration is left in `bot.ts`; each callback body bridges via `runtime.runPromise(...)`. Do not try to make grammy's dispatcher Effect-native (principle #2).

   ```ts
   // src/telegram/bot-service.ts
   import { Bot } from "grammy";
   import { Context, Data, Effect, Layer, Redacted } from "effect";
   import { AppConfig } from "../config";

   export class TelegramApiError extends Data.TaggedError("TelegramApiError")<{
     readonly cause: unknown;
   }> {}

   const makeBot = Effect.gen(function* () {
     const cfg = yield* AppConfig;
     const bot = new Bot(Redacted.value(cfg.botToken));
     // scoped: launch in background on acquire, bot.stop() on release
     yield* Effect.acquireRelease(
       Effect.sync(() => {
         void bot.start();
         return bot;
       }),
       () => Effect.promise(() => bot.stop())
     );
     const send = (chatId: number, text: string, opts?: Parameters<typeof bot.api.sendMessage>[2]) =>
       Effect.tryPromise({
         try: () => bot.api.sendMessage(chatId, text, opts),
         catch: (cause) => new TelegramApiError({ cause }),
       });
     return { bot, api: bot.api, send } as const;
   });

   export class BotService extends Context.Service<
     BotService,
     Effect.Success<typeof makeBot>
   >()("@tg/BotService") {
     static readonly layer = Layer.scoped(BotService, makeBot);
   }
   ```
   Scope in this phase: introduce the service and route **startup/shutdown** through it (replacing the manual `bot.start()`/`bot.stop()` in `index.ts`). The existing `telegram.ts` send/edit calls are migrated onto `BotService.send` incrementally — phase 3 does the bulk when it needs the tagged errors for observability. `createBot` can either receive the `bot` instance from the service or continue constructing handlers as today against `service.bot`; keep the `bot.ts:195-199` handler-registration shape unchanged.

7. **Tighten `tsconfig.json`.** Add `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `moduleDetection: "force"`, `noImplicitOverride`; keep `target/module` ESNext, `moduleResolution: "bundler"`, `noEmit`, and bun types. Fix the resulting type errors (should be few); run `bun run fix` afterward to auto-apply `import type` rewrites.

8. **Add a test script** to `package.json` (`"test": "bun test"`) to prepare for phase 7. No tests yet in this phase.

### Before / After

Env parsing today — four exit points plus a NaN guard, all string-typed:
```ts
// src/index.ts (before)
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error("Missing BOT_TOKEN env var"); process.exit(1); }
// ...ALLOWED_USER_ID, GROQ_API_KEY, PROJECTS_DIR...
const userId = Number.parseInt(ALLOWED_USER_ID, 10);
if (Number.isNaN(userId)) { console.error("..."); process.exit(1); }
```
```ts
// src/index.ts (after) — one boot-validated, redacted, typed record
const cfg = await runtime.runPromise(AppConfig);
const bot = createBot(Redacted.value(cfg.botToken), cfg.allowedUserId, cfg.projectsDir);
```

Tunables move from literals to config-with-defaults (consumers still receive plain numbers, wired in later phases):
```ts
// src/telegram.ts:4,6 (before)      const MAX_MSG_LENGTH = 4000; const DRAFT_INTERVAL_MS = 300;
// (after) AppConfig.splitAt / .draftIntervalMs  (runTimeoutMs is Option, default None = unbounded)
```

### New dependencies

- `effect@4.0.0-beta.78`
- `@effect/platform-bun@4.0.0-beta.78`

Both exact-pinned to the factory version. `grammy` is already a dependency — the `BotService` wrapper adds no new package. All Effect usage is isolated behind `config.ts` / `logger.ts` / `runtime.ts` / `telegram/bot-service.ts`, so a beta bump touches four files.

### Risks & mitigations

- **Beta API churn** — `effect/unstable/*` import paths and `Config`/`Logger` signatures can shift between betas. Mitigate: exact-pin both packages; keep all Effect usage inside the three new files; verify import paths against the installed `node_modules` types, not memory.
- **`verbatimModuleSyntax` forces `import type`** on every type-only import across `src/` — mechanical but wide. Mitigate: run `bun run fix` (ultracite/biome) immediately after enabling it, then `bun run typecheck`.
- **Lazy `ManagedRuntime` could defer a config error** past the point `index.ts` used to fail synchronously. Mitigate: `await runtime.runPromise(AppConfig)` at boot force-evaluates the config layer, preserving fail-fast before `bot.start()`.
- **`noUncheckedIndexedAccess` may surface new `T | undefined` errors** in existing array/record access. Mitigate: expect a handful; fix at the access site (they are latent correctness wins, not this phase's focus).

### Verification

- `bun run typecheck` and `bun run lint` pass.
- `bun run src/index.ts` starts, sends the startup message, and processes a normal prompt end-to-end identically to before (manual smoke).
- Booting with a missing `BOT_TOKEN` or a non-numeric `ALLOWED_USER_ID` exits non-zero at startup (parity with current `index.ts`).
- Secrets never appear in logs: grep the startup output for the token value — it must not be present (`Config.redacted` renders as `<redacted>`).
- `BotService` lifecycle: `runtime.dispose()` on SIGTERM/SIGINT calls `bot.stop()` exactly once (no double-stop, no hang); startup still emits the same startup message. Sending a message via `BotService.send` to an invalid chat surfaces a `TelegramApiError` rather than an unhandled rejection.

### Depends on

Nothing. This is the foundation phase; phases 2-7 build on the `appLayer` / `ManagedRuntime`, the `AppConfig` + `loggerLayer`, and the `BotService` client wrapper established here.

## Phase 2 — Tagged errors + graceful exit-143 handling + scoped child-process cleanup

### Goal

Make interruption and genuine process failure **distinct typed causes** so that `/stop`, provider switch, and a new prompt never surface to the user as `[Error: Process exited with code 143]`. Guarantee **bounded, forced** child-process cleanup so a hung CLI can no longer wedge every future run for that user. (There is no run timeout today — the operator removed it; the `AgentTimedOut` cause below is retained only for the opt-in `RUN_TIMEOUT_MS`, and is dead unless that env is set.) This ships as a small, plain-TS diff on the current `bun spawn` runner — no Effect rewrite required yet — while introducing the typed-error contract that phase 4 (SDK swap) inherits verbatim.

### Why (rationale)

This is the highest-value reliability fix in the migration and it is fully independent of the SDK swap. It targets the exact defects the audit flagged in `src/agent/runner.ts`:

- **143 leak** — an abort sends SIGTERM to the child; the stdout reader usually returns clean EOF (`{done:true}`) rather than throwing, so execution falls through the normal-exit branch (`runner.ts:96-103`), reads `exitCode = 128+15 = 143`, and emits it raw. The friendly "Process was stopped." copy in the catch (`runner.ts:104-107`) is only reached on the racy throw path.
- **Timeout mislabel (latent, opt-in only)** — there is currently no timer, so this can't fire today. If `RUN_TIMEOUT_MS` is enabled, the same clean-EOF path would mislabel a timeout as `143` unless `timedOut` is gated on the normal path (change 3 handles this). Kept as scaffolding, not a live bug.
- **No SIGKILL escalation** — the finally does a single `proc.kill()` (SIGTERM) then an unbounded `await proc.exited` (`runner.ts:108-115`); a child that ignores SIGTERM hangs the finalizer, leaves the per-user `done` promise pending forever, and blocks every subsequent run at `await existing.done` (`runner.ts:30`).
- **Unbounded buffers** — `stderrBuffer` (`runner.ts:61,70`) and the newline-free `buffer` (`runner.ts:77,86-88`) grow without limit.
- **Liveness race** — `hasActiveProcess` reports `false` the instant `signal.aborted` is set (`runner.ts:128-132`), before the child is reaped and the map entry deleted, so a new prompt can slip past the bot gate and then block on the dying process.

Doing this now, still on the CLI spawn, ships user-visible correctness immediately. Phase 4 later deletes most of this plumbing when `spawn` goes away, but keeps the tagged-error union and the `classifyOutcome` mapping.

### Changes

1. **Create `src/agent/errors.ts` — a tagged error union + friendly-copy mapping.** Plain discriminated-union classes (no Effect dependency yet; the shape is Effect-ready so `Data.TaggedError` can be swapped in during phase 1/4 without touching call sites). Every terminal cause is one of these; `classifyOutcome` maps a class to the string the user sees and to the `outcome` label phase 3's `RunEvent` records.

   ```ts
   // src/agent/errors.ts
   export type InterruptReason = "stopped" | "switched" | "new_prompt";

   export class ProcessFailed {
     readonly _tag = "ProcessFailed";
     constructor(readonly code: number, readonly stderr: string) {}
   }
   export class AgentInterrupted {
     readonly _tag = "AgentInterrupted";
     constructor(readonly reason: InterruptReason) {}
   }
   export class AgentTimedOut {
     readonly _tag = "AgentTimedOut";
   }
   export class ProviderCrashed {
     readonly _tag = "ProviderCrashed";
     constructor(readonly message: string) {}
   }

   export type AgentError =
     | ProcessFailed
     | AgentInterrupted
     | AgentTimedOut
     | ProviderCrashed;

   /** Terminal outcome label + user-facing copy for a tagged cause */
   export const classifyOutcome = (e: AgentError) => {
     switch (e._tag) {
       case "AgentInterrupted":
         return { outcome: "interrupted" as const, copy: "Stopped." };
       case "AgentTimedOut":
         return { outcome: "interrupted" as const, copy: "Timed out." };
       case "ProcessFailed":
         return {
           outcome: "errored" as const,
           copy: e.stderr.trim() || `Process failed (exit ${e.code}).`,
         };
       case "ProviderCrashed":
         return { outcome: "errored" as const, copy: e.message };
     }
   };
   ```

2. **Carry the tagged class on the `error` AgentEvent (`src/agent/types.ts:31`).** Add an optional `class` field so `telegram.ts` renders friendly copy and phase 3 observability reads the same taxonomy — without breaking the existing `message`-only shape.

   ```ts
   // src/agent/types.ts — before
   | { kind: "error"; message: string };

   // after
   | { kind: "error"; message: string; class?: import("./errors").AgentError };
   ```

3. **Fix classification in `src/agent/runner.ts` (smallest shippable diff — no Effect rewrite).** Track the interrupt reason on the `ProcessEntry`, gate the exit-code branch on the abort signal *before* it can emit a raw code, and map bare 143/130 to interruption as a fallback. This alone kills the 143 leak. The `timedOut` branch below is only reachable when the opt-in `RUN_TIMEOUT_MS` timer is armed (Decisions #4); with no timeout configured, `timedOut` is a `const false` and the classification is purely abort-driven — keep the branch so enabling the cap later needs no runner change.

   ```ts
   // runner.ts — ProcessEntry gains a reason slot set by stopAgent/switch/new-prompt
   interface ProcessEntry {
     ac: AbortController;
     done: Promise<void>;
     reason?: InterruptReason; // why WE aborted, if we did
   }
   const SIGTERM_EXIT = 143; // 128 + 15
   const SIGINT_EXIT = 130; // 128 + 2

   // replaces runner.ts:96-103 (the normal-exit branch)
   const entry = userProcesses.get(opts.userId);
   const exitCode = await proc.exited;

   if (ac.signal.aborted || timedOut) {
     yield {
       kind: "error",
       message: timedOut ? "Timed out." : "Stopped.",
       class: timedOut
         ? new AgentTimedOut()
         : new AgentInterrupted(entry?.reason ?? "stopped"),
     };
     return;
   }
   if (exitCode === SIGTERM_EXIT || exitCode === SIGINT_EXIT) {
     // fallback: killed without our flag being observed
     yield {
       kind: "error",
       message: "Stopped.",
       class: new AgentInterrupted("stopped"),
     };
     return;
   }
   if (exitCode !== 0) {
     await stderrDrain;
     const err = new ProcessFailed(exitCode, stderrBuffer);
     yield { kind: "error", message: classifyOutcome(err).copy, class: err };
   }
   ```

   The catch block (`runner.ts:104-107`) collapses to a `ProviderCrashed` (a genuine thrown/read error), since interruption and timeout are now handled on the normal path:

   ```ts
   } catch (err) {
     if (ac.signal.aborted || timedOut) return; // interrupt won the race
     const crash = new ProviderCrashed(
       err instanceof Error ? err.message : String(err)
     );
     yield { kind: "error", message: crash.message, class: crash };
   }
   ```

4. **Add SIGKILL escalation in the finally (`runner.ts:108-115`).** Send SIGTERM, then race `proc.exited` against a ~3s grace window and force SIGKILL on expiry so `await proc.exited` / `resolveCleanup()` can never hang. Spawn detached and kill the process group so the CLI's grandchildren (its own spawned tools) are reaped.

   ```ts
   const KILL_GRACE_MS = 3000;

   // replaces the unbounded finally teardown
   } finally {
     clearTimeout(timeout);
     await killBounded(proc, KILL_GRACE_MS);
     await stderrDrain.catch(() => {});
     userProcesses.delete(opts.userId);
     resolveCleanup();
   }

   const killBounded = async (proc: Subprocess, graceMs: number) => {
     try {
       proc.kill(); // SIGTERM to the group (proc spawned detached)
     } catch {
       /* already gone */
     }
     const exited = proc.exited.then(() => "exited" as const);
     const timedOut = new Promise<"grace">((r) => setTimeout(() => r("grace"), graceMs));
     if ((await Promise.race([exited, timedOut])) === "grace") {
       try {
         proc.kill("SIGKILL");
       } catch {
         /* raced to exit */
       }
       await proc.exited;
     }
   };
   ```

   Spawn side (`runner.ts:46-53`) adds process-group isolation so `proc.kill()` reaches grandchildren:

   ```ts
   const proc = spawn({
     cmd: [spec.command, ...args],
     cwd: opts.projectDir,
     stdout: "pipe",
     stderr: "pipe",
     env,
     // detach into its own group; on kill, the whole group (incl. tool subprocesses) dies
   });
   ```

5. **Cap the buffers (`runner.ts:61-71`, `77-94`).** Keep only the trailing ~64KB of stderr as a ring, and cap the newline-free stdout accumulator so a provider emitting one huge line without `\n` can't grow memory unboundedly.

   ```ts
   const STDERR_CAP = 64 * 1024;
   const LINE_CAP = 1 * 1024 * 1024;

   // stderr ring (replaces runner.ts:70)
   stderrBuffer = (stderrBuffer + decoder.decode(value, { stream: true })).slice(-STDERR_CAP);

   // stdout guard (after runner.ts:88 pop)
   if (buffer.length > LINE_CAP) buffer = buffer.slice(-LINE_CAP);
   ```

6. **Make liveness single-source-of-truth (`runner.ts:119-132`).** Have `hasActiveProcess` / `stopAgent` reflect the **map-entry lifecycle** (entry present until `done` resolves) rather than `signal.aborted`. This closes the window where a new prompt sees `false` while the old child is still being reaped. `stopAgent` and the switch/new-prompt callers record the reason.

   ```ts
   // before: liveness inferred from signal.aborted
   export const stopAgent = (userId: number, reason: InterruptReason = "stopped") => {
     const entry = userProcesses.get(userId);
     if (!entry) return false;
     entry.reason = reason;
     entry.ac.abort();
     return true;
   };

   // present-in-map == alive; deleted only after killBounded + resolveCleanup (runner.ts:113)
   export const hasActiveProcess = (userId: number) => userProcesses.has(userId);
   ```

   The already-running guard at the top of `runProvider` (`runner.ts:21-31`) keeps `await existing.done` — but because teardown is now bounded (change 4), that await can no longer block indefinitely.

7. **Make `stopAll` await teardown with a bounded fallback (`runner.ts:134-139`).** On shutdown, abort every entry, then join all `done` promises so no orphaned children survive the process exit.

   ```ts
   export const stopAll = async () => {
     const entries = [...userProcesses.values()];
     for (const e of entries) {
       e.reason = "stopped";
       e.ac.abort();
     }
     await Promise.allSettled(entries.map((e) => e.done));
   };
   ```

   `src/index.ts` awaits `stopAll()` in its shutdown path (it currently calls it fire-and-forget).

8. **Thread the typed error into `src/telegram.ts` (`telegram.ts:341-345`).** Replace the raw `accumulated += [Error: ${event.message}]` splice with `classifyOutcome`-driven copy, so `stopped`/`switched`/`new_prompt` → "Stopped.", timeout → "Timed out.", and only genuine failures show detail.

   ```ts
   // telegram.ts — before
   } else if (event.kind === "error") {
     if (mode !== "text") mode = await switchMode("text");
     accumulated += `\n\n[Error: ${event.message}]`;
   }

   // after
   } else if (event.kind === "error") {
     if (mode !== "text") mode = await switchMode("text");
     const copy = event.class ? classifyOutcome(event.class).copy : event.message;
     accumulated += accumulated ? `\n\n_${copy}_` : copy;
   }
   ```

9. **(Optional, sets up phase 4) Prototype a Scope-based runner.** Behind the same `AsyncGenerator<AgentEvent>` seam, sketch an Effect v4-beta runner using `effect/unstable/process` `ChildProcess.make(cmd, args, { cwd, forceKillAfter })` under `Effect.scoped`, with `/stop` modeled as `Fiber.interrupt` and the timeout as `Effect.timeout`. The scoped handle auto-kills on scope close (`forceKillAfter` is the SIGTERM→SIGKILL grace), and `Cause.hasInterruptsOnly` distinguishes interruption from failure natively — the tagged union above becomes the failure channel. **Do not ship this now**; keep the plain-TS fix as the shipped increment. Land the Effect runner with phase 4 when `spawn` is deleted entirely.

   ```ts
   // sketch only — lands in phase 4
   const run = (opts: RunOptions) =>
     Effect.scoped(
       Effect.gen(function* () {
         const handle = yield* ChildProcess.make(spec.command, args, {
           cwd: opts.projectDir,
           forceKillAfter: Duration.seconds(3),
         });
         // interrupt => Cause.hasInterruptsOnly => AgentInterrupted, never ProcessFailed
       })
     );
   // Opt-in cap only: wrap in Effect.timeoutFail iff AppConfig.runTimeoutMs is Some.
   // Default (None) => no .pipe(timeoutFail) at all, so the run is unbounded and
   // only Fiber.interrupt (/stop) ends it.
   ```

### Files touched

- `src/agent/errors.ts` (new) — tagged error classes + `classifyOutcome`.
- `src/agent/runner.ts` — gated classification, SIGKILL escalation, bounded buffers, map-lifecycle liveness, awaited `stopAll`.
- `src/agent/types.ts` — optional `class` field on the `error` event (`types.ts:31`).
- `src/telegram.ts` — class-to-friendly-copy rendering (`telegram.ts:341-345`).
- `src/index.ts` — `await stopAll()` on shutdown.
- (Callers) `src/bot.ts` — pass the reason to `stopAgent` on switch/new-prompt (`bot.ts:287,416,764,1007`).

### New dependencies

None. Plain TypeScript only. Effect (`effect/unstable/process`) is referenced solely in the optional phase-4 sketch and is not added in this phase.

### Risks & mitigations

- **143/130 → interrupt mapping can mask a child that legitimately exits 143.** Acceptable: the bot always kills via its own `AbortController`, so a real 143 from the child is rare. Mitigation: gate on `ac.signal.aborted || timedOut` as the **primary** signal (change 3) and treat bare 143/130 only as a **fallback** when our flag wasn't observed.
- **Process-group kill semantics differ across platforms** (macOS dev vs Linux/Docker prod). Detached-group spawn + group kill behaves differently on Darwin vs Linux. Mitigation: verify on both; the bounded SIGKILL fallback (change 4) guarantees termination even if group signaling is partial.
- **Changing `hasActiveProcess` semantics may interact with the plan-mode `stopAgent` + immediate continue** in `bot.ts:1006-1008`. Mitigation: verify the plan flow still proceeds — the plan-interrupt path aborts then immediately runs a new prompt; with map-lifecycle liveness the new run now correctly waits on bounded teardown instead of racing a stale `signal.aborted === false`.

### Verification

1. Start a long run, `/stop` → user sees **"Stopped."**, not `Process exited with code 143`. Confirm no orphaned `claude`/`codex` process (`pgrep -f claude`, `pgrep -f codex` return nothing).
2. Trigger a **provider switch mid-run** and a **new-prompt-during-run** → both classified as interruption ("Stopped."), and the subsequent run starts without hanging.
3. (Opt-in path) Set `RUN_TIMEOUT_MS=2000` and run a long prompt → user sees **"Timed out."** With `RUN_TIMEOUT_MS` unset (default), a long run never auto-cancels — only `/stop` ends it.
4. Simulate a SIGTERM-ignoring child (a shell that `trap`s SIGTERM and `sleep`s) → SIGKILL fires within the ~3s grace window and the next run proceeds.
5. Unit-test `classifyOutcome`: each tag maps to the expected `{ outcome, copy }` (a quick `bun:test` harness now, or folded into the phase-7 suite). Assert `AgentInterrupted`/`AgentTimedOut` → `outcome: "interrupted"` and `ProcessFailed`/`ProviderCrashed` → `outcome: "errored"`.

### Depends on

- **phase-1** (Effect foundation) — for the tagged-error shape to align with `Data.TaggedError`/`Config` conventions and for the optional Scope-runner sketch to compile against the pinned `effect` version. The plain-TS increment (changes 1-8) can land even if phase-1 is only partially in place; it introduces no `effect` import.

### Phase 2 addendum — multi-tenant concurrency (locked 2026-07-08)

Multi-user is now on the roadmap, so the current single-global-process model in `runner.ts` (one `activeProcess` per `userId`, aborted on any new prompt) is generalized to a keyed run-registry with a bounded pool instead of being left as-is. This lands in this phase because it shares the same lifecycle/interrupt machinery as the 143 fix — building both at once avoids reworking `stopAgent`/`hasActiveProcess` twice.

1. **Run registry as an Effect service (`src/agent/run-registry.ts`).** Replace the module-level `activeProcess` map with a `RunRegistry` `Context.Service` holding a `Map<userId, Fiber>` plus a `FiberSet` (factory: `packages/orchestrator` fiber-set pattern) that owns every in-flight run. `stopAgent(userId, reason)` interrupts that user's fiber with the tagged `AgentInterrupted(reason)` cause; `hasActiveProcess(userId)` checks registry membership, not `signal.aborted`. Teardown is a Scope finalizer, so registry eviction and child SIGKILL are the same release action — no stale entries.

2. **Two-level bound via `Semaphore`.** Per-user: at most one in-flight run (a new prompt still interrupts the prior one — unchanged UX). Global: a `Config`-driven `MAX_CONCURRENT_RUNS` (`Semaphore.make(n)`, default e.g. 4) caps total concurrent CLI/SDK subprocesses so N users can't fork-bomb the host. A run acquires the global permit inside its scope and releases it on the same finalizer.

3. **Fairness / queueing decision.** When the global permit is exhausted, a new run either (a) queues (await the semaphore) or (b) rejects with a typed `AtCapacity` error surfaced as a friendly "Busy, try again shortly." — pick per operator preference; the registry emits a wide event either way (ties into Phase 3 queue-contention visibility, Open Question 7). Default: short bounded wait, then `AtCapacity`.

4. **Wide-event + observability hooks.** Each run fiber carries the `userId` as a log annotation (factory `Effect.annotateLogs`), so `.data/events.jsonl` (Phase 3) is filterable per user and the `logs` script can group by operator. `already_running` / `at_capacity` become explicit `RunEvent` outcomes rather than silent drops.

This supersedes changes that assumed a single global process: `stopAll()` becomes "interrupt the whole `FiberSet`", and the map-lifecycle liveness fix (change re: `hasActiveProcess`) is realized by registry membership rather than an ad-hoc boolean. New dep footprint is still zero beyond `effect` itself (`FiberSet`, `Semaphore`, `Scope` are in the pinned `effect` package). Verification adds: two users run concurrently without interfering; a third user past `MAX_CONCURRENT_RUNS` queues-or-`AtCapacity`; interrupting user A does not touch user B's fiber.

## Phase 3 — Wide-event observability: RunEvent + .data/events.jsonl + logs script

### Goal

Emit exactly one canonical `RunEvent` per prompt run to a local JSONL file (`.data/events.jsonl`) that a human (`bun run logs`) or an LLM agent (plain `cat`) can query — capturing outcome plus economics with honest degraded shapes (null, never a fabricated `0`), replacing the current discard-after-footer pattern. This is the direct answer to "observability that saves things to a local file any LLM agent can query," with zero infra and no per-event log spam.

### Why (rationale)

`runAndDrain` (`src/bot.ts:962-1036`) is the richest point in the system: it already knows `provider`, `project`, `branch`, `sessionId`, prompt, and `queueDepth`, and it receives a fully-formed `StreamResult` (cost, `durationMs`, `turns`) back from `streamToTelegram` — yet it records **nothing**. Success only feeds `updateSession` + a Telegram footer; the failure path is a bare `console.error("runAndDrain error:", e)` (`src/bot.ts:1011-1013`). No run counters, no latency, no cost ledger, no error taxonomy.

A single wide event per run closes nearly every observability gap at once (loggingsucks.com model). It replaces N scattered log lines with one queryable row, and it is the natural home for the classified outcome from phase 2: a `/stop`, a provider switch, or a timeout must be recorded as `interrupted`/`timeout` with **null** economics, not a `0`-cost success. Phase 1 gives us the `Logger`/`Config` seam; phase 2 gives us the typed cause to classify. This phase turns that into a durable artifact.

Constraint from the plan: telegram-claude is grammy + plain-async-generator Bun/TS. Effect lives only inside the agent/infra layer behind the `ManagedRuntime` bridge from phase 1. `Observability` is an Effect `Context.Service`, but its callers in `bot.ts` reach it through a thin `runtime.runPromise(...)` wrapper — we do **not** rewrite `runAndDrain` into Effect.

### Changes

1. **Add `totalTokens` to the `result` AgentEvent** (`src/agent/types.ts:23-30`) and thread it through. Today the `result` event carries only `cost`/`durationMs`/`turns`; provider token totals are dropped at normalization. Claude already sums usage (`src/agent/claude.ts` forwards `totalTokens` into `agent_done` only — reuse the same sum for `result`), Codex usage arrives on `turn.completed`. `telegram.ts` copies it into `StreamResult` (alongside the existing `result.cost` assignment at `src/telegram.ts:330-334`), and `bot.ts` reads it for the event. Field is optional/nullable so absence degrades to `null`, never `0`.

    ```ts
    // src/agent/types.ts
    | {
        kind: "result";
        text: string;
        sessionId: string;
        cost: number;
        durationMs: number;
        turns: number;
        totalTokens?: number; // NEW — summed provider usage; undefined when absent
      }
    ```

2. **Create `src/observability.ts`** exposing `Observability` as a `Context.Service` with a single method `recordRun(event: RunEvent): Effect<void>`. Define `RunEvent` as a `Schema.Class` so a malformed emit fails in tests, not prod. Fields are exactly what the app already has:

    ```ts
    import { Effect, Layer, Schema } from "effect";
    import { Context } from "effect/Context";

    export const RUN_EVENT_MARKER = "telegram.run";

    export const RunOutcome = Schema.Literals([
      "done",
      "errored",
      "interrupted",
      "timeout",
      "already_running",
    ]);

    const NullableNumber = Schema.NullOr(Schema.Number);

    export class RunEvent extends Schema.Class<RunEvent>("RunEvent")({
      ts: Schema.String, // ISO-8601
      event: Schema.tag(RUN_EVENT_MARKER), // literal "telegram.run"
      runId: Schema.String,
      userId: Schema.Number,
      provider: Schema.String, // activeProvider
      project: Schema.String, // basename or "general"
      sessionId: Schema.NullOr(Schema.String),
      promptChars: Schema.Number,
      outcome: RunOutcome,
      costUsd: NullableNumber, // null on interrupt/timeout/already_running
      turns: NullableNumber,
      totalTokens: NullableNumber,
      durationMs: NullableNumber,
      queueDepth: Schema.Number,
      errorClass: Schema.optional(Schema.String), // from phase-2 tagged error
      errorMessage: Schema.optional(Schema.String), // clipped 240 chars, single-line, no secrets
      version: Schema.String,
      host: Schema.String,
    }) {}
    ```

    Economics (`costUsd`/`turns`/`totalTokens`/`durationMs`) are **NULL** on `interrupted`/`timeout`/`already_running` — mirroring factory's degraded shape — and only populated on `done`/`errored` when the SDK actually reported them.

3. **`recordRun` appends one JSON line to `.data/events.jsonl`** using Bun `appendFile`, wrapped so a serializer/disk error can never crash a chat (best-effort — observability must never break a user's run). The path comes from the phase-1 `Config` service (`eventLogPath`, default `.data/events.jsonl`, overridable via `TG_LOG_FILE`). Optionally also fire `Effect.logInfo` annotated `{ event: "telegram.run" }` so the phase-1 json logger carries the same record when `LOG_FORMAT=json`.

    ```ts
    const makeObservability = Effect.gen(function* () {
      const config = yield* AppConfig;
      const fs = yield* FileSystem.FileSystem;

      const recordRun = (event: RunEvent) =>
        Effect.gen(function* () {
          const line = `${JSON.stringify(event)}\n`;
          yield* fs.writeFile(config.eventLogPath, new TextEncoder().encode(line), {
            flag: "a",
          });
        }).pipe(
          Effect.andThen(
            Effect.logInfo("run complete").pipe(
              Effect.annotateLogs({ event: RUN_EVENT_MARKER, ...event })
            )
          ),
          Effect.ignore // best-effort: never abort/mask the chat
        );

      return { recordRun };
    });

    export class Observability extends Context.Service<
      Observability,
      Effect.Success<typeof makeObservability>
    >()("@telegram-claude/Observability") {
      static readonly layer = Layer.effect(Observability, makeObservability);
    }
    ```

    `.data/` is created at boot (it already holds `state.json`); `recordRun` assumes the dir exists and `Effect.ignore` covers the ENOENT edge on a fresh checkout.

4. **Emit from ONE site.** Wrap the per-run body of `runAndDrain` (`src/bot.ts:983-1013`) with a finalizer that fires **exactly once** — `outcome=done` on normal return, `errored` in the catch (`src/bot.ts:1011`), and `interrupted`/`timeout` derived from the typed error/class introduced in phase 2. Compute `runId` at run start (`crypto.randomUUID()`); read `queueDepth` from `state.queue.length` before draining. Because `runAndDrain` stays Promise-based, use a plain `try/catch/finally` with a single `emitted` guard, and bridge the `recordRun` Effect through the phase-1 runtime.

    ```ts
    // src/bot.ts — inside runAndDrain, per run iteration
    const runId = crypto.randomUUID();
    const queueDepth = state.queue.length;
    let outcome: RunOutcome = "done";
    let economics: { costUsd: number | null; turns: number | null;
      totalTokens: number | null; durationMs: number | null } = {
      costUsd: null, turns: null, totalTokens: null, durationMs: null,
    };
    let errorClass: string | undefined;
    let errorMessage: string | undefined;

    try {
      const result = await streamToTelegram(/* ... */);
      economics = {
        costUsd: result.cost ?? null,
        turns: result.turns ?? null,
        totalTokens: result.totalTokens ?? null,
        durationMs: result.durationMs ?? null,
      };
      // ...existing updateSession / plan handling...
    } catch (e) {
      const classified = classifyRunError(e); // phase-2: { class, message } | interrupt | timeout
      outcome = classified.outcome; // "interrupted" | "timeout" | "errored"
      if (outcome === "errored") {
        errorClass = classified.class;
        errorMessage = clipError(classified.message);
      }
      // interrupt/timeout keep economics = all-null (degraded, never 0)
      if (outcome === "errored") console.error("runAndDrain error:", e);
    } finally {
      const nonEconomic = outcome !== "done" && outcome !== "errored";
      await runtime.runPromise(
        Effect.flatMap(Observability, (o) =>
          o.recordRun(
            new RunEvent({
              ts: new Date().toISOString(),
              event: RUN_EVENT_MARKER,
              runId,
              userId,
              provider: state.activeProvider,
              project: projectName,
              sessionId: sessionId ?? null,
              promptChars: currentPrompt.length,
              outcome,
              costUsd: nonEconomic ? null : economics.costUsd,
              turns: nonEconomic ? null : economics.turns,
              totalTokens: nonEconomic ? null : economics.totalTokens,
              durationMs: nonEconomic ? null : economics.durationMs,
              queueDepth,
              errorClass,
              errorMessage,
              version: VERSION,
              host: hostname(),
            })
          )
        )
      );
    }
    ```

    `clipError` strips newlines, redacts obvious token patterns, and truncates to 240 chars (see Risks). `VERSION` comes from `package.json` (read once at boot); `hostname()` from `node:os`.

5. **Create `scripts/logs-format.ts`** — a ~150-line Bun/`node:readline` parser (no `jq`) ported from factory's `logs-format.ts`. Modes:
   - `runs` — aligned table: `time / outcome / cost / dur / turns / tokens / project`.
   - `errors` — only rows where `outcome === "errored"` (show `errorClass` + clipped `errorMessage`).
   - `stats` — counts by outcome + total cost + total wall time.
   - `follow` — live tail.

   It filters each line to `event === "telegram.run"`, uses width-1 ASCII markers (`+` done, `x` errored, `#` timeout, `~` interrupted, `-` already_running) for column alignment (emoji render double-width and break tables), and handles `EPIPE` so `... | head` doesn't throw. Source file is read from `TG_LOG_FILE` (default `.data/events.jsonl`).

    ```ts
    // scripts/logs-format.ts (shape)
    const MARK: Record<string, string> = {
      done: "+", errored: "x", timeout: "#", interrupted: "~", already_running: "-",
    };
    const parse = (line: string) => {
      try {
        const j = JSON.parse(line.trim());
        return j?.event === "telegram.run" ? j : null;
      } catch {
        return null;
      }
    };
    process.stdout.on("error", (e) => {
      if ((e as NodeJS.ErrnoException).code === "EPIPE") process.exit(0);
    });
    ```

6. **Add `scripts/logs.sh`** (thin wrapper) and npm scripts. `logs.sh` is just `cat "${TG_LOG_FILE:-.data/events.jsonl}" | bun scripts/logs-format.ts "$@"`. `package.json`:

    ```jsonc
    "scripts": {
      "logs": "bash scripts/logs.sh runs",
      "logs:errors": "bash scripts/logs.sh errors",
      "logs:stats": "bash scripts/logs.sh stats",
      "logs:follow": "bash scripts/logs.sh follow"
    }
    ```

7. **Add a `bestEffort(label)` helper and apply it to the highest-signal `.catch(() => {})` send/edit sites.** Replace the empty catches in `src/telegram.ts:47-66` (`safeSendRichDraft`/`safeSendRichMessage`) and the send/edit paths around `src/telegram.ts:225-297`, plus the `bot.ts` send catches, with a helper that debug-logs the failure class via the phase-1 logger before swallowing — preserving non-throwing behavior while making Telegram send failures observable.

    ```ts
    // debug-log then swallow; never throws
    const bestEffort =
      (label: string) =>
      <T>(p: Promise<T>): Promise<T | undefined> =>
        p.catch((e) => {
          void runtime.runPromise(
            Effect.logDebug(`${label} failed`).pipe(
              Effect.annotateLogs({ label, errorClass: (e as Error)?.name ?? "unknown" })
            )
          );
          return undefined;
        });
    ```

    Do **NOT** convert every `.catch(() => {})` — target only the send/edit paths (the ones that indicate a Telegram outage or rate-limit). Fire-and-forget UI cleanups can stay silent.

8. **Make the streaming draft loop a scoped resource, and route its sends through `BotService`.** `streamToTelegram` runs a `DRAFT_INTERVAL_MS` (300ms) `setInterval` edit loop per run (`src/telegram.ts:4,6`). Today, if the run throws or is interrupted before the loop's `clearInterval`, the timer can outlive the run — a leak that compounds under the multi-user pool (Phase 2 addendum). Wrap the loop as `Effect.acquireRelease(start, () => clearInterval)` (or, since `streamToTelegram` stays Promise-based, a `try/finally` that `clearInterval`s on every exit path including interrupt), and migrate its `sendMessage`/`editMessageText` calls onto `BotService.send` so send failures become the tagged `TelegramApiError` that change 4's `RunEvent` records. This closes the last per-run timer leak and completes the `BotService` adoption started in phase 1.

### Before / After

Before — the run outcome is computed then discarded:

```ts
// src/bot.ts:991-1013 (today)
const result = await streamToTelegram(/* ... */);
if (result.sessionId) updateSession(/* ... */);
if (result.planPath && caps.planMode) { /* ... */ }
} catch (e) {
  console.error("runAndDrain error:", e); // vanishes
}
```

After — one wide row per run, honest economics, single emit site (see change 4). Success, `/stop`, provider switch, timeout, and crash each produce exactly one `.data/events.jsonl` line; interrupted/timeout rows carry `null` cost/turns/tokens.

### New dependencies

None. `.jsonl` append is Bun/Effect `FileSystem`; the parser is Bun + `node:readline`; `Observability` reuses the phase-1 `effect` + `@effect/platform-bun` install. `hostname` from `node:os`, `randomUUID` from `node:crypto` — both built-in.

### Risks & mitigations

- **Double-emit (finalizer + catch both fire).** Use a single `finally` block reading one `outcome` variable set by the `try`/`catch` — the emit happens once per loop iteration in `finally` only, mirroring factory's onExit-exactly-once. A capture-sink unit test (phase 7) asserts exactly one row per run.
- **`already_running` guard returns before a run starts** (`src/agent/runner.ts:22-28`). Decision: **yes, emit** — `outcome="already_running"`, all economics null — so queue-contention is visible in `logs:stats`. The emit for this path lives at the `runProvider` early-return, surfaced back to `runAndDrain` (or emitted directly there when `hasActiveProcess` short-circuits at `src/bot.ts:953`).
- **Clipping `errorMessage` must strip secrets and newlines before write.** `clipError` collapses whitespace to single spaces, applies a redaction pass (bearer tokens, `sk-`/`xox`-prefixed keys, `BOT_TOKEN`-shaped strings), then truncates to 240 chars. Tested with a secret-bearing input in phase 7.
- **Observability throwing breaks a chat.** `recordRun` is wrapped in `Effect.ignore`; the `runtime.runPromise` in `finally` is itself best-effort (a rejected promise there is caught, not propagated). A disk-full or serializer bug degrades to a missing row, never a failed run.

### Verification

- Run several prompts — a success, a `/stop`, and an induced error — then confirm `.data/events.jsonl` has exactly one line each with the correct `outcome`; the interrupted/timeout rows have `null` `costUsd`/`turns`/`totalTokens`.
- `bun run logs`, `bun run logs:errors`, `bun run logs:stats` render aligned tables; `bun run logs:follow` tails live as new prompts complete.
- `cat .data/events.jsonl | head` works without an `EPIPE` throw.
- A capture-sink unit test (phase 7) asserts exactly-once emission, null-on-interrupt economics, and a clipped single-line `errorMessage` with no secret substring.

### Depends on

- **phase-1** — the `ManagedRuntime` bridge, `Config` service (`eventLogPath`/`TG_LOG_FILE`, `VERSION`), and the format-switching `Logger` layer that `bestEffort` and the optional annotated `logInfo` use.
- **phase-2** — the typed error/cause (`classifyRunError` → `interrupted`/`timeout`/`errored`) that lets the finalizer classify outcome and drop economics to null honestly instead of guessing from an exit code.

## Phase 4 — Claude Agent SDK migration behind the AgentEvent seam

### Goal

Replace the `claude -p … --output-format stream-json` spawn and its ~225-line
hand-rolled parser (`src/agent/claude.ts:8-232`) with `query()` from
`@anthropic-ai/claude-agent-sdk`, mapping the SDK's already-typed messages onto
the **same** `AgentEvent` union (`src/agent/types.ts:5-31`). `telegram.ts` and
`bot.ts` are untouched — they consume `AsyncGenerator<AgentEvent>` and never see
a process, a JSON line, or an exit code. This is also the phase where the
CLI-string-shaped `ProviderSpec` (`types.ts:61-70`) is retired in favour of an
SDK-call contract, and where `runner.ts` sheds its byte-plumbing.

### Why (rationale)

The stream-json parser is a text-wire reimplementation of what the SDK delivers
as typed objects. `query({ … , includePartialMessages: true })` yields the exact
token-level `stream_event` deltas the bot streams today (`content_block_start` /
`content_block_delta` / `content_block_stop`), but typed — so the entire
`StreamEvent`/`ContentBlock*` type block and the `JSON.parse`-per-line loop
disappear. The provider contract is currently drawn one layer too low, at the
argv/stdout boundary (`buildArgs`/`buildEnv`/`command`/`createParser`); collapsing
it to a single `run()` generator is the one interface change of the whole
migration and the seam that lets an in-process SDK replace a subprocess without
rippling into the consumers. Auth is near-drop-in: the SDK bundles its own Claude
binary and reuses `~/.claude/.credentials.json`, so no `ANTHROPIC_API_KEY` is
introduced.

### Changes

1. **Add the dependency.** `@anthropic-ai/claude-agent-sdk@^0.3.173` in
   `package.json`. It ships per-platform binaries via `optionalDependencies`; no
   separate `claude` CLI install is required at runtime.

2. **Change the provider contract in `src/agent/types.ts`.** Collapse
   `ProviderSpec` to a single SDK-call generator and delete the four
   CLI-oriented fields. `AgentProvider` still extends it and keeps capabilities +
   history readers.

   ```ts
   // before (types.ts:61-70) — argv/stdout shaped
   export interface ProviderSpec {
     buildArgs: (opts: RunOptions) => string[];
     buildEnv: (opts: RunOptions, base: Record<string, string | undefined>) => Record<string, string>;
     command: string;
     createParser: () => (lines: string[]) => Generator<AgentEvent>;
     id: ProviderId;
   }

   // after — one call contract
   export interface ProviderSpec {
     id: ProviderId;
     run: (opts: RunOptions, signal: AbortSignal) => AsyncGenerator<AgentEvent>;
   }
   ```

   `AgentProvider` (`types.ts:73-79`) is unchanged in spirit: `spec + capabilities
   + clearSessionCache/getSessionProject/listAllSessions + displayName`.

3. **Rewrite `src/agent/claude.ts`.** Keep a pure, exported `buildQuery(opts)` so
   option wiring stays unit-testable without booting the SDK, then have `run()`
   drive `query()` and dispatch on `msg.type`. Preserve `formatToolInput`
   (`claude.ts:78-103`) but drop its `JSON.parse` — the SDK's tool input is
   already an object. Preserve the `.claude/plans/` + `ExitPlanMode` →
   `plan_ready` detection (`claude.ts:180-190`) and `buildFileSystemPrompt`
   (`claude.ts:237-245`), now fed through `options.systemPrompt` (append) rather
   than the `--append-system-prompt` argv.

   ```ts
   import { query } from "@anthropic-ai/claude-agent-sdk";

   /** Pure option assembly — exported for tests, no SDK boot. */
   export const buildQuery = (opts: RunOptions, signal: AbortSignal) => {
     const abortController = new AbortController();
     signal.addEventListener("abort", () => abortController.abort(), { once: true });
     return {
       prompt: opts.prompt,
       options: {
         cwd: opts.projectDir,
         resume: opts.sessionId, // resume by session id (replaces `-r <id>`)
         permissionMode: "bypassPermissions" as const, // replaces --dangerously-skip-permissions
         allowDangerouslySkipPermissions: true,
         abortController,
         includePartialMessages: true, // token-level stream_event deltas
         systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: buildFileSystemPrompt(opts.chatId) },
         // No options.env passthrough: chatId is interpolated into the system-prompt
         // text (buildFileSystemPrompt) and passed to the script as `--chat`; BOT_TOKEN
         // reaches the Bash tool via the SDK-inherited process.env (see change 6).
       },
     };
   };
   ```

   ```ts
   const run = async function* (opts: RunOptions, signal: AbortSignal): AsyncGenerator<AgentEvent> {
     const state = createStreamState(); // buffers input_json_delta, times thinking blocks
     let sawStreamEvents = false;

     for await (const msg of query(buildQuery(opts, signal))) {
       if (msg.type === "stream_event") {
         sawStreamEvents = true;
         yield* mapStreamEvent(msg.event, state); // text_delta / thinking_* / tool_use (+ plan_ready)
       } else if (msg.type === "assistant" && !sawStreamEvents) {
         // dedupe guard: only when partial messages were absent, to avoid double text
         for (const block of msg.message?.content ?? []) yield* mapAssistantBlock(block);
       } else if (msg.type === "result") {
         if (msg.is_error) yield { kind: "error", message: msg.result ?? "Run failed" };
         yield {
           kind: "result",
           text: msg.result ?? "",
           sessionId: msg.session_id,
           cost: msg.total_cost_usd ?? 0,
           durationMs: msg.duration_ms ?? 0,
           turns: msg.num_turns ?? 0,
           totalTokens: totalTokensFrom(msg.usage), // undefined when absent, never fabricated 0
         };
       } else {
         yield* mapControlMessage(msg, state); // system:init → session_init, task_started/notification
       }
     }
   };
   ```

   The `StreamState` machine mirrors the current parser's block handling
   (`claude.ts:128-195`): on `content_block_start` note the block type and, for
   `thinking`, stamp `thinkingStartTime` and emit `thinking_start`; on
   `content_block_delta` emit `text_delta` / `thinking_delta` or accumulate the
   tool `input_json_delta`; on `content_block_stop` assemble the buffered tool
   input into a `tool_use` (running `.claude/plans/` + `ExitPlanMode` detection)
   or emit `thinking_done` with the elapsed time.

   Add a `totalTokens?: number` field to the `result` event in `types.ts`
   (currently `types.ts:23-30` carries cost/durationMs/turns only) so the wide
   event from phase 3 records real token totals; sum the explicit usage keys and
   return `undefined` on absence:

   ```ts
   const TOKEN_USAGE_KEYS = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"] as const;
   const totalTokensFrom = (usage: unknown): number | undefined => {
     if (!usage || typeof usage !== "object") return;
     let total = 0, saw = false;
     for (const k of TOKEN_USAGE_KEYS) {
       const v = (usage as Record<string, unknown>)[k];
       if (typeof v === "number" && Number.isFinite(v)) { total += v; saw = true; }
     }
     return saw ? total : undefined;
   };
   ```

4. **Rewrite `src/agent/runner.ts` to drive `provider.run()`.** Keep the phase-2
   machinery — the `RunRegistry` liveness map and the per-user `AbortController` — and
   delete the spawn, dual stdout/stderr readers, `TextDecoder` line-buffering,
   `buffer.split("\n")`, and exit-code branch. The loop
   becomes a thin adapter: iterate the provider generator, mapping any thrown SDK
   error onto the phase-2 tagged errors (`Stopped` / `ProviderFailed`; `TimedOut`
   only when the opt-in `RUN_TIMEOUT_MS` timer is armed).

   ```ts
   export async function* runProvider(spec: ProviderSpec, opts: RunOptions): AsyncGenerator<AgentEvent> {
     // …existing single-flight guard + registry.set(userId, { ac, done }) unchanged…
     // Opt-in only: arm a timer iff AppConfig.runTimeoutMs is Some(ms); else no timer.
     const timeout = Option.match(cfg.runTimeoutMs, {
       onNone: () => undefined,
       onSome: (ms) => setTimeout(() => { timedOut = true; ac.abort(); }, ms),
     });
     try {
       for await (const ev of spec.run(opts, ac.signal)) yield ev;
     } catch (err) {
       if (ac.signal.aborted) {
         yield { kind: "error", message: timedOut ? "Process timed out." : "Process was stopped." };
       } else {
         yield { kind: "error", message: err instanceof Error ? err.message : String(err) };
       }
     } finally {
       if (timeout) clearTimeout(timeout);
       registry.delete(opts.userId);
       resolveCleanup();
     }
   }
   ```

   `ac.signal` is passed straight into the provider (and thence into the SDK's
   `abortController`), so `/stop`, a new prompt, a provider switch, or (if enabled)
   the opt-in timeout abort the SDK run rather than the OS killing a child. The 143-exit-code class
   cannot fire because there is no exit code — abort surfaces as a gated
   interruption, not a raw error. The SDK owns its subprocess lifecycle, so any
   optional Effect `ChildProcess`/`Scope` prototype from phase 2 is dropped here.

5. **Keep Codex on the CLI for this phase — via a uniform shim.** So the contract
   change is uniform, give `codexProvider` a `run(opts, signal)` that internally
   runs the existing spawn + `createCodexParser` path, moved verbatim out of the
   deleted runner code into a small `runCodexCli(spec, opts, signal)` helper (its
   own file, e.g. `src/agent/codex-cli.ts`). Codex behaviour is unchanged; the
   full Codex-SDK swap lands in phase 5.

   ```ts
   // codex.ts — spec now exposes run() like claude, but backed by the CLI
   export const codexProvider: AgentProvider = {
     id: "codex",
     run: (opts, signal) => runCodexCli({ command: "codex", buildArgs, buildEnv }, opts, signal),
     capabilities: { planMode: true, thinking: true, cost: false, subagents: false },
     displayName: "Codex",
     listAllSessions, getSessionProject, clearSessionCache,
   };
   ```

   `runCodexCli` holds the old `spawn`/reader/decoder/exit-code logic but honours
   `signal` (abort → friendly stopped/timeout error, no raw 143) so its outward
   behaviour matches the new claude `run()`.

6. **File-send via prompt-carried chatId (retires the env-var injection).** The
   agent's Bash tool runs `scripts/send-file-to-user.ts`; today it reads the
   per-run chatId from `TELEGRAM_CHAT_ID` in the spawned-process env
   (`claude.ts:266-273`). The SDK has **no reliable top-level `env` passthrough
   that transitively reaches Bash-tool grandchildren**, so instead carry the
   chatId in the instruction text and pass it as a CLI arg:
   - `buildFileSystemPrompt(chatId)` interpolates the id into the append text:
     `"To send a file, run: bun <script> --path <abs-path> --chat <id>"`. The id
     travels *with the prompt*, so each concurrent run carries its own — no global
     `process.env` mutation, multi-tenant-safe by construction (Phase 2 addendum).
   - `scripts/send-file-to-user.ts` reads `--path` / `--chat` from `argv`
     (keep `TELEGRAM_CHAT_ID` as a fallback), and **validates `--chat` against
     the allowed chat id**, rejecting mismatches (closes a prompt-injection
     redirect). It reads `BOT_TOKEN` from `process.env` — a static secret, never
     put in the prompt.
   - `BOT_TOKEN` reaches the script via the SDK-inherited `process.env` (the SDK
     spawns the binary inheriting the parent env, as the CLI did). `buildEnv`'s
     `CLAUDECODE`-strip is retained; the `TELEGRAM_CHAT_ID` line is deleted.
   This drops the SDK-env dependency entirely and needs no in-process MCP tool.

7. **Do NOT pass an `apiKey`.** Leave `ANTHROPIC_API_KEY` unset so the bundled
   binary reuses `~/.claude/.credentials.json` (subscription OAuth, auto-refreshed
   by the SDK). API key stays a strictly opt-in fallback selected by env presence
   (Docker/CI), never the default.

### New dependencies

- `@anthropic-ai/claude-agent-sdk@^0.3.173` — bundles the Claude binary; no
  separate CLI install; reuses on-disk subscription login.

### Risks & mitigations

- **SDK 0.3.173 message-shape assumptions.** The `stream_event` / `assistant` /
  `result` unions must match `mapStreamEvent` / `mapAssistantBlock` / the result
  extraction. Mitigation: log a few real `query()` runs and diff the observed
  `msg.type` shapes against the mapping *before* deleting `createStreamParser`.
- **Dedupe guard is load-bearing.** Emitting both `stream_event` text and the
  final `assistant` blocks would double the streamed text. Mitigation: the
  `assistant`-only-when-`!sawStreamEvents` guard, pinned by a unit test that
  feeds both message kinds through `run()` and asserts no duplicate `text_delta`.
- **History reader depends on the SDK writing the same store.** `claude-history.ts`
  parses `~/.claude/projects/**.jsonl` for `sessionId`/`cwd`/`type:user`; if the
  SDK stops writing it, the `/history` and `/projects` resume pickers break
  silently (readers fail-open to `[]`). Mitigation: integration-verify a
  freshly-run SDK session appears in `listAllSessions("claude")`.
- **`options.env` reaching the Bash tool.** File-send breaks if the SDK does not
  forward `options.env` into the tool subprocess. Mitigation: an integration test
  that asks the agent to send a file and asserts `TELEGRAM_CHAT_ID` was read.

### Verification

- A normal Claude prompt streams text / thinking / tool lines and a footer
  identical in spirit to before; `.data/events.jsonl` (phase 3) shows real
  `cost` / `turns` / `totalTokens`.
- Resume works: a follow-up message continues the same session via
  `options.resume`.
- Plan mode: a plan request emits `plan_ready` and the review/approve UI is
  unchanged.
- After an SDK-run session, `listAllSessions("claude")` shows it —
  `/history` and `/projects` resume still work.
- `/stop` mid-run aborts cleanly (interrupted outcome, friendly message, no
  orphan, no `143`).
- Codex still works unchanged through its `runCodexCli` shim.

### Depends on

- **phase-2** — tagged errors + graceful abort/timeout classification + the
  per-user liveness/`AbortController`/timeout machinery this runner reuses.
- **phase-3** — the wide `RunEvent`; the new `totalTokens` on the `result` event
  feeds it.

## Phase 5 — Codex SDK migration (thread.runStreamed) + real token usage

### Goal

Replace the `codex exec --json` child-process spawn and the hand-rolled JSONL
parser in `src/agent/codex.ts` (the `CodexEvent`/`CodexItem` type block at
lines 8-64 and `createCodexParser` at lines 95-186) with
`@openai/codex-sdk`'s `new Codex()` + `thread.runStreamed()`. The SDK exposes
Codex's transport as **typed `ThreadEvent`s**, so `codex.ts` collapses from a
byte/line parser into a thin `mapThreadEvent` adapter that yields the same
`AgentEvent` union (`src/agent/types.ts:5-31`) — leaving `telegram.ts`,
`bot.ts`, and `codex-history.ts` untouched.

Two capabilities the current CLI path can't reach come for free with the SDK:

1. `config.developer_instructions` — a real system-prompt channel that retires
   the `buildCodexPrompt` prompt-prefix hack (`codex.ts:195-231`).
2. Real usage tokens on `turn.completed` — letting the result event report
   honest token totals instead of the hard-coded `cost:0`/`turns:0` at
   `codex.ts:160-168`.

### Why

Codex mirrors Claude: today it is a **stateful JSONL parser over a text
transport** the SDK already surfaces as typed items. The current design forces
three compromises the SDK removes:

- **No system-prompt channel.** Because `codex exec` has no
  `--append-system-prompt`, the file-send and plan-mode convention
  instructions are string-prepended to the user's prompt on the first turn
  only (`buildCodexPrompt`, `codex.ts:225-231`) — and silently rely on
  conversation context surviving on resume. `config.developer_instructions` is
  the first-class replacement and applies on every run.
- **Fabricated economics.** `turn.completed` carries a `usage` object
  (`input_tokens`, `cached_input_tokens`, `output_tokens`,
  `reasoning_output_tokens` — already typed at `codex.ts:52-59`) but the parser
  discards it and emits `cost:0, turns:0` (`codex.ts:165-167`). Under the
  ChatGPT-plan login there is no per-token dollar cost, but token totals are
  real and worth surfacing.
- **Argv + line-buffer plumbing.** `buildArgs` (`codex.ts:239-249`) assembles
  `exec [resume <id>] --json --dangerously-bypass-approvals-and-sandbox
  --skip-git-repo-check <prompt>`, and the runner byte-buffers stdout and
  `JSON.parse`s each line (`codex.ts:110-114`). `resumeThread(id)` /
  `startThread()` + `runStreamed()` replace all of it with a typed
  async-iterable, and abort becomes a `signal` pass-through.

This phase depends on **phase-4**, which reshapes the provider contract from
the CLI-string-shaped `ProviderSpec` (`buildArgs`/`buildEnv`/`command`/
`createParser`, `types.ts:61-70`) to an in-process
`run: (opts, signal) => AsyncGenerator<AgentEvent>`. This phase implements that
`run()` for Codex.

### Changes

1. **Add dependency `@openai/codex-sdk@0.139.0`** to `package.json` (pin the
   exact version — the SDK is young and churn-prone; isolate it behind
   `codex.ts`). The SDK bundles the Codex binary via per-platform
   `optionalDependencies`, so no separate `codex` install is required for
   spawning; the on-disk `~/.codex` login is still what authenticates.

2. **Rewrite `codexProvider.run()` in `src/agent/codex.ts`** around the SDK.
   Construct `new Codex({ config })` (config carries only the
   `shell_environment_policy` hardening from item 3 — there is **no**
   `developer_instructions` and no `mcp_servers`); start or resume a thread; drive
   `runStreamed`; map each typed `ThreadEvent` (union in the SDK's
   `src/events.ts`: `thread.started` / `turn.started` / `turn.completed` /
   `turn.failed` / `item.started` / `item.updated` / `item.completed` / `error`)
   via a `mapThreadEvent` closure that preserves the current parser's semantics:
   - `thread.started` → `session_init` (`thread_id` is the session id).
   - `item.started`/`item.completed` (`item: ThreadItem` from `src/items.ts`,
     variants `command_execution` / `file_change` / `mcp_tool_call` /
     `agent_message` / `reasoning` / …) → `tool_use` / `text_delta` / thinking
     triple, keeping the completion-only emit guard (avoids dup tool lines,
     `codex.ts:130-133`) and `stripZshWrapper` (`codex.ts:66-72`).
   - **`plan_ready` detection (survives the JSONL-parser deletion):** on
     `item.completed` where `item.type === "file_change"` and
     `item.status === "completed"`, match any `item.changes[].path` (a
     `FileUpdateChange { path, kind }`) whose normalized suffix ends
     `.codex/plans/PLAN.md` → emit `plan_ready` (emit-once, replacing
     `codex.ts:139-144`). **Fallback:** `file_change` only fires for
     apply_patch-style writes; a PLAN.md written via shell redirection
     (`cat > …`, `tee`, a script) surfaces as a `command_execution` item with
     the path buried in the free-text `command`. So also keep an `fs.watch`
     (or post-turn `stat`) on `<workingDirectory>/.codex/plans/PLAN.md` as a
     safety net. Both paths feed the same emit-once guard.
   - `turn.completed` → `result` with `totalTokens` summed from `usage` via a
     new `sumUsage` (see item 7); `cost:0` (ChatGPT plan), `turns:1`.
   - `turn.failed` / `error` → deduped tagged `error` (keep the
     `lastError` guard and `parseErrorMessage`, `codex.ts:74-88`,169-182).

3. **Keep the first-turn prompt prefix for file-send + plan-mode instructions.**
   The `@openai/codex-sdk@0.139.0` SDK exposes **no `developer_instructions` /
   system-prompt hook** (verified against source: `CodexOptions`/`ThreadOptions`/
   `TurnOptions` have no such field) — so the injected-prefix approach stays. Keep
   `buildFileSystemPrompt` (`codex.ts:195-203`), `buildPlanModePrompt`
   (`codex.ts:212-218`), and `buildCodexPrompt` (`codex.ts:220-231`); the composed
   prefix is prepended to `opts.prompt` on the **first turn**.
   **Persistence across `resumeThread` (verified):** resume runs
   `codex exec resume <id>`, which reconstructs the full prior conversation from
   `~/.codex/sessions/**/rollout-*.jsonl` and replays it — so the turn-1 prefix
   stays in-context on later turns **in short/medium threads**. The one hole:
   codex auto-compaction (fires near ~90% of the context window) keeps only the
   most-recent user messages within a ~20K-token budget and can **evict the
   oldest user message (turn 1, our prefix)** in a very long session — so the
   prefix is reliable-but-not-guaranteed. The durable alternative, an `AGENTS.md`
   in the `workingDirectory` (codex loads it as UserInstructions, rebuilt fresh
   after every compaction; 32 KiB default cap), is **rejected as the default**
   because the bot targets arbitrary user project dirs and it would litter the
   repo (git noise, collision with the user's own AGENTS.md). Keep the prefix;
   `AGENTS.md`/`AGENTS.override.md` is the escalation path only if eviction is
   observed. The prefix is NOT re-injected on `resumeThread`.
   `buildFileSystemPrompt(chatId)` now interpolates the chatId and instructs the
   `--chat` CLI arg, exactly as the Claude side (phase 4 change 6) — the id rides
   the prompt, so no `TELEGRAM_CHAT_ID` env injection is needed. `BOT_TOKEN` (the
   static secret the script needs) reaches the shell tool via the inherited
   `process.env`, but Codex's default `shell_environment_policy` strips names
   matching `*TOKEN*` — so harden once (static, no race) with
   `config: { shell_environment_policy: { inherit: "all", set: { BOT_TOKEN: … } } }`,
   or have the script read the token from a file instead of env. Drop the
   `buildEnv` `TELEGRAM_CHAT_ID` line (`codex.ts:251-261`); keep its
   `CLAUDECODE`-strip.

4. **Delete the CLI plumbing:** `createCodexParser` (`codex.ts:95-186`), the
   `CommandExecutionItem`/`FileChange`/`FileChangeItem`/`AgentMessageItem`/
   `ReasoningItem`/`CodexItem`/`CodexEvent` type block (`codex.ts:8-64`),
   `buildArgs` (`codex.ts:239-249`), and `buildEnv`/`buildCodexPrompt`. Replace
   the local event/item interfaces with the SDK's exported `ThreadEvent` /
   `Usage` types so mapping is checked against the installed version.

5. **Keep the `codex login status` warn in `src/index.ts`** (non-blocking
   startup check). Auth stays on the on-disk `~/.codex` subscription login — no
   API key is passed to the SDK; it inherits `process.env` and reuses the
   stored credentials, exactly as the CLI did.

6. **Widen the `result` event in `src/agent/types.ts`.** Add
   `totalTokens?: number` to the `result` variant (`types.ts:23-30`) so Codex's
   real token count has a field to land in (Claude will populate the same field
   in phase-4). Thread it through the telegram footer as a follow-up; nullable
   so subscription runs without usage degrade honestly rather than reporting 0.

7. **Update Codex capabilities.** `cost` stays `false` (no dollar cost under the
   ChatGPT plan). If `turn.completed.usage` reliably yields token totals, the
   footer now shows real duration + tokens + `turns:1`; leave the
   `capabilities` object at `{ planMode:true, thinking:true, cost:false,
   subagents:false }` (`codex.ts:268-273`) — `cost:false` already hides the
   dollar figure while the honest token/duration/turn numbers render.

### Before / After

Before — spawn argv + stateful JSONL parser (`codex.ts:95-186`,239-249):

```ts
const buildArgs = (opts: RunOptions) => {
  const safety = [
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
  ];
  const prompt = buildCodexPrompt(opts); // instructions prepended to prompt
  if (opts.sessionId) {
    return ["exec", "resume", opts.sessionId, "--json", ...safety, prompt];
  }
  return ["exec", "--json", ...safety, prompt];
};

const createCodexParser = () => {
  let sessionId = "";
  return function* parseCodexLines(lines: string[]): Generator<AgentEvent> {
    for (const line of lines) {
      const parsed: CodexEvent = JSON.parse(line.trim()); // hand-parse each line
      if (parsed.type === "thread.started") { /* ... */ }
      // ...turn.completed -> { cost: 0, turns: 0 }  // fabricated economics
    }
  };
};
```

After — SDK thread + typed event mapping:

```ts
import { Codex, type ThreadEvent, type ThreadOptions, type Usage } from "@openai/codex-sdk";

/** Sum only the explicit usage keys; undefined (not 0) when absent, so a
 *  subscription run without usage degrades honestly. */
const sumUsage = (usage: Usage | undefined): number | undefined => {
  if (!usage) return undefined;
  const keys = [
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
  ] as const;
  let total = 0;
  let saw = false;
  for (const k of keys) {
    const v = (usage as Record<string, unknown>)[k];
    if (typeof v === "number" && Number.isFinite(v)) {
      total += v;
      saw = true;
    }
  }
  return saw ? total : undefined;
};

const developerInstructions = () =>
  `${buildFileSystemPrompt()}\n\n${buildPlanModePrompt()}`;

const threadOptions = (opts: RunOptions): ThreadOptions => ({
  workingDirectory: opts.projectDir,
  sandboxMode: "danger-full-access",
  approvalPolicy: "never",
  skipGitRepoCheck: true,
});

/** codexProvider.run — in-process SDK, same AgentEvent output */
async function* run(
  opts: RunOptions,
  signal: AbortSignal
): AsyncGenerator<AgentEvent> {
  const codex = new Codex({
    config: {
      developer_instructions: developerInstructions(),
      mcp_servers: {},
    },
  });
  const thread = opts.sessionId
    ? codex.resumeThread(opts.sessionId, threadOptions(opts))
    : codex.startThread(threadOptions(opts));

  const { events } = await thread.runStreamed(opts.prompt, { signal });

  const start = Date.now();
  let sessionId = "";
  let lastAgentMessage = "";
  let lastError = "";
  let planEmitted = false;

  for await (const ev of events) {
    yield* mapThreadEvent(ev, {
      start,
      onSession: (id) => { sessionId = id; },
      onText: (t) => { lastAgentMessage = t; },
      sessionId: () => sessionId,
      lastMessage: () => lastAgentMessage,
      lastError: () => lastError,
      setError: (e) => { lastError = e; },
      planEmitted: () => planEmitted,
      markPlan: () => { planEmitted = true; },
    });
  }
}
```

Where `mapThreadEvent` reproduces the existing switch — including the
completion-only guard, `stripZshWrapper`, `.codex/plans/` plan detection, and
`parseErrorMessage` dedupe — but the `turn.completed` arm now yields real
tokens:

```ts
// turn.completed -> result with honest tokens, cost still 0, turns 1
yield {
  kind: "result",
  text: state.lastMessage(),
  sessionId: state.sessionId(),
  cost: 0,
  durationMs: Date.now() - state.start,
  turns: 1,
  totalTokens: sumUsage(ev.usage),
};
```

### New dependencies

- `@openai/codex-sdk@0.139.0` (exact pin). Bundles the Codex binary via
  per-platform `optionalDependencies`; no separate `codex` CLI install needed
  for runs. Isolated entirely behind `src/agent/codex.ts`.

### Risks & mitigations

- **SDK API surface is young / unverified.** The exact shapes of
  `resumeThread(id, opts)`, `ThreadOptions`, `config.developer_instructions`,
  `ThreadEvent`, and `Usage` must be checked against the installed
  `0.139.0` — in particular whether `.codex/plans/` writes still surface as a
  `file_change`-style item so plan detection works. Mitigation: import the
  SDK's own exported types (never re-declare) so a shape mismatch is a compile
  error; add an integration smoke test that asserts a `plan_ready` fires.
- **`developer_instructions` on resume.** The old code only prefixed
  instructions on the first turn and leaned on conversation context thereafter.
  Confirm `developer_instructions` is (re)applied on every `runStreamed`
  including `resumeThread`, so file-send + plan conventions stay in force
  across a multi-turn session. Mitigation: verification step below exercises a
  resumed turn.
- **History reader coupling.** `codex-history.ts` reads
  `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` and filters by recorded cwd.
  The SDK must still write those `session_meta` rollout lines for the
  `/history` resume picker to work. Mitigation: assert a freshly-run SDK
  session appears in `listAllSessions("codex")`; readers fail-open to `[]`, so
  a silent format change would drop the session without an error.
- **Abort semantics.** `runStreamed({ signal })` must reject/stop promptly on
  abort. Mitigation: the phase-2 scoped runner passes the AbortController
  signal; verify `/stop` mid-run stops the stream and records an interrupted
  outcome (not a fabricated error).

### Verification

1. A Codex prompt streams tool/text/thinking items and a footer; the footer now
   shows **real token totals** (not 0) and duration + `turns:1`.
2. A follow-up message resumes the same thread via `resumeThread`, and
   `developer_instructions` are still in effect — the agent can send a file
   (`send-file-to-user.ts`) and honors the plan convention on the resumed turn.
3. A plan-only request writes `.codex/plans/PLAN.md` and emits exactly one
   `plan_ready`, feeding the unchanged review/approve UI.
4. After an SDK Codex run, `listAllSessions("codex")` shows it — `/history`
   resume works end-to-end.
5. `/stop` mid-run interrupts cleanly via the `signal`; the run is recorded as
   an interrupted outcome, no `[Error: ...]` bubble.

### Depends on

- **phase-4** — the `ProviderSpec` → in-process `run(opts, signal)` contract
  reshape and the scoped/abort-aware runner this phase's `run()` plugs into.

## Phase 6 — Session & auth hardening (SessionStore service + typed auth detection)

### Goal

Harden state/session persistence and make agent auth mode explicit at boot:

- Extract session persistence into an Effect `SessionStore` `Context.Service` backed by `.data/sessions.json`, shaped `project -> provider -> { sessionId }`, with **atomic unique-tmp writes**, **fail-open reads**, a **`version`** field, and **corruption preservation** (rename bad file, never silent-wipe).
- Drive persistence off the normalized `AgentEvent` stream — tap `session_init`/`result` in the runner (factory's pattern) instead of the ad-hoc "write on result only" path in `bot.ts`.
- Surface auth as a typed startup readout: `anthropicApiKey` read via `Config.option(Config.redacted(...))` filtered to non-empty, logged as `subscription login (~/.claude)` vs `ANTHROPIC_API_KEY (API pricing)`. Keep the Codex login-status warn; optionally promote a missing login to a typed startup warning.

This lands **after** the SDK swaps (phase-4/5) so persistence reads from the SDK-sourced event stream, and **after** the Effect foundation (phase-1) so `SessionStore` and auth config compose into the existing `appLayer` and are reached through the `ManagedRuntime` bridge — the grammy handlers stay Promise-based.

### Why

`src/state.ts` has three concrete defects:

1. **Silent corruption wipe.** `loadPersistedState` (`src/state.ts:55-87`) wraps everything in `try { … } catch { return null; }`. Any parse/read error — including a truncated write or a hand-edit typo — is indistinguishable from a legitimate first run. `bot.ts` then falls back to empty defaults (`persisted?.activeProject ?? ""`, `persisted?.sessions ?? emptySessions()`), so **one bad byte discards `activeProject` and every session ID for both providers with no log**, and the next `saveState` overwrites the file, making the loss permanent.
2. **Fixed tmp name.** `saveState` (`src/state.ts:104-106`) writes to a single `${STATE_FILE}.tmp` then renames. Atomic for today's synchronous callers, but unsafe the moment a second writer (async `SessionStore`, a future second process) exists — two writers race on the same tmp path.
3. **No version field.** `PersistedState` has no schema tag, so the only migration hook is the shape-sniffing `isOldShape` heuristic (`src/state.ts:29-46`). A future format change has nowhere to branch.

Separately, both SDKs default to on-disk subscription login (`~/.claude`, `~/.codex`) and pass **no API key**. Whether an API key is present silently flips billing from subscription to metered API pricing. Making that a **boot-time readout** turns a runtime surprise (and a source of accidental spend) into one log line.

Finally, session persistence today happens in `bot.ts:998-1005` — `updateSession` is called only after `streamToTelegram` returns a `result.sessionId`. An interrupted run (a `/stop`, a new prompt) never reaches that line, so a session that the SDK already initialized (`session_init`) is not recorded and cannot be resumed. Tapping the stream at `session_init` **and** `result` — factory's `Stream.tap` pattern — captures the id as soon as it exists.

### Changes

1. **Create `src/agent/session-store.ts` — a `SessionStore` service.** Model it as a class-per-service with a static `layer`, inferring the shape from the impl (no hand-written interface), matching factory's `packages/agent/src/session-store.ts`. Backing file `.data/sessions.json`, shape `{ version, sessions: { [project]: { [provider]: { sessionId } } } }`. Provider-namespaced so `claude`/`codex` ids never collide. Methods: `get(project, provider)`, `set({ project, provider, sessionId })`, `clear(project, provider)`. Reads **fail open** to an empty store; writes are **atomic** via a unique tmp suffix (`pid + rand`) + rename.

2. **Harden `loadPersistedState` in `src/state.ts` (`:55-87`).** Distinguish the three cases instead of collapsing them:
   - `ENOENT` → legitimate first run → return `null`, emit `state.load { result: "missing" }`.
   - Parse/validation error → **corruption**: rename the bad file to `state.json.corrupt-<ts>` (best-effort; must not throw on a read-only `.data`), emit `state.load { result: "corrupt" }`, then return `null` so the bot still boots.
   - Success → emit `state.load { result: "ok" }`.
   Keep the existing one-time flat-shape migration (`isOldShape`, `:29-46`) and **add** a `version`-based migration branch for future schema bumps.

3. **Persist session on the normalized stream (`src/agent/runner.ts`).** Tap the `AgentEvent` stream inside the runner/`runAndDrain` and write `sessionId` on `session_init` **and** `result` via `SessionStore.set`, replacing the result-only `updateSession` call in `bot.ts:998-1005`. This mirrors factory's `Stream.tap(event => event.kind === "session_init" || event.kind === "result" ? persist(...) : Effect.void)`. Resume behavior is unchanged — the same id is written, just earlier and on more terminal paths.

4. **Auth detection in `src/config.ts` + `src/index.ts`.** In the phase-1 `Config` service read `anthropicApiKey` via `Config.option(Config.redacted("ANTHROPIC_API_KEY"))` filtered to non-empty (a set-but-empty var counts as absent). At startup log the active mode. Keep the existing `checkCodexAvailable` warn (`src/index.ts:8-26`). Optionally promote a missing Claude login (no `~/.claude/.credentials.json` and no API key) to a typed startup warning rather than a first-message failure.

5. **Add unique-tmp + `version` to `saveState` (`src/state.ts:104-106`)** and emit a `state.save { bytes, durationMs }` event. Same unique-tmp helper as `SessionStore` (share it).

### Before / After

Corruption handling in `src/state.ts`:

```ts
// BEFORE (src/state.ts:55-87) — any error is silent total loss
export function loadPersistedState() {
  try {
    const text = readFileSync(STATE_FILE, "utf-8");
    const parsed = JSON.parse(text) as unknown;
    // …migrate / read…
    return { activeProvider, activeProject, sessions };
  } catch {
    return null; // ENOENT and "corrupt JSON" are indistinguishable
  }
}
```

```ts
// AFTER — distinguish missing vs corrupt; preserve the bad file; observe
export const loadPersistedState = () => {
  let text: string;
  try {
    text = readFileSync(STATE_FILE, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      logEvent({ event: "state.load", result: "missing" });
      return null; // legitimate first run
    }
    throw e; // real IO fault — surface, don't mask as empty state
  }

  try {
    return parseAndMigrate(text); // isOldShape + version branch
  } catch (err) {
    const corruptPath = `${STATE_FILE}.corrupt-${Date.now()}`;
    try {
      renameSync(STATE_FILE, corruptPath); // best-effort; read-only .data must not throw
    } catch {
      /* keep booting even if preservation fails */
    }
    logEvent({
      event: "state.load",
      result: "corrupt",
      preservedTo: corruptPath,
      errorClass: (err as Error).name,
    });
    return null; // fail open: boot with defaults, but the data is not gone
  }
};
```

Atomic write with a collision-safe tmp name:

```ts
// BEFORE (src/state.ts:104-106) — fixed tmp path races any second writer
const tmp = `${STATE_FILE}.tmp`;
writeFileSync(tmp, JSON.stringify(data, null, 2));
renameSync(tmp, STATE_FILE);
```

```ts
// AFTER — unique tmp suffix + version field + observed write
const uniqueTmp = (path: string) =>
  `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;

const writeJsonAtomic = (path: string, value: unknown) => {
  const started = performance.now();
  const body = JSON.stringify(value, null, 2);
  const tmp = uniqueTmp(path);
  writeFileSync(tmp, body);
  renameSync(tmp, path);
  logEvent({ event: "state.save", bytes: body.length, durationMs: performance.now() - started });
};
```

`SessionStore` as an Effect service (factory `Context.Service` idiom, shape inferred from the impl):

```ts
// src/agent/session-store.ts
import { Context, Effect, Layer } from "effect";
import type { ProviderId } from "./types";

const STORE_VERSION = 1 as const;

interface StoreFile {
  version: number;
  sessions: Record<string, Partial<Record<ProviderId, { sessionId: string }>>>;
}

const emptyStore = (): StoreFile => ({ version: STORE_VERSION, sessions: {} });

const makeSessionStore = (storePath: string) =>
  Effect.gen(function* () {
    // fail open: any read/parse error -> empty store, never throw
    const read = (): StoreFile => {
      try {
        const parsed = JSON.parse(readFileSync(storePath, "utf-8")) as StoreFile;
        return parsed?.version === STORE_VERSION ? parsed : migrate(parsed);
      } catch {
        return emptyStore();
      }
    };

    const get = (project: string, provider: ProviderId) =>
      Effect.sync(() => read().sessions[project]?.[provider]?.sessionId);

    const set = (args: { project: string; provider: ProviderId; sessionId: string }) =>
      Effect.sync(() => {
        const store = read();
        const forProject = store.sessions[args.project] ?? {};
        forProject[args.provider] = { sessionId: args.sessionId };
        store.sessions[args.project] = forProject;
        writeJsonAtomic(storePath, store); // unique-tmp + rename
      });

    const clear = (project: string, provider: ProviderId) =>
      Effect.sync(() => {
        const store = read();
        delete store.sessions[project]?.[provider];
        writeJsonAtomic(storePath, store);
      });

    return { get, set, clear } as const;
  });

export class SessionStore extends Context.Service<
  SessionStore,
  Effect.Success<ReturnType<typeof makeSessionStore>>
>()("@telegram-claude/SessionStore") {
  static readonly layer = (storePath: string) =>
    Layer.effect(SessionStore, makeSessionStore(storePath));
}
```

Wire the store path from config with `Layer.unwrap` (factory's config-derived-layer idiom), and provide it into the existing `appLayer` from phase-1:

```ts
// composition root (phase-1 appLayer)
const sessionStoreLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig;
    return SessionStore.layer(config.sessionsPath); // .data/sessions.json
  })
);
```

Persist off the stream in the runner (replaces `bot.ts:998-1005`):

```ts
// src/agent/runner.ts — tap session_init AND result, not result-only
runStream.pipe(
  Stream.tap((event) =>
    event.kind === "session_init" || event.kind === "result"
      ? sessions.set({ project: opts.projectDir, provider, sessionId: event.sessionId })
      : Effect.void
  )
);
```

Auth readout in `src/config.ts` + `src/index.ts`:

```ts
// src/config.ts — API key optional, empty string treated as absent
const anthropicApiKey = yield* Config.option(Config.redacted("ANTHROPIC_API_KEY")).pipe(
  Effect.map(Option.filter((k) => Redacted.value(k).length > 0))
);

// src/index.ts (onStart) — one boot-time line
const authMode = Option.isSome(config.anthropicApiKey)
  ? "Agent auth: ANTHROPIC_API_KEY (API pricing)"
  : "Agent auth: subscription login (~/.claude)";
console.log(authMode); // -> routes through the phase-1 logger
```

### New dependencies

None. `effect` and `@effect/platform-bun` are already introduced in phase-1; this phase only adds a new service module and hardens two existing files.

### Risks & mitigations

- **Migration bug moving sessions into `SessionStore`.** Splitting session state out of `state.json` risks a one-time data-loss window. Mitigation: keep the existing flat-shape migration (`src/state.ts:29-46`) untouched, add a `version`-tagged migration path in `SessionStore.read` (`migrate(parsed)`), and cover both with a `bun:test` round-trip that seeds an old-shape file and asserts the ids survive. Consider a read-through: if `sessions.json` is empty but `state.json` has sessions, import them once.
- **Stream-tap persistence changing resume behavior.** Writing on `session_init` in addition to `result` must record the *same* id the old path did. Mitigation: a test that runs a scripted provider (factory's `emittingSpec` idiom) emitting `session_init` then `result` and asserts the stored id equals `result.sessionId`; verify resume across a simulated restart for both providers.
- **Corruption-preservation rename throwing on read-only `.data`.** The `renameSync` to `state.json.corrupt-<ts>` must be best-effort. Mitigation: wrap it in its own `try/catch` (shown above) so a read-only or full disk never blocks boot — the bot still starts with defaults and logs the failure.
- **Observability calls in the persistence hot path.** `state.save`/`state.load` events must be best-effort (phase-3's `bestEffort`/`Effect.ignore`) so a logging fault never aborts a save.

### Verification

1. **Corruption is preserved, not wiped.** Hand-corrupt `.data/state.json` (truncate mid-object) → bot boots, the file is renamed to `state.json.corrupt-<ts>`, a `state.load { result: "corrupt" }` event is emitted, and recoverable state (anything still in `sessions.json`) is not lost.
2. **No leftover tmp files.** A `bun:test` round-trip performing rapid/concurrent saves asserts the store round-trips and `readdirSync(.data)` contains no `*.tmp` entry afterward (factory's `session-store.test.ts` assertion).
3. **Auth readout is correct.** Toggling `ANTHROPIC_API_KEY` (set vs unset vs empty string) flips the startup log between `subscription login (~/.claude)` and `ANTHROPIC_API_KEY (API pricing)`; empty string is reported as subscription.
4. **Resume survives restart.** Start a run for each provider, restart the bot, send a follow-up → the conversation resumes (same `sessionId` fed to `query({ resume })` / `codex.resumeThread(id)`), proving the stream-tapped write persisted.
5. **Missing-file is not corruption.** Delete `.data/state.json` → boot logs `state.load { result: "missing" }` (not `corrupt`) and no `*.corrupt-*` file is created.

### Depends on

- **phase-4** (Claude Agent SDK migration) — persistence is tapped off the SDK-sourced `session_init`/`result` events.
- **phase-5** (Codex SDK migration) — same, for the Codex provider's typed thread events.

Also builds on **phase-1** (the `Config` service + logger layer this reuses for auth detection and the `state.load`/`state.save` events) and **phase-3** (the wide-event/observability sink those events flow into).

## Phase 7 — Testing, tooling & polish

### Goal

Lock the new invariants from phases 2, 3, and 6 with `bun:test` — zero extra test-framework dependencies — and add the small tooling ergonomics (biome test overrides, a fast husky hook, an optional Docker recipe) that keep the migration durable. No monorepo scaffolding: no turbo, no workspace `catalog`, no `packages/*`/`apps/*` split. This phase adds coverage and polish only; it changes no runtime behavior.

### Why (rationale)

The reliability and observability gains from earlier phases (the 143→interrupted classification, the one-wide-event-per-run contract, atomic session/state writes) are only trustworthy if their invariants are pinned by tests. factory's `bun:test` idiom — real filesystem via `mkdtempSync(tmpdir())`, hand-written fake providers (`emittingSpec`/`blockingSpec`), a capture-sink layer for the wide event, dependency injection as the seam instead of `jest.mock` — maps 1:1 onto this codebase and needs no test dependency (Bun runs `*.test.ts` natively). This works precisely because the `AgentEvent` seam (`src/agent/types.ts:5-31`) already decouples the consumers from the process layer: a fake provider that yields scripted events can drive `src/agent/runner.ts` and `src/telegram.ts` through their whole surface with no Telegram API and no subprocess.

The current tooling is already close to the target: `biome.jsonc` already has `globals:["Bun"]`, `useConsistentTypeDefinitions:interface`, and `noMagicNumbers:"off"`; `.husky/pre-commit` already exists and runs `bun run fix && bun run lint && bun run typecheck`; `prepare: husky` is wired. So the tooling delta is small — the load-bearing work here is the tests.

### Changes

1. **Add a `test` script** to `package.json`. Bun auto-discovers `*.test.ts`, so this is a one-liner:

   ```jsonc
   // package.json scripts
   "test": "bun test",
   "test:watch": "bun test --watch"
   ```

2. **`src/state.test.ts`** — round-trip `loadPersistedState`/`saveState` (`src/state.ts`) against a real temp dir. Assert: (a) write→read round-trips `activeProvider`/`activeProject`/provider-namespaced `sessions`; (b) after a `saveState`, the dir contains `state.json` and **no** leftover `*.tmp` file (proves the atomic rename in `src/state.ts` completed); (c) the phase-3/6 corruption path — a truncated/garbage `state.json` is preserved (renamed to `state.json.corrupt-<ts>`) rather than silently wiping sessions, and the loader distinguishes `ENOENT` (legit first run → empty state) from a parse error. The store path must be injectable (parameterize the path, or point `.data` at the temp dir) so tests never touch the real `.data/state.json`.

   ```ts
   import { describe, expect, test } from "bun:test";
   import { mkdtempSync, readdirSync } from "node:fs";
   import { tmpdir } from "node:os";
   import { dirname, join } from "node:path";

   const tmpStore = () => join(mkdtempSync(join(tmpdir(), "state-")), "state.json");

   test("atomic save leaves no partial temp file", async () => {
     const path = tmpStore();
     await saveState(path, { activeProvider: "claude", activeProject: "/p", sessions: { claude: {}, codex: {} } });
     const files = readdirSync(dirname(path));
     expect(files).toContain("state.json");
     expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
   });

   test("corrupt state is preserved, not silently wiped", async () => {
     const path = tmpStore();
     await Bun.write(path, "{ not json");
     const loaded = await loadPersistedState(path);
     expect(loaded).toBeNull(); // fail-open to defaults
     expect(readdirSync(dirname(path)).some((f) => f.startsWith("state.json.corrupt-"))).toBe(true);
   });
   ```

3. **`src/agent/session-store.test.ts`** — cover the phase-6 `SessionStore` (provider-namespaced `taskId → provider → { sessionId }`, atomic unique-tmp writes, fail-open reads). Assert: (a) `setSession`/`getSession` round-trip per provider without cross-provider collision (claude and codex ids for the same project stay distinct); (b) the tmp filename is **unique per write** (pid+rand suffix), so two concurrent writers cannot clobber a shared `*.tmp`; (c) a missing store reads as empty (`{}`) rather than throwing.

4. **`src/observability.test.ts`** — pin the phase-3 wide-event contract with a capture-sink appender injected into the emit function. This is the plain-TS analog of factory's `captureLayer`: pass a fake `append: (line: string) => void` into the `RunEvent` emitter and assert against the collected rows. Cases:
   - **Exactly-once**: a normal run emits exactly one `events.jsonl` line with `outcome:"done"` and populated economics.
   - **Null economics on interrupt/timeout**: an interrupted run (`/stop`, new prompt, provider switch) or a timeout emits `outcome:"interrupted"`/`"timeout"` with `agentCostUsd`/`turns`/`totalTokens` **`null`** — degraded shape, never fabricated `0`.
   - **Clipped errorMessage**: an errored run clips `errorMessage` to a single line, ≤240 chars, no secrets.
   - **Best-effort**: a throwing appender does **not** propagate — the emit is wrapped so a serializer/disk error can never crash a chat.

   ```ts
   test("interrupt emits exactly one row with null economics", () => {
     const sink: RunEvent[] = [];
     const emit = makeRunEmitter({ append: (line) => sink.push(JSON.parse(line)) });
     emit({ outcome: "interrupted", provider: "claude", project: "/p", /* … */ });
     expect(sink).toHaveLength(1);
     expect(sink[0]?.outcome).toBe("interrupted");
     expect(sink[0]?.agentCostUsd).toBeNull();
     expect(sink[0]?.totalTokens).toBeNull();
   });

   test("emit is best-effort — a throwing appender never propagates", () => {
     const emit = makeRunEmitter({ append: () => { throw new Error("disk full"); } });
     expect(() => emit({ outcome: "done", /* … */ })).not.toThrow();
   });
   ```

5. **`src/agent/runner.test.ts`** — the highest-value test, driving `src/agent/runner.ts` with fake providers to lock the phase-2 interrupt classification. Two fakes (factory's `emittingSpec`/`blockingSpec` idiom):
   - `emittingSpec(events)` — a provider whose `run()` yields a fixed `AgentEvent[]` then completes; asserts the runner streams events in order and forwards `session_init`/`result`.
   - `blockingSpec()` — yields one event then blocks until aborted; asserts that `stopAgent(userId)` (or a new prompt / provider switch) surfaces as an **`interrupted`** outcome, **not** `{kind:"error", message:"Process exited with code 143"}`. Explicitly assert the exit-code→cause mapping: a SIGTERM/143 (and 130) originating from our own abort classifies as interrupt/timeout, while a genuine non-zero child exit stays an error.
   - Also assert the one-process-per-user invariant across providers and that a hung child does not deadlock subsequent runs (phase-2 SIGKILL escalation / bounded finalizer).

   ```ts
   const emittingSpec = (events: AgentEvent[]): ProviderSpec => ({
     id: "fake",
     async *run() { for (const e of events) yield e; },
   });

   const blockingSpec = (): ProviderSpec => ({
     id: "fake",
     async *run(_opts, signal) {
       yield { kind: "session_init", sessionId: "s1" };
       await new Promise<void>((res) => signal.addEventListener("abort", () => res()));
     },
   });

   test("abort classifies as interrupted, never a 143 error", async () => {
     const out: AgentEvent[] = [];
     const run = collect(runAgent("fake", opts), out); // resolves via injected registry
     queueMicrotask(() => stopAgent(opts.userId));
     const result = await run;
     expect(result.outcome).toBe("interrupted");
     expect(out.some((e) => e.kind === "error" && /143/.test(e.message))).toBe(false);
   });
   ```

   This requires a small seam: `runAgent` must resolve the provider through an injectable registry (phase-6 turns the registry into a lookup that tests can override), so `emittingSpec`/`blockingSpec` are substituted without patching modules.

6. **`src/telegram.test.ts`** — feed `streamToTelegram` (`src/telegram.ts`) a scripted `AsyncGenerator<AgentEvent>` and a **fake ctx/api** (a thin object recording `sendMessage`/`editMessageText`/draft calls), no Telegram network. Assert: `text_delta`s accumulate and split at the 4000-char boundary; a classified `error` event renders the friendly copy (`stopped`/`timeout`) rather than a raw `Process exited with code 143`; the footer/thinking/subagent UI is gated by the active provider's capabilities. This needs a light refactor to inject the sender (see Risks) — keep it a thin seam, not a rewrite.

7. **`biome.jsonc`** — add the test globs to `files.includes` and an `overrides` block scoping test-only relaxations. `noMagicNumbers` is already `"off"` globally, so the override is mainly future-proofing (if it is ever re-enabled globally, test data stays literal-heavy without fighting the linter) plus a home for `useAwait`/complexity relaxations tests tend to trip:

   ```jsonc
   {
     "files": {
       "includes": [
         "src/**/*.ts",
         "scripts/**/*.ts",
         "!node_modules/**/*",
         "!dist/**/*"
       ]
     },
     "overrides": [
       {
         "includes": ["**/*.test.ts"],
         "linter": {
           "rules": {
             "style": { "noMagicNumbers": "off" },
             "complexity": { "noExcessiveCognitiveComplexity": "off" }
           }
         }
       }
     ]
   }
   ```

   Keep `globals:["Bun"]` and `useConsistentTypeDefinitions:interface` as-is (already present).

8. **`.husky/pre-commit`** — keep it fast: **fix + lint + typecheck, no `bun test`** (factory deliberately keeps the test line out of the hook). The current hook already runs `bun run fix && bun run lint && bun run typecheck`; leave it. If commits get slow, narrow it to staged files via `bunx --bun ultracite fix` on the staged set, but do not add tests to the hook — run `bun test` in CI instead.

9. **(Optional) `Dockerfile` + `docker-compose.yml`** — a single-stage image for a CLI/SDK-spawning bot:

   ```dockerfile
   FROM oven/bun:1.3
   WORKDIR /app
   RUN apt-get update && apt-get install -y --no-install-recommends git gh && rm -rf /var/lib/apt/lists/*
   COPY . .
   RUN bun install --frozen-lockfile
   CMD ["bun", "run", "src/index.ts"]
   ```

   ```yaml
   # docker-compose.yml
   services:
     bot:
       build: .
       env_file: .env
       volumes:
         - ./.data:/app/.data            # persist state.json / sessions / events.jsonl
         - ~/.claude:/root/.claude:ro    # reuse host subscription login, no API key
         - ~/.codex:/root/.codex:ro
   ```

   Read-only mounts of `~/.claude` and `~/.codex` reuse the host subscription login (phase-4/5 pass **no** API key). Document in `.env.example` that `ANTHROPIC_API_KEY` is **only** needed inside Docker on macOS, because the macOS Keychain credentials cannot cross into the Linux container:

   ```dotenv
   # ANTHROPIC_API_KEY — leave UNSET for local subscription auth (~/.claude login).
   # Only set this inside Docker on macOS: the macOS Keychain can't cross into Linux.
   # ANTHROPIC_API_KEY=
   # Observability: local .data/events.jsonl is always on. Optionally ALSO forward
   # each RunEvent to a cloud OTel backend by setting an endpoint (+ headers).
   # Unset = local-only (the default). Example: Axiom —
   #   OTEL_EXPORTER_OTLP_ENDPOINT=https://api.axiom.co
   #   OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer xaat-...,X-Axiom-Dataset=telegram-claude
   OTEL_EXPORTER_OTLP_ENDPOINT=
   OTEL_EXPORTER_OTLP_HEADERS=
   ```

10. **Ship the optional OTLP forwarder (config-gated, off by default).** Build it in this phase — decision 2026-07-08. Local `.data/events.jsonl` stays the **default and load-bearing** path (the operator runs local-only); the OTLP export is a **one-env-var opt-in** so open-source users can point at a cloud OTel backend (Axiom, Grafana/Tempo, Honeycomb, an OTel Collector, …) without any code change. Gated on `OTEL_EXPORTER_OTLP_ENDPOINT`: under Effect v4-beta a `Layer.unwrap(Effect.gen(...))` reads the env via `Config.option` and returns `Layer.empty` when unset (zero overhead, no network, no dep pulled at runtime), otherwise adds an `Otlp.layerJson` over `FetchHttpClient` that forwards the **same** `RunEvent` as an OTLP log record — so the two sinks never diverge. Keep it additive: OTLP never replaces the JSONL append and a forwarder failure is best-effort (must never break a chat, same discipline as `recordRun`). Support the standard `OTEL_EXPORTER_OTLP_HEADERS` (e.g. Axiom's `Authorization` + `X-Axiom-Dataset`) via `Config.option` so auth is env-only, never in code. Document the Axiom recipe in `.env.example`; the endpoint stays unset for the operator's local-only default.

    ```ts
    export const telemetryLayer = Layer.unwrap(
      Effect.gen(function* () {
        const endpoint = yield* Config.option(Config.string("OTEL_EXPORTER_OTLP_ENDPOINT"));
        // OTEL_EXPORTER_OTLP_HEADERS: "k1=v1,k2=v2" — Axiom needs Authorization + X-Axiom-Dataset
        const headers = yield* Config.option(Config.string("OTEL_EXPORTER_OTLP_HEADERS"));
        return Option.match(endpoint, {
          onNone: () => Layer.empty, // local-only default: no network, no dep at runtime
          onSome: (baseUrl) =>
            Otlp.layerJson({
              baseUrl,
              resource: { serviceName: "telegram-claude" },
              headers: Option.getOrUndefined(Option.map(headers, parseOtlpHeaders)),
            }).pipe(Layer.provide(FetchHttpClient.layer)),
        });
      })
    );
    ```

### Before / After

Before — the only quality gate is lint/format; run outcomes and atomic writes are unverified, and an abort surfaces as a raw exit code with nothing pinning that it should be an interrupt:

```ts
// no *.test.ts anywhere; runner.ts:96-103 emits the 143 error with no test asserting otherwise
yield { kind: "error", message: `Process exited with code ${exitCode}` };
```

After — colocated `bun:test` files pin each invariant via injected fakes, no test dependency, no network, no subprocess:

```ts
// src/agent/runner.test.ts — blockingSpec + stopAgent asserts interrupt, not 143
expect(result.outcome).toBe("interrupted");
expect(out.every((e) => e.kind !== "error")).toBe(true);
```

### New dependencies

None. `bun:test` is built into the Bun runtime; `husky`, `@biomejs/biome`, and `ultracite` are already devDependencies. Docker/OTLP are optional and add no npm dependency to the bot itself (OTLP, if built, reuses the phase-1 Effect packages already pinned).

### Risks & mitigations

- **Testing `src/telegram.ts` may require injecting a fake ctx/api.** Keep it a thin seam: parameterize `streamToTelegram` on the sender/draft functions (or accept an injected `api`) rather than importing grammy's `Context` directly. This is a small refactor of the message-send calls, not a rewrite of the streaming loop.
- **husky hook must stay fast** to avoid commit friction. Fix + lint + typecheck only; never add `bun test` to the hook — run the suite in CI. If typecheck is the slow part, that is a pre-existing cost, not new.
- **Docker process-group kill differs from macOS.** The phase-2 SIGTERM→grace→SIGKILL escalation and detached process-group kill (`kill(-pid)`) must be validated **inside** the container — Linux child/grandchild reaping behaves differently than Bun `spawn` on Darwin. Add a manual container smoke check: start a long run, `/stop`, confirm no orphaned `claude`/`codex` processes remain.
- **`.data` path in tests must be injectable** so `state.test.ts`/`session-store.test.ts` never read or clobber the real `.data/state.json`. If the store path is currently a module-level constant, this phase depends on phase-6 having parameterized it.

### Verification

- `bun test` is green and covers: the exactly-once wide event, `interrupt`/`timeout` → null economics (never `0`), atomic state + session writes with no leftover `*.tmp`, corrupt-state preservation, and the 143→`interrupted` classification in the runner.
- `bun run lint` passes with the `*.test.ts` override; `.husky/pre-commit` fixes/lints/typechecks staged work fast (no test run).
- `bun run typecheck` stays clean with the new test files under `include`.
- (If Docker) the container boots, reuses the host `~/.claude` login with no API key set, processes a prompt end-to-end, and `.data/events.jsonl` + `.data/state.json` persist across a `docker compose down && up`.
- (If Docker) `/stop` during a run leaves no orphaned agent processes in the container (validates phase-2 SIGKILL escalation on Linux).

### Depends on

- **phase-3** — the `RunEvent` schema, single best-effort emit site, and `.data/events.jsonl` that `src/observability.test.ts` asserts against.
- **phase-6** — the `SessionStore` service (atomic unique-tmp writes, provider-namespaced keys) and injectable store/registry paths that `session-store.test.ts` and `runner.test.ts` require. Phase-2's typed interrupt/timeout causes are the behavior `runner.test.ts` pins; phase-6's registry seam is what lets the fake providers be injected.

## Open Questions

- ~~Effect adoption depth~~ — **RESOLVED 2026-07-08: full Effect foundation (phases 1-2 as written)**, with grammy wrapped as a scoped effect-client-wrapper `BotService` (phase 1) and bot.ts staying Promise-based behind the ManagedRuntime bridge. The plain-TS-only variant is rejected.
- ~~Multi-user planned?~~ — **RESOLVED 2026-07-08: yes, on the roadmap.** Phase 2's liveness model is generalized now to a keyed `RunRegistry` + `FiberSet` + `Semaphore` bound (see Phase 2 addendum). The single-global-process assumption is retired.
- ~~SDK history-file shapes~~ — **RESOLVED 2026-07-08 (as a hard gate): verify first, then delete.** An integration check must prove `@anthropic-ai/claude-agent-sdk@0.3.173` still writes `~/.claude/projects/**/*.jsonl` and `@openai/codex-sdk@0.139.0` still writes `~/.codex/sessions/**/rollout-*.jsonl` before the CLI history readers are removed in phases 4-5; keep the CLI paths until green.
- ~~Can TELEGRAM_CHAT_ID be reliably passed through each SDK's subprocess env…?~~ — **RESOLVED 2026-07-08: no env passthrough; carry the chatId in the prompt.** Research (Claude Agent SDK docs; Codex SDK source at `rust-v0.139.0`) confirmed there is no reliable top-level `options.env` that transitively reaches Bash/shell-tool grandchildren on the Claude side, and on Codex the ambient-env path is process-scoped (race-prone once multi-user ships) and its default `shell_environment_policy` strips `*TOKEN*` names. **Solution (both providers, one mechanism):** interpolate the per-run chatId into the instruction text via `buildFileSystemPrompt(chatId)` (Claude `systemPrompt` append / Codex first-turn prefix), and have `scripts/send-file-to-user.ts` read `--path`/`--chat` from argv and validate `--chat` against the allowed id. The chatId rides the prompt (per-run, multi-tenant-safe; it is non-secret and already in session history). `BOT_TOKEN` stays out of the prompt and reaches the script via inherited `process.env` — on Codex, harden with `config.shell_environment_policy.set` (or read the token from a file) to survive the `*TOKEN*` strip. No in-process MCP tool, no stdio MCP server, no new dependency. (See phase 4 change 6, phase 5 item 3.)
- ~~Confirm subscription-login-only + Docker scope.~~ — **RESOLVED 2026-07-08: subscription login only (no `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`, zero metered charges); Docker is NOT the target — deployment is a systemd-managed process on the host.** Therefore phase 7's Docker recipe + API-key-fallback work is **deferred** (not needed now). Keep the API-key-by-env-presence code path as latent scaffolding only. Phase 6/7 should instead document the systemd unit (service reads `~/.claude` / `~/.codex` on-disk login of the run-as user; `WorkingDirectory`/`EnvironmentFile` for `BOT_TOKEN`/`GROQ_API_KEY`; `Restart=on-failure`).
- ~~Codex SDK specifics against 0.139.0.~~ — **RESOLVED 2026-07-08 (verified in source).** (a) **`developer_instructions` does NOT exist** (no system-prompt hook on `CodexOptions`/`ThreadOptions`/`TurnOptions`) — keep the first-turn prompt prefix (phase 5 item 3). (b) **Prefix persists across `resumeThread`** via full rollout replay, **except** codex auto-compaction can evict the oldest user message (our turn-1 prefix) in very long threads (~20K user-msg budget); `AGENTS.md` is the durable fallback but rejected as default (repo pollution). (c) **`plan_ready` detection survives the parser deletion:** `.codex/plans/PLAN.md` writes surface as a typed `item.completed` `file_change` item with `changes[].path` (`FileUpdateChange{path,kind}`, status `completed`) — match the normalized suffix. Caveat: `file_change` only fires for apply_patch-style writes; a shell-redirection write shows up as `command_execution` (path in free text), so **keep an `fs.watch`/post-turn `stat` on `<cwd>/.codex/plans/PLAN.md` as a fallback** (phase 5 item 2).
- ~~Should the 10-minute run timeout become configurable?~~ — **RESOLVED 2026-07-08: timeout removed entirely; `RUN_TIMEOUT_MS` is opt-in, default unbounded** (Decisions #4). Still open: should the `already_running` / `at_capacity` guard emit a wide event (queue-contention visibility) or stay silent — and, once multi-user ships, does the unbounded-run-holds-a-`Semaphore`-permit starvation risk force an idle-timeout after all?
- ~~OTLP: ship the stub in phase 7 or document as future work?~~ — **RESOLVED 2026-07-08: ship it in phase 7, config-gated, OFF by default.** Local `.data/events.jsonl` stays the default/load-bearing path (operator runs local-only). The OTLP export is a one-env-var opt-in (`OTEL_EXPORTER_OTLP_ENDPOINT` + `OTEL_EXPORTER_OTLP_HEADERS`) so open-source users can forward the same `RunEvent` to a cloud OTel backend (Axiom, etc.) with no code change; unset = `Layer.empty`, zero overhead. Additive (never replaces the JSONL append), best-effort. (See phase 7 change 10.)
