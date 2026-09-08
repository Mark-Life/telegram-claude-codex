# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install          # install dependencies
bun run src/index.ts # start bot
bun --watch run src/index.ts  # dev mode (auto-reload on changes)
bun test             # run tests
bun run typecheck    # tsc --noEmit
bun run lint         # check lint/format (ultracite/biome)
bun run fix          # auto-fix lint/format issues
bun run backup       # snapshot .data/bot.db into .data/backups/
```

## Architecture

Telegram bot that bridges coding-agent CLIs (Claude Code + OpenAI Codex) with Telegram. Runs the active provider (SDK in-process for Claude, spawned CLI for Codex), normalizes its output to a provider-agnostic event model, and renders it into the chat. The active provider is swappable at runtime via `/provider`.

Two things shape the whole layout: **every conversation is a route** — user + chat + forum topic — so topics run in parallel with their own session, project, queue and compose draft; and **output is quiet by default** — a typing indicator, then one message with the answer, unless `/verbose` is on. All durable state is SQLite (`.data/bot.db`).

### Module Overview (src/)

- **index.ts** — Entry point. Opens/migrates `.data/bot.db` and runs the one-time legacy JSON import *before* any update is served; boots `AppConfig` + `BotService` through the Effect runtime (env validation fails fast); warns (non-blocking) on `codex login status` and on the BotFather flags `getMe` exposes read-only (privacy mode, join-groups); registers the command list in four scopes; starts polling. Shutdown: stop all runs → `runtime.dispose()` (stops the bot) → `closeDb()`.
- **bot.ts** — `createBot(token, allowedUserId, projectsDir)`: grammy instance, access-control middleware, reply-keyboard-button → command rewriting, then the `register*()` groups from `handlers/`. Registration order matters (topic-title bookkeeping → compose interceptor → commands → text → uploads) and is documented in place.
- **state.ts** — Thin wrapper over the settings table: `loadPersistedState()` plus setters for active project/provider and per-provider model/effort. `BotState` is derived from `loadBotState`, so the two can't drift.
- **telegram.ts** — `streamToTelegram({ctx, events, policy, route, …})`: typing ticker (the only progress signal under the quiet policy), 1.5s deferred-edit flush, `dispatchEvent` per event, `finalizeStream`. Re-exports `splitText` / `sendRichMarkdown` / `StreamResult`.
- **config.ts / runtime.ts / logger.ts / telemetry.ts / observability.ts** — Effect layers: env config (`AppConfig`), the `ManagedRuntime` all Promise-land code bridges through, console logging, optional OTLP forwarding, and the one-wide-event-per-run ledger.
- **transcribe.ts** — Voice message transcription via Groq Whisper (`whisper-large-v3-turbo`).

#### db/ — durable state (`.data/bot.db`, bun:sqlite, WAL)

- **client.ts** — `openDb(file)` (WAL, `foreign_keys`, 5s `busy_timeout`, migrate) plus the process-wide `getDb()` / `closeDb()` and `DATA_DIR` / `DB_FILE`. One handle ⇒ one write path.
- **migrations.ts** — `MIGRATIONS` applied in order by the `user_version` pragma, one transaction each. Append-only: never edit or reorder a shipped entry.
- **threads.ts** — Per-topic ops keyed `(chat_id, thread_id)`. `pin` upserts project+provider and NULLs `session_id` when either changed; `setSession` / `clearSession` / `list` / `drop`.
- **sessions.ts** — Per-project, provider-namespaced session ids — the store used everywhere *outside* a topic.
- **compose.ts** — Durable compose buffers keyed `(user_id, thread_id)`; a restart mid-compose keeps the draft.
- **settings.ts** — Key/value ops + typed `loadBotState` / `save*` helpers. `SETTING_KEYS`; models and efforts are one JSON blob each, so a new provider needs no migration. Every read is total (missing/corrupt ⇒ code default).
- **legacy-import.ts** — One-time `state.json` + `sessions.json` → db import, guarded by the `legacy_import_done` setting. Nothing already in the db is overwritten, the files stay on disk, `topics.json` is ignored.
- **provider-id.ts** — `isProviderId` (narrows db/JSON strings), `DEFAULT_PROVIDER`.
- **index.ts** — Flat function surface over the ops, bound to the process-wide handle (prepared statements cached per handle in a `WeakMap`).

#### telegram/ — chat I/O

- **route.ts** — `Route {chatId, threadId}`. `threadIdOf` (only `is_topic_message` counts — a reply thread in a non-forum supergroup carries `message_thread_id` too), `routeOf` / `requireRoute`, `threadOpts` (spread onto every direct `ctx.api.*` send or it lands in the wrong topic), `routeKey`.
- **render-policy.ts** — `Verbosity` (`"full"|"quiet"`, unset/unknown ⇒ quiet), `QUIET_POLICY` / `FULL_POLICY` (`{footer, technicalPhases, textDrafts}`), `parseVerbosity`, `policyFor`.
- **send.ts** — Route-aware `safeSendRichMessage` / `safeSendRichDraft` / `sendRichMarkdown` over `sendRichMessage(Draft)` (`{markdown}` for model text, `{html}` for bot chrome), plain-text fallback; `bestEffort`, `ignoreError`.
- **stream-state.ts** — Mutable `StreamCtx`, mode switching (text/tools/thinking) with per-phase draft slots, overflow splitting (runs even with drafts off), `finalizeStream` (footer gated on `policy.footer`).
- **stream-handlers.ts** — One handler per `AgentEvent` kind + `dispatchEvent`. Technical phases gated on `policy.technicalPhases` AND the provider capability; `error` is never gated; `plan_ready` stops the stream.
- **format.ts** — Constants (4000 chars, 1.5s edit, 300ms draft, 5s typing), `splitText`, HTML escaping/rendering, `formatFooter`.
- **bot-service.ts** — grammy bot as a scoped Effect resource; release calls `bot.stop()` exactly once.

#### handlers/ — commands and message handling

- **deps.ts** — `HandlerDeps` (bot, botId, projectsDir, token), `RunPipeline`, `PresentPlan`.
- **user-state.ts** — `UserState` keyed `(userId, chatId, threadId)` — it extends `RunKey`, so a state can be handed straight to the run registry. `stateFor` seeds a topic from its pinned `threads` row (else the global settings) and reads the compose buffer back from the db.
- **session-routing.ts** — The only module that reads or writes a session id: topic ⇒ `threads` row, otherwise ⇒ `sessions` table. `resolveSessionId`, `adoptSession`, `rememberRunSession`, `forgetSession`, `setRouteProject`.
- **run.ts** — Prompt pipeline: `handlePrompt` (pending-plan feedback → queue when this conversation is busy → `runAndDrain`), `runSinglePrompt` (one `runAgent` + `streamToTelegram` + one wide `RunEvent` on every path), queue callbacks, `registerTextHandler`.
- **verbosity.ts** — `/verbose` toggle, `currentVerbosity`, `currentRenderPolicy` (read fresh per run).
- **topic-titles.ts** — Tracks topics Telegram named implicitly (`forum_topic_created.is_name_implicit`; a `forum_topic_edited` drops the claim) and renames one from its first text/voice message via `editForumTopic`. Fired, not awaited; every failure swallowed.
- **session-commands.ts** — `/start`, `/provider`, `/model`, `/effort`, `/stop`, `/status`, `/help`, `/new`, `/compact`.
- **projects.ts** — `/projects` picker + pinned project message, `/branch`, `/pr`.
- **history.ts**, **plan.ts**, **compose.ts**, **uploads.ts**, **helpers.ts** — session browser, plan approval UI, `/compose`+`/send`+`/cancel`, voice/file/photo intake, shared keyboards/regexes/formatting.

#### agent/ — provider abstraction layer

- **types.ts** — `AgentEvent` (normalized event model, incl. the compaction-only `compact_done`/`compact_failed` pair aliased as `CompactEvent`), `ProviderId` (`"claude"|"codex"`), `RunKey` (`{userId, chatId, threadId}` — the conversation a run belongs to), `RunOptions extends RunKey`, `ProviderCapabilities` (`{compaction, cost, planMode, subagents, thinking}`), `SessionInfo`, `ProviderSpec`, `AgentProvider` (optional `compact`, same shape as an sdk `run`).
- **runner.ts** — Generic run lifecycle feeding the run's bounded event queue: `spawnAndStream` for a `cli` spec (stdout line buffering, capped stderr, SIGTERM + 3s kill grace) and `streamProvider` for an `sdk` spec (scope-close aborts the SDK's `AbortController`). A run is unbounded in wall time; `/stop` and a new prompt in the same slot are what end it.
- **run-registry.ts** — Run slots keyed by `runKeyOf({userId, chatId, threadId})` = `userId:chatId:threadId|"main"`: a `FiberMap` gives single-flight *per conversation* (a new run in the same slot interrupts the old one; sibling topics are untouched), a `Semaphore` enforces the global `MAX_CONCURRENT_RUNS` (`AtCapacity` when full), `emitTerminal` turns any fiber exit into one terminal `AgentEvent` and ends the queue, `stopAll` bounds the shutdown drain.
- **session-store.ts** — Effect service over db/sessions.ts (the non-topic store only); `agent/index.ts` taps it on the event stream.
- **topic-title.ts** — Best-effort topic title from a conversation's first message: one turn, no tools, no MCP, no session file (Codex additionally read-only/`approvalPolicy:"never"`), cheapest model per provider (`haiku` / `gpt-5.6-luna`), 15s timeout. Runs outside the run registry; every failure returns `null`.
- **claude.ts** — Claude `AgentProvider` (`kind:"sdk"`): drives `query()` from `@anthropic-ai/claude-agent-sdk`, mapping typed SDK messages onto `AgentEvent` (partial `stream_event`→text/thinking, complete assistant blocks→tool_use, `.claude/plans/`/`ExitPlanMode` plan detection). No apiKey (subscription auth). Passes `AppConfig.claudeSettings` via `options.settings`. Caps: all true. `compact()` resumes the session with the `/compact` slash command as the prompt (the SDK has no compaction control request) and folds `compact_boundary` / `status.compact_result` into one terminal event.
- **claude-settings.ts** — `DEFAULT_CLAUDE_SETTINGS` (hardened SDK `Settings`: denies interactive/harness tools + plan mode (`Enter/ExitPlanMode`), disables bundled skills/remote-control/artifacts, `effortLevel:"high"`; workflows left ON). Overridable at boot via `CLAUDE_SETTINGS_JSON` (JSON overlay; top-level keys replace, `permissions` merges one level deep).
- **claude-history.ts** — `~/.claude/projects/...` session reader (the SDK writes the same store; `persistSession` defaults on).
- **codex.ts** — Codex `AgentProvider`: `codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check` (resume via `codex exec resume <id> …`; cwd comes from the spawn). JSONL→`AgentEvent` parser, `.codex/plans/`→`plan_ready` detection. File-send + plan-convention instructions injected via first-turn prompt prefix (Codex has no `--append-system-prompt`). Caps: `{compaction:false, planMode:true, thinking:true, cost:false, subagents:false}` — the Codex SDK exposes no compaction API, so `/compact` declines for Codex.
- **codex-history.ts** — `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` session reader; project filtering via recorded cwd (realpath-normalized).
- **executor-mcp.ts** — Optional cloud Executor (executor.sh) MCP wiring. `buildExecutorMcpServers({url, token})` → Claude-SDK `mcpServers` shape (`{type:"http", url, headers}`), undefined when `EXECUTOR_MCP_URL`/`EXECUTOR_API_KEY` are absent/blank. `readExecutorMcpServers` reads them off `AppConfig`; claude.ts passes the map straight to `options.mcpServers`, codex.ts feeds it through `toCodexMcpServers` (→ `{url, http_headers, default_tools_approval_mode:"auto"}`) into an `mcp_servers` config override. Tools surface as `mcp__executor__execute` / `mcp__executor__resume`.
- **compact.ts** — `compactSpec(id, compact)` dresses a provider's compaction as an `sdk` run spec (so the registry's single-flight/capacity/interrupt rules apply unchanged); `foldCompactEvents` folds the run's stream into one `CompactEvent`, turning an interrupt/crash into a failure with the run's own copy.
- **registry.ts** — `getProvider(id)`, `listProviders()` (claude + codex registered).
- **index.ts** — Public surface: `runAgent(providerId, opts)` (taps session ids into the per-project store only when `opts.threadId === null`), `compactAgent(providerId, opts)`, `stopAgent(key, reason)`, `hasActiveProcess(key)`, `stopAll`, `listAllSessions(p)`, `getSessionProject(p, id)`, `clearSessionCache(p)`, `getCapabilities(p)`, `supportsCompaction(p)`, `getModels(p)`, `getEffortLevels(p)`, `getDefaultEffort(p)`.

### Data Flow

```
Update → bot.ts (access control, button→command)
  → telegram/route.ts: {chatId, threadId} → handlers/user-state: UserState (= RunKey)
  → text: handlers/run.handlePrompt → session-routing.resolveSessionId
      → agent.runAgent(provider, opts) → run-registry slot → runner / SDK
      → telegram.streamToTelegram(policy from /verbose, route) → that chat+topic
  → voice: handlers/uploads → transcribe.ts (Groq Whisper) → same flow
