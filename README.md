# telegram-claude

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Telegram bot interface for coding agents (Claude Code + OpenAI Codex) on a VPS. Message the bot from any device, it runs the active agent in your project directories and answers in the chat. Every forum topic is a separate conversation, so several can run at once. Switch providers at runtime with `/provider`.

![telegram-claude demo](https://lxbpjvrr41.ufs.sh/f/6KZjuRTQYJxHIndwqxeD4mh8cu39QUEVvM0jCpqogftBHWKs)

## Features

- **Forum topics** — every topic is its own conversation with its own session, project, queue and compose draft; topics run in parallel, up to `MAX_CONCURRENT_RUNS`
- **Auto-named topics** — a topic Telegram named for you is renamed from its first message, using the active provider's cheapest model
- **Quiet by default** — a run shows a typing indicator and then one message with the answer; `/verbose` brings tool calls, thinking and the footer back
- **SQLite state** — topics, sessions, compose drafts and settings live in `.data/bot.db`, with an optional nightly backup timer
- **Multi-provider** — switch between Claude Code and OpenAI Codex at runtime via `/provider`; sessions and capabilities are tracked per provider
- **Project switching** — select any project directory via inline keyboard, auto-unpins old messages
- **Streaming responses** — real-time draft messages with edit-based fallback (verbose mode)
- **Session continuity** — follow-up messages continue the same conversation, per provider and per topic
- **Message queuing** — messages sent while that conversation is busy are queued and processed in order
- **Thinking stream** — the agent's thinking/reasoning content streamed in a separate message (verbose mode)
- **Branch awareness** — current git branch and open PRs shown in `/status` and response footers
- **Voice messages** — voice notes transcribed via Groq Whisper, then sent to the agent as text
- **Long response splitting** — auto-splits messages exceeding Telegram's 4000 char limit
- **Rich message rendering** — model output sent as markdown, bot chrome as HTML, plain text as fallback
- **Plan mode interception** — Codex uses the `.codex/plans/` convention; Claude's `ExitPlanMode`/`.claude/plans/` flow is supported but **off by default** (the hardened Claude settings deny plan mode — re-enable via `CLAUDE_SETTINGS_JSON`). When active, the plan is presented for approval with options to execute (new/resume session), modify with feedback, or cancel
- **Capability-aware UI** — cost/turns footer, thinking panel, and subagent messages adapt to what the active provider supports (e.g. Codex shows duration only)
- **Hardened agent defaults** — the Claude Agent SDK runs with a locked-down `Settings` profile (plan mode + interactive/harness tools denied, bundled skills/remote-control/artifacts off, `effortLevel: high`); override any of it via `CLAUDE_SETTINGS_JSON`
- **Wide-event observability** — one structured JSON line per run appended to `.data/events.jsonl`, queryable with `bun run logs` (no external infra)
- **Compose mode** — collect multiple messages (text, voice, forwarded, files, photos) into a single prompt with `/compose` and `/send`
- **Access control** — single authorized user via Telegram user ID

## Prerequisites

- [Bun](https://bun.sh/) runtime
- A Claude subscription login — the [Claude Agent SDK](https://docs.anthropic.com/en/api/agent-sdk/overview) is bundled as a dependency (no separate CLI install needed); it reuses your `~/.claude` login, so authenticate once with `claude login`
- [Codex](https://developers.openai.com/codex/cli) CLI installed and authenticated (`codex login`) — optional, only if you want the Codex provider
- [Groq](https://console.groq.com/) API key — for voice message transcription
- `sqlite3` on `PATH` — only for the nightly database backup, which uses `sqlite3 .backup` because a plain file copy of a WAL database can miss committed writes (`sudo apt-get install -y sqlite3`)

Agent auth is login-managed: authenticate on the host once and the bundled binaries reuse it. No API key is required by default — subscription/CLI login is used (an optional `ANTHROPIC_API_KEY` fallback exists for Docker/CI, see [Optional configuration](#optional-configuration)).

> **Note:** This bot uses the Claude Agent SDK (`query()`). Starting June 15, 2026, paid Claude plans include a dedicated monthly credit for programmatic usage (`claude -p`, Agent SDK, GitHub Actions). Usage draws from this credit first, then from optional usage credits at API rates. See [Anthropic's announcement](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) for details and credit amounts by plan.

## Setup

### 1. Create Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. `/newbot` → follow prompts → copy the bot token

### 2. Get Your Telegram User ID

Forward any message to [@userinfobot](https://t.me/userinfobot) — it replies with your user ID.

### 3. Configure

```bash
cp .env.example .env
```

Edit `.env`:
```
BOT_TOKEN=your_bot_token_here
ALLOWED_USER_ID=your_telegram_user_id
PROJECTS_DIR=/home/agent/projects
GROQ_API_KEY=your_groq_api_key
```

No OpenAI or Anthropic API key is required in `.env` — agent auth is handled by the login flow (see next step).

#### Optional configuration

All optional, with sensible defaults:

| Env var | Default | Purpose |
|---|---|---|
| `ALLOWED_CHAT_ID` | (unset) | Forum supergroup id. Only the file-send script reads it: a run started in a topic sends files back to the group, and without this the send is refused |
| `CLAUDE_SETTINGS_JSON` | (hardened defaults) | JSON overlay of Claude Agent SDK `Settings` — override the default lockdown (see below) |
| `MAX_CONCURRENT_RUNS` | `4` | Global cap on concurrent agent runs |
| `RUN_TIMEOUT_MS` | (unbounded) | Per-run timeout in ms; unset means `/stop` is the only cancellation |
| `TG_LOG_FILE` | `.data/events.jsonl` | Wide-event log path |
| `LOG_FORMAT` | `pretty` on a TTY, else `logfmt` | `pretty` \| `logfmt` \| `json` |
| `LOG_LEVEL` | `Info` | Minimum log level |
| `DRAFT_INTERVAL_MS` | `300` | Telegram draft update interval (ms) |
| `SPLIT_AT` | `4000` | Message split threshold (chars) |
| `ANTHROPIC_API_KEY` | (unset) | Optional API-key fallback for Docker/CI; unset keeps subscription login |
| `EXECUTOR_MCP_URL` | (unset) | Cloud Executor's org-scoped MCP endpoint (`https://executor.sh/org_<id>/mcp`) |
| `EXECUTOR_API_KEY` | (unset) | Executor API key; sent as `Authorization: Bearer <key>` |

**Executor (external integrations over MCP).** Optionally wire [Executor](https://executor.sh) into every agent run as an MCP server, giving the agent a single tool surface for external systems — Notion, Google Workspace, Vercel, Atlassian, and whatever else you connect. Set both env vars (endpoint and key are minted in the Executor dashboard); when either is blank the bot runs without Executor and nothing else changes. Both providers are wired: Claude via the Agent SDK's `mcpServers`, Codex via an `mcp_servers` config override.

Rather than exposing one tool per integration, Executor exposes a small set of meta-tools that surface to the model under the `mcp__executor__*` prefix:

| Tool | Purpose |
|---|---|
| `execute` | Run TypeScript in a sandboxed runtime; connected integrations are reachable as `tools.<integration>.*` |
| `resume` | Continue a paused, approval-gated execution via its `executionId` |
| `skills` | Fetch long-form how-to guidance (e.g. `skills({name:"execute"})`) kept out of the always-loaded tool descriptions |

Which integrations are available is configured in the Executor dashboard, not in `.env`; the `execute` tool description enumerates them at connect time.

```bash
EXECUTOR_MCP_URL=https://executor.sh/org_xxx/mcp
EXECUTOR_API_KEY=exec_...
```

**Claude agent hardening.** Every Claude run is passed a locked-down SDK `Settings` profile by default: plan mode (`Enter`/`ExitPlanMode`) and interactive/harness tools (`AskUserQuestion`, cron, remote/push, notebook, `DesignSync`, …) are denied, bundled skills / remote control / artifacts are disabled, and `effortLevel` is `high`; workflows stay on. Override any subset with `CLAUDE_SETTINGS_JSON` — top-level keys replace wholesale, `permissions` merges one level deep, and malformed JSON fails fast at boot. Examples:

```bash
CLAUDE_SETTINGS_JSON='{"permissions":{"deny":[]}}'   # clear all denials (re-enables Claude plan mode)
CLAUDE_SETTINGS_JSON='{"effortLevel":"medium"}'      # lower effort, keep every other default
```

### 4. Authenticate the Agent CLIs

Log into each coding-agent CLI once on the host (these persist for the bot):

```bash
claude login   # Claude Code
codex login    # Codex — optional, only if you want the Codex provider
```

`codex login` supports ChatGPT (Plus/Pro/Team) or an OpenAI API key, via a browser-based flow. On startup the bot runs a non-blocking `codex login status` check and only warns if Codex isn't logged in — Claude-only hosts still boot fine.

### 5. Install & Run

```bash
bun install
bun run src/index.ts
```

This runs the bot in the foreground — fine for a first check, and `bun run dev` auto-reloads on changes during development. For any real deployment, run it as a systemd service (next section): it auto-restarts on crashes and survives reboots.

### 6. Run as a Service (recommended)

To keep the bot running across reboots and auto-restart on crashes, install it as a systemd **user** service. One command detects your paths and sets everything up:

```bash
bun run service:install
```

This detects the `bun` binary (`process.execPath`), the repo directory, your `.env`, and the `PATH` dirs holding `bun`/`claude`/`codex`; generates `~/.config/systemd/user/telegram-claude.service`; runs `daemon-reload`; `enable --now`; and enables linger so the bot survives logout and starts at boot. It is idempotent — re-run it any time (e.g. after `bun upgrade` moves the binary) and it reconciles the unit, restarting only if the definition changed.

Preview the generated unit without writing anything:

```bash
bun run service:install --dry-run
```

Add `--with-backup` to also install the nightly database snapshot timer (see [State and backups](#state-and-backups)):

```bash
bun run service:install --with-backup
```

Operations:

| Command | Description |
|-----------------------------|-------------------------------------------|
| `bun run service:status`    | Show active/enabled/linger and backup-timer state (`--json` for a machine-readable blob) |
| `bun run service:logs`      | Follow the journal (`-n <N>` scrollback, `--no-follow` to tail once) |
| `bun run service:backup`    | Take one database snapshot through the systemd unit, then show its journal |
| `bun run service:restart`   | Restart the service |
| `bun run service:start`     | Start the service |
| `bun run service:stop`      | Stop the service |
| `bun run service:uninstall` | Disable, stop, and remove the units (leaves `.env`, linger and existing snapshots untouched) |

If `loginctl enable-linger` needs privilege on your host, install prints the exact `sudo loginctl enable-linger $USER` to run and continues. The raw `systemctl --user … telegram-claude` / `journalctl --user -u telegram-claude -f` commands still work for anyone who prefers them.

**Alternative: tmux.** If you'd rather not use systemd, run the bot in a detached tmux session — `tmux new-session -d -s telegram-claude 'bun run src/index.ts'` — and reattach with `tmux attach -t telegram-claude`. It survives SSH disconnects but won't auto-restart on crashes or come back after a reboot, so prefer the service for anything long-lived.

### 7. Upgrading an existing install

```bash
git pull
bun install
bun run service:restart
```

The first boot after the upgrade creates `.data/bot.db` and imports the old JSON stores into it — active project, provider, per-provider model and effort choices, and every session id in `state.json` and `sessions.json`. The import is guarded by a flag inside the database, so it runs once; the JSON files are left on disk untouched and are never read again. Topics need nothing: each one pins itself the first time you write in it.

Re-run `bun run service:install --with-backup` if you want the nightly snapshot timer. Install is idempotent, so re-running it is safe.

## Topics

Each forum topic is a separate conversation. It pins its own project and provider, keeps its own session id, its own message queue and its own compose draft, and its run has its own slot — so topics work in parallel, bounded only by `MAX_CONCURRENT_RUNS`. A chat without topics, a plain group and the forum's General topic each stay one conversation, exactly as before.

**In your private chat with the bot.** Turn topic mode on for the bot in [@BotFather](https://t.me/BotFather) (`/mybots` → pick the bot → bot settings → topics). Your chat with it then opens as a list of topics rather than one thread. To confirm it took, `getMe` reports the flag:

```bash
curl -s "https://api.telegram.org/bot$BOT_TOKEN/getMe"   # "has_topics_enabled": true
```

**In a forum supergroup.** Create a supergroup, turn **Topics** on in its settings, then add the bot as an **administrator** with permission to manage topics. Behaviour is identical to private-chat topics. Two BotFather switches matter here and no API can change them: privacy mode must be **disabled** (`/setprivacy`) or the bot never sees plain messages in a topic, and group membership must be **enabled** (`/setjoingroups`). The bot logs a warning at startup for either.

**Naming.** A topic you name yourself is left alone. When Telegram names it for you, the bot renames it from the first text or voice message you send, using the active provider's cheapest model — one turn, no tools, no session file, and silently dropped if it fails. Renaming the topic yourself before that first message also wins.

**Commands inside a topic.** `/stop` and `/new` affect that topic alone. `/projects` re-pins the topic to the chosen project — starting a fresh session there — and also becomes the default for new conversations; `/provider` behaves the same way. Other topics keep the project and provider they are pinned to. `/verbose` is the one global switch: it applies to every conversation at once.

## Commands

| Command | Description |
|-----------|--------------------------------------|
| `/projects` | Select active project directory |
| `/provider` | Switch coding agent provider (Claude Code / Codex) |
| `/model` | Switch model within the active provider |
| `/effort` | Switch reasoning-effort level within the active provider |
| `/history` | Browse and resume past sessions |
| `/stop` | Kill running agent process |
| `/status` | Show active project, provider & process state |
| `/new` | Clear session, start fresh conversation |
| `/compact` | Summarize the active session in place, keeping it (Claude Code only) |
| `/verbose` | Toggle tool calls, thinking and the metadata footer on or off |
| `/compose` | Start collecting messages into a batch |
| `/send` | Send all composed messages as one prompt |
| `/cancel` | Cancel compose mode, discard messages |
| `/branch` | Show current git branch |
| `/pr` | List open pull requests |
| `/help` | Show available commands |

Text messages are forwarded to the active coding agent as prompts. Voice messages are transcribed and forwarded the same way.

### Quiet Output

Output is quiet by default: a run shows a typing indicator and then one message with the answer. Tool calls, thinking, sub-agent messages and the metadata footer (project, cost, time, turns) never reach the chat, and no draft previews are streamed — a long answer is still split across messages, and an error always shows. `/verbose` toggles the full dev view back on and reports which mode you landed in. The choice is stored in `.data/bot.db` and applies to every conversation.

### Switching Providers

Use `/provider` to pick between Claude Code and OpenAI Codex via an inline keyboard. The choice is global, persisted across restarts, and switching auto-stops any running process. The active provider is shown in `/status`, `/help`, the pinned project message, and the startup message. Sessions are tracked separately per provider, so `/history` and follow-up continuity stay scoped to whichever provider is active.

### Compacting a Session

Long conversations eventually fill the context window. `/compact` summarizes the active project's session for the active provider in place: the session id is unchanged, so the next message continues the same conversation instead of starting over as `/new` would. A run in flight is stopped first (as with `/new`), and the reply quotes the context size before and after when the provider reports it.

Only Claude Code supports it — the Agent SDK reaches the CLI's own compaction by sending `/compact` as the prompt for the resumed session, and reports the result on a `compact_boundary` message. The Codex SDK (0.146.0) exposes no compaction API, so `/compact` declines for Codex and points at `/new` rather than clearing anything.

### Compose Mode

Use `/compose` to batch multiple messages into a single prompt. Useful for forwarding context from other chats, combining voice notes with text, or building multi-part requests. All message types are supported: text, voice (auto-transcribed), forwarded messages, files, and photos. Send `/send` when done or `/cancel` to discard.

## How It Works

- Runs the active provider in the selected project dir and normalizes its streaming output into a provider-agnostic event model
  - Claude Code: the Agent SDK `query()` runs in-process (no CLI spawn); it bundles its own Claude binary and reuses `~/.claude` login
  - Codex: spawns `codex exec --json` (resume via `codex exec resume <id>`)
- Quiet by default: a typing indicator while the run works, then the answer. In verbose mode the response is also streamed back as drafts (~300ms interval), falling back to progressive message editing if drafts aren't supported
- Long responses auto-split into multiple messages (4000 char limit)
- Follow-up messages continue the same session for the active provider (Claude via the SDK `resume` option, Codex `exec resume <id>`); a forum topic keeps its session id on its own row, everything outside a topic keeps one session per project per provider
- UI features adapt to provider capabilities — Codex omits cost/turns (duration only) and subagent messages; both stream thinking
- Voice notes are transcribed via Groq Whisper (`whisper-large-v3-turbo`)
- When `EXECUTOR_MCP_URL` + `EXECUTOR_API_KEY` are set, cloud Executor is attached to both providers as an MCP server, so the agent can reach external integrations through its `mcp__executor__*` meta-tools
- One run at a time per conversation (across providers); a message sent while that conversation is busy is queued, while other topics keep running in parallel up to `MAX_CONCURRENT_RUNS`
- Plan mode is organic for both providers: Claude writes to `.claude/plans/` and calls `ExitPlanMode`; Codex follows the `.codex/plans/PLAN.md` convention it's taught via an injected prompt prefix. Either triggers the same interception — the bot displays the plan as plain text and offers action buttons: execute in a new session, execute keeping context, or modify with feedback
- Use `/stop` to cancel the current process and clear the queue

## State and backups

Everything the bot remembers lives in `.data/`, next to the code. It is git-ignored and the only thing worth backing up.

| File | Holds |
|---|---|
| `.data/bot.db` | SQLite: forum topics (project pin, provider, session id), per-project sessions, compose drafts, and settings — active project and provider, model and effort per provider, verbosity |
| `.data/events.jsonl` | one JSON line per run (see [Observability](#observability)) |
| `.data/backups/` | nightly `bot.db` snapshots, once you install the timer |
| `.data/state.json`, `.data/sessions.json` | legacy JSON stores. Imported into `bot.db` once on first boot, then left in place and never read again |

The database runs in WAL mode, so `bot.db-wal` and `bot.db-shm` sit beside it.

### Nightly backup

Two more systemd user units: `telegram-claude-backup.service` takes one snapshot, `telegram-claude-backup.timer` fires it daily with `Persistent=true`, so a run missed while the machine was down is caught up. Install and check them:

```bash
bun run service:install --with-backup
systemctl --user list-timers telegram-claude-backup
```

Each run writes `.data/backups/bot-YYYYMMDD.db.gz` and deletes snapshots older than 14 days; set `BACKUP_KEEP_DAYS` in `.env` to change the window. The snapshot is taken with `sqlite3 .backup`, so `sqlite3` must be on `PATH`. Take one by hand:

```bash
bun run service:backup   # through the installed unit, then prints its journal
bun run backup           # the script directly, no systemd
```

`bun run service:status` shows the timer's state next to the bot's.

### Restore

```bash
bun run service:stop
gunzip -c .data/backups/bot-20260901.db.gz > .data/bot.db
rm -f .data/bot.db-wal .data/bot.db-shm
bun run service:start
```

Deleting the stale `-wal` and `-shm` files matters: they belong to the database you just replaced. `events.jsonl` and the legacy JSON files are not in the snapshot.

## Observability

Each run appends exactly one structured JSON line to `.data/events.jsonl` — outcome, cost, tokens, duration, turns, provider, and project. Economics degrade to `null` (never a fabricated `0`) when a run is interrupted or errors. Query it with no extra infra:

```bash
bun run logs          # recent runs, aligned table
bun run logs:errors   # only failed runs (error class + message)
bun run logs:stats    # counts by outcome + total cost/time
bun run logs:follow   # live tail
```

The path is overridable via `TG_LOG_FILE`, and `LOG_FORMAT=json` mirrors the same record to stdout.

## Stack

TypeScript, Bun, [Effect](https://effect.website/), [grammy](https://grammy.dev/), [Claude Agent SDK](https://docs.anthropic.com/en/api/agent-sdk/overview), [Groq SDK](https://github.com/groq/groq-typescript)

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)
