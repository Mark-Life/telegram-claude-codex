# Providers: Codex, Claude Code and pi

## What the bot looks for

No setting turns a provider on. At startup the bot finds each provider's CLI, checks the login and logs one line per provider, such as `Codex CLI: <path>`, with a status.

| Status       | Meaning              |
| ------------ | -------------------- |
| `ready`      | CLI found, logged in |
| `logged_out` | CLI found, no login  |
| `missing`    | CLI not found        |
| `unknown`    | Check timed out      |

With no provider ready, every run fails until you connect an account.

|  | Codex | Claude Code (optional) |
| --- | --- | --- |
| Binary | `codex` | `claude` |
| Search path | `PATH`, `~/.local/bin`, `~/bin`, `~/.bun/bin`, `~/.codex/bin` | `PATH`, `~/.local/bin`, `~/bin`, `~/.bun/bin`, `~/.claude/local` |
| Override | `CODEX_BIN` | `CLAUDE_BIN` |

- A systemd unit takes `PATH` from `/etc/environment`, not your shell rc file. So `which codex` in your terminal can mislead you.
- Install Claude as the service account: `curl -fsSL https://claude.ai/install.sh | bash`. Log in with `claude auth login`.
- A revoked Claude login still reads `ready`, and every Claude run then fails. Log in again or switch with `/provider`.

With both ready, new conversations start on Codex. `/provider` changes a conversation.

On Claude, a member gets file tools in the sandbox view. Groups, guests and Business get web search only. A member run is refused without both `bwrap` and `socat`.

The sandbox view keeps Claude's credentials file, and a member's shell can read it. Runs bill your subscription. Grant `member` only to people you trust with it.

## Connect the Codex account

As the owner, in the chat:

```
/login
```

It lists each account the bot signs in to, with its status. To connect Codex, tap «Sign in: Codex» and approve the link and code on any device. The bot confirms when done. It waits ten minutes; send `/login` again to retry.

You can also run `codex login` in a shell **as the service account** (`sudo -iu bot codex login`). A login as another user puts the credentials where the service cannot read them. After a shell login, send `/login` to recheck. No restart is needed. Every run bills to this account; sign out with `codex logout`.

| `/login` says | Fix |
| --- | --- |
| `Codex: not installed on the server.` | No CLI at boot. `journalctl --user -u bot \| grep 'CLI'` shows what was tried. Install it or set `CODEX_BIN`, then restart. |
| `I could not start the connection. Try again later.` | CLI found but would not start. |

### Which provider a conversation uses

A conversation stays on the provider it started on. A new topic uses the New chats default in `/settings` of whoever writes first. Groups, guests, members and Business always use the light provider.

`/provider` is owner only and shows once two or more providers are installed. It works in a workspace forum topic or the owner's private chat. A switch starts a new conversation and stops what was running.

## Connect the Claude account

`/login` has no Claude entry yet. In a shell, as the service account:

```
claude auth login
```

`/provider` sees the new login without a restart. To make Claude the default provider, restart with `systemctl --user restart bot`. `journalctl --user -u bot | grep -i claude` shows `Claude CLI: <path>` and its status.

## pi

### Detection

The bot looks for `pi` in this order: `PI_BIN`, `PATH`, `~/.pi/agent/bin`, `~/.local/bin`, `~/bin`, `~/.bun/bin`. pi is `ready` when it has a model and credentials for it. The model is `PI_DEFAULT_MODEL`, else `defaultProvider/defaultModel` in `~/.pi/agent/settings.json`.

