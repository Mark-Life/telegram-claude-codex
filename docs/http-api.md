# HTTP API

The same bot, a different door. Programs (Codex, ChatGPT through [Executor](https://executor.sh), webhooks, pipelines, your own scripts) call it over HTTP with an API key. A key acts exactly as the Telegram user who made it, as if they wrote to the bot in a private chat. Off by default.

## Turn it on

1. In `.env`: `API_ENABLED=true`, a free `API_PORT` (default `8787`) and `API_PUBLIC_URL`, the HTTPS address clients will use (for example `https://bot.example.com`). See [Configuration](configuration.md).
2. Restart the bot. The journal says `HTTP API on 127.0.0.1:<port>, public at <url>`. If something else already holds the port (`wrangler dev` uses `8787` too), the bot still starts, without the API: the journal says `HTTP API not started: port <port> unavailable` and the owner gets a private message. Pick another `API_PORT` and restart.
3. Put a reverse proxy with HTTPS in front of the port. The server always binds `127.0.0.1` and never terminates TLS itself. For Caddy, use [`deploy/bot-api.caddy.example`](../deploy/bot-api.caddy.example).
4. Make a key: `/apikeys` in a private chat with the bot.

Check it from the server: `curl -s http://127.0.0.1:8787/v1/health` answers `{"status":"ok"}`.

## Keys

A key looks like `pab_<id>_<secret>`. Only the owner and executors can hold keys, each their own.

- **Make one** with `/apikeys` → «Новый ключ», then send a name (one line, up to 64 characters). The bot sends the key once, in a message it deletes after 10 minutes. Copy it into the client right away; for Executor, paste it into its secure connect page, never into a chat. The bot keeps only a sha256 of the secret, so a lost key cannot be shown again: make a new one.
- An owner or executor run in your private chat with the bot can make one too when you ask it (`packages/agent/scripts/apikeys-cli.ts`, documented for the run in the `bot-api-keys` skill). Runs elsewhere (the workspace forum, a task that does not hold your Telegram account) are not offered it: use `/apikeys` in the private chat. It never prints the key: it sends it to your private chat with the bot the same way, and revokes the key if that message cannot be sent.
- **List and revoke** in `/apikeys` → «Мои ключи» (the owner's «Все ключи» shows everyone's), in the CLI, or over the API (`keys.list`, `keys.revoke`). Keys are never made over the API, so a leaked key cannot mint more.
- **Tier is read on every request.** Demote an executor to member or revoke them, and their keys stop working at once (`403 Forbidden`); give the tier back and they work again. Revoking a key is permanent. A run the key started that is still working stops too: at once when the key is revoked in `/apikeys` or over the API, within a few seconds after a revoke in the CLI or a demotion.
- When an executor makes a key, the owner gets a message. Every key made, revoked, moved to another user, given another secret or deleted outside the bot (a run can write `.data/bot.db` directly) is reported to the owner by the access watcher, like a tier change.

**Treat a key like the bot itself.** It gets everything its holder gets in a private chat. An owner's or executor's runs have the whole machine (shell, `.env`, `.data`) and the owner's Telegram account, so an executor's key is not a smaller power than the owner's in practice.

## Calling it

Send the key as `Authorization: Bearer <key>` or as `x-api-key: <key>`. Everything but `GET /v1/health`, `GET /openapi.json` and `GET /docs` needs it.

| Method | Path | operationId | What it does |
| --- | --- | --- | --- |
| GET | `/v1/health` | `health.get` | public: the bot is up |
| GET | `/v1/me` | `me.get` | who the key acts as: `telegramUserId`, `tier`, `keyId`, `keyName` |
| GET | `/v1/keys` | `keys.list` | live keys of the key's user; every key for the owner |
| POST | `/v1/keys/{keyId}/revoke` | `keys.revoke` | revoke one of them (any key, for the owner) |
| GET | `/v1/tasks` | `tasks.list` | every recurring task, with `nextRunAt` |
| GET | `/v1/tasks/{taskId}` | `tasks.get` | one task |
| POST | `/v1/tasks` | `tasks.create` | a new task |
| PATCH | `/v1/tasks/{taskId}` | `tasks.update` | change only the fields sent; `enabled` pauses or resumes |
| DELETE | `/v1/tasks/{taskId}` | `tasks.delete` | delete it, stopping a fire that runs or waits (204) |
| POST | `/v1/tasks/{taskId}/run` | `tasks.runNow` | fire it now, in the background (202, `{admitted: "queued" \| "coalesced"}`) |
| GET | `/v1/reminders?date=&from=&to=&tz=` | `reminders.list` | reminders in due order, undated last, optionally for local days |
| POST | `/v1/reminders` | `reminders.create` | a reminder (`at`, ISO 8601 with an offset) or an undated to-do |
| PATCH | `/v1/reminders/{reminderId}` | `reminders.update` | new `text`, `at` (`null` undates it) or `tz` |
| POST | `/v1/reminders/{reminderId}/complete` | `reminders.complete` | done: off the list, its topic closed |
| DELETE | `/v1/reminders/{reminderId}` | `reminders.delete` | the same as complete, as in the CLI (204) |
| POST | `/v1/notify` | `notify.send` | `{text, to: "me" \| "workspace"}`: a plain message from the bot, link previews off |
| POST | `/v1/runs` | `runs.create` | start an agent run (202, `{runId, status}`); `Idempotency-Key` header |
| GET | `/v1/runs/{runId}?waitSec=0..20` | `runs.get` | the run's status and answer, waiting up to `waitSec` for it to end |
| POST | `/v1/runs/{runId}/cancel` | `runs.cancel` | stop a running run |
| GET | `/v1/settings/mine` | `settings.getMine` | your own defaults for new conversations: provider, model, effort |
| PATCH | `/v1/settings/mine` | `settings.updateMine` | change them |
| GET | `/v1/settings/bot` | `settings.getBot` | owner: the bot's settings (language, replies, time zone, limits, groups, workspace, account) |
| PATCH | `/v1/settings/bot` | `settings.updateBot` | owner: change them; `workspace: null` unlinks the workspace |
| GET | `/v1/settings/light` | `settings.getLight` | owner: what light runs run on: groups, guests, members, Business replies |
| PATCH | `/v1/settings/light` | `settings.updateLight` | owner: change it |
| GET | `/v1/settings/helpers` | `settings.getHelpers` | owner: the `format`, `judge` and `title` helper passes |
| PATCH | `/v1/settings/helpers/{use}` | `settings.updateHelper` | owner: change one pass |
| GET | `/v1/settings/voice` | `settings.getVoice` | owner: the voice-reply model and voice, and the voices to pick from |
| PATCH | `/v1/settings/voice` | `settings.updateVoice` | owner: change them |
| GET | `/v1/settings/providers` | `settings.getProviders` | owner: each provider's own settings, with the values they take |
| PATCH | `/v1/settings/providers/{provider}` | `settings.updateProvider` | owner: change some of them; `null` goes back to the provider's default |

- `GET /openapi.json` is the OpenAPI 3.1 document, with `API_PUBLIC_URL` as its server. Executor imports it as typed tools named by the operationIds. `GET /docs` is the same document as a readable page.
- Errors are JSON `{"_tag": "...", "message": "..."}` with the status: `Unauthorized` 401 (no key, a wrong one, a revoked one), `Forbidden` 403 (the holder lost owner or executor access, or may not do this one thing), `NotFound` 404, `Conflict` 409 (the bot's state does not allow it now, such as no workspace, or an `Idempotency-Key` reused with another body), `InvalidInput` 422 (the request did not match the schema, or the bot's rules refused it; `message` says what to change), `PayloadTooLarge` 413 (the body is over the cap below), `RateLimited` 429, `Unavailable` 503 (Telegram failed, or every agent run slot is busy; nothing was done).
- **Rate limits**, per key: 60 reads a minute, 20 writes a minute and 20 agent runs an hour, each refilling gradually (a run counts only once it starts: a refusal or an `Idempotency-Key` replay costs none of the hour's runs); and at most 2 runs of one user going at once. A client address that sends 20 bad keys in a minute waits too. A 429 carries `Retry-After` and `retryAfterSec`. Behind the proxy, the client address is the last `X-Forwarded-For` entry, the one the proxy added.
- A request body is capped at 964096 bytes (about 940 KiB): a `runs.create` at its longest prompt and input fits even with every character `\uXXXX`-escaped. A larger one gets `PayloadTooLarge` 413 and nothing is done.
- Every key made or revoked, and every API request that changes something, is a `telegram.api` line in `.data/events.jsonl`: who, which key, which operation, and how it ended. Never a body or a key.

```bash
curl -s -H "Authorization: Bearer $KEY" https://bot.example.com/v1/me
```

## Tasks, reminders and notices

These are the same as in Telegram, under the same rules, because every door goes through the same code: `/tasks`, `/reminders`, the bot's CLIs and the API.

- **Tasks** are shared by the owner and executors, as in `/tasks`. A change to what a task does or where it reports (`payload`, `type`, `project`, `chatId`, `threadId`) makes it yours: it then runs with your powers. A pause, a rename, a new schedule or run choice keeps its writer. Only the task's writer or the owner may make a script a gate (`sessionMode` `own` or `route` on a script) or a gate a plain script without a new `payload`. A `route` task runs in your own private chat with the bot (`chatId` = your Telegram user id, see `me.get`) or the workspace. Without `chatId` a task is silent: only its failures reach the owner. `provider`, `modelTier` and `effortLevel` left out (or `null` on update) follow the writer's `/settings`.
- A task change over the API is in the scheduler at once, as from `/tasks`; one made with the tasks CLI is picked up within a minute.
- **Reminders** take `at` as ISO 8601 with `Z` or an offset (`2026-09-08T09:00:00+03:00`); resolve "tomorrow at 9" to one first. `tz` defaults to the home zone from `/settings`, else `DEFAULT_TZ`. The bot sends a dated reminder in its own topic when it is due, within 30 seconds.
- **Notices** (`notify.send`) go to your own private chat with the bot, or, for the owner, to the workspace topic. They are plain text, at most 4096 characters, with link previews off, and the bot does not answer them. A user who never started the bot gets `Conflict`.

```bash
curl -s -X POST -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"text":"Call the bank","at":"2026-09-08T09:00:00+02:00"}' https://bot.example.com/v1/reminders
```

## Agent runs

`runs.create` is the bot doing what you ask, as if you wrote it to the bot in your private chat: the same model choice (`/settings`), the same skills, the same machine. It runs in the background; the call answers at once with a `runId`.

```bash
curl -s -X POST -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -H 'Idempotency-Key: mail-1842' \
  -d '{"prompt":"Does this email need me? If yes, two lines. If not, answer exactly __TASK_SKIP__.","input":"From: ...","profile":"guest","deliver":"agent"}' \
  https://bot.example.com/v1/runs
# {"runId":12,"status":"running"}
curl -s -H "Authorization: Bearer $KEY" "https://bot.example.com/v1/runs/12?waitSec=20"
```

- **`prompt`** (up to 32000 characters) is what you would write to the bot. **`input`** (up to 128000) is data it works on, an email or a webhook body: it comes after the prompt, fenced and marked as data. Marking it is no defence: text in it can still steer the run, so run untrusted input with `profile: "guest"`.
- **`profile`**: `full` (the default) gets exactly what you get in your private chat: an owner's or executor's run has the shell, `.env`, your connected services and the owner's Telegram account. `guest` gets what a stranger gets there: read-only in a scratch directory, web search, no secrets in its environment, no connected services, no Telegram account, the light model.
- **`deliver`**: `never` (the default) leaves the answer here only. `always` also sends it to your private chat with the bot, under a line naming the key. `agent` lets the run decide: it is sent unless the answer is exactly `__TASK_SKIP__`, the same word a silent task uses. The answer still comes back here either way, so a pipeline can branch on it; check `status` too, since a failed run sends nothing.
- **Statuses**: `running`, then `succeeded` (with `result`), `failed` (with `error`), `cancelled` (by `runs.cancel`, or because its key was revoked or its holder lost the tier it started at) or `interrupted` (the bot restarted while it worked: start it again). There is no queue: when every run slot is busy, `runs.create` answers `Unavailable` with `Retry-After` and starts nothing.
- **`result`**: `text`, the final answer, cut at 8000 characters (`truncated`); `notified` `{chatId, messageId}` when the bot sent it to your chat; `costUsd` when the provider reports one (none of today's do).
- **`pendingAccountActions`** `[{id, kind}]`, beside `status` on a run of any status: writes the run asked to make on the owner's Telegram account that still wait for the button. A cancelled or failed run's writes can still be approved, so they are listed too.
- **`runs.get?waitSec=20`** waits up to 20 seconds for a running run to end before it answers, so a loop of it follows a run without busy polling. A run is visible to its key's user; the owner sees every run.
- **`runs.cancel`** stops a running run and answers it a few seconds later, `cancelled` once it stopped. What it already did stays done.
- **`Idempotency-Key`**: send any unique string with `runs.create` to make a retry safe. The same key with the same body answers the run the first call started; with another body it is `Conflict`. Keys are kept per API key, for good.
- **A run keeps no conversation.** Every run starts fresh, never continues your chat, and leaves nothing for your next message there. It takes the bot's lower-priority slots, so it never takes the one kept for the owner. It does not wait on background work it starts: its last answer is its result.
- **Writes as the owner always wait for the button**, whatever `TELEGRAM_ACCOUNT_WRITES` or `/settings` say, and the confirmation says which API key's run asked.
- A restart waits for running API runs as it waits for chat runs; a run cut anyway is `interrupted` after the boot.

## Settings

The same settings as `/settings` in Telegram, under the same rules: every door goes through the same code, so a value Telegram would not offer is refused here too, and a change made here is in Telegram at once (and the other way round).

- **Who may call them.** `settings.getMine` and `settings.updateMine` are «Мои настройки»: every key holder (the owner and executors) reads and changes their own. Everything else is the owner's, as in Telegram: an executor's key gets `Forbidden`.
- **Every read lists what each field takes now** in `options`: the providers that can run, the tiers the chosen provider has, the effort levels it offers. A write takes only those. `InvalidInput` says what was wrong and lists the values; `Conflict` means the bot's state does not allow it now (your own defaults on a provider not installed or not logged in, a voice with no ElevenLabs key, a write mode with no Telegram account). Nothing is stored when any field of a request is refused.
- **A write changes only the fields sent** and answers the setting as it now stands. Fields of one request are checked together: `{"provider":"claude","model":"sol"}` checks `sol` against Claude.
- **Models are tiers** (`luna`, `terra`, `sol`, `astra`, weakest first), which each provider runs on its own model, plus `default` (the provider's own) and, in your own defaults where it can be routed, `auto` (the model router picks). On pi, which has no tiers, `model` takes a pi model by name (`provider/id`) from `options.model`.
- **Provider settings** are those `/settings` → «Провайдеры» shows, by the provider's own key. `null` unsets one. Only the listed keys can be set; nothing else of the provider's config is reachable.
- **Not here:** secrets (an ElevenLabs key shows only as `configured`, the Telegram account only as its `status`), the bot's persona and Telegram profile (the `bot-profile` skill), access and trusted groups (`/users`, the `bot-access` skill), linking a workspace (`/setworkspace` in the group itself; the API only unlinks it), and one conversation's `/model`, `/effort` or `/provider` (an API run never continues a conversation).

```bash
curl -s -H "Authorization: Bearer $KEY" https://bot.example.com/v1/settings/mine
curl -s -X PATCH -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"provider":"claude","model":"sol","effort":"high"}' https://bot.example.com/v1/settings/mine
curl -s -X PATCH -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"timeZone":"Europe/Berlin","verbosity":"full","limits":{"groupRunsPerDay":"off"}}' \
  https://bot.example.com/v1/settings/bot
curl -s -X PATCH -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"provider":"claude","effort":"low"}' https://bot.example.com/v1/settings/helpers/title
curl -s -X PATCH -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"maxConcurrentRuns":4}' https://bot.example.com/v1/settings/bot
# A value it does not offer changes nothing:
# {"_tag":"InvalidInput","message":"`maxConcurrentRuns` cannot be `4` now. It takes `1`, `2`, `3`, `5`."}
curl -s -X PATCH -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model_verbosity":"high","model_reasoning_summary":null}' \
  https://bot.example.com/v1/settings/providers/codex
```
