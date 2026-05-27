# Multi-Provider Migration Plan (Claude Code + Codex)

Step-by-step plan to make the Telegram bot support multiple coding-agent CLIs, starting with adding Codex alongside Claude Code. Companion to [claude-code-functions.md](./claude-code-functions.md) (the feature inventory).

## Locked decisions

| Decision | Choice | Consequence |
|----------|--------|-------------|
| Provider selection | **Global toggle** — one active provider for the whole bot, flipped via `/provider` | Single `activeProvider` in state. Sessions still namespaced by provider (a project can hold both a Claude and a Codex session). |
| Codex event schema | **Spike first** — verify real `codex exec --json` output before building the adapter | Plan opens with a research phase; adapter designed against captured JSONL, not docs. |
| Scope | **Telegram bot only** (`src/`) | `scripts/auto-pr/` stays Claude-only. Abstraction lives in `src/agent/`. |
| Plan mode for Codex | **Research stage now, implementation deferred to a placeholder** | Phase 1 = research. Phase 6 = placeholder, filled in from Phase 1 output. Codex ships with plan mode disabled until then. |

## Target architecture

### The seam
`ClaudeEvent` (src/claude.ts:72-98) is already a normalized internal event model — `telegram.ts` only ever consumes that, never the CLI. That is the adapter boundary. Rename `ClaudeEvent` → `AgentEvent`; every provider's parser maps its raw CLI output into `AgentEvent`. `telegram.ts` stays provider-agnostic.

### Module layout (new `src/agent/`)

| File | Responsibility |
|------|----------------|
| `src/agent/types.ts` | `AgentEvent` (renamed), `ProviderId`, `RunOptions`, `ProviderCapabilities`, `AgentProvider`, `ProviderSpec`. |
| `src/agent/runner.ts` | Generic process lifecycle: per-user process map, `AbortController`, 10-min timeout, stdout line-buffering, stderr capture. Parameterized by a `ProviderSpec`. Owns the **global one-process-per-user invariant** (across providers). |
| `src/agent/claude.ts` | Claude `ProviderSpec`: `buildArgs`, `buildEnv` (`CLAUDECODE` strip), stream-json parser. Migrated from `src/claude.ts`. Plan detection (`.claude/plans/` + `ExitPlanMode`) lives in its parser. |
| `src/agent/claude-history.ts` | Claude session reader. Migrated from `src/history.ts` (`~/.claude/projects/...`). |
| `src/agent/codex.ts` | Codex `ProviderSpec`: `buildArgs` (`codex exec --json --cd`), `buildEnv` (`CODEX_HOME`/`OPENAI_API_KEY` hygiene), JSONL parser. **New.** |
| `src/agent/codex-history.ts` | Codex session reader (`~/.codex/sessions/YYYY/MM/DD/...`). **New.** |
| `src/agent/registry.ts` | `Record<ProviderId, AgentProvider>`, `getProvider(id)`, `listProviders()`. |
| `src/agent/index.ts` | Public surface for `bot.ts`: `runAgent(providerId, opts)`, `stopAgent(userId)`, `hasActiveProcess(userId)`, `stopAll()`, `listAllSessions(providerId)`, `getSessionProject(providerId, id)`, `clearSessionCache()`, `getCapabilities(providerId)`. |

### Interfaces (sketch)

```ts
type ProviderId = "claude" | "codex";

interface RunOptions {
  userId: number; prompt: string; projectDir: string;
  chatId: number; sessionId?: string;
}

interface ProviderCapabilities {
  planMode: boolean; thinking: boolean; cost: boolean; subagents: boolean;
}

interface ProviderSpec {                         // what runner.ts needs
  id: ProviderId;
  command: string;                               // "claude" | "codex"
  buildArgs(opts: RunOptions): string[];
  buildEnv(opts: RunOptions, base: Record<string,string|undefined>): Record<string,string>;
  createParser(): (lines: string[]) => Generator<AgentEvent>;
}

interface AgentProvider extends ProviderSpec {
  displayName: string;
  capabilities: ProviderCapabilities;
  listAllSessions(): SessionInfo[];
  getSessionProject(sessionId: string): string | undefined;
  clearSessionCache(): void;
}
```

Process control (`stopAgent`, `hasActiveProcess`, `stopAll`) stays generic in `runner.ts`, keyed by `userId` only — the one-process-per-user rule holds across providers.

### State model changes (`src/state.ts`)

```ts
interface PersistedState {
  activeProvider: ProviderId;                    // NEW
  activeProject: string;
  sessions: Record<ProviderId, Record<string,string>>;  // CHANGED: was Record<string,string>
}
```