```

### Key Patterns

- **Route-keyed conversations**: `UserState`, the run slot, the session id, the compose buffer and every send are keyed by (user, chat, forum topic). `threadId: null` — private chat, plain group, General topic — keeps the pre-topics behaviour. `ctx.reply` carries `message_thread_id` itself; every direct `ctx.api.*` call must spread `threadOpts(route)`.
- **Session continuity**: A topic's session id lives on its `threads` row; outside a topic it is per project per provider in `sessions`. Read and write it only through `handlers/session-routing.ts`, never the two stores directly. Re-pinning a topic with a different project or provider NULLs its session id, so the next prompt starts fresh there. `/compact` summarizes in place — the id never changes and no store is touched, so a failed compaction leaves the conversation exactly as it was.
- **Runs**: single-flight per conversation, parallel across topics, globally capped by `MAX_CONCURRENT_RUNS`. A second message in the same conversation is queued; `/stop`, `/new` and a provider switch interrupt that conversation's run only.
- **Quiet by default**: `RenderPolicy` (from the `verbosity` setting, unset ⇒ quiet) decides what reaches the chat — drafts, technical phases and the footer are off, leaving a typing indicator and the final answer. Errors and overflow splitting are never gated. `/verbose` flips it globally.
- **Provider abstraction**: Each provider is an `AgentProvider` (spec + capabilities + history reader) in the registry; the generic runner drives it and emits normalized `AgentEvent`s — the seam that decouples the handlers and telegram layer from any specific CLI. UI features are gated on `getCapabilities(activeProvider)` (e.g. Codex shows duration only, no cost/turns; shows thinking; hides subagents).
- **Persistence**: bun:sqlite, one process-wide handle, schema versioned by `user_version`. The old JSON stores are imported once at boot and then ignored; they stay on disk as a copy. Db reads are total — a corrupt or unknown value degrades to a default rather than throwing.
- **Streaming**: AsyncGenerator pattern — the registry's queue is drained as events, `telegram/stream-handlers.ts` consumes them and sends via `sendRichMessage` / `sendRichMessageDraft` (`{markdown}` for model text, `{html}` for bot chrome), with a plain-text fallback on failure.


## Local Effect Source

Two Effect checkouts are cloned locally for reference (we're mid-transition, so both matter):

- **v3** (current stable): `~/.local/share/effect-solutions/effect` — `effect@3.21.0`, the main `Effect-TS/effect` repo.
- **v4** (smol / next): `~/.local/share/effect-solutions/effect-smol` — `effect@4.0.0-beta.x`, the `Effect-TS/effect-smol` repo.

Use these to explore APIs, find usage examples, and understand implementation details when the documentation isn't enough. Check the version that matches the code you're touching; when in doubt, consult both.

## Code Quality:

When writing or reviewing TypeScript/full-stack code, follow the `quality-code` skill (`.agents/skills/quality-code/SKILL.md`). It loads on demand — invoke it for the full standards.
