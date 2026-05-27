# Claude Code Functions We Rely On

Analysis of all Claude Code CLI features used by this project, for planning Codex migration.

## CLI Invocation & Flags

| Feature | Description | Where Used | Claude Code Docs | Codex CLI Docs | Codex Equivalent / Notes |
|---------|-------------|------------|-----------------|----------------|--------------------------|
| `claude -p "<prompt>"` | Non-interactive prompt mode - send a prompt and get a response without entering REPL | `src/claude.ts:299` - core invocation | https://docs.anthropic.com/en/docs/claude-code/cli-usage | https://developers.openai.com/codex/noninteractive | Use `codex exec "<prompt>"`. It also accepts `-`/stdin, which may be cleaner for Telegram prompts containing shell-sensitive characters. |
| `--output-format stream-json` | Stream structured JSON events (JSONL) to stdout instead of plain text | `src/claude.ts:301` - enables event parsing | https://docs.anthropic.com/en/docs/claude-code/cli-usage#output-format | https://developers.openai.com/codex/noninteractive | **VERIFIED:** `codex exec --json` emits flat JSONL. Top-level types: `thread.started`, `turn.started`, `item.started`, `item.completed`, `turn.completed`, `turn.failed`, `error`. Item types: `agent_message`, `command_execution`, `file_change`, `reasoning`. Completely different from Claude's `stream_event`/content-block schema — must be a dedicated adapter. Full schema in `codex-schema.md`. |
| `-r <sessionId>` | Resume a previous conversation session by ID | `src/claude.ts:309-311` - session continuity | https://docs.anthropic.com/en/docs/claude-code/cli-usage | https://developers.openai.com/codex/noninteractive | **VERIFIED:** `codex exec resume <sessionId> --json "<prompt>"` works and **keeps the same `thread_id`** (stable session id per project — no re-keying needed). `--last`/`--all` also exist; use explicit ids. ⚠️ **`resume` does NOT accept `-C/--cd`** (errors `unexpected argument '-C'`); set the process `cwd` via `Bun.spawn({ cwd })` for resume turns. It does accept `--json`, the bypass flag, `--skip-git-repo-check`, `-m`, `-o`. |
| `--verbose` | Include additional detail in streaming output | `src/claude.ts:303` | https://docs.anthropic.com/en/docs/claude-code/cli-usage | https://developers.openai.com/codex/noninteractive | No exact `exec` verbosity flag. Use `--json` for structured progress, plus local stderr capture. If more telemetry is needed, inspect Codex JSONL events and session logs. |
| `--include-partial-messages` | Stream partial/intermediate assistant messages (not just final) | `src/claude.ts:304` | https://docs.anthropic.com/en/docs/claude-code/cli-usage | https://developers.openai.com/codex/noninteractive | No separate flag. `codex exec --json` streams progress events and final output; adapter must map whatever text deltas or completed message events Codex emits to Telegram updates. |
| `--dangerously-skip-permissions` | Skip all tool permission prompts (headless mode) | `src/claude.ts:305` - required for unattended operation | https://docs.anthropic.com/en/docs/claude-code/cli-usage | https://developers.openai.com/codex/agent-approvals-security | **VERIFIED (DECISION):** use `--dangerously-bypass-approvals-and-sandbox --skip-git-repo-check` for parity with the bot's current Claude config. Safer alt verified to work: `-s workspace-write -c 'approval_policy="never"'` (writes inside workspace, never prompts) — switch to this if the bot host is not itself sandboxed. Both run headless with no prompts. |
| `--append-system-prompt` | Append custom text to the system prompt | `src/claude.ts:306-307` - injects file-sending capability | https://docs.anthropic.com/en/docs/claude-code/cli-usage | https://developers.openai.com/codex/config-reference | No direct flag with the same name. Put persistent guidance in `AGENTS.md` or a Codex profile/config, or prepend bot-specific instructions to the prompt sent to `codex exec`. |
| `cwd` (working directory) | Claude runs in a specific project directory | `src/claude.ts:327` - `cwd: projectDir` in spawn | Implicit - Claude Code uses cwd for project context | https://developers.openai.com/codex/cli | **VERIFIED:** first-turn `codex exec -C <projectDir> ...` works. **But `resume` rejects `-C`** — for resume turns rely solely on `Bun.spawn({ cwd: projectDir })` (resume also recorded the cwd in its session). So: `-C` on `exec`, process-cwd on `resume`. |