In-memory: `sessions: Record<ProviderId, Map<string,string>>`.
`updateSession(state, providerId, projectPath, sessionId?)` gains a `providerId` arg.

**Backward-compat migration** in `loadPersistedState()`: old shape (`sessions: Record<string,string>`, no `activeProvider`) → `{ activeProvider: "claude", sessions: { claude: <old>, codex: {} } }`. One-time, on first load.

## Phased plan

Phases 0, 1, 2 are independent and can run in parallel. Phase 4 depends on 0 + 2. Phase 6 depends on 1.

### Phase 0 — Codex CLI spike (research, no product code)
**Problem:** `claude-code-functions.md` maps Codex from docs, not observed output. The adapter cannot be built reliably without the real `codex exec --json` event schema.
**Do:**
- Confirm/install Codex CLI; verify the `codex login` flow (browser-based CLI login, same model as Claude Code CLI login today — no API key).
- Run `codex exec --json` against representative prompts: plain text reply, a tool/shell command, a file edit, multi-turn `codex exec resume`, an error case.
- Capture raw JSONL → `docs/plan/codex/samples/*.jsonl`.
- Document: event types & shapes, where the session ID appears, resume mechanics, tool/command event shape, delta-level vs message-level text, cost/usage availability, thinking/reasoning events.
**DoD:** `docs/plan/codex/codex-schema.md` written; Codex columns in `claude-code-functions.md` updated with verified facts. Enough detail to write `src/agent/codex.ts` without guessing.

### Phase 1 — Codex plan-mode research (research, no product code)
**Problem:** Claude plan mode = Claude writes to `.claude/plans/`, calls `ExitPlanMode` → parser emits `plan_ready` → bot presents plan with action buttons (src/claude.ts:210-220, src/bot.ts:658-792). Codex has neither the directory convention nor the tool.
**Find out:**
- Does Codex have any native plan / approval / dry-run concept?
- How does `codex exec` behave when prompted to "plan only, do not implement"?
- Can "plan is ready" be reliably detected from JSONL (file-write event, sentinel marker in final message, protocol event)?
- Does Codex expose an app-server / structured-approval mode?
**Possible outcomes:**
1. Prompt convention + known path (`.codex/plans/`) + file-write detection.
2. Sentinel marker in the final assistant message.
3. Codex has a native mechanism to map onto `plan_ready`.
4. No reliable path — plan mode stays Claude-only.
**DoD:** Phase 6 below rewritten from a placeholder into a concrete implementation stage (chosen outcome, exact detection logic, files to touch). Until then Codex ships with `capabilities.planMode: false`.

### Phase 2 — Provider abstraction refactor (Claude-only, zero behavior change)
**Do:**
- Create `src/agent/types.ts`; rename `ClaudeEvent` → `AgentEvent` (keep all variants).
- Extract generic lifecycle from `src/claude.ts` into `src/agent/runner.ts`.
- Move Claude-specific logic into `src/agent/claude.ts` as a `ProviderSpec`/`AgentProvider`.
- Move `src/history.ts` into `src/agent/claude-history.ts`; wire into the Claude provider.
- Add `src/agent/registry.ts` (Claude only) and `src/agent/index.ts`.
- Repoint `bot.ts` imports: `runClaude` → `runAgent("claude", ...)`, `stopClaude` → `stopAgent`, history functions via `agent/index.ts`.
- Delete old `src/claude.ts`, `src/history.ts`.
**DoD:** bot behaves identically to today; `bun run typecheck` + `bun run lint` pass; manual smoke test (text prompt, tool use, `/history`, `/stop`, plan flow) green.

### Phase 3 — State model + `/provider` selection UI
**Do:**
- `src/state.ts`: add `activeProvider`, namespace `sessions` by provider, implement backward-compat migration.
- `src/bot.ts`: add `activeProvider` to `UserState`; `/provider` command + inline keyboard (lists `registry` providers); thread `providerId` through `handlePrompt` → `runAndDrain` → `runAgent` and through `updateSession`; show provider in `/status`, `/help`, the pinned project message, and the startup message.
- `src/index.ts`: register `provider` bot command.
- Switching provider while a process runs: auto-stop the running process; the confirmation message states that the previous session was stopped and the provider was switched.
**DoD:** `/provider` toggles + persists + survives restart; Claude remains default; existing sessions still resume. (Codex selectable only once Phase 4 registers it.)

