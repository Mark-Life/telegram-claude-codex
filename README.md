# telegram-claude

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Telegram bot interface for coding agents (Claude Code + OpenAI Codex) on a VPS. Message the bot from any device, it runs the active agent in your project directories and streams back results. Switch providers at runtime with `/provider`.

## Features

- **Multi-provider** — switch between Claude Code and OpenAI Codex at runtime via `/provider`; sessions and capabilities are tracked per provider
- **Project switching** — select any project directory via inline keyboard, auto-unpins old messages
- **Streaming responses** — real-time draft messages with edit-based fallback
- **Session continuity** — follow-up messages continue the same conversation (per provider)
- **Message queuing** — messages sent while the agent is busy are queued and processed in order
- **Thinking stream** — the agent's thinking/reasoning content streamed in a separate message
- **Branch awareness** — current git branch and open PRs shown in `/status` and response footers
- **Voice messages** — voice notes transcribed via Groq Whisper, then sent to the agent as text
- **Long response splitting** — auto-splits messages exceeding Telegram's 4000 char limit
- **MarkdownV2 rendering** — formatted output with plain text fallback
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

For development, you can use `bun run dev` for auto-reload on changes, or run in a tmux session. However, tmux is not suitable for production — it won't auto-restart on crashes or survive reboots. Use a systemd service for persistent deployments.

### 6. Run as a Service (recommended)

To keep the bot running across reboots and auto-restart on crashes, set up a systemd user service.

A template service file is included in the repo. Edit `telegram-claude.service` to set the correct paths for your system:

- `WorkingDirectory` — path to this repo
- `EnvironmentFile` — path to your `.env` file
- `ExecStart` — absolute path to `bun`
- `Environment=PATH=...` — must include directories containing the `bun`, `claude`, and (if used) `codex` binaries

Then symlink and enable it:

```bash
# edit paths in the service file
vim telegram-claude.service

# symlink to systemd user directory
mkdir -p ~/.config/systemd/user
ln -sf "$(pwd)/telegram-claude.service" ~/.config/systemd/user/telegram-claude.service

# allow service to run without an active login session
loginctl enable-linger $USER

# enable and start
systemctl --user daemon-reload
systemctl --user enable telegram-claude
systemctl --user start telegram-claude
```

Useful commands:

```bash
systemctl --user status telegram-claude    # check status
journalctl --user -u telegram-claude -f    # follow logs
systemctl --user restart telegram-claude   # restart
systemctl --user stop telegram-claude      # stop
```

## Commands

| Command | Description |
|-----------|--------------------------------------|
| `/projects` | Select active project directory |
| `/provider` | Switch coding agent provider (Claude Code / Codex) |
| `/history` | Browse and resume past sessions |
| `/stop` | Kill running agent process |
| `/status` | Show active project, provider & process state |
| `/new` | Clear session, start fresh conversation |
| `/compose` | Start collecting messages into a batch |
| `/send` | Send all composed messages as one prompt |
| `/cancel` | Cancel compose mode, discard messages |
| `/branch` | Show current git branch |
| `/pr` | List open pull requests |
| `/help` | Show available commands |

Text messages are forwarded to the active coding agent as prompts. Voice messages are transcribed and forwarded the same way.

### Switching Providers

Use `/provider` to pick between Claude Code and OpenAI Codex via an inline keyboard. The choice is global, persisted across restarts, and switching auto-stops any running process. The active provider is shown in `/status`, `/help`, the pinned project message, and the startup message. Sessions are tracked separately per provider, so `/history` and follow-up continuity stay scoped to whichever provider is active.

### Compose Mode

Use `/compose` to batch multiple messages into a single prompt. Useful for forwarding context from other chats, combining voice notes with text, or building multi-part requests. All message types are supported: text, voice (auto-transcribed), forwarded messages, files, and photos. Send `/send` when done or `/cancel` to discard.

## How It Works

- Runs the active provider in the selected project dir and normalizes its streaming output into a provider-agnostic event model
  - Claude Code: the Agent SDK `query()` runs in-process (no CLI spawn); it bundles its own Claude binary and reuses `~/.claude` login
  - Codex: spawns `codex exec --json` (resume via `codex exec resume <id>`)
- Streams response back via `sendMessageDraft` (~300ms interval), falling back to progressive message editing if drafts aren't supported
- Long responses auto-split into multiple messages (4000 char limit)
- Follow-up messages continue the same session for the active provider (Claude via the SDK `resume` option, Codex `exec resume <id>`); sessions are tracked per provider
- UI features adapt to provider capabilities — Codex omits cost/turns (duration only) and subagent messages; both stream thinking
- Voice notes are transcribed via Groq Whisper (`whisper-large-v3-turbo`)
- When `EXECUTOR_MCP_URL` + `EXECUTOR_API_KEY` are set, cloud Executor is attached to both providers as an MCP server, so the agent can reach external integrations through its `mcp__executor__*` meta-tools
- One active process per user (across providers); messages sent while busy are queued automatically
- Plan mode is organic for both providers: Claude writes to `.claude/plans/` and calls `ExitPlanMode`; Codex follows the `.codex/plans/PLAN.md` convention it's taught via an injected prompt prefix. Either triggers the same interception — the bot displays the plan as plain text and offers action buttons: execute in a new session, execute keeping context, or modify with feedback
- Use `/stop` to cancel the current process and clear the queue

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