## Stream JSON Event Types

Events we parse from `--output-format stream-json`. These define the wire protocol.

| Event Type | Description | Where Parsed | Docs | Codex CLI Docs | Codex Equivalent / Notes |
|------------|-------------|--------------|------|----------------|--------------------------|
| `{ type: "system", subtype: "init", session_id }` | First event - provides the session ID for resumption | `src/claude.ts:226-227` | https://docs.anthropic.com/en/docs/claude-code/cli-usage#output-format | https://developers.openai.com/codex/noninteractive | **VERIFIED:** Codex's first event is `{"type":"thread.started","thread_id":"<uuid>"}`. The `thread_id` IS the session id (== `session_meta.payload.id` in the persisted log). Map to `{ kind:"session_init", sessionId: thread_id }`. |
| `{ type: "stream_event", event: { type: "content_block_start", content_block } }` | Start of a content block (text, tool_use, or thinking) | `src/claude.ts:158-175` | Same | https://developers.openai.com/codex/noninteractive | No Anthropic content-block wrapper. Codex JSONL events must be mapped into internal bot events such as `text`, `tool_use`, and `thinking` if those concepts are present. |
| `{ type: "stream_event", event: { type: "content_block_delta", delta } }` | Incremental content: `text_delta`, `input_json_delta`, `thinking_delta` | `src/claude.ts:176-196` | Same | https://developers.openai.com/codex/noninteractive | **VERIFIED: Codex has NO delta/token streaming.** Zero `*_delta`/`item.updated` events across all spikes. Text arrives **message-level** as `item.completed` (`item.type:"agent_message"`, full `text`). A run may contain several `agent_message` items (Codex narrates between actions). Map each to one `text_delta` (append). Existing 300ms throttle is harmless but unnecessary; UX will be chunky, not typewriter. |
| `{ type: "stream_event", event: { type: "content_block_stop" } }` | End of a content block - triggers tool_use emission | `src/claude.ts:198-225` | Same | https://developers.openai.com/codex/noninteractive | Codex may emit tool/action lifecycle events instead of block stops. Bot should emit a normalized internal `tool_use` event when a Codex command/tool event is complete enough to display. |
| `{ type: "result", subtype, is_error, result, session_id, total_cost_usd, duration_ms, num_turns }` | Final result with cost/duration/turn metadata | `src/claude.ts:250-258` | Same | https://developers.openai.com/codex/noninteractive | **VERIFIED:** no Claude-style `result` event. Success terminator is `{"type":"turn.completed","usage":{input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens}}`. **Tokens: yes. Cost (USD): NO. Duration: NO (measure locally). Turns: NO.** Final text = accumulated `agent_message` text (or `-o <file>` fallback, verified writes only the final message). Synthesize `result` on `turn.completed`. → `capabilities.cost: false`. |
| `{ type: "system", subtype: "task_started", task_id, description }` | Subagent/task spawned | `src/claude.ts:228-235` | Same | https://developers.openai.com/codex/subagents | **VERIFIED:** `codex exec --json` emits **no** subagent/task lifecycle events on stdout (none observed). Do not map; hide subagent UI for Codex. → `capabilities.subagents: false`. |
| `{ type: "system", subtype: "task_notification", task_id, status, summary, usage }` | Subagent/task completed with stats | `src/claude.ts:237-249` | Same | https://developers.openai.com/codex/subagents | **VERIFIED:** no equivalent on `codex exec --json` stdout. Omit. |
| `{ type: "assistant", message, session_id }` | Full assistant message (used with `--include-partial-messages`) | `src/claude.ts:57-60` - type defined but not actively consumed | Same | https://developers.openai.com/codex/noninteractive | **VERIFIED:** Codex's `item.completed`/`agent_message` IS this (whole message). `-o <file>` writes only the final message (verified: `DONE`, no trailing newline) — usable as fallback; the stream already carries it. |

