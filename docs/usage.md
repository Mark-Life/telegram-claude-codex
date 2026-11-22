# Using the bot

## Everyday use

Send text or a voice message. The bot transcribes voice and quotes the transcript above the reply. To hide the transcript, turn off Voice transcripts in `/settings`.

### Duplicate messages

A bad connection can make Telegram send one message twice. In a private chat, the bot skips a copy of 40 characters or more that opens a new topic with the same words as a topic opened less than a minute ago. Groups and the workspace forum are not checked.

### Voice replies

Ask for a voice answer, for example "explain it in a voice message". The bot speaks the answer with ElevenLabs and sends a voice message of up to about 15 minutes.

- Only owner and executor runs can do this.
- It needs `ELEVENLABS_API_KEY` ([configuration](configuration.md)) and `ffmpeg`. Without the key, the bot answers in text.
- Pick the voice and model in `/settings` → Bot settings → Voice replies. A voice saved from the ElevenLabs library needs a paid plan.
- Eleven v4 sounds best, v4 Turbo is faster, Flash v2.5 is cheaper.

### Language and persona

The bot speaks English by default. To switch to Russian, use `/settings` → Language. No restart is needed.

The switch changes the bot's own text: menus, buttons, notices and errors. The agent's answer language is separate: add a rule to `AGENTS.md` in the work directory, for example "Always answer in English".

The bot's name in Telegram does not change with the language. `profile-cli.ts set-persona` sets the name and gender. `set-persona --gender female` makes the bot speak of itself in the feminine.

### Files and replies

- Reply to a message to add it as context.
- Documents and photos are saved into `<work dir>/user-sent-files`, and the agent gets the path.
- The agent sends files back with `packages/agent/scripts/send-file-to-user.ts`.

### Commands

