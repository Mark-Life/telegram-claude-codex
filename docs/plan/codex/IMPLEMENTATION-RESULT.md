# Multi-Provider Migration — Implementation Result

Date: 2026-05-21
Branch: `feat/codex`
Status: **All 7 phases complete.** Bot now supports Claude Code and OpenAI Codex as runtime-swappable providers.

Companion docs: [migration-plan.md](./migration-plan.md) · [codex-schema.md](./codex-schema.md) · [codex-plan-mode.md](./codex-plan-mode.md) · [claude-code-functions.md](./claude-code-functions.md)

---

## TL;DR

- Telegram bot was Claude-only; it now drives **either Claude Code or Codex**, switched live via `/provider`, with one global active provider.
- A new `src/agent/` layer normalizes every provider's CLI output into one internal `AgentEvent` model; `telegram.ts` stays provider-agnostic.
- Sessions are namespaced per provider; old state auto-migrates. Plan mode works for **both** providers (organic, no `/plan` command).
- Verification per phase: `bun run typecheck` (exit 0) + `bun run lint` (0 errors, 53 warnings = baseline) + parser unit checks against real captured Codex JSONL + **live `codex exec` runs** (text, resume, plan).
- No hard blockers. Codex CLI v0.132.0 is installed and logged in (ChatGPT).

---

## What shipped, by phase

| Phase | Scope | Outcome |
|-------|-------|---------|
| **0** | Codex CLI spike (research) | Captured real `codex exec --json` JSONL → `codex-schema.md` + 21 sample files. Documented event schema + Codex→`AgentEvent` mapping. |
| **1** | Codex plan-mode research | Recommended **Outcome 1** (`.codex/plans/PLAN.md` + `file_change` detection) → `codex-plan-mode.md`. |
| **2** | Provider abstraction refactor (Claude-only, zero behavior change) | Created `src/agent/` (types/runner/claude/claude-history/registry/index). Renamed `ClaudeEvent`→`AgentEvent`. Deleted old `src/claude.ts`, `src/history.ts`. |
| **3** | State model + `/provider` UI | `activeProvider` + per-provider session namespacing + backward-compat migration. `/provider` command + inline keyboard; provider surfaced in `/status`, `/help`, pinned message, startup. |
| **4** | Codex provider implementation | `src/agent/codex.ts` + `codex-history.ts`. JSONL parser, `exec`/`exec resume`, env hygiene, first-turn prompt-prefix for file-send. Registered in registry. Warn-only `codex login status` check on startup. |
| **5** | Capability gating & UX polish | Threaded `ProviderCapabilities` into `telegram.ts`. Gated cost/turns footer, thinking panel, subagent messages, and plan UI on capabilities. Genericized shared strings. Fixed Codex history cwd realpath matching. |
| **6** | Codex plan mode | Taught Codex the `.codex/plans/` convention via prompt prefix; parser emits `plan_ready` on that file write (deduped). Flipped `capabilities.planMode: true`. Zero `bot.ts` changes. Live-tested end-to-end. |
| **7** | Docs & cleanup | Updated `CLAUDE.md`, `README.md`; genericized stale "Claude" comments in shared code. |

---

## Architecture (as shipped)

```
src/agent/
├── types.ts          AgentEvent (the seam), ProviderId, RunOptions, ProviderCapabilities, SessionInfo, ProviderSpec, AgentProvider
├── runner.ts         Generic process lifecycle: global one-process-per-user, AbortController, 10-min timeout, line-buffering, stderr capture
├── claude.ts         Claude AgentProvider — stream-json parser + .claude/plans+ExitPlanMode plan detection. caps: all true
├── claude-history.ts ~/.claude/projects/... session reader
├── codex.ts          Codex AgentProvider — codex exec --json parser + .codex/plans plan detection. caps: {planMode:T, thinking:T, cost:F, subagents:F}
├── codex-history.ts  ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl reader (cwd realpath-filtered)
├── registry.ts       getProvider(id), listProviders() — claude + codex
└── index.ts          Public surface: runAgent, stopAgent, hasActiveProcess, stopAll, listAllSessions, getSessionProject, clearSessionCache, getCapabilities
```

Flow: `bot.ts handlePrompt() → runAgent(state.activeProvider, opts) → provider spec (spawned by runner.ts) → AgentEvent stream → telegram.ts (capability-gated rendering)`.

Adding a 3rd provider (e.g. Gemini CLI) = one new `ProviderSpec` + registry entry. No `bot.ts`/`telegram.ts` changes.

---

## Key decisions made (orchestrator's calls)