## Content Block Types (within stream events)

| Block Type | Description | Where Used | Codex CLI Docs | Codex Equivalent / Notes |
|------------|-------------|------------|----------------|--------------------------|
| `text` / `text_delta` | Main response text, streamed incrementally | `src/claude.ts:164-165, 182-184` -> `src/telegram.ts:429-447` | https://developers.openai.com/codex/noninteractive | **VERIFIED:** Codex `agent_message` items carry whole `text` (message-level, no deltas). Emit each as a `text_delta` (prefix `\n\n` if buffer non-empty). Reuse the existing text path; throttling stays but has little to do. |
| `tool_use` / `input_json_delta` | Tool calls (Read, Write, Edit, Bash, Grep, Glob, etc.) with JSON input | `src/claude.ts:166-169, 185-189, 202-219` -> `src/telegram.ts:448-457` | https://developers.openai.com/codex/noninteractive | **VERIFIED:** two item types cover it. `command_execution` → `{name:"Bash", input: command}` (command is wrapped `/bin/zsh -lc '...'`, strip + truncate to 80; also has `aggregated_output`, `exit_code`, `status` completed/failed). `file_change` → per `changes[]`: `{name: kind==="add"?"Write":"Edit", input: path}` (paths absolute). No `Read`/`Grep`/`Glob` tool events (reads/searches happen inside shell commands). |
| `thinking` / `thinking_delta` | Extended thinking content | `src/claude.ts:170-174, 190-196, 221-224` -> `src/telegram.ts:458-497` | https://developers.openai.com/codex/noninteractive | **VERIFIED:** Codex emits `item.completed` with `item.type:"reasoning"` (whole-summary `text`, no deltas, no timing). Only surfaced when reasoning config is raised (`-c model_reasoning_summary="detailed" -c model_reasoning_effort="high"`); absent by default. Emit as one thinking block (start + single delta + done, durationMs 0). → `capabilities.thinking: true` (safe, it's a sanitized summary). |

## Session & History System

We rely on Claude Code's internal file storage for session history.

| Feature | Description | Where Used | Notes | Codex CLI Docs | Codex Equivalent / Notes |
|---------|-------------|------------|-------|----------------|--------------------------|
| Session IDs | Returned via `system.init` event; used with `-r` to resume | `src/claude.ts:227`, `src/bot.ts:837,857-858` | Core to conversation continuity | https://developers.openai.com/codex/noninteractive | **VERIFIED:** Codex session id = `thread_id` from the `thread.started` event (UUIDv7). Resume keeps the same id, so one persisted id per project suffices. Namespace separately from Claude ids (plan already does this via `sessions: Record<ProviderId, ...>`). |
| Session JSONL files | Claude stores sessions as `.jsonl` files in `~/.claude/projects/<dir>/` | `src/history.ts:14,126,144` | We read these directly for `/history` command | https://developers.openai.com/codex/noninteractive | **VERIFIED:** path is `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<thread_id>.jsonl`. ⚠️ **Different schema from the `--json` stdout stream** — uses `session_meta` + `response_item`/`event_msg` wrappers. History reader needs only: line 1 `session_meta.payload` (`id`, `cwd`, `timestamp`, `cli_version`) + first `event_msg`/`user_message` for a preview. Do not reuse the live stdout parser here. |
| Project storage dir naming | `~/.claude/projects/` + path with `/` replaced by `-` | `src/history.ts:31-33` | e.g. `/root/projects/foo` -> `-root-projects-foo` | https://developers.openai.com/codex/noninteractive | **VERIFIED:** no dir encoding — sessions are dated files. Filter by `session_meta.payload.cwd` matching the active project dir. (Resume uses `--all` to disable cwd filtering, but app-level filtering by `cwd` is what `/history` needs.) |
| JSONL structure | Lines contain `{ sessionId, timestamp, cwd, type, message }` | `src/history.ts:64-99` | We parse first few lines for metadata | https://developers.openai.com/codex/noninteractive | **VERIFIED:** Codex session line 1 = `{timestamp, type:"session_meta", payload:{id, cwd, timestamp, cli_version, ...}}`; user prompts = `{type:"event_msg", payload:{type:"user_message", message:"..."}}`. Map these into the shared `ConversationSummary` (id ← `payload.id`, project ← `payload.cwd`, preview ← first `user_message.message`). |
| Session-to-project mapping | We cache which session belongs to which project | `src/history.ts:18-22, 166-170` | Enables cross-project session resume | https://developers.openai.com/codex/noninteractive | Keep this app-level mapping. Codex resume also supports `--all`, but explicit bot state will be more predictable. |