| Command | Does |
| --- | --- |
| `/new` | forget the session and start fresh |
| `/stop` | kill the running task and clear the queue |
| `/history` | owner and executor: resume a past conversation, on any provider |
| `/compact` | summarize the session to free its context |
| `/context` | how full the context window is, with buttons to sum it up or start over |
| `/compose` | start collecting messages into one prompt |
| `/send` / `/cancel` | send the collected messages, or discard them |
| `/model` / `/effort` | override the model and effort in this conversation only. On pi, `/model <words>` finds a model by name: see [pi](providers.md#pi) |
| `/help` | what the assistant can do |
| `/tasks`, `/task add` | owner and executor: recurring tasks |
| `/users`, `/grant`, `/revoke` | owner only: who may use the bot |
| `/callname` | owner only: the name it answers to in groups |
| `/login` | owner only, private chat only: sign in to and out of the owner's Telegram account and Codex, see [Telegram account](telegram-account.md) and [Providers](providers.md) |
| `/provider` | owner only: answer through Codex, Claude or pi in this conversation |
| `/settings` | private chat only: see [Settings](#settings) |
| `/usage` | owner and executors, private chat only: how much of each subscription is used, and when each window resets |
| `/apikeys` | owner and executors, private chat only: make, list and revoke keys for the [HTTP API](http-api.md) |

`/new` and `/stop` inside a topic affect that topic alone.

### `/history`

`/history` lists the owner's and executors' conversations, newest first, with provider, model and title. Picking a conversation on another provider switches this conversation to it and stops what runs here. Only the owner can switch.

The Tasks button lists the last 50 fires of each recurring task. It is a run log: a fresh fire has no session to resume.

At first boot, the bot imports the newest 200 Codex conversations of its own runs from `$CODEX_HOME/sessions`. Older Claude conversations are not imported.

### `/context`

`/context` shows the model, the share of the context window used, and where the provider sums up on its own. The numbers match Claude Code's `/context` and the Codex status line. Right after `/new` there is no figure.

The owner and executors get «Sum up» and «Start over», which work like `/compact` and `/new`.

### `/usage`

`/usage` lists every provider on the server, with its plan and the share used of the five-hour and weekly windows. It asks each provider's own CLI and spends no tokens.

| Case | The block says |
| --- | --- |
| Logged out | so |
| Read fails or takes longer than 15 s | it could not tell |
| Login with no plan limits (an API key, or for Claude a long-lived token) | it shows none |
| pi | the bot does not show its limits |

## Which model answers

When your default model is Auto, the bot picks a model on the first message of each conversation and keeps it until the conversation ends. `/new`, a new forum topic or a project switch picks again. This router needs `TYPESAFE_API_KEY`. Without it, or when the call fails, you get Terra at medium effort.

| Tier | Used for | Codex model, first found |
| --- | --- | --- |
| Luna | chat and read-only lookups | `gpt-6-luna` |
| Terra | everyday work | `gpt-6.1-terra`, else `gpt-5.6-terra` |
| Sol | deep work; anything that touches the Ozma database or changes code | `gpt-6.2-sol`, else `gpt-6.1-sol`, else `gpt-6-sol` |
| Astra | prose the owner will sign | `gpt-6.2-astra`, else `gpt-6-astra` |

A ChatGPT Go login offers only Terra and Luna. `/model` and `/effort` override the choice in one conversation.

### What a new conversation starts on

The owner and every executor set their own provider, model and effort in `/settings` → New chats. This applies to new topics and to conversations after `/new`. A running conversation keeps what it runs on.

- **Model:** Auto (the router), the provider's default, or a tier: Astra, Sol, Terra or Luna.
- **Effort:** Auto, the provider's default, or a level.
- **Default provider down:** a new topic starts on the detected provider.

### `/new` on another provider

If your default provider differs from the conversation's, `/new` switches the conversation as `/provider` does. It stops what runs there.

| Where | What `/new` does |
| --- | --- |
| Owner's private chat and topics; executor's own private topics | switches |
| Executor's private chat outside a topic | stays on the detected default, because it shares one conversation with the owner's |
| A workspace topic | an executor's `/new` moves nothing |

When the owner's `/new` moves the private chat, the executors' conversation on that provider starts over too. Choosing a new default provider moves nothing that runs: a conversation moves at `/new`.

### Groups, guests, members, Business

Groups, guests, members and Business replies run on the cheap model at low effort. The owner can change this in `/settings` → «Groups and guests». For prompt tasks, see [What a prompt task runs on](#what-a-prompt-task-runs-on).

### Sent files

A run that reads a sent document never uses a model below Terra (Sonnet on Claude), unless you chose the model. A scanned PDF has no text, so the agent gets the file only.

## Messages while a task runs

On Claude and Codex, a message sent while a task runs goes into that task. A 👀 reaction confirms it. `/stop` and `/new` drop a message the agent has not read yet.

In groups, or with Messages mid-task off in `/settings`, messages are queued and run in order. The status message lets you force-send or clear the queue.

## Background work (Claude)

On Claude, the owner's and executors' conversations can leave work running after the answer: a background command, a Monitor, a dynamic workflow, or a wake-up of at most an hour. When the work reports, the agent continues in the same chat.

- A waiting conversation takes a `MAX_BACKGROUND_RUNS` slot. With none free, the bot says so.
- On wake-ups alone, it stops after 70 minutes with no activity.
- `/stop`, `/new`, a `/history` resume or a new model or effort ends it.

For anything that must happen at a set time, use reminders or tasks, not a wake-up. Tasks wait the same way: see [Background work in a fire](#background-work-in-a-fire).

### After a restart

A restart stops the work, and the bot continues it once it is back. It does not continue after three restarts in a row with no user message, or if the sender lost full access. `/stop` ends it for good.

## Forwarded messages

Forwarded messages sent together go as one prompt and are charged as one run. Words typed during the burst join it as the request. Up to fifty forwards go in one burst. Groups take forwards one by one.

## Plans

When the agent writes `.codex/plans/PLAN.md`, the bot posts the plan with Execute (new session), Execute (keep context) and Modify plan.

## Quiet by default

A run shows a typing indicator, then one message with the answer. To see steps, drafts and a footer with time and cost, set the Detail row of `/settings` to «with steps». «answer only» restores the default.

## Sub-agents and workflows

When a run starts sub-agents or a dynamic workflow, one status message shows each agent's state, last tool and time. It shows even with Detail set to «answer only». Groups and guests never see it. «⏹ Stop» in it works like `/stop`.

## Settings

`/settings` opens only in a private chat, because it shows the owner's Telegram account and work chat. Every row takes effect at once, without a restart.

| Screen | Who sees it | What it holds |
| --- | --- | --- |
| My settings | the owner and executors | New chats: what their own new conversations start on |
| Bot settings | the owner | switches, language, detail, daily limits, Telegram account, work chat, time zone, tasks at once, and the «Voice replies», «Groups and guests» and «Helpers» screens |
| Providers | the owner | Claude Code's and Codex's own settings, see [Provider settings](#provider-settings) |

Members and guests cannot open `/settings`. Each Bot settings value is one row of the `settings` table.

| Row | `settings` key | Values | Unset |
| --- | --- | --- | --- |
| Guests | `guests` | `on`, `off` | on |
| Mark as read | `mark_read` | `on` (chats the bot read in the owner's account become read), `off` (the bot marks nothing unless asked) | on |
| Messages mid-task | `steer` | `on` (a message joins the running task), `off` (it is queued) | on |
| Voice transcripts | `voice_transcript` | `on`, `off` | on |
| Language | `bot_language` | `ru`, `en` | `en` |
| Detail | `verbosity` | `quiet` (only the answer), `full` (steps, drafts, time and cost) | `quiet` |
| Private, per person | `private_runs_per_user` | `10`, `30`, `100`, `off` | `30` |
| Private, total | `private_runs_per_day` | `100`, `500`, `2000`, `off` | `500` |
| Groups, per person | `group_runs_per_user` | `10`, `30`, `100`, `off` | `30` |
| Groups, total | `group_runs_per_day` | `50`, `100`, `300`, `off` | `100` |
| Confirm account actions | `account_writes` | `confirm`, `direct` | `TELEGRAM_ACCOUNT_WRITES` |
| Time zone | `default_tz` | an IANA zone | `DEFAULT_TZ` |
| Tasks at once | `max_concurrent_runs` | `1`, `2`, `3`, `5` | `MAX_CONCURRENT_RUNS` |
| Voice replies → model | `tts_model` | `eleven_v4`, `eleven_v4_turbo`, `eleven_flash_v2_5` | `eleven_v4` |
| Voice replies → voice | `tts_voice` | a voice id from the ElevenLabs account | the account's first voice that matches the persona's gender |

### New chats

These rows on My settings belong to whoever presses them. Each is a row of `user_settings`, keyed by that person's Telegram id.

| Row | `user_settings` key | Values | Unset |
| --- | --- | --- | --- |
| Who answers | `default_provider` | `auto` (the detected default), a ready provider, or `none` | «not chosen»: the detected default |
| Model | `default_model` | `auto`, `default`, `astra`, `sol`, `terra`, `luna` | `auto` |
| Model, on pi | `default_pi_model` | a pi `provider/id` from the list, or `default` | pi's default |
| Depth | `default_effort` | `auto`, `default`, `low`, `medium`, `high`, `xhigh` | `auto` |

pi has no tiers. Its Model list holds your favourites and last `/model` picks. To add another model, find it with `/model <words>` in a conversation.

### Groups and guests

This screen under Bot settings sets the model for groups, guests and members, bot-wide.

| Row | `settings` key | Values | Unset |
| --- | --- | --- | --- |
| Who answers | `light_provider` | `default` (the detected one), or a ready provider | the detected light provider |
| Model | `light_model` | `default` (the cheap light model), `astra`, `sol`, `terra`, `luna` | the light model |
| Model, on pi | `light_pi_model` | a pi `provider/id` from the list, or `default` | `PI_LIGHT_MODEL`, else pi's default |
| Depth | `light_effort` | `default` (low), `low`, `medium`, `high`, `xhigh` | low |

If the chosen provider cannot take a run, that run uses the detected one.

### Limits

A limit row counts runs per day, and `off` removes the limit. The owner is never counted. An executor is counted only in groups. The owner is told when a guest uses half, and then all, of the per-person private limit.

### Telegram account

This section shows whether the owner's Telegram account is connected. Use `/login` to connect or log out. The switch row shows only when `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` are set.

### Time zone

Press Time zone, then send a zone, such as `Europe/Sofia`, or a city with one zone, such as `Sofia`. An unknown zone gets an error: press the row again to retry. New reminders without a zone get this zone. Existing reminders keep theirs.

### Tasks at once

A run that finds no free slot fails with «I am busy right now». Nothing waits for a slot. Lowering the value stops no running run.

### Work chat

This section shows the workspace set with `/setworkspace`, and a button that forgets it. A private chat with topics already works as a workspace. Use a work chat to work with other people.

### Helper passes

«Helpers» under Bot settings picks where three background passes run.

| Pass | `<use>` | What it is |
| --- | --- | --- |
| Address check | `judge` | the fallback when `TYPESAFE_API_KEY` is unset or its call fails |
| Topic titles | `title` | topic titles |
| Task formatting | `format` | the format pass of script tasks |

| Row | `settings` key | Values | Unset |
| --- | --- | --- | --- |
| Who answers | `helper_<use>_provider` | `default` (Auto), or a ready provider | Auto |
| Model | `helper_<use>_model` | `default`, `astra`, `sol`, `terra`, `luna` | the provider's light model |
| Model, on pi | `helper_<use>_pi_model` | a pi `provider/id` from the list, or `default` | `PI_LIGHT_MODEL`, else pi's default |
| Depth | `helper_<use>_effort` | `default`, then the provider's levels | «Usual» |

Model and Depth show only once a provider is chosen here. Picking another provider resets both.

The address check gives up after 30 seconds and a title after 15. A deeper setting there can cost a missed answer or a default topic name. The format pass has no limit, so a deeper setting delays task results.

### Provider settings

Providers lists Claude and Codex. pi has no settings screen yet. A row opens a list: «Provider default» and every value the setting offers. Values apply from the next answer on, to every run of that provider. Claude's Answer style and Git rules apply from `/new` or the next `/compact`.

| Provider | Row | Key | Values |
| --- | --- | --- | --- |
| Claude | Claude attribution | `attribution` | on, off |
| Claude | Window before compaction | `autoCompactWindow` | `100000`, `200000`, `400000`, `1000000` |
| Claude | Command output | `bashOutputMaxChars` | `4000`, `30000`, `64000`, `128000` |
| Claude | Git rules | `includeGitInstructions` | on, off |
| Claude | Answer style | `outputStyle` | `Concise`, `Explanatory`, `Proactive` |
| Claude | Conversation cache | `promptCacheTtl` | `5m`, `1h` |
| Claude | Subagent cache | `subagentPromptCacheTtl` | `5m`, `1h` |
| Codex | Compaction point | `model_auto_compact_token_limit` | `100000`, `150000`, `200000`, `300000` (unset: `CODEX_AUTO_COMPACT_TOKENS`) |
| Codex | Reasoning summary | `model_reasoning_summary` | `auto`, `concise`, `detailed`, `none` |
| Codex | Answer length | `model_verbosity` | `low`, `medium`, `high` |

For Codex, «Provider default» is the value in `$CODEX_HOME/config.toml` (`~/.codex/config.toml` by default). For Claude, it is Claude Code's built-in value. The bot's own settings, such as the sandbox, MCP servers and model, always win over these rows.

## Recurring tasks

The owner and executors can schedule tasks. A task is a schedule plus a payload.

| Kind | Payload | Runs |
| --- | --- | --- |
| `prompt` | text sent to the agent as the owner | in its own run slot, so it never interrupts a live conversation. Only the final answer is delivered. |
| `script` | code run through Executor, no model | free per run |

- If a prompt task's answer says the work could not be done, for example an expired token, the owner gets a short notice.
- A cheap read-only pass tidies a script result, unless the task sets `raw`.
- A failed script reports and waits for the next fire. It does not retry.

### Script approvals

A script that pauses for an approval reports an id with its question. Send back "approve <id>" or "decline <id>". For an input request, send the answer and the id. You have 15 minutes before Executor drops the request.

### Which conversation a task keeps

There are three modes, for both kinds:

- **fresh** (the default): every fire starts a new conversation.
- **own**: the task keeps one private conversation across fires, so a fire can build on the last ("compare with yesterday"). «Start over» resets it.
- **route**: each fire runs in the task's chat and topic, as if its writer sent the instruction there. The topic's provider, model and project apply.

A route task works only in the writer's private chat with the bot or in the work chat, and cannot be silent. A route fire spends no daily budget.

### Busy conversations

A fire that finds its conversation busy waits until it is free. It never interrupts anyone. A restart drops a waiting fire, and the next scheduled tick runs the task.

### Background work in a fire

On Claude, a fire of a fresh or own `prompt` task waits for its background work, as a conversation does. The last answer after the work reports is the task's report.

A fire fails at once with a notice, and is not retried, when:

- no `MAX_BACKGROUND_RUNS` slot is free
- it waited on wake-ups alone for 70 minutes with no activity

«Stop» or deleting the task ends a waiting fire with nothing sent. A restart does not lose the work: the bot continues the fire once it is back. It stops after three continues in a row, or if the task was changed, lost full access, or its provider is not available. In most of these cases the notify route is told why.

### Gate scripts

A `script` task with a mode is a gate. Executor runs it with no model on every fire, and the model runs only when the script returns a prompt.

The script sees what it kept last time as `taskState` (`null` at first; do not declare it yourself). It returns `{ state, prompt }`:

- `state` is kept for the next fire, at most 64 KiB of JSON.
- `prompt` is what the model is told.

| Script output | Result |
| --- | --- |
| `{ state }` with no `prompt` (or a null one), `null`, `{}`, empty output, or exactly `__TASK_SKIP__` | successful fire, no model run, nothing sent |
| plain text | the prompt, as it is |

A failed model run keeps the old state, so the retry sees the same change. The gate's output becomes an instruction with its writer's powers. So only the script's author or the owner can switch it between fresh and a mode.

### Create a task

Create one in the chat, as one message.

```
/task add
title: Morning digest
cron: 0 9 * * *
tz: Europe/Berlin
type: prompt
---
Tell me what came to my email overnight.
```

`cron` is standard five-field `minute hour day-of-month month day-of-week`. `tz` is an IANA zone.

| Optional line | Effect |
| --- | --- |
| `enabled: false` | created paused |
| `raw: true` | deliver output untouched |
| `project` | the project |
| `session: own` or `session: route` | the mode. Route does not work with `silent: true`, and works only in your private chat with the bot or the work chat. |

### Manage tasks

`/tasks` lists them, each with these buttons:

| Button | Does |
| --- | --- |
| Pause/Resume | pauses or resumes the task |
| Run now | runs it. A task with a mode may wait for its conversation. |
| Delete | deletes it |
| Stop | ends the running or waiting fire with nothing sent. The next scheduled run fires as usual. A route task uses its chat's `/stop`. |
| Session | picks the mode. Once one is set, it also offers «Start over». |

«Start over» on an own task starts a new conversation at its next fire. On a route task, it clears the chat conversation as `/new` does there. Picking a mode does not make the task yours: it keeps the powers of whoever wrote it.

A Codex run can manage tasks through `packages/agent/scripts/tasks-cli.ts` (`list|add|update|delete`). `--session <fresh|own|route>` sets the mode, and `update --reset-session` starts over. The bot notices a change made there within a minute.

### What a prompt task runs on

A prompt task runs on its writer's New chats defaults in `/settings`, read again at every fire. If that provider cannot run, the fire goes to the first one that can.

To set a task's own provider, model and depth, use the Model button in `/tasks`, or `tasks-cli` with `--provider`, `--model <tier>` and `--effort <level>`. `auto` follows the defaults again. A route task uses its chat's choice.

### Executor setup

Script tasks need `EXECUTOR_MCP_URL` and `EXECUTOR_API_KEY`. `EXECUTOR_VERSION` picks v1 or v2. Unset, it follows the url: `mcp.executor.sh` is v2, anything else v1.

## Personal rules and skills

Anything you ask the assistant to remember is written into your workspace, not into its code:

```
<work dir>/AGENTS.md                        your standing rules
<work dir>/.agents/skills/<slug>/SKILL.md   one workflow, when a rule is too small
```

Say «remember …» and the run appends the rule to `AGENTS.md`. For a multi-step workflow, it writes a skill under `.agents/skills/` and links it from `AGENTS.md`. Every later session reads these files, so a rule survives `/new`, a restart and a redeploy. On Claude and pi, your global rules for that CLI (`~/.claude/CLAUDE.md`, `~/.pi/agent/AGENTS.md`) apply too.

Both files are yours. Edit them by hand any time, with no restart.

- A line that is only `@<path>` (for example `@~/notes/CONTEXT.md`) brings that file in too, up to about 40,000 characters in all.
- Neither file lives in this repo, so a self-update or a fresh clone does not touch them.
- Only your own and executor runs see them. Group, guest and member runs never do.