Setup, keys and a `models.json` example: [Set up pi](#set-up-pi).

### How a run works

pi runs do not load your pi extensions, MCP servers, pi skills, themes or project `.pi/`. Your and executor runs get your workspace `AGENTS.md` and `~/.pi/agent/AGENTS.md` ([usage](usage.md#personal-rules-and-skills)).

- `/skill:<name>` loads one of the bot's skills. Other `/` messages go to pi as text.
- `/compact` and `/context` work.
- `/usage` does not show pi's limits.

### Picking a model

A conversation runs on the default model until you pick another. The default is `PI_DEFAULT_MODEL`, else pi's `settings.json`, or your pi pick in My settings → New chats.

Favourites are `enabledModels` in `~/.pi/agent/settings.json`. Use exact `provider/id`s or globs such as `"openrouter/anthropic/claude-*"`.

| Command | Result |
| --- | --- |
| `/model` | Buttons: current pick, «Default», favourites, recent picks. |
| «All models» | Every id, grouped by provider. |
| `/model <words>` | Sets a full `provider/id` at once, else shows matches: `/model openrouter claude sonnet`. |
| `/effort` | Thinking levels of the model, if it has them. |

The bot reloads the model list about once a day, and soon after a restart.

### Which providers are offered

Only providers whose key works are offered. With no OpenRouter key, no OpenRouter model shows.

Groups, guests, members, Business and helper passes get no key from the bot's env. A provider keyed only there is offered for your runs, but not in «Groups and guests» → Model. Put the key in `auth.json` or `models.json`.

| `!command` key                                           | Works for      |
| -------------------------------------------------------- | -------------- |
| `!sh -c '. ~/.pi/agent/.env.local; …'`                   | These runs too |
| `!cat ~/.config/openrouter.key`, `!pass show openrouter` | Your runs only |

### Local models are off

Local models are off for every run, yours included. A model is local when its `baseUrl` points to a non-public address: `http://127.0.0.1:11434/v1`, `localhost`, LAN, tailnet or link-local. A remote server on a custom port (`https://gpu.example.com:8443/v1`) is not local.

Local models do not show in `/model` or the `/settings` pickers. A conversation that still uses one fails, and the log says `runs on a local endpoint`. With a local default, `/model` marks the default row «(not available now)»; pick a model below it.

These are refused too:

- Azure without `AZURE_OPENAI_RESOURCE_NAME`.
- Google Vertex.
- A host that does not resolve. The log says `does not resolve`.

### Blocked env variables

pi runs never get these variables:

`AZURE_OPENAI_BASE_URL`, `AZURE_OPENAI_ENDPOINT`, `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `GOOGLE_GEMINI_BASE_URL`, `GOOGLE_VERTEX_BASE_URL`, `LLAMA_BASE_URL`, every `AWS_ENDPOINT_URL*`, and a `GOOGLE_CLOUD_LOCATION` that is not a plain region name.

- A key in `auth.json` whose `env` sets one is refused.
- If `auth.json` does not parse, every model is refused.
- In your pi runs, the `aws` CLI ignores `endpoint_url` in `~/.aws/config` (R2, MinIO) and goes to AWS.

A script that needs one of them works on Claude and Codex, but not on pi.

### Helper passes

Topic titles and the format pass of script tasks run on pi when you pick pi in «Groups and guests», or when no Codex or Claude is ready. The model is the one picked there, else `PI_LIGHT_MODEL`, else pi's default. Set each pass's provider, model and depth in «Helpers» of `/settings` ([Helper passes](usage.md#helper-passes)).

### Executor, Telegram account and memory

Your and executors' runs get Executor (when `EXECUTOR_MCP_URL` and `EXECUTOR_API_KEY` are set) and your Telegram account (when logged in). Group runs get the chat's group memory. pi never sees the Executor key or account token.

Account writes still wait for your button under `TELEGRAM_ACCOUNT_WRITES=confirm`. pi's own `mcp.json` is never read.

### Access limits

| Sender | pi gets |
| --- | --- |
| Group | No file or shell tools, no web search. Only the chat's memory. |
| Guest, Business | No file or shell tools, no web search. Chat only. |
| Member | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` in the sandbox view. Refused without both `bwrap` and `socat`. |

The sandbox view holds pi's `auth.json`, `models.json`, `models-store.json`, `settings.json` and `.env.local`, read-only. A member's tools can read your keys.

## Set up pi

pi runs models from OpenRouter, any OpenAI-compatible endpoint, or a provider pi supports with an API key.

### Install

Install pi as the service account with pi's managed installer. Keep it at 1.6.x; the bot warns at boot about any other minor. The installer and `pi update --self` take the latest release and delete older ones.

To install exactly 1.6.0 next to what you have, run this as the service account:

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

A failed step leaves pi on its old release. Then check `~/.pi/agent/bin/pi --version` and restart the bot. To roll back, write the old version (`1.4.0`) to `current-version` the same way and restart.

### Key and model

For OpenRouter, put the key in `~/.pi/agent/auth.json` (mode 0600):

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

| Topic | What to do |
| --- | --- |
| Keys | pi does not read `~/.pi/agent/.env.local` or a `.env`. A `$NAME` key comes from the bot's env, which only your runs get. For light runs, put the key in `auth.json`, `models.json`, or a `!command` there. |
| Member access | A member can read your pi keys. Grant `member` only to people you trust, and use a key with a spending limit. |
| `PI_LIGHT_MODEL` | A cheap model for groups, guests, topic titles, the format pass and the address judge's fallback. Key its provider in `auth.json` or `models.json`. |

Local models, blocked env variables and access limits: see [pi](#pi).
