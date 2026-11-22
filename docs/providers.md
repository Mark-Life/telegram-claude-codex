# Providers: Codex, Claude Code and pi

## What the bot looks for

No setting turns a provider on. At startup the bot finds each provider's CLI and asks if the account is logged in (5 s at most each). It logs one line per provider, such as `Codex CLI: <path>`, with a status.

| Status       | Meaning              |
| ------------ | -------------------- |
| `ready`      | CLI found, logged in |
| `logged_out` | CLI found, no login  |
| `missing`    | CLI not found        |
| `unknown`    | Check timed out      |

With nothing ready the bot keeps running, but every run fails until you connect an account.

|  | Codex | Claude Code (optional) |
| --- | --- | --- |
| Binary | `codex` | `claude` |
| Login check | `codex login status` | `auth status` on the SDK's CLI |
| Search path | `PATH`, `~/.local/bin`, `~/bin`, `~/.bun/bin`, `~/.codex/bin` | `PATH`, `~/.local/bin`, `~/bin`, `~/.bun/bin`, `~/.claude/local` |
| Override | `CODEX_BIN` | `CLAUDE_BIN` |

- A CLI installed after boot is found at the next check.
- A systemd unit takes `PATH` from `/etc/environment`, not your shell rc file. `which codex` in your terminal can mislead you.
- Install Claude as the service account: `curl -fsSL https://claude.ai/install.sh | bash`. Log in with `claude auth login`.
- A `claude` on the search path only tells the bot Claude is installed. Runs use the CLI that `@anthropic-ai/claude-agent-sdk` ships (`bun install` pulls about 236 MB for it).
- The check confirms a login exists, not that it works. A revoked token reads `ready` and every Claude run fails. Log in again or switch with `/provider`.

With both ready, new conversations start on Codex. `/provider` changes a conversation. Claude serves the address judge's fallback (no `TYPESAFE_API_KEY`, or its call failed) when Codex is not ready, or when you pick it in «Helpers».

Executor, the Telegram account and group memory work on Claude too. The bot holds the tokens and passes each call on, so a Claude child never sees them.

| Sender | Claude gets |
| --- | --- |
| Group, guest, Business | No local tools. Web search only. |
| Member | File tools in the sandbox view, as on Codex. Refused without both `bwrap` and `socat`. |

The sandbox view keeps Claude's real credentials file. Runs bill your subscription, and a member's shell could read that file. Grant `member` only to people you trust with it.

## Connect the Codex account

As the owner, in the chat:

```
/login
```

It lists each account the bot signs in to, with its status: your Telegram account and each provider with a device flow (Codex today). The Codex status is what `codex login status` says.

When the machine is not authenticated:

1. Tap «Sign in: Codex». The bot runs `codex login --device-auth`.
2. The bot posts a link and a code. Approve them on any device.
3. The bot confirms when the process exits.

It waits ten minutes, then kills the child. Send `/login` again to retry. «Cancel sign-in: Codex» kills it sooner. Sign out in the shell with `codex logout`, since every run bills to that account.

Alternative: run `codex login` in a shell **as the service account** (`sudo -iu bot codex login`). A login as another user leaves the credentials where the service cannot read them.

A missing account at boot shows in the startup message. A Codex sign-in, or a `/login` that finds the account already connected, rechecks every provider. No restart needed.

| `/login` says | Fix |
| --- | --- |
| `Codex: not installed on the server.` | No CLI at boot. `journalctl --user -u bot \| grep 'CLI'` shows what was tried. Install it or set `CODEX_BIN`, then restart. |
| `I could not start the connection. Try again later.` | CLI found but would not start. |

### Which provider a conversation uses

A conversation stays on the provider it started on.

| Where | Provider |
| --- | --- |
| Forum topic | The one in its row. If it cannot run, the bot answers with one sentence and the topic stays. |
| New topic | Default of whoever writes first (New chats in `/settings`), if chosen and able to run |
| Owner's private chat | The owner's stored choice, else the detected default |
| Everything else, executors' private chats outside a topic too | Detected default: the first ready provider |
| Topic in an executor's private chat | Pinned by a run or their `/new`, never `/provider`. If it cannot run, it moves to their default (else the detected one) and starts a new conversation. |
| Groups, guests, members, Business | Always the light provider, topics too |

The owner and executors share the private-chat conversation of one project and provider.

`/provider` is owner only. It is listed once two or more providers are installed. It changes the provider of the conversation it is sent in: a workspace forum topic (for the owner and executors writing there) or the owner's private chat. A switch starts a new conversation and stops what was running. In the private chat it also clears the stored conversation on the new provider, which executors share.