## Plan Mode

| Feature | Description | Where Used | Codex CLI Docs | Codex Equivalent / Notes |
|---------|-------------|------------|----------------|--------------------------|
| `.claude/plans/` directory | Claude writes plan files here when in plan mode | `src/claude.ts:212-214` - detected via Write tool to plans path | https://developers.openai.com/codex/cli | **VERIFIED (RECOMMENDED):** prompt-convention works. Asked Codex to "plan only, write to `.codex/plans/PLAN.md`, don't implement" → it wrote a clean markdown plan there and made no code changes (`samples/06-plan-mode.jsonl`). Detect via the `file_change` event whose `changes[].path` includes `/.codex/plans/`. Full Phase 6 spec in `codex-plan-mode.md`. |
| `ExitPlanMode` tool | Claude calls this tool when plan is finalized | `src/claude.ts:217-219` - triggers `plan_ready` event | https://developers.openai.com/codex/cli | **VERIFIED:** no `ExitPlanMode` and no plan/approval event on `codex exec --json` stdout. Not needed — the plan-file `file_change` write IS the trigger (emit `plan_ready` directly on it; simpler than Claude's Write+ExitPlanMode two-step). |
| Plan file reading | We read the plan file and present it to user with action buttons | `src/bot.ts:659-699` | https://developers.openai.com/codex/cli | Keep this bot behavior. Only the plan-file location and detection logic need to become backend-specific. |
| Plan execution (new session) | Clear session, send plan as prompt | `src/bot.ts:701-729` | https://developers.openai.com/codex/noninteractive | Directly portable: clear Codex session mapping and call `codex exec` with the approved plan prompt. |
| Plan execution (resume) | Keep session, send "approved" prompt | `src/bot.ts:731-755` | https://developers.openai.com/codex/noninteractive | Use `codex exec resume <sessionId> "approved..."`. |
| Plan modification | Send user feedback back to Claude in same session | `src/bot.ts:795-815` | https://developers.openai.com/codex/noninteractive | Use `codex exec resume <sessionId> "<feedback>"` and regenerate/update the plan file. |

## Subagent / Task System

| Feature | Description | Where Used | Codex CLI Docs | Codex Equivalent / Notes |
|---------|-------------|------------|----------------|--------------------------|
| `task_started` event | Emitted when Claude spawns a subagent (Agent tool) | `src/claude.ts:228-235` -> `src/telegram.ts:499-505` | https://developers.openai.com/codex/subagents | Codex supports subagents, but the bot should verify whether `codex exec --json` emits task-start events. If not, hide subagent-start messages for Codex. |
| `task_notification` event | Emitted when subagent completes, with usage stats | `src/claude.ts:237-249` -> `src/telegram.ts:506-524` | https://developers.openai.com/codex/subagents | Codex supports subagents, but completion payloads may not match Claude's schema. Treat completion notifications and usage stats as optional backend capabilities. |
| Usage stats | `total_tokens`, `tool_uses`, `duration_ms` per subagent | `src/claude.ts:33,82-89` | https://developers.openai.com/codex/subagents | **VERIFIED:** no per-subagent stats (no subagent events). Whole-run usage on `turn.completed.usage` = `{input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens}`. No `duration_ms`, no `tool_uses` count, no cost — measure duration locally. |

