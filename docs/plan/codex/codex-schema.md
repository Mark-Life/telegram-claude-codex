# Codex `exec --json` Event Schema (VERIFIED)

Findings from Phase 0 spike. Codex CLI **v0.132.0**, logged in via ChatGPT (no API key). All output below is real captured JSONL — see `samples/`.

Flags used for every spike (parity with the bot's existing Claude `--dangerously-skip-permissions`):

```
codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check
```

> **Safer alternative for an isolated host:** `codex exec --json -s workspace-write -c 'approval_policy="never"'`. This lets Codex write inside the workspace but blocks escapes and never prompts. The bot currently runs Claude fully unsandboxed, so the bypass flag is the parity choice; switch to `workspace-write` if the bot host is not itself sandboxed.

---

## 1. The two schemas (do not confuse them)

Codex emits **two different JSONL formats**:

| Schema | Where | Used by |
|--------|-------|---------|
| **Experimental `exec` event stream** | stdout of `codex exec --json` | `src/agent/codex.ts` live parser (this doc) |
| **Rollout/session log** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `src/agent/codex-history.ts` reader (see §10) |

They are **not** the same shape. The stdout stream is a small, flat, high-level event model. The persisted session log is a verbose internal `response_item`/`event_msg` transcript. **The live parser must target the stdout stream only.**

---

## 2. Stdout event types (the wire protocol)

Every line on stdout is one JSON object with a top-level `"type"`. Across all spikes, the complete observed set is:

| `type` | Meaning | Carries |
|--------|---------|---------|
| `thread.started` | First event of a run. **Holds the session id.** | `thread_id` |
| `turn.started` | A model turn began | (no fields) |
| `item.started` | A work item began (only for long-running items: commands, file changes) | `item` (status `in_progress`) |
| `item.completed` | A work item finished (or a whole message/reasoning arrived) | `item` (terminal status) |
| `turn.completed` | Turn finished successfully. **Holds token usage.** | `usage` |
| `turn.failed` | Turn failed | `error.message` |
| `error` | Top-level error (emitted alongside `turn.failed`) | `message` |

There is **no `result` / `task_complete` event on stdout** like Claude has. The "final result" is the last `item.completed` whose `item.type === "agent_message"`, and the run terminator is `turn.completed` (success) or `turn.failed`/`error` (failure). See §8.

### Item types (inside `item.started` / `item.completed`)

| `item.type` | Meaning |
|-------------|---------|
| `agent_message` | Assistant text (whole message, see §6) |
| `command_execution` | A shell command run by Codex |
| `file_change` | A file create/edit/delete |
| `reasoning` | Reasoning/thinking summary (see §9) |

> Note: `agent_message` and `reasoning` only ever appeared as `item.completed` (no `item.started`) — they arrive whole. Only `command_execution` and `file_change` have an `item.started` → `item.completed` lifecycle.

---

## 3. Where the session ID lives  ⭐ critical for resume

The session id is the **`thread_id`** on the very first event:

```json
{"type":"thread.started","thread_id":"019e4b7a-20fe-76e1-9dd4-1cde801f6ad1"}
```

It is a UUIDv7. Capture it from `thread.started` and persist it as the project's Codex session id. (In the persisted session log the same id appears as `session_meta.payload.id`.)

`samples/01-plain-text.jsonl`

---

## 4. Resume mechanics  ⭐ confirmed

```
cd <projectDir> && codex exec resume <SESSION_ID> --json <flags> "<prompt>"
```

- **Resume KEEPS the same `thread_id`.** Spike #3 created `019e4b7a-20fe-76e1-9dd4-1cde801f6ad1`; the resume in spike #4 emitted `thread.started` with the *same* id. → The bot stores **one stable session id per project**; it does not need to re-key after each turn.
- `codex exec resume` also supports `--last` and `--all`. The bot should use explicit ids per project (same as today with Claude `-r`).

### ⚠️ `resume` does NOT accept `--cd` / `-C` / `-s` / `--add-dir`

`codex exec resume --help` shows a *reduced* flag set. Passing `-C` errors with `unexpected argument '-C' found`. Resume reuses the **cwd recorded in the session** (and the spawn process cwd). Implication for `buildArgs`:

| Run | Args |
|-----|------|
| **First turn** | `codex exec --json <flags> -C <projectDir> "<prompt>"` |
| **Resume turn** | `codex exec resume <sid> --json <flags> "<prompt>"` — **no `-C`**; set `Bun.spawn({ cwd: projectDir })` instead |

`resume` *does* accept: `--json`, `--dangerously-bypass-approvals-and-sandbox`, `--skip-git-repo-check`, `-m`, `-o`, `--output-schema`, `--ephemeral`, `-c`. So the bypass+git flags are still passable on resume; only the working-dir flag is gone.

`samples/04-resume.jsonl` (successful resume), `samples/04b-resume-cd-rejected.txt` (the `unexpected argument '-C' found` rejection, captured separately).

---

## 5. Shell / command event shape

```json
{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"/bin/zsh -lc ls","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"/bin/zsh -lc 'echo hello-from-shell'","aggregated_output":"hello-from-shell\n","exit_code":0,"status":"completed"}}
```

Fields on a `command_execution` item:

| Field | Notes |
|-------|-------|
| `id` | `item_N`, stable across the start/completed pair |
| `command` | Full command. **Wrapped in `/bin/zsh -lc '<cmd>'`** — strip the wrapper for display (regex `^/bin/\w+ -lc /`). |
| `aggregated_output` | Combined stdout+stderr. Empty on `item.started`; populated on `item.completed`. |
| `exit_code` | `null` on start; integer on completion |
| `status` | `in_progress` → `completed` (exit 0) or `failed` (non-zero) |

For the bot's `tool_use` display: map to a `Bash`-style entry, command string truncated to 80 chars (matches existing `formatToolInput`). The closest single moment to emit is `item.completed` (or `item.started` if you want to show the command as it begins).

`samples/02-shell-command.jsonl`, `samples/extra-cmd-output.jsonl`, `samples/05-error.jsonl`

---

## 6. File-edit / patch event shape

```json
{"type":"item.started","item":{"id":"item_1","type":"file_change","changes":[{"path":"/abs/path/hello.txt","kind":"add"}],"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"file_change","changes":[{"path":"/abs/path/hello.txt","kind":"update"}],"status":"completed"}}
```

Fields on a `file_change` item:

| Field | Notes |
|-------|-------|
| `changes[]` | Array — one item per file touched in this patch |
| `changes[].path` | **Absolute path** (note: resolves through `/private` on macOS) |
| `changes[].kind` | `add` (new file) / `update` (edit). `delete` not observed but is the obvious third value. |
| `status` | `in_progress` → `completed` |

For display: map each `changes[]` entry to a `Write`/`Edit`-style `tool_use` (`add`→Write, `update`→Edit). **This is also the plan-mode detection hook** — see `codex-plan-mode.md`: a `file_change` whose path ends in `.codex/plans/…` is the plan-ready signal.

`samples/03-file-edit.jsonl`, `samples/04-resume.jsonl`

---

## 7. Text: message-level, NOT delta-level  ⭐

**Codex stdout emits whole assistant messages, not token deltas.** Across every sample there were **zero** `item.updated` / `*_delta` events. Assistant text arrives as a single `item.completed`:

```json
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Hello, nice to meet you."}}
```

A run can contain **multiple** `agent_message` items (Codex narrates between actions — e.g. "I'll create the file." → file_change → "Created hello.txt."). All of them have the full text.

### Implication for `telegram.ts` throttling

- The 300 ms `sendMessageDraft` / progressive-edit throttle designed for Claude token streaming is **overkill but harmless** for Codex — there's simply nothing to throttle mid-message. Each `agent_message` should be appended to the running response text and flushed.
- There is no partial/streaming text, so the UX will feel "chunky" (text appears one full sentence/paragraph at a time as Codex narrates) rather than typewriter-style. No code change strictly required — the existing consumer just receives larger, less frequent `text_delta`s. Recommend treating each `agent_message.text` as one `text_delta` (append with a leading newline if the buffer is non-empty) so the footer/splitting logic keeps working unchanged.

`samples/01-plain-text.jsonl` and all others.

---

## 8. Final / completion event shape

There is **no Claude-style `result` event**. Completion is signalled by `turn.completed`:

```json
{"type":"turn.completed","usage":{"input_tokens":13412,"cached_input_tokens":11648,"output_tokens":11,"reasoning_output_tokens":0}}
```

The **final assistant text** is the last `agent_message` item's `text` (accumulate them). Optionally, `-o, --output-last-message <FILE>` writes *only* the final assistant message to a file (verified: wrote `DONE` with no trailing newline) — usable as a fallback, but the stream already has it.

To synthesize the bot's `result` event, the parser should, on `turn.completed`:
- `text` = accumulated `agent_message` text (or last one)
- `sessionId` = the `thread_id` captured at `thread.started`
- `durationMs` = **wall-clock measured locally** (Codex stdout gives no duration)
- `turns` = not provided → omit / default 1
- `cost` = **not provided** (see §9) → 0 / omit

`samples/extra-lastmsg.jsonl`, `/tmp` last-message check.

---

## 9. Cost / usage / tokens / duration

- **Tokens: YES.** `turn.completed.usage` = `{ input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens }`.
- **Cost (USD): NO.** Codex emits no dollar cost (ChatGPT-account auth, not metered API). The bot's cost footer should be treated as optional/zero for Codex.
- **Duration: NO** on stdout. Measure wall-clock locally (the runner already can).
- **Turns: NO** explicit count on stdout.

→ `capabilities.cost` should be **false** for Codex. The footer code in `telegram.ts` must tolerate missing cost/turns (mostly already does; verify in Phase 5).

---

## 10. Reasoning / thinking events

Present, but **summary-level and message-level** (not deltas):

```json
{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"**Providing simple reasoning**\n\nThe user wants..."}}
```

- Only appears as a single `item.completed` with `item.type:"reasoning"`, `text` = a reasoning summary.
- Surfaced reliably only when reasoning config is raised: spike used `-c 'model_reasoning_summary="detailed"' -c 'model_reasoning_effort="high"'`. With defaults, reasoning items may not appear at all.
- `reasoning_output_tokens` in `usage` reflects reasoning even when no `reasoning` item is shown.

→ `capabilities.thinking` can be **true** for Codex, but there's no start/stop/delta lifecycle — emit it as a single thinking block (start + one delta + done, or a dedicated whole-thinking event). Given it's a sanitized summary, displaying it is safe.

`samples/extra-reasoning.jsonl`

---

## 11. Persisted session log (for `codex-history.ts` — different schema)

Path: `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<thread_id>.jsonl`. First line is `session_meta`:

```json
{"timestamp":"2026-05-21T16:59:15.699Z","type":"session_meta","payload":{"id":"019e4b7a-20fe-76e1-9dd4-1cde801f6ad1","cwd":"/var/folders/.../tmp.o4fLNujiZy","originator":"codex_exec","cli_version":"0.132.0","source":"exec","model_provider":"openai","base_instructions":"<long>","git":{}}}
```

Useful fields for `/history`:
- `payload.id` — session id (== `thread_id`).
- `payload.cwd` — **project filter** (replaces Claude's dir-encoded path scheme; filter sessions by matching `cwd` to the active project).
- `payload.timestamp` / line `timestamp` — for sorting/recency.

The first user prompt (for a preview label) is in an `event_msg` line:

```json
{"type":"event_msg","payload":{"type":"user_message","message":"Create a file hello.txt containing the word hello.", ...}}
```

The rest of the log uses `{type:"response_item", payload:{type:"message"|"agent_message"|"custom_tool_call"|"patch_apply_end"|"token_count"|...}}` and `{type:"event_msg", payload:{type:"task_started"|"task_complete"|...}}`. The history reader only needs `session_meta` (id, cwd, timestamp) + first `user_message` for a summary card — it does **not** need to replay the whole transcript.

> ⚠️ Do not point the live parser at this file. Filenames are dated; project filtering comes from `session_meta.cwd`, not a Claude-style encoded dir name.

---

## 12. Error handling  ⭐

Two distinct failure layers:

**(a) Shell-command failure inside the run** — NOT a Codex error. The CLI exits **0**. Surfaces as a `command_execution` item with `status:"failed"`, `exit_code:1`, and the error text in `aggregated_output`:

```json
{"type":"item.completed","item":{"type":"command_execution","command":"/bin/zsh -lc 'cat /nonexistent...'","aggregated_output":"cat: ...: No such file or directory\n","exit_code":1,"status":"failed"}}
```

**(b) True CLI / model error** — CLI exits **non-zero (1)**. Emits an `error` event and a `turn.failed`, and **no `turn.completed`**:

```json
{"type":"error","message":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'nonexistent-model-xyz' model is not supported when using Codex with a ChatGPT account.\"}}"}
{"type":"turn.failed","error":{"message":"...same..."}}
```

→ Parser: on `error` or `turn.failed`, emit the bot's `error` event with `error.message` (or top-level `message`). The message is sometimes a JSON-encoded string — try `JSON.parse` and surface `.error.message` if present, else show raw. Also honour the existing non-zero-exit + stderr fallback in the runner.

`samples/05-error.jsonl` (shell-internal), `samples/05b-cli-error.jsonl` (true CLI error).

---

## 13. Codex event → `AgentEvent` mapping  ⭐ (the adapter table)

Target internal variants (post-rename `ClaudeEvent`→`AgentEvent`): `session_init`, `text_delta`, `tool_use`, `thinking_start`/`thinking_delta`/`thinking_done`, `plan_ready`, `agent_started`/`agent_done`, `result`, `error`.

| Codex stdout event | Condition | → `AgentEvent` |
|--------------------|-----------|----------------|
| `thread.started` | always (first event) | `{ kind: "session_init", sessionId: thread_id }` |
| `turn.started` | — | *(none — ignore)* |
| `item.completed` · `item.type==="agent_message"` | — | `{ kind: "text_delta", text: item.text }` *(prefix `\n\n` if buffer non-empty so multiple narration messages separate cleanly)* |
| `item.started` · `command_execution` | (optional) show command as it starts | `{ kind: "tool_use", name: "Bash", input: stripZsh(command).slice(0,80) }` |
| `item.completed` · `command_execution` | if not already emitted on start | `{ kind: "tool_use", name: "Bash", input: stripZsh(command).slice(0,80) }` |
| `item.completed` · `file_change` | for each `changes[]` | `{ kind: "tool_use", name: change.kind==="add"?"Write":"Edit", input: change.path }` **and** if `change.path` matches `/.codex/plans/` → `{ kind: "plan_ready", planPath: change.path }` *(Phase 6 — gated on `capabilities.planMode`)* |
| `item.completed` · `reasoning` | `capabilities.thinking` | emit `{ kind: "thinking_start" }`, `{ kind: "thinking_delta", text: item.text }`, `{ kind: "thinking_done", durationMs: 0 }` *(no real timing)* |
| `turn.completed` | always (success terminator) | `{ kind: "result", text: <accumulated agent_message text>, sessionId: <captured thread_id>, cost: 0, durationMs: <local wall-clock>, turns: 1 }` |
| `error` / `turn.failed` | failure | `{ kind: "error", message: parseMaybeJson(message ?? error.message) }` |
| *(no equivalent)* | Codex `exec` emits no subagent task events | `agent_started` / `agent_done` — **never emitted** → `capabilities.subagents: false` |

Notes:
- `session_init` should fire once, from `thread.started`. On resume it fires again with the same id — harmless (bot already has it).
- The parser must keep a small accumulator for `agent_message` text so it can populate `result.text`, and stash `thread_id` for `result.sessionId`.
- `command_execution`: emit on **either** start or completed, not both (pick one to avoid duplicate tool lines). Recommend `item.completed` so `exit_code`/output is known (could append a ✓/✗ later).

---

## 14. Capabilities summary (verified) for `registry.ts`

```ts
capabilities: {
  planMode:  false,  // true after Phase 6 (see codex-plan-mode.md — detection is viable)
  thinking:  true,   // reasoning items, summary-level, config-gated
  cost:      false,  // no USD cost; tokens available but not dollars
  subagents: false,  // codex exec emits no task_started/notification events
}
```