## Connect the Claude account

`/login` has no Claude entry yet. In a shell, as the service account:

```
claude auth login
```

`/provider` and a refused message recheck without a restart. The default provider is set at boot and after a Codex `/login`. To make Claude the default, run `systemctl --user restart bot`.

`journalctl --user -u bot | grep -i claude` shows `Claude CLI: <path>` and its status.

## pi

### Detection

pi (`pi`, 1.6.x from its managed installer) is searched in this order: `PI_BIN`, `PATH`, `~/.pi/agent/bin`, `~/.local/bin`, `~/bin`, `~/.bun/bin`.

- `ready`: pi has a model and `pi auth check --no-refresh` finds credentials for it. The model is `PI_DEFAULT_MODEL`, else `defaultProvider/defaultModel` in `~/.pi/agent/settings.json`.
- No model: `logged_out`.
- A default that may not run (a local one) leaves pi ready while another model exists, with one log warning. With none left, `logged_out`.
- A version outside 1.4.x logs a warning and is still used.

Setup, keys and a `models.json` example: [Set up pi](#set-up-pi).

### How a run works

Each run starts its own `pi --mode rpc` child with discovery off: no extensions, MCP servers, pi skills, prompt templates, themes, `AGENTS.md`/`CLAUDE.md` or project `.pi/`. Nothing is installed or fetched at startup.

- Your and executor runs get your workspace `AGENTS.md` and pi's `~/.pi/agent/AGENTS.md` from the bot ([usage](usage.md#personal-rules-and-skills)).
- They load the bot's skills: sending a file, recurring tasks and, for you, access, profile, self-update and upstream sync.
- A message starting with `/` is plain text, except `/skill:<name>` of one of those skills. That loads the skill with the rest of the message.
- Your runs keep sessions in `~/.pi/agent/sessions` and resume them.
- `/compact` uses pi's compaction and keeps the session. `/context` shows pi's estimate.
- A message sent while pi works joins the running task.
- When pi is ready, `/usage` says the bot does not show pi's limits.

### Picking a model

pi has no automatic model choice. A conversation runs on the default until you pick another. The default is `PI_DEFAULT_MODEL`, else pi's `settings.json`, or your pi pick in My settings → New chats.

`/model` shows up to eight buttons: the current pick, «Default», your favourites, the last five models picked with `/model`, then models of small providers from `models.json`. A pick no longer listed keeps its row, marked «not available now».

Favourites are `enabledModels` in `~/.pi/agent/settings.json` (the Ctrl+P list in pi, edited with `/scoped-models`). Use exact `provider/id`s or globs such as `"openrouter/anthropic/claude-*"`. A `:high` suffix is ignored.

| Command | Result |
| --- | --- |
| «All models» | Every id, grouped by provider, each tappable to copy. A provider with more than 15 models (OpenRouter) gets one line with its count and a search to send. |
| `/model <words>` | A full `provider/id`, or an id only one provider has, is set at once. Else every word must appear in the id or name, and up to eight matches come back as buttons: `/model openrouter claude sonnet`. |
| `/effort` | Offers the levels of the model's thinking setting, or says it has none. |

The model list is read from pi when `/model` or a `/settings` picker opens, at most once an hour. The cleanup pass also reads it, right after start and every 3 hours, once pi is `ready` and the list is over a day old. So the list and every `!command` key are read soon after a restart and about daily. While the first read runs (a few seconds, longer with a slow `!command` key), `/model`, `/effort` and the `/settings` pickers say the list is loading. A button from an older list asks you to open `/model` again.

### Which providers are offered

Only providers whose key works are offered. pi lists a provider with a `!command` key without running it, so the bot runs each such command itself (3 s at most, output never kept or logged). It drops every provider whose `auth.json` or `models.json` key, or a `models.json` `headers` entry, comes out empty. With no OpenRouter key, no OpenRouter model shows in `/model`, its search, «All models» or the `/settings` pickers.

Groups, guests, members, Business replies and helper passes get no provider key from the bot's env. A provider keyed only there (Groq via `GROQ_API_KEY`, no `groq` in `auth.json` or `models.json`) is offered for your runs (`/model`, New chats) but not in «Groups and guests» → Model.

With `bwrap`, these runs resolve a `!command` key or header inside the sandbox view, which holds only the pi files listed below.

| `!command` | Works for |
| --- | --- |
| `!sh -c '. ~/.pi/agent/.env.local; …'` | These runs too |
| `!cat ~/.config/openrouter.key`, `!pass show openrouter` | Your runs only. The provider is left out of «Groups and guests». |

A light pick or `PI_LIGHT_MODEL` on such a model is skipped for the next in line. When none is left, «Groups and guests» → Model and the helper-pass note say so. Put a key in `auth.json` or `models.json`.

### Local models are off

Local models are switched off for now, for every run, yours included. A model is local when its `baseUrl` is, or resolves to, a non-public address: loopback (`http://127.0.0.1:11434/v1`, `localhost`), LAN, tailnet or link-local. It is left out of `/model`, its search, «All models», favourites, recent picks and the `/settings` pickers. A light pick or `PI_LIGHT_MODEL` on it is skipped for the next in line.

A conversation or light choice that still names one fails with the usual error. The log says `runs on a local endpoint`. A model pi does not list fails the same way, since its endpoint cannot be checked.

With a local default, a conversation with no pick of its own fails. `/model` shows the default row as «(not available now)». Pick a model below it.

A remote server on a custom port (`https://gpu.example.com:8443/v1`) is not local.

The check fails closed. A model runs only when pi sends it to an `http`, `https`, `ws` or `wss` URL whose host resolves to public addresses. So these are refused too:

- No such URL: Azure without `AZURE_OPENAI_RESOURCE_NAME`, and Google Vertex (`{location}` template URL).
- Host does not resolve (DNS down at boot, say). The model stays listed and pi stays ready, but runs are refused until the name resolves. The log says `does not resolve`.

An Azure model (any `azure` model, or an `azure-openai*` api) with `AZURE_OPENAI_RESOURCE_NAME` is checked at `https://<name>.openai.azure.com`. A GitHub Copilot login is checked at the host its token names (`proxy-ep`), else `copilot-api.<enterprise host>`, where pi sends it instead of the listed `baseUrl`.

### Blocked env variables

pi children never get a variable that moves a model past its listed `baseUrl`:

`AZURE_OPENAI_BASE_URL`, `AZURE_OPENAI_ENDPOINT`, `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `GOOGLE_GEMINI_BASE_URL`, `GOOGLE_VERTEX_BASE_URL`, `LLAMA_BASE_URL`, every `AWS_ENDPOINT_URL*`, and a `GOOGLE_CLOUD_LOCATION` that is not a plain region name. Bedrock ignores `endpoint_url` in `~/.aws/config`.

- A key in `auth.json` whose `env` sets one is refused.
- Every model is refused when `auth.json` exists but does not parse.
- Shell commands of your own full-access pi runs lose them too, and get `AWS_IGNORE_CONFIGURED_ENDPOINT_URLS=true`. The `aws` CLI there ignores `endpoint_url` in `~/.aws/config` (R2, MinIO) and goes to AWS.

A script that needs one (an OpenRouter key behind `OPENAI_BASE_URL`, say) works on Claude and Codex, whose runs are unchanged, but not on pi. Handing the names back would let a script reach a local model.

### Helper passes

Topic titles and the format pass of script tasks run on pi when pi is picked in «Groups and guests», or when pi is the only provider that can serve them (no Codex or Claude ready).

Each pass is one `pi --mode json` child: no tools, no session, thinking off, in the sandbox view. The model is the one picked there, else `PI_LIGHT_MODEL`, else pi's default, the first with a key the pass gets.

- The prompt goes on stdin, never the command line.
- A format answer cut off by the output limit is dropped, and the raw output goes out.
- Inline `<think>` reasoning is never sent.

The address judge's fallback (no TypeSafe key, or its call failed) is the same kind of pass. It goes to the first ready of Codex, Claude and pi. Each of the three passes can use any provider, with its own model and depth, in «Helpers» of `/settings` ([Helper passes](usage.md#helper-passes)). On pi, Depth sets thinking.

### Executor, Telegram account and memory

- Your and executors' runs get Executor (when `EXECUTOR_MCP_URL` and `EXECUTOR_API_KEY` are set) and your Telegram account (when logged in).
- Account writes still wait for your button under `TELEGRAM_ACCOUNT_WRITES=confirm`.
- Group runs get the chat's group memory.
- pi never sees the Executor key or account token. The bot opens a local port per run that passes calls on, with a password only pi gets, valid until the run ends.
- A server that does not answer within 10 seconds is left out of that run (`pi.mcp.unavailable` in the log).
- pi's own `mcp.json` (in `~/.pi/agent` or a project's `.pi/`) is never read.

Not yet on pi: automatic model choice and a `/settings` screen of its own.

### Access limits

| Sender | pi gets |
| --- | --- |
| Group | No file or shell tools, no web search. Only the chat's memory. |
| Guest, Business | No file or shell tools, no web search. Chat only. |
| Member | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` in the sandbox view, scratch directory writable. Refused without both `bwrap` and `socat`. |

- A photo sent with an answered group message, or one it replies to, still reaches the model, on every provider. A model without image input gets pi's note instead.
- The sandbox view holds pi's key and config files read-only: `auth.json`, `models.json`, `models-store.json`, `settings.json`, `.env.local`. A member's tools can read your keys.
- The view reaches only the endpoint of the run's model: the URL pi lists for it (catalog or `models.json`), exactly that host and port, at a public address.

## Set up pi

pi runs models from OpenRouter, any OpenAI-compatible endpoint, or a provider pi supports with an API key.

### Install

Install pi as the service account with pi's managed installer. Keep it at 1.6.x. The bot is checked against 1.6.0 and warns at boot about any other minor.

The installer and `pi update --self` always take the latest release. The update then deletes every older release but the one it ran from. To put exactly 1.6.0 next to what you have, run this as the service account. The first line puts the node from pi's installer on `PATH`, as the launcher does, for `npm` and the release's `pi`.

```sh
N=${XDG_DATA_HOME:-$HOME/.local/share}/pi-node/current/bin; [ -x "$N/node" ] && export PATH="$N:$PATH"
R=~/.pi/agent/install/releases/1.6.0
mkdir -p "$R" && cd "$R" &&
  curl -fsSL https://pi.dev/api/installer/releases/1.6.0/package.json -o package.json &&
  curl -fsSL https://pi.dev/api/installer/releases/1.6.0/package-lock.json -o package-lock.json &&
  npm ci --ignore-scripts --min-release-age=0 --omit=dev --include=optional --no-fund --no-audit &&
  [ "$(./node_modules/.bin/pi --version)" = 1.6.0 ] &&
  printf '1.6.0\n' > ~/.pi/agent/install/current-version.tmp &&
  mv ~/.pi/agent/install/current-version.tmp ~/.pi/agent/install/current-version &&
  echo 'pi 1.6.0 is current' || echo 'pi 1.6.0 did not install; current-version is unchanged'
```

Each step runs only if the one before worked. `current-version` changes only when the new release prints `1.6.0`, so a failed download or `npm ci` leaves pi on its old release. Then check `~/.pi/agent/bin/pi --version` and restart the bot.

To roll back, write the old version (`1.4.0`) to `current-version` the same way and restart. The launcher reads it on every start. The old release stays in `releases/`. The bot finds pi in `~/.pi/agent/bin` without `PATH`.

### Key and model

Put a key and a model in `~/.pi/agent`. For OpenRouter, `~/.pi/agent/auth.json` (mode 0600):

```json
{ "openrouter": { "type": "api_key", "key": "sk-or-..." } }
```

Or a custom provider in `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "api": "openai-completions",
      "apiKey": "$OPENROUTER_API_KEY",
      "models": [{ "id": "z-ai/glm-5.2" }]
    }
  }
}
```

Then pick the model: `PI_DEFAULT_MODEL=openrouter/z-ai/glm-5.2` in `.env`, or `defaultProvider` and `defaultModel` in `~/.pi/agent/settings.json`. `pi auth check --provider openrouter --model z-ai/glm-5.2 --json` must say `ready`.

### Notes

- **Keys.** pi does not read `~/.pi/agent/.env.local` or a `.env`. A `$NAME` key comes from the bot's env, which only your runs get. A key that light runs need goes in `auth.json`, literally in `models.json`, or in a `!command` there. The sandbox view binds only `auth.json`, `models.json`, `settings.json`, `models-store.json` and `.env.local` of `~/.pi/agent`, read-only.
- **OAuth.** A pi OAuth login is never refreshed from a run in the sandbox view. An owner run refreshes it.
- **Member access.** The view holds your pi keys, so a member can read them. Grant `member` only to people you trust, and use a key with a spending limit.
- **Models.** Pick in the chat with `/model`. List a few in `enabledModels` of `~/.pi/agent/settings.json` (`["openrouter/anthropic/claude-sonnet-5.5", "groq/*"]`) and `/model` shows them first.
- **`PI_LIGHT_MODEL`.** Set a cheap model for groups, guests, topic titles, the format pass and the address judge's fallback. Its provider must be keyed in `auth.json` or `models.json`, since those runs get no key from the bot's env. A provider whose key does not resolve is left out of every list.
- **Local models, blocked env variables, sandbox network.** See [pi](#pi).
