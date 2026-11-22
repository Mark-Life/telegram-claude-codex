# HTTP API

Call the bot over HTTP from scripts, webhooks or [Executor](https://executor.sh). A key acts as the user who made it, as in their private chat with the bot. Off by default.

## Turn it on

1. In `.env`, set `API_ENABLED=true`, `API_PORT` (default `8787`) and `API_PUBLIC_URL`, the HTTPS address clients use. See [Configuration](configuration.md).
2. Restart the bot. The journal says `HTTP API on 127.0.0.1:<port>, public at <url>`.
3. Put an HTTPS reverse proxy in front of the port. For Caddy, use [`deploy/bot-api.caddy.example`](../deploy/bot-api.caddy.example).
4. Make a key with `/apikeys` in a private chat with the bot.

If the journal says `HTTP API not started: port <port> unavailable`, pick another `API_PORT` and restart. `wrangler dev` also uses `8787`.

Check from the server: `curl -s http://127.0.0.1:8787/v1/health` answers `{"status":"ok"}`.

## Keys

Only the owner and executors can hold keys. A key looks like `pab_<id>_<secret>`.

| Task | How |
| --- | --- |
| Make a key | `/apikeys` → «New key», then send a name (up to 64 characters). |
| List keys | `/apikeys` → «My keys». The owner's «All keys» shows everyone's. |
| Revoke a key | `/apikeys` or `keys.revoke`. Revoking is permanent and stops the key's runs. |

The bot sends the key once and deletes the message after 10 minutes. Copy it into the client at once. A lost key cannot be shown again, so make a new one. For Executor, paste it on its secure connect page, never in a chat.

A demoted or revoked executor's keys get `403 Forbidden` at once.

**Treat a key like the bot itself.** It gets everything its holder gets in a private chat: the whole machine (shell, `.env`, `.data`) and the owner's Telegram account. An executor's key is as strong as the owner's in practice.

## Calling it

Send the key as `Authorization: Bearer <key>` or `x-api-key: <key>`. `GET /v1/health`, `GET /openapi.json` and `GET /docs` need no key.

| Request | operationId | What it does |
| --- | --- | --- |
| GET `/v1/health` | `health.get` | bot is up (no key) |
| GET `/v1/me` | `me.get` | `telegramUserId`, `tier`, `keyId`, `keyName` |
| GET `/v1/keys` | `keys.list` | live keys; all keys for the owner |
| POST `/v1/keys/{keyId}/revoke` | `keys.revoke` | revoke a key (any key, for the owner) |
| GET `/v1/tasks` | `tasks.list` | all recurring tasks |
| GET `/v1/tasks/{taskId}` | `tasks.get` | one task |
| POST `/v1/tasks` | `tasks.create` | new task |
| PATCH `/v1/tasks/{taskId}` | `tasks.update` | change sent fields; `enabled` pauses or resumes |
| DELETE `/v1/tasks/{taskId}` | `tasks.delete` | delete (204) |
| POST `/v1/tasks/{taskId}/run` | `tasks.runNow` | run now (202) |
| GET `/v1/reminders?date=&from=&to=&tz=` | `reminders.list` | reminders, optionally for local days |
| POST `/v1/reminders` | `reminders.create` | reminder or undated to-do |
| PATCH `/v1/reminders/{reminderId}` | `reminders.update` | `text`, `at` (`null` undates), `tz` |
| POST `/v1/reminders/{reminderId}/complete` | `reminders.complete` | mark done |
| DELETE `/v1/reminders/{reminderId}` | `reminders.delete` | same as complete (204) |
| POST `/v1/notify` | `notify.send` | `{text, to: "me" \| "workspace"}`: a plain message |
| POST `/v1/runs` | `runs.create` | start a run (202, `{runId, status}`) |
| GET `/v1/runs/{runId}?waitSec=0..20` | `runs.get` | status and answer; waits up to `waitSec` |
| POST `/v1/runs/{runId}/cancel` | `runs.cancel` | stop a run |
| GET `/v1/settings/mine` | `settings.getMine` | your defaults: provider, model, effort |
| PATCH `/v1/settings/mine` | `settings.updateMine` | change |
| GET `/v1/settings/bot` | `settings.getBot` | owner: language, replies, time zone, limits, groups, workspace, account |
| PATCH `/v1/settings/bot` | `settings.updateBot` | owner: change; `workspace: null` unlinks |
| GET `/v1/settings/light` | `settings.getLight` | owner: light-run settings |
| PATCH `/v1/settings/light` | `settings.updateLight` | owner: change |
| GET `/v1/settings/helpers` | `settings.getHelpers` | owner: `format`, `judge`, `title` helper passes |
| PATCH `/v1/settings/helpers/{use}` | `settings.updateHelper` | owner: change one pass |
| GET `/v1/settings/voice` | `settings.getVoice` | owner: voice-reply model and voice |
| PATCH `/v1/settings/voice` | `settings.updateVoice` | owner: change |
| GET `/v1/settings/providers` | `settings.getProviders` | owner: per-provider settings |
| PATCH `/v1/settings/providers/{provider}` | `settings.updateProvider` | owner: change; `null` restores default |

Executor imports `GET /openapi.json` as typed tools named by the operationIds. `GET /docs` shows it as a page.

### Errors

Errors are JSON `{"_tag": "...", "message": "..."}`.

| Status | `_tag` | Meaning |
| --- | --- | --- |
| 401 | `Unauthorized` | No key, a wrong one, or a revoked one. |
| 403 | `Forbidden` | The holder lost access, or may not do this. |
| 404 | `NotFound` |  |
| 409 | `Conflict` | Bot state blocks it (such as no workspace), or an `Idempotency-Key` reused with another body. |
| 413 | `PayloadTooLarge` | Body over the cap below. |
| 422 | `InvalidInput` | `message` says what to change. |
| 429 | `RateLimited` | Wait `Retry-After` seconds. |
| 503 | `Unavailable` | Telegram failed, or every run slot is busy. Retry later. |

### Limits

| Limit      | Value                                              |
| ---------- | -------------------------------------------------- |
| Reads      | 60 a minute per key                                |
| Writes     | 20 a minute per key                                |
| Agent runs | 20 an hour per key; at most 2 of one user at once  |
| Bad keys   | 20 a minute from one client address, then it waits |
| Body size  | 964096 bytes (about 940 KiB)                       |

### Audit log

Every key change and every API write is a `telegram.api` line in `.data/events.jsonl`. Bodies and keys are never logged.

```bash
curl -s -H "Authorization: Bearer $KEY" https://bot.example.com/v1/me
```

## Tasks, reminders and notices

Same rules as `/tasks` and `/reminders` in Telegram. Tasks are shared by the owner and executors.

- A change to `payload`, `type`, `project`, `chatId` or `threadId` makes the task yours, and it runs with your powers.
- A task without `chatId` is silent. Only its failures reach the owner.
- A reminder's `at` is ISO 8601 with `Z` or an offset (`2026-09-08T09:00:00+03:00`). `tz` defaults to the home zone from `/settings`, else `DEFAULT_TZ`.
- `notify.send` goes to your private chat, or the workspace topic for the owner. Plain text, up to 4096 characters. A user who never started the bot gets `Conflict`.

```bash
curl -s -X POST -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"text":"Call the bank","at":"2026-09-08T09:00:00+02:00"}' https://bot.example.com/v1/reminders
```

## Agent runs

`runs.create` works as if you wrote to the bot in your private chat, with your `/settings` model. It answers at once with a `runId`. Each run starts fresh, with no chat history.

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
| `input` | Up to 128000 characters. Data to work on, such as an email. |
| `profile` | `full` (default): your private-chat powers, including the shell and the owner's Telegram account. `guest`: read-only, no secrets, no connected services, light model. |
| `deliver` | `never` (default): answer stays in the API. `always`: also sent to your private chat. `agent`: sent unless the answer is exactly `__TASK_SKIP__`. |

**Text in `input` can still steer the run.** Run untrusted input with `profile: "guest"`.

Send a unique `Idempotency-Key` header to make a retry safe. A retry with the same key and body gets the first run.

### Statuses

| Status | Meaning |
| --- | --- |
| `running` | Working. |
| `succeeded` | Done, with `result`. |
| `failed` | Failed, with `error`. Nothing is sent. |
| `cancelled` | Stopped by `runs.cancel`, or its key was revoked, or its holder lost access. |
| `interrupted` | The bot restarted mid-run. Start it again. |

### Result and polling

Loop `runs.get?waitSec=20` to follow a run. `result.text` is the answer, cut at 8000 characters. `runs.cancel` does not undo what the run already did.

`pendingAccountActions` lists writes on the owner's Telegram account that wait for the button. API runs always wait for the button, whatever `TELEGRAM_ACCOUNT_WRITES` says.

### Behavior

A run does not wait for background work it starts. Its last answer is its result.

## Settings

Same settings and rules as `/settings` in Telegram. `settings.getMine` and `settings.updateMine` work for every key holder. All other `settings.*` are owner only.

- Every read has `options`: the values each field takes now. A write takes only those.
- A write changes only the fields sent. If any field is refused, nothing is stored.
- Models are tiers: `luna`, `terra`, `sol`, `astra`, weakest first. pi takes a model name (`provider/id`) from `options.model`.

Secrets, access, the bot's profile and linking a workspace are not in the API. Link a workspace with `/setworkspace` in the group.

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
