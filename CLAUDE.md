# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install          # install dependencies
bun run src/index.ts # start bot
bun --watch run src/index.ts  # dev mode (auto-reload on changes)
bun run lint         # check lint/format (ultracite/biome)
bun run fix          # auto-fix lint/format issues
```

## Architecture

Telegram bot that bridges coding-agent CLIs (Claude Code + OpenAI Codex) with Telegram. Spawns the active provider's CLI as a child process, streams its JSON output, normalizes it to a provider-agnostic event model, and progressively edits Telegram messages with the response. The active provider is swappable at runtime via `/provider`.

### Module Overview (src/)

- **index.ts** — Entry point. Validates env vars (`BOT_TOKEN`, `ALLOWED_USER_ID`, `GROQ_API_KEY`, optional `PROJECTS_DIR`), warns (non-blocking) if `codex login status` fails, registers commands (incl. `/provider`), starts bot.
- **bot.ts** — Grammy bot setup, command handlers (`/projects`, `/provider`, `/stop`, `/status`, `/new`, …), message routing, capability gating. Maintains per-user state: `activeProject` path, `activeProvider`, and per-provider `sessions` maps.
- **state.ts** — Persisted bot state (`.data/state.json`). Holds `activeProject`, `activeProvider`, and provider-namespaced `sessions`. One-time migration of the old flat-session shape → `{activeProvider:"claude", sessions:{claude:<old>, codex:{}}}`.
- **telegram.ts** — Consumes the normalized `AgentEvent` stream via `sendMessageDraft` (300ms interval) with fallback to progressive `editMessageText`. Auto-splits at 4000 chars. Converts Markdown → Telegram HTML. Falls back to plain text on parse failure. Footer/thinking/subagent/plan UI gated on the active provider's capabilities.
- **transcribe.ts** — Voice message transcription via Groq Whisper (`whisper-large-v3-turbo`).

#### agent/ — provider abstraction layer

- **types.ts** — `AgentEvent` (normalized event model), `ProviderId` (`"claude"|"codex"`), `RunOptions`, `ProviderCapabilities` (`{cost, planMode, subagents, thinking}`), `SessionInfo`, `ProviderSpec`, `AgentProvider`.
- **runner.ts** — Generic process lifecycle: global one-process-per-user (keyed by userId, across providers), AbortController, 10-min timeout, stdout line-buffering, stderr capture. AsyncGenerator yielding `AgentEvent`.
- **claude.ts** — Claude `AgentProvider` (`kind:"sdk"`): drives `query()` from `@anthropic-ai/claude-agent-sdk`, mapping typed SDK messages onto `AgentEvent` (partial `stream_event`→text/thinking, complete assistant blocks→tool_use, `.claude/plans/`/`ExitPlanMode` plan detection). No apiKey (subscription auth). Passes `AppConfig.claudeSettings` via `options.settings`. Caps: all true.
- **claude-settings.ts** — `DEFAULT_CLAUDE_SETTINGS` (hardened SDK `Settings`: denies interactive/harness tools + plan mode (`Enter/ExitPlanMode`), disables bundled skills/remote-control/artifacts, `effortLevel:"high"`; workflows left ON). Overridable at boot via `CLAUDE_SETTINGS_JSON` (JSON overlay; top-level keys replace, `permissions` merges one level deep).
- **claude-history.ts** — `~/.claude/projects/...` session reader (the SDK writes the same store; `persistSession` defaults on).
- **codex.ts** — Codex `AgentProvider`: `codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check` (resume via `codex exec resume <id> …`; cwd comes from the spawn). JSONL→`AgentEvent` parser, `.codex/plans/`→`plan_ready` detection. File-send + plan-convention instructions injected via first-turn prompt prefix (Codex has no `--append-system-prompt`). Caps: `{planMode:true, thinking:true, cost:false, subagents:false}`.
- **codex-history.ts** — `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` session reader; project filtering via recorded cwd (realpath-normalized).
- **registry.ts** — `getProvider(id)`, `listProviders()` (claude + codex registered).
- **index.ts** — Public surface: `runAgent(providerId, opts)`, `stopAgent`, `hasActiveProcess`, `stopAll`, `listAllSessions(p)`, `getSessionProject(p, id)`, `clearSessionCache(p)`, `getCapabilities(p)`.

### Data Flow

```
User message → bot.ts (access control + routing)
  → text: handlePrompt() → runAgent(activeProvider) → provider spec (spawn CLI via runner) → telegram.ts (stream to chat)
  → voice: transcribe.ts (Groq Whisper) → handlePrompt() → same flow
```

### Key Patterns

- **Provider abstraction**: Each provider is an `AgentProvider` (spec + capabilities + history reader) in the registry. The generic `runner.ts` spawns it and emits normalized `AgentEvent`s — the seam that decouples bot.ts/telegram.ts from any specific CLI. UI features are gated on `getCapabilities(activeProvider)` (e.g. Codex shows duration only, no cost/turns; shows thinking; hides subagents).
- **Session continuity**: Session IDs stored per provider per project in user state. Follow-up messages resume the same conversation for the active provider.
- **One process per user**: Global, across providers — a new prompt (or a `/provider` switch) aborts any running process for that user.
- **Streaming**: AsyncGenerator pattern — the runner yields events, telegram.ts consumes and streams via `sendMessageDraft` (with edit-based fallback). Draft support auto-detected on first event.
- **HTML formatting**: Markdown converted via regex with placeholder system — code blocks extracted first to avoid nested regex conflicts, then reinserted after other transformations.


## Local Effect Source

Two Effect checkouts are cloned locally for reference (we're mid-transition, so both matter):

- **v3** (current stable): `~/.local/share/effect-solutions/effect` — `effect@3.21.0`, the main `Effect-TS/effect` repo.
- **v4** (smol / next): `~/.local/share/effect-solutions/effect-smol` — `effect@4.0.0-beta.x`, the `Effect-TS/effect-smol` repo.

Use these to explore APIs, find usage examples, and understand implementation details when the documentation isn't enough. Check the version that matches the code you're touching; when in doubt, consult both.

## Code Quality:

When writing or reviewing TypeScript/full-stack code, follow the `quality-code` skill (`.agents/skills/quality-code/SKILL.md`). It loads on demand — invoke it for the full standards.