## Tool Use Tracking

We intercept and display which tools Claude is using.

| Tool Name | What We Extract | Where Used | Codex CLI Docs | Codex Equivalent / Notes |
|-----------|----------------|------------|----------------|--------------------------|
| `Read` | `file_path` | `src/claude.ts:110-111` | https://developers.openai.com/codex/noninteractive | Codex file reads may appear as tool/activity events, but exact names differ. Normalize to `Read`-like display when an event includes a path. |
| `Write` | `file_path` (+ plan detection) | `src/claude.ts:112-113, 211-216` | https://developers.openai.com/codex/noninteractive | **VERIFIED:** `file_change` item, `changes[].kind:"add"`, `changes[].path` (absolute). Plan detection = path includes `/.codex/plans/`. |
| `Edit` | `file_path` | `src/claude.ts:114-115` | https://developers.openai.com/codex/noninteractive | **VERIFIED:** same `file_change` item with `changes[].kind:"update"` for edits to existing files (`exec` edits in-workspace directly; confirmed on resume append). |
| `Bash` | `command` (truncated to 80 chars) | `src/claude.ts:116-119` | https://developers.openai.com/codex/concepts/sandboxing | **VERIFIED:** `command_execution` item carries `command` (wrapped `/bin/zsh -lc '<cmd>'` — strip wrapper), `aggregated_output` (combined stdout+stderr), `exit_code`, `status` (`completed`/`failed`). Truncate command to 80 chars as today. |
| `Glob` | `pattern` | `src/claude.ts:120-121` | https://developers.openai.com/codex/noninteractive | No guaranteed named `Glob` tool. Map search/list activity if Codex exposes pattern data; otherwise omit. |
| `Grep` | `pattern` | `src/claude.ts:122-123` | https://developers.openai.com/codex/noninteractive | No guaranteed named `Grep` tool. Shell `rg` commands may show up as command events and can be displayed as Bash. |
| `WebFetch` | `url` | `src/claude.ts:124-125` | https://developers.openai.com/codex/cli/features#web-search | Codex web search is enabled with `--search`; URL fetch activity may not map one-to-one. Treat web activity as optional unless JSONL exposes URL fields. |
| `WebSearch` | `query` | `src/claude.ts:126-127` | https://developers.openai.com/codex/cli/features#web-search | Use `codex --search` / configured web search when needed. Map search events if Codex emits query fields. |
| `Task` (Agent) | `description` | `src/claude.ts:128-129` | https://developers.openai.com/codex/subagents | Codex supports subagents, but the JSONL event shape needs verification before this can be a direct adapter mapping. Hide or synthesize from task-like events if they appear. |
| `ExitPlanMode` | (triggers plan_ready) | `src/claude.ts:217-219` | https://developers.openai.com/codex/cli | **VERIFIED:** no equivalent. Use the plan-file detector (`file_change` to `/.codex/plans/`) as the `plan_ready` trigger instead. |

## Environment & Process Management