1. **Headless safety (the plan's one open question): use `--dangerously-bypass-approvals-and-sandbox` + `--skip-git-repo-check`.** Parity with the existing Claude `--dangerously-skip-permissions`, which already runs unsandboxed on this single-user host. Safer `--sandbox workspace-write` noted as a one-line swap if the deployment changes.
2. **Combined Phase 0 + Phase 1 into one research agent** — plan-mode research depends on the event schema, and both poke the same CLI; avoided redundant spikes.
3. **Ran Phase 0+1 (research) in parallel with Phase 2 (refactor)** — disjoint paths (`docs/` vs `src/`). Phases 3→4→5→6→7 ran sequentially (overlapping files / dependencies).
4. **Codex omits `-C/--cd` entirely** — research found `codex exec resume` rejects it. The runner already spawns with `cwd: projectDir`, so cwd is consistent for both first-turn and resume.
5. **Plan mode is organic for both providers (no `/plan` command).** Claude has no explicit trigger today (it's user-phrasing-driven); making Codex symmetric was cleaner than adding a Codex-only command. Codex is taught the path convention via an always-present (first-turn) prompt prefix.
6. **`capabilities.cost: false` for Codex** — Codex emits token counts but no USD cost/turn-count. Footer shows duration only (measured locally via a `createParser()` closure timestamp).
7. **File-send + plan-convention instructions injected via first-turn prompt prefix** — Codex has no `--append-system-prompt`; chose prompt-prefixing over writing `AGENTS.md` (no repo pollution). Resume retains it via session context.
8. **`registry.ts` uses `Partial<Record<ProviderId, AgentProvider>>`** — avoids a fake entry while only Claude existed (Phase 2); both keys populated now.

---

## Verification status

- **Typecheck:** `bun run typecheck` → exit 0 (clean) at every phase and final.
- **Lint:** `bun run lint` → 0 errors, 53 warnings. Baseline was 51; the +2 are an inline callback regex (`useTopLevelRegex`, consistent with 10 existing ones) and parser cognitive-complexity (matches the Claude parser). No new error *types*.
- **Codex parser:** unit-checked against all 7 real sample JSONL files (`docs/plan/codex/samples/`) — correct `AgentEvent` sequences for plain text, shell, file-edit, resume (stable session id), error (single, deduped), reasoning, and plan.
- **Live Codex runs:** real `codex exec` first-turn + `resume` (stable `thread_id`), and a real planning run that wrote `.codex/plans/PLAN.md` with no source edits → parser emitted `plan_ready`.
- **State migration:** verified a scratch old-shape `state.json` migrates to `{activeProvider:"claude", sessions:{claude:<old>, codex:{}}}`.
- **Not done (no harness):** live Telegram smoke test — requires `BOT_TOKEN`/`ALLOWED_USER_ID`. See "Recommended manual test" below.

---

## Known limitations & risks (not blockers)

- **Codex text is message-level, not token-level.** No streaming deltas from `codex exec --json`; replies appear in whole chunks. UX is chunkier than Claude's typewriter stream. Inherent to the CLI.
- **Plan-mode depends on model compliance.** Detection requires Codex to actually write to `.codex/plans/`. It complied in every test, but a stubborn model could inline the plan as prose → no `plan_ready` (graceful: run just completes, no buttons). Prose-fallback designed in `codex-plan-mode.md`, deferred until observed.
- **Codex token totals are dropped** (available in `turn.completed.usage` if you later want to surface them). Cost stays hidden by capability gate.
- **Plan convention is first-turn-only** (token economy, consistent with file-send injection). Follow-up planning in a long session relies on Codex retaining the turn-1 instruction via session context. Acceptable; new sessions always carry it.
- **`--dangerously-bypass-approvals-and-sandbox`** gives Codex full host access (matches Claude today). Fine for a trusted single-user host; revisit if ever deployed shared/untrusted.

## Blockers

None. Codex CLI v0.132.0 is installed (`/opt/homebrew/bin/codex`) and logged in via ChatGPT. Claude-only hosts still boot (codex check is warn-only).

---

## Recommended manual test (needs Telegram tokens)

1. Start bot: `bun run src/index.ts`. Confirm startup message shows the active provider.
2. `/provider` → switch to Codex. Send a text prompt → streams a reply (footer shows time, no cost).
3. Follow-up message → confirms `resume` (same Codex session continues).
4. Ask Codex to "plan X without implementing" → plan buttons appear → Execute (new session) and Execute (keep context) both work.
5. `/history` → lists Codex sessions for the project; resume one.
6. `/stop` mid-run; `/new` starts fresh. `/provider` back to Claude → Claude session still resumes (per-provider namespacing).
7. Restart bot → active provider + sessions persisted.

---

## Suggested follow-ups (optional, out of scope)

- Surface Codex token usage in the footer (data is in `turn.completed.usage`).
- `/history` provider badge to show both providers' sessions at once (currently active-provider-only by design).
- Add parser unit tests to the repo (against `docs/plan/codex/samples/`) — no test suite exists yet.
- Implement the plan-mode prose-fallback if Codex non-compliance shows up in practice.
- `.gitignore` `.codex/plans/` in target repos (as is common for `.claude/`).
