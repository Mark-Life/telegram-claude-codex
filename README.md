# Owner Telegram Bot

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A private Telegram bot that runs [Codex](https://developers.openai.com/codex), [Claude Code](https://code.claude.com) or [pi](https://pi.dev) on your own server. You write to it in Telegram, the agent works in one directory on the machine, and the answer comes back to the chat.

- **One owner.** The user in `ALLOWED_USER_ID` gets full access. Other people get only what their tier allows, inside a sandbox.
- **One process.** Bun polls Telegram, so there is no webhook and no public port. Each run starts a `codex`, `claude` or `pi` child process.
- **One data directory.** SQLite, logs and backups live in `.data/`. Back up only that.

It also handles voice messages, forum topics, recurring tasks, reminders, group chats, and acting as your own Telegram account. See [docs/usage.md](docs/usage.md).

## Requirements

- A Linux server with systemd
- [Bun](https://bun.sh) 1.4+, Node 24+ and git
- At least one agent CLI, logged in as the service account: `codex`, `claude`, or `pi` 1.6.x
- `sudo apt install bubblewrap socat sqlite3`, for the sandbox and backups
- A bot token from [@BotFather](https://t.me/BotFather), your numeric Telegram user id, and a [Groq](https://console.groq.com) key for voice messages

## Deploy

1. In [@BotFather](https://t.me/BotFather), send `/newbot` to get `BOT_TOKEN`. Then send `/setprivacy` and choose **Disable**, so the bot can read group messages.
2. Clone it under its own account. The bot works in `WORK_DIR` and can edit its own code there.

   ```bash
   sudo adduser --disabled-password --gecos "" bot
   sudo -iu bot
   mkdir -p ~/workspace
   git clone https://github.com/Mark-Life/telegram-claude-codex ~/workspace/owner-telegram-bot
   cd ~/workspace/owner-telegram-bot
   bun install
   cp .env.example .env
   ```

3. Set the required values in `.env`. Put each comment on its own line, because systemd reads a trailing `# ...` as part of the value. Optional variables are in [docs/configuration.md](docs/configuration.md).

   ```bash
   BOT_TOKEN=123456:ABC...
   ALLOWED_USER_ID=123456789
   GROQ_API_KEY=gsk_...
   WORK_DIR=/home/bot/workspace
   ```

4. Log in to an agent as `bot`: `codex login` or `claude auth login`. To set up pi, see [docs/providers.md](docs/providers.md#set-up-pi). You can also connect Codex later from the chat with `/login`.
5. Run it once by hand: `bun run apps/telegram/src/index.ts`. It prints `Bot started` and sends you a message.
6. Install it as a service:

   ```bash
   deploy/install.sh --with-backup
   journalctl --user -u bot -f
   ```

   This installs systemd user units, so it needs no root. It turns on lingering and adds a nightly backup. See [docs/operations.md](docs/operations.md).

The bot speaks English by default. To switch to Russian, use `/settings`.

## Optional

| Feature | How |
| --- | --- |
| Parallel conversations | A forum supergroup with the bot as admin, then `/setworkspace`. See [docs/access.md](docs/access.md) |
| Other people | `/grant <id> <executor\|member>`, `/users` |
| Gmail, Notion, GitHub and more | [Executor](https://executor.sh): `EXECUTOR_MCP_URL`, `EXECUTOR_API_KEY` |
| Voice replies | `ELEVENLABS_API_KEY` |
| Automatic model routing, smarter group replies | `TYPESAFE_API_KEY` |
| Act as your Telegram account | `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, then `/login`. See [docs/telegram-account.md](docs/telegram-account.md) |
| HTTP API | `API_ENABLED=true`, a reverse proxy with HTTPS, keys from `/apikeys`. See [docs/http-api.md](docs/http-api.md) |

## Operating

```bash
systemctl --user status bot
journalctl --user -u bot -f
systemctl --user restart bot   # after an .env change
```

The user sees one plain sentence when a run fails. The details go to the journal, and every run is also logged in `.data/events.jsonl`. To update, pull and restart, or ask the bot to update itself.

## Development

```bash
bunx turbo dev --filter=telegram
bun run typecheck
bun run check   # bun run fix to auto-fix
bun test
```

Every check must pass before a commit. The code layout is in `AGENTS.md`.

## Docs

|  |  |
| --- | --- |
| [usage.md](docs/usage.md) | commands, model routing, `/settings`, tasks |
| [configuration.md](docs/configuration.md) | every environment variable |
| [providers.md](docs/providers.md) | Codex, Claude Code and pi |
| [access.md](docs/access.md) | tiers, groups, sandbox, forum workspace |
| [telegram-account.md](docs/telegram-account.md) | acting as your Telegram account |
| [http-api.md](docs/http-api.md) | keys, endpoints, limits |
| [operations.md](docs/operations.md) | `.data/`, service unit, backups, logs |

## License

[MIT](LICENSE)
