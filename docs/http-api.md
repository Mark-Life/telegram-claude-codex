# HTTP API

Call the bot over HTTP with an API key. Use it from scripts, webhooks, pipelines, Codex, or ChatGPT through [Executor](https://executor.sh). A key acts as the Telegram user who made it, as in a private chat with the bot. Off by default.

## Turn it on

1. In `.env`, set `API_ENABLED=true`, a free `API_PORT` (default `8787`) and `API_PUBLIC_URL`. This is the HTTPS address clients use, for example `https://bot.example.com`. See [Configuration](configuration.md).
2. Restart the bot. The journal says `HTTP API on 127.0.0.1:<port>, public at <url>`.
3. Put an HTTPS reverse proxy in front of the port. The server binds `127.0.0.1` only and never terminates TLS. For Caddy, use [`deploy/bot-api.caddy.example`](../deploy/bot-api.caddy.example).
4. Make a key with `/apikeys` in a private chat with the bot.

If the port is taken (`wrangler dev` also uses `8787`), the bot still starts without the API. The journal says `HTTP API not started: port <port> unavailable` and the owner gets a private message. Pick another `API_PORT` and restart.

Check from the server: `curl -s http://127.0.0.1:8787/v1/health` answers `{"status":"ok"}`.

## Keys

A key looks like `pab_<id>_<secret>`. Only the owner and executors can hold keys, each their own.

| Task | How |
| --- | --- |
| Make a key | `/apikeys` → «New key», then send a name (one line, up to 64 characters). |
| List keys | `/apikeys` → «My keys». The owner's «All keys» shows everyone's. Also CLI or `keys.list`. |
| Revoke a key | `/apikeys`, the CLI, or `keys.revoke`. Revoking is permanent. |

- The bot sends the key once, in a message it deletes after 10 minutes.
- Copy it into the client at once. For Executor, use its secure connect page, never a chat.
- The bot stores only a sha256 of the secret. A lost key cannot be shown again: make a new one.
- Keys are never made over the API, so a leaked key cannot mint more.
- An owner or executor run in your private chat can also make a key when you ask (`packages/agent/scripts/apikeys-cli.ts`, see the `bot-api-keys` skill). It never prints the key. It sends it to your private chat the same way, and revokes the key if that message fails.
- Runs elsewhere (the workspace forum, a task that does not hold your Telegram account) cannot make keys. Use `/apikeys` in the private chat.

Your tier is read on every request. If an executor is demoted or revoked, their keys get `403 Forbidden` at once. They work again if the tier returns.

A run the key started stops too. It stops at once after a revoke in `/apikeys` or over the API. It stops within a few seconds after a revoke in the CLI or a demotion.

The owner gets a message when an executor makes a key. The access watcher reports every key made, revoked, moved to another user, given another secret or deleted outside the bot, like a tier change. A run can write `.data/bot.db` directly.

**Treat a key like the bot itself.** It gets everything its holder gets in a private chat. Owner and executor runs have the whole machine (shell, `.env`, `.data`) and the owner's Telegram account. An executor's key is not a smaller power than the owner's in practice.

## Calling it

Send the key as `Authorization: Bearer <key>` or `x-api-key: <key>`. Only `GET /v1/health`, `GET /openapi.json` and `GET /docs` need no key.

| Request | operationId | What it does |
| --- | --- | --- |
| GET `/v1/health` | `health.get` | bot is up (no key) |
| GET `/v1/me` | `me.get` | `telegramUserId`, `tier`, `keyId`, `keyName` |
| GET `/v1/keys` | `keys.list` | live keys; all keys for the owner |
| POST `/v1/keys/{keyId}/revoke` | `keys.revoke` | revoke a key (any key, for the owner) |
| GET `/v1/tasks` | `tasks.list` | all recurring tasks, with `nextRunAt` |
| GET `/v1/tasks/{taskId}` | `tasks.get` | one task |
| POST `/v1/tasks` | `tasks.create` | new task |
| PATCH `/v1/tasks/{taskId}` | `tasks.update` | change sent fields; `enabled` pauses or resumes |
| DELETE `/v1/tasks/{taskId}` | `tasks.delete` | delete; stops a running or waiting fire (204) |
| POST `/v1/tasks/{taskId}/run` | `tasks.runNow` | fire now, in the background (202, `{admitted: "queued" \| "coalesced"}`) |
| GET `/v1/reminders?date=&from=&to=&tz=` | `reminders.list` | due order, undated last; optionally for local days |
| POST `/v1/reminders` | `reminders.create` | reminder (`at`, ISO 8601 with an offset) or undated to-do |
| PATCH `/v1/reminders/{reminderId}` | `reminders.update` | `text`, `at` (`null` undates), `tz` |
| POST `/v1/reminders/{reminderId}/complete` | `reminders.complete` | mark done, close its topic |
| DELETE `/v1/reminders/{reminderId}` | `reminders.delete` | same as complete, as in the CLI (204) |
| POST `/v1/notify` | `notify.send` | `{text, to: "me" \| "workspace"}`: a plain message, link previews off |
| POST `/v1/runs` | `runs.create` | start a run (202, `{runId, status}`); `Idempotency-Key` header |
| GET `/v1/runs/{runId}?waitSec=0..20` | `runs.get` | status and answer; waits up to `waitSec` |
| POST `/v1/runs/{runId}/cancel` | `runs.cancel` | stop a run |
| GET `/v1/settings/mine` | `settings.getMine` | your defaults: provider, model, effort |
| PATCH `/v1/settings/mine` | `settings.updateMine` | change |
| GET `/v1/settings/bot` | `settings.getBot` | owner: language, replies, time zone, limits, groups, workspace, account |
| PATCH `/v1/settings/bot` | `settings.updateBot` | owner: change; `workspace: null` unlinks |
| GET `/v1/settings/light` | `settings.getLight` | owner: light-run settings (groups, guests, members, Business) |
| PATCH `/v1/settings/light` | `settings.updateLight` | owner: change |
| GET `/v1/settings/helpers` | `settings.getHelpers` | owner: `format`, `judge`, `title` helper passes |
| PATCH `/v1/settings/helpers/{use}` | `settings.updateHelper` | owner: change one pass |
| GET `/v1/settings/voice` | `settings.getVoice` | owner: voice-reply model and voice, and the voices to pick from |
| PATCH `/v1/settings/voice` | `settings.updateVoice` | owner: change |
| GET `/v1/settings/providers` | `settings.getProviders` | owner: per-provider settings, with the values they take |
| PATCH `/v1/settings/providers/{provider}` | `settings.updateProvider` | owner: change; `null` restores default |

`GET /openapi.json` is the OpenAPI 3.1 document, with `API_PUBLIC_URL` as its server. Executor imports it as typed tools named by the operationIds. `GET /docs` shows it as a page.

### Errors

Errors are JSON `{"_tag": "...", "message": "..."}`.

| Status | `_tag` | Meaning |
| --- | --- | --- |
| 401 | `Unauthorized` | No key, a wrong one, or a revoked one. |
| 403 | `Forbidden` | The holder lost owner or executor access, or may not do this. |
| 404 | `NotFound` |  |
| 409 | `Conflict` | Bot state does not allow it now (such as no workspace), or an `Idempotency-Key` reused with another body. |
| 413 | `PayloadTooLarge` | Body over the cap below. Nothing is done. |
| 422 | `InvalidInput` | Schema mismatch or a bot rule refused it. `message` says what to change. |
| 429 | `RateLimited` | See below. |
| 503 | `Unavailable` | Telegram failed, or every agent run slot is busy. Nothing was done. |

### Limits

| Limit      | Value                                              |
| ---------- | -------------------------------------------------- |
| Reads      | 60 a minute per key                                |
| Writes     | 20 a minute per key                                |
| Agent runs | 20 an hour per key; at most 2 of one user at once  |
| Bad keys   | 20 a minute from one client address, then it waits |
| Body size  | 964096 bytes (about 940 KiB)                       |

- Each rate limit refills gradually.
- The body cap fits a `runs.create` at its longest prompt and input, even with every character `\uXXXX`-escaped. A larger body gets `PayloadTooLarge` 413 and nothing is done.
- A run counts only once it starts. A refusal or an `Idempotency-Key` replay costs none of the hour's runs.
- A 429 carries `Retry-After` and `retryAfterSec`.
- Behind the proxy, the client address is the last `X-Forwarded-For` entry, the one the proxy added.

### Audit log

Every key made or revoked, and every API request that changes something, is a `telegram.api` line in `.data/events.jsonl`. It records who, which key, which operation, and how it ended. Never a body or a key.

```bash
curl -s -H "Authorization: Bearer $KEY" https://bot.example.com/v1/me
```

## Tasks, reminders and notices

Same rules as in Telegram (`/tasks`, `/reminders`, the CLIs).

**Tasks** are shared by the owner and executors, as in `/tasks`.

- A change to `payload`, `type`, `project`, `chatId` or `threadId` makes the task yours. It then runs with your powers.
- A pause, rename, new schedule or run choice keeps the task's writer.
- Only the writer or the owner may make a script a gate (`sessionMode` `own` or `route` on a script), or make a gate a plain script without a new `payload`.
- A `route` task runs in your private chat with the bot (`chatId` = your Telegram user id, see `me.get`) or in the workspace.
- A task without `chatId` is silent. Only its failures reach the owner.
- If `provider`, `modelTier` and `effortLevel` are left out (or `null` on update), they follow the writer's `/settings`.
- A change over the API reaches the scheduler at once. A change made with the tasks CLI is picked up within a minute.

**Reminders**:

- `at` is ISO 8601 with `Z` or an offset (`2026-09-08T09:00:00+03:00`). Resolve "tomorrow at 9" to one first.
- `tz` defaults to the home zone from `/settings`, else `DEFAULT_TZ`.
- A dated reminder is sent in its own topic when due, within 30 seconds.

**Notices** (`notify.send`):

- Go to your private chat with the bot. The owner can send to the workspace topic instead.
- Plain text, at most 4096 characters, link previews off. The bot does not answer them.
- A user who never started the bot gets `Conflict`.

```bash
curl -s -X POST -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"text":"Call the bank","at":"2026-09-08T09:00:00+02:00"}' https://bot.example.com/v1/reminders
```

## Agent runs

`runs.create` works as if you wrote to the bot in your private chat: same model choice (`/settings`), skills and machine. It runs in the background and answers at once with a `runId`.

```bash
curl -s -X POST -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -H 'Idempotency-Key: mail-1842' \
  -d '{"prompt":"Does this email need me? If yes, two lines. If not, answer exactly __TASK_SKIP__.","input":"From: ...","profile":"guest","deliver":"agent"}' \
  https://bot.example.com/v1/runs
# {"runId":12,"status":"running"}
curl -s -H "Authorization: Bearer $KEY" "https://bot.example.com/v1/runs/12?waitSec=20"
```

### Request fields

| Field | Values |
| --- | --- |
| `prompt` | Up to 32000 characters. What you would write to the bot. |
| `input` | Up to 128000 characters. Data to work on, such as an email or webhook body. It comes after the prompt, fenced and marked as data. |
| `profile` | `full` (default): what you get in your private chat. Owner and executor runs have the shell, `.env`, connected services and the owner's Telegram account. `guest`: what a stranger gets. Read-only in a scratch directory, web search, no secrets, no connected services, no Telegram account, light model. |
| `deliver` | `never` (default): answer stays here. `always`: also sent to your private chat, under a line naming the key. `agent`: the run decides. It is sent unless the answer is exactly `__TASK_SKIP__`, the word a silent task uses. |

Marking `input` as data is no defence. Text in it can still steer the run. Run untrusted input with `profile: "guest"`.

The answer also comes back here, so a pipeline can branch on it. Check `status`: a failed run sends nothing.

### Statuses

| Status | Meaning |
| --- | --- |
| `running` | Working. |
| `succeeded` | Done, with `result`. |
| `failed` | Failed, with `error`. |
| `cancelled` | Stopped by `runs.cancel`, or its key was revoked, or its holder lost the tier it started at. |
| `interrupted` | The bot restarted mid-run. Start it again. |

There is no queue. When every run slot is busy, `runs.create` answers `Unavailable` with `Retry-After` and starts nothing.

### Result and polling

- **`result`**: `text` is the final answer, cut at 8000 characters (`truncated`). `notified` is `{chatId, messageId}` when the bot sent it to your chat. `costUsd` appears when the provider reports one (none do today).
- **`pendingAccountActions`** `[{id, kind}]` sits beside `status` on a run of any status. It lists writes the run asked for on the owner's Telegram account that still wait for the button. A cancelled or failed run's writes can still be approved.
- **`runs.get?waitSec=20`** waits up to 20 seconds for the run to end. Loop it to follow a run without busy polling.
- A run is visible to its key's user. The owner sees every run.
- **`runs.cancel`** stops a running run. It answers a few seconds later, `cancelled` once the run stopped. What it already did stays done.
- **`Idempotency-Key`**: send any unique string with `runs.create` to make a retry safe. The same key and body answers the run the first call started. The same key with another body is `Conflict`. Keys are kept per API key, for good.

### Behavior

- A run keeps no conversation. Every run starts fresh, never continues your chat, and leaves nothing for your next message there.
- It uses lower-priority slots, never the one kept for the owner.
- It does not wait on background work it starts. Its last answer is its result.
- Writes as the owner always wait for the button, whatever `TELEGRAM_ACCOUNT_WRITES` or `/settings` say. The confirmation names the API key whose run asked.
- A restart waits for running API runs, as it waits for chat runs. A run cut anyway is `interrupted` after boot.

## Settings

Same settings and rules as `/settings` in Telegram. A value Telegram would not offer is refused here too. Changes show on both sides at once.

| Endpoints | Who |
| --- | --- |
| `settings.getMine`, `settings.updateMine` («My settings») | Every key holder (owner and executors), for their own. |
| All other `settings.*` | Owner only. An executor's key gets `Forbidden`. |

- **`options`**: every read lists what each field takes now (runnable providers, tiers, effort levels). A write takes only those values.
- **Errors**: `InvalidInput` lists the allowed values. `Conflict` means bot state blocks it, for example your own defaults on a provider not installed or not logged in, a voice with no ElevenLabs key, or a write mode with no Telegram account.
- **Atomic**: nothing is stored if any field of a request is refused. Fields are checked together: `{"provider":"claude","model":"sol"}` checks `sol` against Claude.
- **Partial writes**: a write changes only the fields sent and answers with the setting as it now stands.
- **Models** are tiers: `luna`, `terra`, `sol`, `astra`, weakest first. Each provider runs a tier on its own model. `default` is the provider's own. `auto` (the model router picks) works in your own defaults where it can be routed.
- **pi** has no tiers. Its `model` takes a pi model by name (`provider/id`) from `options.model`.
- **Provider settings** are those of `/settings` → «Providers», by the provider's own key. `null` unsets one. Only the listed keys can be set. Nothing else of the provider's config is reachable.

**Not available here:**

- Secrets. An ElevenLabs key shows only as `configured`, the Telegram account only as its `status`.
- The bot's persona and Telegram profile (the `bot-profile` skill).
- Access and trusted groups (`/users`, the `bot-access` skill).
- Linking a workspace. Use `/setworkspace` in the group itself. The API only unlinks.
- One conversation's `/model`, `/effort` or `/provider`. An API run never continues a conversation.

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
