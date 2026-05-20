# telegram-claude

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Telegram bot interface for Claude Code on a VPS. Message the bot from any device, it runs Claude Code in your project directories and streams back results.

## Features

- **Project switching** — select any project directory via inline keyboard, auto-unpins old messages
- **Streaming responses** — real-time draft messages with edit-based fallback
- **Session continuity** — follow-up messages continue the same Claude conversation
- **Message queuing** — messages sent while Claude is busy are queued and processed in order
- **Thinking stream** — Claude's thinking/reasoning content streamed in a separate message
- **Branch awareness** — current git branch and open PRs shown in `/status` and response footers
- **Voice messages** — voice notes transcribed via Groq Whisper, then sent to Claude as text
- **Long response splitting** — auto-splits messages exceeding Telegram's 4000 char limit
- **MarkdownV2 rendering** — formatted output with plain text fallback
- **Plan mode interception** — when Claude enters plan mode, the plan is presented for approval with options to execute (new/resume session), modify with feedback, or cancel
- **Cost & duration tracking** — metadata footer on each response
- **Compose mode** — collect multiple messages (text, voice, forwarded, files, photos) into a single prompt with `/compose` and `/send`
- **Access control** — single authorized user via Telegram user ID

## Prerequisites

- [Bun](https://bun.sh/) runtime
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed and authenticated
- [ffmpeg](https://ffmpeg.org/) — required for voice messages >20MB (chunked transcription)
- [Groq](https://console.groq.com/) API key — for voice message transcription

> **Note:** This bot uses `claude -p` (programmatic usage). Starting June 15, 2026, paid Claude plans include a dedicated monthly credit for programmatic usage (`claude -p`, Agent SDK, GitHub Actions). Usage draws from this credit first, then from optional usage credits at API rates. See [Anthropic's announcement](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) for details and credit amounts by plan.

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

### 4. Install & Run

```bash
bun install
bun run src/index.ts
```

For development, you can use `bun run dev` for auto-reload on changes, or run in a tmux session. However, tmux is not suitable for production — it won't auto-restart on crashes or survive reboots. Use a systemd service for persistent deployments.

### 5. Run as a Service (recommended)

To keep the bot running across reboots and auto-restart on crashes, set up a systemd user service.

A template service file is included in the repo. Edit `telegram-claude.service` to set the correct paths for your system:

- `WorkingDirectory` — path to this repo
- `EnvironmentFile` — path to your `.env` file
- `ExecStart` — absolute path to `bun`
- `Environment=PATH=...` — must include directories containing both `bun` and `claude` binaries

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
| `/history` | Browse and resume past Claude sessions |
| `/stop` | Kill running Claude process |
| `/status` | Show active project & process state |
| `/new` | Clear session, start fresh conversation |
| `/compose` | Start collecting messages into a batch |
| `/send` | Send all composed messages as one prompt |
| `/cancel` | Cancel compose mode, discard messages |
| `/branch` | Show current git branch |
| `/pr` | List open pull requests |
| `/help` | Show available commands |

Text messages are forwarded to Claude Code as prompts. Voice messages are transcribed and forwarded the same way.

### Compose Mode

Use `/compose` to batch multiple messages into a single Claude prompt. Useful for forwarding context from other chats, combining voice notes with text, or building multi-part requests. All message types are supported: text, voice (auto-transcribed), forwarded messages, files, and photos. Send `/send` when done or `/cancel` to discard.

## How It Works

- Spawns `claude -p "<msg>" --output-format stream-json` in the selected project dir
- Streams response back via `sendMessageDraft` (~300ms interval), falling back to progressive message editing if drafts aren't supported
- Long responses auto-split into multiple messages (4000 char limit)
- Follow-up messages continue the same Claude session via `-r <session-id>`
- Voice notes are transcribed via Groq Whisper (`whisper-large-v3-turbo`), files >20MB are chunked with ffmpeg
- One active process per user; messages sent while busy are queued automatically
- When Claude writes a plan file and calls `ExitPlanMode`, the bot intercepts it, displays the plan as plain text, and offers action buttons: execute in a new session, execute keeping context, or modify with feedback
- Use `/stop` to cancel the current process and clear the queue

## Stack

TypeScript, Bun, [grammy](https://grammy.dev/), [Groq SDK](https://github.com/groq/groq-typescript)

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)
