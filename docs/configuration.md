# Configuration

The bot reads `.env` and `.env.local` from the repo root. A missing or bad required value stops the bot at boot.

Never put a comment on the same line as a value. systemd keeps a trailing `# ...` as part of the value, so `DEFAULT_TZ=Europe/Sofia  # my zone` stops the bot.

## Core

| Variable | Required | What it does |
| --- | --- | --- |
| `BOT_TOKEN` | yes | BotFather token. |
| `ALLOWED_USER_ID` | yes | Your numeric Telegram id. The only owner. |
| `GROQ_API_KEY` | yes | Voice transcription. |
| `WORK_DIR` | yes | Where all runs work, e.g. `/home/bot/workspace`. This repo is cloned at `<WORK_DIR>/owner-telegram-bot`. |
| `ELEVENLABS_API_KEY` | no | [ElevenLabs](https://elevenlabs.io) key for voice replies. Pick voice and model in `/settings` → Voice replies. Needs `ffmpeg`. |

## Providers

A provider works once its CLI is installed and logged in. These variables are overrides.

| Variable | Default | What it does |
| --- | --- | --- |
| `BWRAP_BIN`, `SOCAT_BIN`, `CODEX_BIN`, `PI_BIN` | on `PATH` | Absolute paths, if a binary is not on `PATH`. |
| `CLAUDE_BIN` | the SDK's binary | Absolute path to the native Claude Code binary. A `.js` file or a bad path leaves Claude `unsupported`. |
| `PI_DEFAULT_MODEL` | pi's `settings.json` | Model as `provider/id`, e.g. `openrouter/z-ai/glm-5.2`. With no model set anywhere, pi shows `logged_out`. |
| `PI_LIGHT_MODEL` | `PI_DEFAULT_MODEL` | Model for light runs: groups, guests, members, Business replies. `/settings` → «Groups and guests» → Model overrides it. |
| `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` | unset | Use instead of `claude auth login`. |
| `CODEX_AUTO_COMPACT_TOKENS` | `150000` | Context size where Codex summarizes the session. `/settings` → Providers → Codex → Compaction point overrides it. |

Light runs on pi get no provider key from the bot's env. Put the key in pi's `auth.json` or `models.json`.

**Warning:** `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` reach every Claude run and every full-access Codex run. A member's run can print them with `env` and read the credentials file.

## Model tiers

`CODEX_TIER_MODELS` and `CLAUDE_TIER_MODELS` map the tiers Luna, Terra, Sol and Astra to model slugs, e.g. `luna=gpt-6-luna,terra=gpt-5.6-terra`. A bad pair stops the bot at boot.

By default, a Codex tier takes the newest model the bot knows for that tier that your account offers, e.g. `gpt-6.2-sol`. Claude's defaults are `haiku`, `sonnet`, `opus` and `fable`, in tier order.

The bot hides a tier your account does not offer. For example, a ChatGPT Go login gets only Terra and Luna. Light runs use Luna unless «Groups and guests» → Model picks another tier (see [Settings](usage.md#settings)).

## Limits and time

| Variable | Default | What it does |
| --- | --- | --- |
| `DEFAULT_TZ` | `Europe/Sofia` | IANA zone for new reminders. An unknown zone stops the bot. `/settings` → Time zone overrides it. |
| `MAX_CONCURRENT_RUNS` | `4` | Runs at once. `/settings` → Tasks at once overrides it. |
| `MAX_BACKGROUND_RUNS` | `20` | Conversations that may wait on background work at once. Each waiting Claude process holds about 150–250 MB. |

## Executor

| Variable | Default | What it does |
| --- | --- | --- |
| `EXECUTOR_MCP_URL` | unset | [Executor](https://executor.sh) MCP endpoint. v1: `https://executor.sh/<org>/mcp`. v2: `https://mcp.executor.sh/org/<org>/mcp`. |
| `EXECUTOR_API_KEY` | unset | A v1 API key, or a v2 personal access token (`exp_…`). |
| `EXECUTOR_VERSION` | `v2` for `mcp.executor.sh`, else `v1` | Set it for a self-hosted Executor. |

Executor needs both the URL and the key.

**Use your own Executor values.** A run reaches everything the key's organisation connected (Notion, GitHub, Vercel…). Mint a key for this machine. Never copy the pair from another `.env`.

## TypeSafe

`TYPESAFE_API_KEY` is an optional [TypeSafe](https://typesafe.ai) key. One judgment costs 550–900 input tokens. Use one key per machine.

Without the key, a new conversation uses Terra at medium effort, and the helper provider checks call names. Report checks and missed-reminder checks are skipped.

## Telegram account

| Variable | Default | What it does |
| --- | --- | --- |
| `TELEGRAM_API_ID` | unset | App id from [my.telegram.org](https://my.telegram.org). See [Telegram account](telegram-account.md). |
| `TELEGRAM_API_HASH` | unset | App hash from the same page. Set both or neither. |
| `TELEGRAM_ACCOUNT_WRITES` | `confirm` | `confirm`: every action as the owner waits for your button. `direct`: actions run at once, so tasks can send unattended. `/settings` → Confirm account actions overrides it. |
| `TELEGRAM_ACCOUNT_MCP_PORT` | `0` (a free port) | Loopback port for the account tools. |

## HTTP API

| Variable | Default | What it does |
| --- | --- | --- |
| `API_ENABLED` | `false` | `true` turns on the [HTTP API](http-api.md). An unknown value, `True` too, stops the bot. |
| `API_PORT` | `8787` | Port on `127.0.0.1`. Put a reverse proxy in front for the internet. |
| `API_PUBLIC_URL` | `http://127.0.0.1:<API_PORT>` | Address clients use through your proxy. When set, the bot trusts `X-Forwarded-For` for the client address. |

## Logging

| Variable | Default | What it does |
| --- | --- | --- |
| `LOG_FORMAT` | `pretty` on a TTY, else `logfmt` | `pretty`, `logfmt` or `json`. Under systemd keep `logfmt`. |
| `LOG_LEVEL` | `Info` | `Error`, `Warn`, `Info`, `Debug`, `Trace` and others. |
| `TG_LOG_FILE` | `events.jsonl` | Run ledger. A relative path resolves in `.data/`. |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS` | unset | Also send logs and traces to an OTel backend. Headers as `k1=v1,k2=v2`. |