### Phase 4 — Codex provider implementation
Depends on Phase 0 + Phase 2.
**Do:**
- `src/agent/codex.ts`: `buildArgs` (`codex exec --json --cd <dir>`, `resume <sessionId>`, headless approval/sandbox flags), `buildEnv` (env hygiene), JSONL parser mapping captured Codex events → `AgentEvent`.
- `src/agent/codex-history.ts`: dated-path session reader.
- Register Codex in `registry.ts` with verified `capabilities` (`planMode: false` for now).
- File-sending capability (`buildFileSystemPrompt`, src/claude.ts:266-275): Codex has no `--append-system-prompt` — deliver via `AGENTS.md`, a Codex config profile, or prompt prefixing (decide from Phase 0).
- `src/index.ts`: optional warn-only check that the `codex` CLI is installed and logged in — Claude-only deploys still start. No API key env var; auth is CLI-managed (`codex login`), same as Claude Code today.
**DoD:** `/provider` → Codex; text prompts stream; `resume` continues a conversation; `/history` lists Codex sessions; `/stop` works; `/new` starts fresh.

### Phase 5 — Capability gating & UX polish
**Do:**
- Plan buttons + `plan_ready` handling gated on `capabilities.planMode` (Codex: hidden).
- Footer (src/telegram.ts:602-625) tolerates missing cost/turns — mostly already does; verify under Codex.
- Thinking panel hidden when `capabilities.thinking` is false.
- Subagent messages hidden when `capabilities.subagents` is false.
**DoD:** no Claude-only feature throws under Codex; both providers give a clean UX.

### Phase 6 — Codex plan mode  *(IMPLEMENTED — Outcome 1)*
Chosen approach (from [codex-plan-mode.md](./codex-plan-mode.md)): **organic plan mode**, symmetric with Claude (no `/plan` command).
- **Detection:** Codex's first-turn prompt prefix teaches it the convention "when asked to plan without implementing, write the plan to `./.codex/plans/PLAN.md` and stop." The parser in `src/agent/codex.ts` emits `{ kind: "plan_ready", planPath }` when a `file_change` event's path includes `.codex/plans/` (deduped once per run). Mirrors Claude's `.claude/plans/` + `ExitPlanMode` detection; the file write itself is the trigger (no exit-plan signal needed).
- **`bot.ts` changes:** none — the plan review/approve/execute UI is provider-agnostic and already gated on `capabilities.planMode` (Phase 5).
- **Capability:** `capabilities.planMode` flipped to `true` for Codex.
- **Verified:** live `codex exec` planning run wrote `PLAN.md`, made no source edits, and the parser emitted `plan_ready`.
- **Caveat:** relies on model compliance (writing to the path). Graceful degrade if it doesn't (run completes normally, no plan buttons). A prose-fallback (treat final message as the plan) is documented but deferred until real non-compliance is observed.

### Phase 7 — Docs & cleanup
**Do:** update `CLAUDE.md` (architecture section, `src/agent/` layout, provider concept), `README.md` (`/provider`, `codex login` setup), env var docs. Remove any remaining Claude-specific naming in shared code.
**DoD:** docs match shipped behavior.

## Cross-cutting concerns

- **No test suite exists.** Verification per phase = `bun run typecheck` + `bun run lint` + manual Telegram smoke test. Consider adding parser unit tests against the captured JSONL samples during Phase 4.
- **One process per user is global**, not per-provider — enforced in `runner.ts`. `/stop` stops whichever provider is running.
- **History `/history` scope:** lists the *active provider's* sessions only (simpler). Showing both with a provider badge is a possible later enhancement.
- **`send-file-to-user.ts`** is already provider-agnostic (needs only `BOT_TOKEN` + `TELEGRAM_CHAT_ID`); only the *injection mechanism* of its instructions differs per provider (Phase 4).
- **Auth model:** both providers use CLI-managed login, not API keys — Claude Code CLI login today, `codex login` for Codex (run once on the host, browser-based flow). The bot never handles credentials or API key env vars. Auth checks are warn-only so a host with only one provider logged in still starts.
- **Extensibility:** the registry pattern supports N providers — adding a third (e.g. Gemini CLI) later = one new `ProviderSpec` + registry entry, no `bot.ts`/`telegram.ts` changes.

## Resolved questions

1. **Codex headless safety** — **RESOLVED: use `--dangerously-bypass-approvals-and-sandbox` + `--skip-git-repo-check`.** Rationale: parity with the bot's existing Claude config (`--dangerously-skip-permissions`), which already runs fully unsandboxed on this host; the bot is operated by a single trusted user on their own machine. The safer `--sandbox workspace-write` (writes confined to the project, no network) remains a drop-in alternative if the deployment context changes — swap the flag in `src/agent/codex.ts` `buildArgs`.