| Feature | Description | Where Used | Codex CLI Docs | Codex Equivalent / Notes |
|---------|-------------|------------|----------------|--------------------------|
| One process per user | Map of `userId -> AbortController` | `src/claude.ts:100-104, 285-295` | https://developers.openai.com/codex/noninteractive | Reuse unchanged. Codex still runs as a child process for non-interactive execution. |
| 10-minute timeout | Auto-abort after 10 min | `src/claude.ts:105, 334-338` | https://developers.openai.com/codex/noninteractive | Reuse unchanged, though Codex tasks may benefit from configurable per-project timeout later. |
| Process abort via signal | `AbortController.signal` passed to `Bun.spawn` | `src/claude.ts:313, 332` | https://developers.openai.com/codex/noninteractive | Reuse unchanged. Verify Codex exits cleanly and does not leave child shell commands running after abort. |
| `CLAUDECODE` env var removal | Stripped to avoid Claude-inception | `src/claude.ts:320-321` | https://developers.openai.com/codex/config-reference | Codex-specific equivalent is environment hygiene around `CODEX_HOME`, `OPENAI_API_KEY`, and shell environment inheritance. Avoid leaking unintended agent env vars into nested agent runs. |
| `TELEGRAM_CHAT_ID` env var | Injected so scripts can send files back | `src/claude.ts:324` | https://developers.openai.com/codex/config-reference | Reuse unchanged if scripts remain shell-based. Ensure Codex config allows inheriting this env var, or pass it explicitly in `Bun.spawn`. |
| stderr capture | Collected for error reporting | `src/claude.ts:340-351, 377-378` | https://developers.openai.com/codex/noninteractive | Reuse unchanged. With `--json`, stdout is the event stream and stderr remains useful for CLI/runtime failures. |

## State Persistence (Our Layer)

Not Claude Code features per se, but our adapter layer that wraps them.

| Feature | Description | Where Used | Codex CLI Docs | Codex Equivalent / Notes |
|---------|-------------|------------|----------------|--------------------------|
| Active project tracking | Which project dir is selected | `src/state.ts:54-57`, `src/bot.ts:262-263` | https://developers.openai.com/codex/cli | Reuse unchanged. It should feed `codex exec --cd <projectDir>`. |
| Session map persistence | `projectPath -> sessionId` saved to `.data/state.json` | `src/state.ts:42-51, 60-71` | https://developers.openai.com/codex/noninteractive | Reuse conceptually, but namespace by backend so Claude and Codex sessions do not collide. |
| Session clearing (`/new`) | Deletes session mapping so next prompt starts fresh | `src/bot.ts:430-445` | https://developers.openai.com/codex/noninteractive | Reuse unchanged after backend namespacing. Next Codex prompt should call `codex exec`, not `codex exec resume`. |

## Summary: What Codex Needs to Support

For Codex migration, these are the key capabilities needed:

1. **Non-interactive prompt mode** with streaming JSON output - `codex exec --json` is the direct starting point.
2. **Session resume** by ID - use `codex exec resume <sessionId>`.
3. **Streaming event protocol** (content blocks, deltas, tool use, thinking) - requires a Codex JSONL parser and a normalized internal event model. **VERIFIED:** Codex is message-level (no deltas); events are `thread.started`/`item.*`/`turn.*`. See `codex-schema.md` §13 for the full event→`AgentEvent` table.
4. **Subagent/task events** (started, notification with usage) - **VERIFIED:** Codex `exec` emits none. `capabilities.subagents: false`; hide subagent UI.
5. **Plan mode** (write plan file, exit plan mode tool) - **VERIFIED viable:** prompt convention + `.codex/plans/PLAN.md` + `file_change` detection works. `capabilities.planMode` can be flipped to `true` in Phase 6. See `codex-plan-mode.md`.
6. **Tool use visibility** (which tools are being called and with what args) - available in principle through Codex JSONL/tool/activity events, but names and payloads differ.
7. **Cost/duration/turns metadata** in result event - **VERIFIED:** no `result` event; `turn.completed.usage` has token counts only. No USD cost, no duration, no turn count. `capabilities.cost: false`; measure duration locally.
8. **Session history storage** (browsable, resumable) - Codex uses `~/.codex/sessions/...` JSONL, so `/history` needs a backend-specific parser.
9. **Custom system prompt injection** - use `AGENTS.md`, Codex config/profile, or prompt prefixing; no direct `--append-system-prompt` flag.
10. **Headless permission bypass** - **VERIFIED (decision):** `--dangerously-bypass-approvals-and-sandbox --skip-git-repo-check` (parity with current Claude). Both this and the safer `-s workspace-write -c 'approval_policy="never"'` run with zero prompts; the latter blocks escapes outside the workspace. Note: `-s read-only` cleanly blocks all writes (useful for a planning/analysis turn).
