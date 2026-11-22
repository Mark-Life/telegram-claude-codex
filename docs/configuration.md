# Configuration

The bot reads `.env` and `.env.local` from the repo root (`packages/env/src/bot.ts`). Real environment variables win. A missing or malformed required value stops the bot at boot.

Never put a comment on the same line as a value. systemd keeps a trailing `# ...` as part of the value, so `DEFAULT_TZ=Europe/Sofia  # my zone` stops the bot. In `.env.example` each comment sits above its key, so you can safely uncomment a key line.

## Core

| Variable | Required | Default | What it does |
| --- | --- | --- | --- |
| `BOT_TOKEN` | yes | none | BotFather token. Must not be empty. |
| `ALLOWED_USER_ID` | yes | none | Numeric Telegram id of the owner. Only source of owner rights. Never stored, cannot be granted. |
| `GROQ_API_KEY` | yes | none | Voice transcription. |
| `ELEVENLABS_API_KEY` | no | unset | [ElevenLabs](https://elevenlabs.io) key for voice replies: a run asked to answer by voice sends a voice message (`send-voice-to-user.ts`). Pick voice and model in `/settings` → Voice replies. Unset: the run says voice is not set up and answers in text. Needs `ffmpeg` on the host. |
| `WORK_DIR` | yes | unset | The one directory all runs work in, for example `/home/bot/workspace`. User files live at its root, and this repo is cloned at `<WORK_DIR>/owner-telegram-bot`. |

## Providers

No variable enables a provider. An installed, logged-in CLI is enough.

| Variable | Default | What it does |
| --- | --- | --- |
| `BWRAP_BIN` | `bwrap` on `PATH` | Absolute path to bubblewrap. |
| `SOCAT_BIN` | `socat` on `PATH` | Absolute path to socat. |
| `CODEX_BIN` | resolved at boot | Absolute path to `codex`. Needed only if it is not on `PATH` or in `~/.local/bin`, `~/bin`, `~/.bun/bin`, `~/.codex/bin`. |
| `CLAUDE_BIN` | the SDK's binary | Claude Code binary for runs. Follows that install's updates. Must be the native binary, best as an absolute path. A bare name is looked up on `PATH`. A `.js` entry or a bad path leaves Claude `unsupported`. |
| `PI_BIN` | resolved at boot | The `pi` CLI. Needed only if it is not on `PATH` or in `~/.pi/agent/bin`, `~/.local/bin`, `~/bin`, `~/.bun/bin`. |
| `PI_DEFAULT_MODEL` | pi's `settings.json` default | Model as `provider/id` (`openrouter/z-ai/glm-5.2`). With no value here or in `~/.pi/agent/settings.json`, pi reads `logged_out`. |
| `PI_LIGHT_MODEL` | `PI_DEFAULT_MODEL` | Model for light runs (groups, guests, members, Business replies), topic titles, the format pass and the address judge's fallback. |
| `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` | unset | API key or long-lived token instead of `claude auth login`. A set token wins over the stored login. |
| `CODEX_AUTO_COMPACT_TOKENS` | `150000` | Context size, in tokens, where Codex summarizes a session in place and keeps the same session id. Anything but a positive integer falls back to the default. `/settings` → Providers → Codex → Compaction point overrides it. |

`PI_LIGHT_MODEL` notes:

- «Groups and guests» → Model in `/settings` wins for light runs, titles and formatting.
- «Helpers» → Model wins for that helper's pass.
- Light runs get no provider key from the bot's env. Put the key in pi's `auth.json` or `models.json`. A model keyed only by the env (`GROQ_API_KEY`) is skipped, and pi's default is used.

**Warning:** `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` reach every Claude child. A member's run can print them with `env`, and can read the credentials file too. Codex runs with full access (owner, executors, tasks) inherit them too.

## Model tiers

Tiers: Luna, Terra, Sol, Astra. `CODEX_TIER_MODELS` and `CLAUDE_TIER_MODELS` map each to a slug, e.g. `luna=gpt-6-luna,terra=gpt-5.6-terra`.

**Codex default:** each tier takes the first candidate below, newest first, that the account lists in `$CODEX_HOME/models_cache.json`. With no list, the first candidate.

| Tier  | Candidates                                |
| ----- | ----------------------------------------- |
| Astra | `gpt-6.2-astra`, `gpt-6-astra`            |
| Sol   | `gpt-6.2-sol`, `gpt-6.1-sol`, `gpt-6-sol` |
| Terra | `gpt-6.1-terra`, `gpt-5.6-terra`          |
| Luna  | `gpt-6-luna`                              |

**Claude default:** Luna, Terra, Sol and Astra are the full ids of the `haiku`, `sonnet`, `opus` and `fable` aliases. A slug the account does not offer is dropped with a warning.

When `CODEX_TIER_MODELS` is set, it replaces the candidates whole, one slug per tier. An unknown tier or a malformed pair stops the bot at boot.

A tier is not offered when:

- `CODEX_TIER_MODELS` leaves it out.
- Its slug is missing from the account's list.
- The account lists none of its candidates. Example: a ChatGPT Go login offers no Sol or Astra and only `gpt-5.6-terra`, so it gets Terra and Luna.

Picks of a tier that is not offered move to the nearest offered tier. A stored pick of a missing slug moves the same way.

The judge uses `luna`. So do light runs, the formatter and topic titles, unless «Groups and guests» → Model picks another tier (see [Settings](usage.md#settings)).

## Limits and time

| Variable | Default | What it does |
| --- | --- | --- |
| `DEFAULT_TZ` | `Europe/Sofia` | IANA zone for new reminders. Reminders in it show no zone label. An unknown zone stops the bot. `/settings` → Time zone overrides it. |
| `MAX_CONCURRENT_RUNS` | `4` | Runs at once across all conversations and task fires. Runs waiting on background work do not count. `/settings` → Tasks at once overrides it. |
| `MAX_BACKGROUND_RUNS` | `20` | Conversations and `prompt` task fires that may wait on background work at once, apart from `MAX_CONCURRENT_RUNS`. Turns that work starts later (report, wake-up, message sent in) run here too. A waiting Claude process holds about 150–250 MB. |

## Executor

| Variable | Default | What it does |
| --- | --- | --- |
| `EXECUTOR_MCP_URL` | unset | [Executor](https://executor.sh) MCP endpoint, given to runs that are allowed it. v1: `https://executor.sh/<org>/mcp`. v2: `https://mcp.executor.sh/org/<org>/mcp`. |
| `EXECUTOR_API_KEY` | unset | Sent as `Authorization: Bearer`. A v1 API key, or a v2 personal access token (`exp_…`). Codex gets it by environment, not command line, so other users on the host cannot read it from the process list. Claude never gets it: the bot calls Executor for it. |
| `EXECUTOR_VERSION` | `v2` for `mcp.executor.sh`, else `v1` | How script tasks replay. `v1` posts to REST `/api/executions`. `v2` uses the MCP `execute` tool at `EXECUTOR_MCP_URL`. Set it yourself for a self-hosted Executor. Any other value stops the bot. |

Executor needs both URL and key. A blank string counts as unset.

**Use your own Executor values.** The URL is scoped to one organisation, and the key acts as it. A run reaches everything that organisation connected (Notion, GitHub, Vercel…). Mint a key in your own dashboard for this machine. Never copy the pair from another `.env`. You would hand your bot a stranger's integrations, and revoking the key later breaks both machines.

## TypeSafe

`TYPESAFE_API_KEY` (unset by default): [TypeSafe](https://typesafe.ai) key for four judgments. Nothing breaks without it. Use one key per machine. One judgment costs 550–900 input tokens.

| Judgment | Without the key |
| --- | --- |
| Model for a new conversation | Terra at medium effort |
| Call name: address or mention | One-turn pass on the helper provider (Codex, Claude, pi, or the one in «Helpers») |
| Did a scheduled report do its work | Skipped |
| Does a message ask for a reminder the keyword scan missed | Skipped |

## Telegram account

| Variable | Default | What it does |
| --- | --- | --- |
| `TELEGRAM_API_ID` | unset | App id from [my.telegram.org](https://my.telegram.org). See [Telegram account](telegram-account.md). |
| `TELEGRAM_API_HASH` | unset | App hash from the same page. Set both or neither: only one stops the bot at boot. |
| `TELEGRAM_ACCOUNT_WRITES` | `confirm` | `confirm`: every action as the owner (message, file, forward, edit, delete, reaction, pin, poll…) waits for the owner's button. `direct`: writes run at once, so scheduled tasks can send unattended. Raw `tg_call` writes always wait. `/settings` → Confirm account actions overrides it. |
| `TELEGRAM_ACCOUNT_MCP_PORT` | `0` | Loopback port for the account tools. `0` picks a free port. |

## HTTP API

| Variable | Default | What it does |
| --- | --- | --- |
| `API_ENABLED` | `false` | Turns on the [HTTP API](http-api.md). On: `true`, `yes`, `on`, `1`, `y`. Off: `false`, `no`, `off`, `0`, `n`, unset. Any other value (`True` too) stops the bot. |
| `API_PORT` | `8787` | Port on `127.0.0.1`. Read only with `API_ENABLED=true`. Use a reverse proxy for the internet. If in use, the API stays off, the bot runs and the owner gets a message. |
| `API_PUBLIC_URL` | `http://127.0.0.1:<API_PORT>` | `http(s)://` address clients use through your proxy. Shown in the OpenAPI document and `/apikeys`. Setting it also makes the failed-key limit read the client address from the last `X-Forwarded-For` entry. Unset, that header is ignored. A trailing `/` is dropped. A non-http(s) value stops the bot. |

## Logging

| Variable | Default | What it does |
| --- | --- | --- |
| `LOG_FORMAT` | `pretty` on a TTY, else `logfmt` | `pretty`, `logfmt` or `json`. Under systemd keep `logfmt`. |
| `LOG_LEVEL` | `Info` | `All`, `Fatal`, `Error`, `Warn`, `Info`, `Debug`, `Trace`, `None`. |
| `TG_LOG_FILE` | `events.jsonl` | Run ledger, also access changes, API keys and API writes. A relative path resolves in `.data/`. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | Also send logs (run events too) and traces to an OTel backend. The local ledger is always written. |
| `OTEL_EXPORTER_OTLP_HEADERS` | unset | `k1=v1,k2=v2` auth headers for that endpoint. |
