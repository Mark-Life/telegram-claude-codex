# Using the bot

## Everyday use

Send text or a voice message. The bot transcribes voice and quotes the transcript above the reply.

With Voice transcripts off in `/settings`, the transcript is hidden (private chats and drafts). The voice note is still transcribed and run. The switch is the `voice_transcript` row of `settings` (`off`; no row or `on` shows it). It takes effect at once.

### Duplicate messages

A bad connection can make Telegram send one message twice. In a private chat with topics, each copy opens its own topic.

The bot skips a copy when all of these hold:

- the chat is private
- the text or transcript is 40 characters or more
- it opens a new topic with the same words that opened another topic less than a minute ago

The bot answers with one line, and the first message goes on. Words sent into an existing topic always run. So do shorter words such as «yes». Groups and the workspace forum are not checked.

### Voice replies

Ask for a voice answer ("explain it in a voice message", «answer by voice»). The bot does the work and writes the answer for the ear: plain sentences, numbers as words, no formatting. It speaks it with ElevenLabs and sends a voice message to the same chat and topic, with a line or two of text.

- Only owner and executor runs can, and only when asked.
- Needs `ELEVENLABS_API_KEY` ([configuration](configuration.md)) and `ffmpeg`. Without the key, the bot says voice is not set up and answers in text.
- A voice message is at most about 15 minutes.
- Pick the voice and model in `/settings` → Bot settings → Voice replies. The screen lists the ElevenLabs account's voices, its own (cloned or designed) first, so a voice added on elevenlabs.io shows up there. A voice saved from the library needs a paid ElevenLabs plan.
- Eleven v4 sounds best, v4 Turbo is faster, Flash v2.5 is cheaper.

### Language and persona

The bot speaks English by default. The Language row of `/settings` switches to Russian and back, without a restart (the `bot_language` row of `settings`: `ru`; no row or `en` is English).

It covers everything the bot says: replies, menus, buttons, notices, errors, reminder and task lists. The command descriptions in Telegram's menu are re-registered for every user at once.

Two model texts follow it too. The Business answer written for the owner is Russian under Русский and English under English. A new private-chat topic gets its name from the first words sent in it: text, a voice transcript, a caption or a `/compose` batch. A file sent without words leaves the name for the next words. An unset call name is «Ассистент» in Russian, «Assistant» in English.

It does not set the language the agent answers in. For that, add a rule to `AGENTS.md` in the work directory, for example "Always answer in English".

The bot's name in Telegram does not change with the language. `profile-cli.ts set-persona` sets both. With no gender set, the bot speaks of itself in the masculine. `set-persona --gender female` switches it. Every run, group runs included, is told the bot's name, gender and owner, so the agent's own words agree with the bot's copy.

### Files and replies

- Reply to a message to prepend it as context.
- Documents and photos are saved into `<work dir>/user-sent-files` (a sandboxed run's scratch directory, or a group's own directory). The path goes to the agent.
- The agent sends files back with `packages/agent/scripts/send-file-to-user.ts`.

### Commands

| Command | Does |
| --- | --- |
| `/new` | forget the session and start fresh |
| `/stop` | kill the running task and clear the queue |
| `/history` | owner and executor: resume a past conversation, on any provider |
| `/compact` | summarize the session to free its context: Claude compacts it in place, Codex continues in a new one from the summary |
| `/context` | how full this conversation's context window is, with buttons to sum it up or start over |
| `/compose` | start collecting messages into one prompt |
| `/send` / `/cancel` | send the collected messages, or discard them |
| `/model` / `/effort` | override the routed model and effort, in this conversation only. On pi, `/model <words>` finds a model by name and «All models» lists every id: see [pi](providers.md#pi) |
| `/help` | what the assistant can do |
| `/tasks`, `/task add` | owner and executor: recurring tasks |
| `/users`, `/grant`, `/revoke` | owner only: who may use the bot |
| `/callname` | owner only: the name it answers to in groups |
| `/login` | owner only, private chat only: one menu to sign in to and out of the owner's Telegram account and Codex, see [Telegram account](telegram-account.md) and [Providers](providers.md) |
| `/provider` | owner only: answer through Codex, Claude or pi, in this conversation |
| `/settings` | private chat only. A home screen with a button per area. The owner: what their new conversations start on, the bot's switches, limits, language, time zone and work chat, and Claude Code's and Codex's own settings. An executor: what their own new conversations start on. See [Settings](#settings) |
| `/usage` | owner and executors, private chat only: how much of each subscription is used, per window, and when each window starts over |
| `/apikeys` | owner and executors, private chat only: make, list and revoke keys for the [HTTP API](http-api.md) |

`/new` and `/stop` inside a topic affect that topic alone.

### `/history`

`/history` lists the owner's and executors' conversations, newest first. Each row shows when it was last used, the provider and model, the project (if not the current one) and a title. The title is the topic's name (🗂️) or the first thing asked. The list lives in the `session_history` table of `bot.db`.

- Every main run that keeps its session gets a row. So does a fire of a `session: route` task.
- Light runs, scratch runs and other task fires get none.
- A topic's name is kept when it is created, renamed, or named by the bot. A topic last renamed before the bot recorded topic names shows its first message until it is renamed again.
- A topic's conversation from before history was recorded shows as "(no topic)" until the topic is renamed or gets a new message.
- A Codex `/compact` continues in a new session. `/history` lists it once, under the new session. An older button for the old one still resumes it.
- Picking a conversation on another provider switches this conversation to it first, as `/provider` does, and stops what runs here. Only the owner can switch. An executor is told whose the conversation was.

The Tasks button lists the last 50 fires per recurring task, newest first: when, provider and model, and how each ended. It is a run log. A fresh fire has no session to resume. A task that keeps a conversation shows the session it ran on.

At first boot with this table, the bot imports the newest 200 Codex conversations its own main runs left in `$CODEX_HOME/sessions` (`~/.codex/sessions` by default). It takes a rollout whose first prompt has the instructions only an owner or executor run gets.

- Group runs, helper turns, compaction seeds and other Codex clients are skipped. So is a fire of a task that still exists. Fires of tasks deleted before the update can still show up.
- If that folder cannot be read yet (Codex not logged in, no permission), the import waits for the next boot.
- Claude's older conversations are not imported. Its session list cannot tell the bot's runs from your own Claude Code sessions.

### `/context`

`/context` shows the provider and model, the share used with a bar, the tokens against the window, and where the provider sums up on its own. The numbers match the provider's own CLI.

| Provider | Matches | Note |
| --- | --- | --- |
| Claude | Claude Code's `/context` | Measured against the window it compacts in. On some 1M models that is 200K, and the reply says so. |
| Codex | its status line | Leaves a fixed 12k of prompts and tools out: 50k of 258k reads 15%, not 19%. |

- The figure is recorded at every request and settled at the end of each answer. While the bot works, it is the latest request's.
- Right after `/new` there is no figure. After `/compact`, Codex shows what the summary left. Claude shows none until the next answer, because Claude Code's own count still includes the conversation it summed up.
- The owner and executors get «Sum up» and «Start over» (like `/compact` and `/new`). Members see their own conversation, without buttons.
- A group, and a guest with no access granted, has no conversation to show.

### `/usage`

`/usage` is for the owner and executors, in a private chat only. It lists every provider installed on the server. For each one logged in, it shows the plan, the five-hour and weekly windows (and any per-model window) with the share used, and the reset time in the home zone.

It asks each provider's own CLI, the way its own `/status` or `/usage` does. `codex app-server` answers `account/read` and `account/rateLimits/read`. Claude Code answers a usage request on a session that runs no turn. Neither spends tokens, and the CLI keeps refreshing its own login. The bot never reads `auth.json` or `.credentials.json`.

| Case | The block says |
| --- | --- |
| Logged out | so. Logins are re-checked first (at most once a minute per provider), so a logout after boot shows too. |
| Read fails or takes longer than 15 s | it could not tell |
| Login with no plan limits (an API key, or for Claude a long-lived token) | it shows none |
| A limit is reached | a closing line says so |
| pi (no subscription windows), once ready | the bot does not show its limits |

## Which model answers

Each conversation is routed once, on its first message, and keeps that choice until it ends. A `/new`, a new forum topic or a project switch routes again.

The router runs when the starter's default is Auto (the default for everyone who never changed it), unless the old `model_routing` switch is `off` (below).

One TypeSafe Jev request asks seven questions about the message. Three are how much has to be worked out, how many operations it unfolds into, and what a wrong answer costs. The rest ask if it is small talk, database work, writing the owner will sign, or a change to software. A policy table in `packages/agent/src/model-router.ts` turns the answers into a tier and an effort.

| Tier | Used for | Codex model, first found |
| --- | --- | --- |
| Luna | chat and read-only lookups | `gpt-6-luna` |
| Terra | everyday work | `gpt-6.1-terra`, else `gpt-5.6-terra` |
| Sol | past the second level of depth; anything that touches the Ozma database or changes code | `gpt-6.2-sol`, else `gpt-6.1-sol`, else `gpt-6-sol` |
| Astra | prose the owner will sign | `gpt-6.2-astra`, else `gpt-6-astra` |

- A ChatGPT Go login offers only Terra and Luna.
- Without a key, or when the call fails or runs out of budget, the result is Terra at medium effort. A judgment never fails a run.
- `/model` and `/effort` override the choice in that conversation alone. Their first entry hands it back to the defaults of whoever sends the next message there.
- None of this reaches the chat. It goes to the ledger.

### What a new conversation starts on

The owner and every executor set their own in the New chats section of `/settings`: a provider, a model and an effort. A new forum topic and a conversation after `/new` start there. A running conversation keeps what it runs on. `/provider`, `/model` and `/effort` change only the conversation they are sent in.

- **Model:** Auto (the router), the provider's default, or a tier: Astra, Sol, Terra or Luna. The menu names each tier by the provider's own model, for example Opus 5.5 for Sol on Claude.
- **Effort:** Auto, the provider's default, or a level.
- **Provider change:** both choices keep their meaning.
- **Default provider down:** a new topic starts on the detected one (the owner's private topics on the private chat's provider). The menu shows the provider as unavailable. `/new` says so and stays where it is.

### `/new` on another provider

`/new` on another provider than the default switches the conversation as `/provider` does. It stops what runs there and never resumes that provider's old conversation.

| Where | What `/new` does |
| --- | --- |
| Owner's private chat and topics; executor's own private topics | switches |
| Executor's private chat outside a topic | shares one conversation with the owner's, so it stays on the detected default; `/new` says the choice works in their topics |
| A workspace topic | belongs to everyone; an executor's `/new` moves nothing |

- When the owner's `/new` moves the private chat, the reply warns that executors' conversation on that provider starts over too, as `/provider` does.
- Choosing a new default provider moves nothing that runs. A conversation moves at `/new`.
- The first row of the provider list, Auto, follows the detected default, in a new topic and on `/new` alike.
- Someone who never chose a provider sees «not chosen» and stays put on `/new`.
- In a private chat outside a topic, a model and effort default holds only for whoever starts its shared conversation.
- A new recurring task takes its writer's model and effort defaults at its first fire. Its provider stays Codex while Codex can run. On another provider, only defaults that leave nothing to Auto apply.
- Someone who never pressed these rows starts as before. The old `model_routing` row of `settings` still decides for them (the last row of `/model` used to flip it). `off` gives the provider's default model at its default effort. Anything else gives the router.
- The first entry of `/model` and `/effort` reads «As in /settings» when the caller's own default is not Auto.

### Groups, guests, members, Business

Only owner and executor runs are routed. Groups, guests, members and Business replies run on the cheap model at low effort.

The owner can change this in «Groups and guests» of `/settings`: a provider, a model tier and a depth, bot-wide. If the chosen provider cannot take a run (logged out, or unable to give a member a writable folder), that run uses the detected one.

A recurring `prompt` task follows its own rules: see What a prompt task runs on, under Recurring tasks.

### Sent files

- A file sent with no caption is answered on a routed model. It does not decide the conversation's model; the words you send next do.
- A run that reads a sent document never routes below Terra (Sonnet on Claude). A model you chose yourself stays.
- The bot reads a PDF's text when it saves the file and gives the run that text, so a run never depends on the PDF tools on its machine. A scanned PDF has no text and goes on as the file alone.

## Messages while a task runs

A message sent while a task runs goes into that task, on Claude and Codex. The agent reads it at its next tool call. If the model had already written its answer, it answers the message right after.

- A 👀 reaction says the task got it. Where reactions are off, a short reply says it.
- If the task ends first (an error, `/compact`, a `/provider` switch), the message runs next, like a queued one, and loses its 👀. A message the agent already took is not run twice.
- `/stop` and `/new` drop a message the agent has not run.
- In groups, or with Messages mid-task off in `/settings`, the message is queued and drained in order. The status message offers to force-send or clear the queue.
- A recurring task that fires into a busy conversation (`session: route`) never joins a running task. It waits until the conversation, and its queue, are done.

## Background work (Claude)

On Claude, the owner's and an executor's conversations can leave work running after the answer: a background command, a Monitor, a dynamic workflow, or a wake-up (`ScheduleWakeup`, at most an hour ahead). The answer is sent and typing stops. When the work reports or the wake-up fires, the agent continues in the same chat or topic.

- A message sent meanwhile goes straight in, even with Messages mid-task off. So do messages queued while the agent was working.
- A waiting conversation moves from a `MAX_CONCURRENT_RUNS` slot to one of `MAX_BACKGROUND_RUNS`, and its later turns run there. With none free, it does not wait, and says so.
- It waits as long as a command, Monitor or workflow runs. A workflow may take days. The CLI ends a Monitor or a command at its own deadline.
- On wake-ups alone it stops after 70 minutes of nothing, and says so. A Monitor or wake-up the agent sets again each time keeps it going until `/stop`.
- `/stop`, `/new`, a `/history` resume or a new model or effort ends it at once.

A `prompt` task's fire waits the same way (see [Background work in a fire](#background-work-in-a-fire)). For anything that must happen at a set time, use reminders or tasks, not a wake-up.

### After a restart

A restart of the bot does not end such a conversation. It stops it at once and says so in the chat.

When the bot is back, it continues. A workflow is relaunched from where it stopped, and finished agents do not rerun. A command or Monitor restarts if still needed. A wake-up waits until it was due.

It does not continue if the sender lost full access, Claude cannot run, or it was already resumed three restarts in a row with no user message between. The startup notice counts those beside the ones that went on (or will, when their wake-up is due), and their chat is told.

One the user moved on from (`/new`, `/history`, `/provider`) is dropped quietly. A message the user sends there before it went on takes the pending work along with it. `/stop` ends it for good.

## Forwarded messages

Forwarded messages sent together go as one prompt.

- In a private chat or the workspace forum, each forward waits 1.5 s for the next one. Words typed meanwhile, or while the burst is still being read, join it as the request.
- The burst is charged as one run and read one message at a time, in the order sent. Each message is headed with its sender and date.
- Voice notes are transcribed (and echoed, with Voice transcripts on). Photos and documents are saved where the conversation can open files. Places, contacts and polls are written out. Videos, audio files and stickers are named.
- A burst of nothing readable, such as stickers alone, is dropped.
- Words sent just before the forwards still start or join a run of their own. Telegram sends a forward's comment first.
- Fifty forwards go out at once. The rest start the next burst. Groups take forwards one by one.

## Plans

When the agent writes `.codex/plans/PLAN.md`, the bot posts the plan with Execute (new session), Execute (keep context) and Modify plan.

## Quiet by default

A run shows a typing indicator, then one message with the answer. Tool calls and thinking never reach the chat. There is no metadata footer.

The dev view is the Detail row of `/settings`. «with steps» shows steps, drafts and a footer with time and cost. «answer only» restores the default.

Everything a user reads is in the bot's language. Logs, the ledger and the CLIs stay English.

## Sub-agents and workflows

When a run starts sub-agents (Claude's Agent tool, Codex's spawned agents) or a dynamic workflow, one status message shows them live, whatever the Detail row says. Groups and guests never see it.

It shows each agent with its state (⏳ queued · 🔄 running · ✅ done · ❌ failed · ⏹ stopped), last tool and time. It also shows the totals (`3/7 done · 1 failed · 2m10s · 84k tokens`; stopped agents are counted apart) and a bar of how many ended. Past ten agents, the rest are counted.

A workflow shows its name and wave (`wave 2 of 3`). An agent's label drops the start that repeats its wave's title: `research:hermes` reads `hermes` under Research. A finished wave folds into one line. Past three folded waves, the oldest share one.

- The message is edited in place about once every 1.5 s. Deleted by hand, it comes back with the next change.
- «⏹ Stop» is `/stop` for the run's own user while the message is live.
- In a private chat and the workspace forum, it is pinned without a sound while the run goes, and unpinned when it ends. A chat where the bot cannot pin keeps it unpinned.
- When everything has ended and the agent answered, it becomes a summary: each sub-agent with its time, each wave with its agents, and failures with their error. A wave's agents are counted past four. Past three waves, the oldest share one line.
- A workflow a conversation waits on keeps its message live after the answer, until it ends.

## Settings

`/settings` opens a home screen: a short summary of what is in force, and a button per area. It opens only in a private chat, like `/login`, because it shows the owner's Telegram account and work chat.

Every screen is the same message: a press edits its text and buttons. «<< Back» returns one level up. Each screen names every setting with its current value and says what it does. After a press, the text shows the new value at once.

| Screen | Who sees it | What it holds |
| --- | --- | --- |
| My settings | the owner and executors | New chats: what their own new conversations start on |
| Bot settings | the owner | the switches, language, detail, daily limits, the Telegram account, the work chat, the time zone, tasks at once, and «Voice replies», «Groups and guests» and «Helpers» one level down |
| Providers | the owner | Claude Code's and Codex's own settings, see [Provider settings](#provider-settings) |

An executor sees only My settings, and a press that names an owner screen is refused. Members and guests cannot open `/settings`.

Every row takes effect at once, without a restart. A row the owner never pressed keeps the default below, so a new row changes nothing until it is pressed. Messages mid-task and Mark as read are the exceptions: their default is the new behaviour.

Messages mid-task off brings back the queue. Mark as read off leaves chats unread after the bot looked at them.

Each value of Bot settings is one row of the `settings` table.

| Row | `settings` key | Values | Unset |
| --- | --- | --- | --- |
| Guests | `guests` | `on`, `off` | on |
| Mark as read | `mark_read` | `on` (a chat the bot read in the owner's account becomes read, a voice note or round video it downloaded listened, a Business chat read after the bot answers there), `off` (the bot marks nothing on its own, only when asked) | on |
| Messages mid-task | `steer` | `on` (a message sent mid-task joins it, where the provider can), `off` (it is queued) | on |
| Voice transcripts | `voice_transcript` | `on`, `off` | on |
| Language | `bot_language` | `ru`, `en` | `en` |
| Detail | `verbosity` | `quiet` (only the answer), `full` (steps, drafts, a footer with time and cost) | `quiet` |
| Private, per person | `private_runs_per_user` | `10`, `30`, `100`, `off` | `30` |
| Private, total | `private_runs_per_day` | `100`, `500`, `2000`, `off` | `500` |
| Groups, per person | `group_runs_per_user` | `10`, `30`, `100`, `off` | `30` |
| Groups, total | `group_runs_per_day` | `50`, `100`, `300`, `off` | `100` |
| Confirm account actions | `account_writes` | `confirm`, `direct` | `TELEGRAM_ACCOUNT_WRITES` |
| Time zone | `default_tz` | an IANA zone | `DEFAULT_TZ` |
| Tasks at once | `max_concurrent_runs` | `1`, `2`, `3`, `5` | `MAX_CONCURRENT_RUNS` |
| Voice replies → model | `tts_model` | `eleven_v4`, `eleven_v4_turbo`, `eleven_flash_v2_5` | `eleven_v4` |
| Voice replies → voice | `tts_voice` | a voice id from the ElevenLabs account | the account's first voice matching the persona's gender, its own voices first |

### New chats

The New chats rows, on My settings, belong to whoever presses them. Each is a row of the `user_settings` table, keyed by that person's Telegram id. A press opens a list in the same message, and «<< Back» returns to the screen.

| Row | `user_settings` key | Values | Unset |
| --- | --- | --- | --- |
| Who answers | `default_provider` | `auto` (the detected default), a provider that is ready, or `none` (the list's last row) | none («not chosen»): the detected default (the owner's private topics: `owner_provider`, else the detected default), and `/new` stays put |
| Model | `default_model` | `auto`, `default`, `astra`, `sol`, `terra`, `luna` | `auto`, or `default` while `model_routing` is `off` |
| Model, on pi | `default_pi_model` | a pi `provider/id` from the list (favourites and recent `/model` picks), or `default` | pi's default |
| Depth | `default_effort` | `auto`, `default`, `low`, `medium`, `high`, `xhigh` | `auto`, or `default` while `model_routing` is `off` |

pi has no tiers. Its Model list holds pi models by name: «pi's usual», your favourites, and your last `/model` picks. Find another model with `/model <words>` in a conversation. It then shows up here among the recent ones. A stored model no longer on the list is marked «not available now», since new conversations still start on it: pick another or «pi's usual».

The owner's private chat keeps its provider in the `owner_provider` row of `settings`, which `/provider` and `/new` write.

### Groups and guests

«Groups and guests» is a screen under Bot settings. It is the owner's alone and bot-wide, each row a row of `settings`. As in New chats, a press opens a list in the same message.

| Row | `settings` key | Values | Unset |
| --- | --- | --- | --- |
| Who answers | `light_provider` | `default` (the detected one), or a provider that is ready | the detected light provider |
| Model | `light_model` | `default` (the cheap light model), `astra`, `sol`, `terra`, `luna` | the light model |
| Model, on pi | `light_pi_model` | a pi `provider/id` from the list (favourites and recent `/model` picks), or `default` | `PI_LIGHT_MODEL`, else pi's default |
| Depth | `light_effort` | `default` (low), `low`, `medium`, `high`, `xhigh` | low |

While «Helpers» is on Auto, topic titles and the format pass of script tasks follow Who answers too. That needs the provider to run (ready, or its check gave no answer) and to do them. Otherwise they stay on the detected helper (Codex first, then Claude, then pi).

Model goes with them to whichever provider they land on, as for a light run. Depth does not: a helper pass keeps its own low effort. A note under the screen's hint points to «Helpers».

### Limits

A limit row counts runs per day. `off` removes the limit. The owner is never counted. An executor is counted only in groups. The owner is told when a guest uses half of the per-person private limit, and when they use all of it, at the value in force at that moment.

### Telegram account

This section shows whether the owner's Telegram account is connected. Connecting and logging out stay in `/login`. The switch row shows only when `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` are set. The next write a run asks for uses the new value.

### Time zone

A press on Time zone asks for a zone. The owner's next text message in that chat and topic is the answer: `Europe/Sofia`, any case, or a city that names one zone, such as `Sofia`.

- An unknown zone gets an error and the value stays. Press the row again to retry.
- A text that cannot be a zone (a sentence of more than three words) closes the question and goes to the agent as usual.
- A command, the Cancel button or ten minutes without an answer also close the question.

New reminders without a zone get this zone, also from `reminders-cli.ts`. The reminder list shows it without a zone label. A reminder that exists keeps its zone.

### Tasks at once

The value applies to the next run that starts. A run that finds no room fails with «I am busy right now». Nothing waits for a slot. Lowering the value stops no running run. New runs are refused until enough end.

### Work chat

This section shows the workspace set with `/setworkspace`, and a button that forgets it. A private chat with topics turned on already works as a workspace. A work chat is for work with other people.

### Helper passes

«Helpers» is a screen under Bot settings, for the owner, bot-wide. It lists three questions the bot asks itself, each with where it runs now («Auto» when the owner chose nothing that can run).

| Pass | `<use>` | What it is |
| --- | --- | --- |
| Address check | `judge` | the address judge's fallback, used when `TYPESAFE_API_KEY` is unset or its call fails |
| Topic titles | `title` | topic titles |
| Task formatting | `format` | the format pass of script tasks |

Each pass has its own rows, each a row of `settings`.

| Row | `settings` key | Values | Unset |
| --- | --- | --- | --- |
| Who answers | `helper_<use>_provider` | `default` (Auto), or a provider that is ready | Auto |
| Model | `helper_<use>_model` | `default`, `astra`, `sol`, `terra`, `luna` | the provider's light model |
| Model, on pi | `helper_<use>_pi_model` | a pi `provider/id` from the list (favourites and recent `/model` picks), or `default` | `PI_LIGHT_MODEL`, else pi's default |
| Depth | `helper_<use>_effort` | `default`, then the levels the provider offers on that model | see below |

- On Auto, titles and formatting follow «Groups and guests», then the detected helper. The address check goes to the first ready provider among Codex, Claude and pi. On Auto the screen has the Who answers row only.
- Model and Depth apply only with a provider chosen here. Picking another provider, Auto included, resets both to «Usual». Tapping the one already chosen keeps them.
- The pass uses Auto, and drops the model and depth chosen here, when the chosen provider cannot run (not ready, and its check gave an answer). The same holds for pi with no model a helper can run. For pi, its Who answers choice says why, and the overview adds a note on the missing key.
- Depth «Usual» is the provider's own for the address check (Codex's model default, Claude low, pi thinking off). For titles and formatting it is low. On pi, a depth the model does not offer runs at the deepest level below it.
- The address check gives up after 30 seconds and a title after 15. A deeper setting there costs silence or Telegram's own topic name. The format pass has no limit, so a deeper setting delays a task's result.
- With nothing chosen, a provider whose check gave no answer comes after every ready one. So a Codex check that timed out moves the address check to a ready Claude until the next check.

### Provider settings

Providers lists Claude and Codex. pi has no settings screen yet. Each screen shows the version of the CLI that runs start, and every setting the owner can change, with its value and what it does.

A row opens a list: «Provider default» (forget the value) and every value the setting offers. Values apply from the next answer on, to every run of that provider (the owner's, executors', groups' and guests', scheduled tasks and `/compact`). The format, title and judge helper turns stay bare. Claude's Answer style and Git rules are part of a conversation's system prompt, so a running conversation applies them from `/new` or the next `/compact`.

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

Values are stored as one JSON object per provider in the `settings` table: `claude_settings`, `codex_settings` and `pi_settings` (empty). A key or value the list does not offer is dropped on read, so a row edited by hand never breaks a run.

«Provider default» is Claude Code's built-in value, since runs read no settings file. For Codex it is the value in `$CODEX_HOME/config.toml` (`~/.codex/config.toml` by default). Inside the sandbox view, which has no such file, it is Codex's built-in value.

What the bot depends on never changes, whatever a row says. The owner's values are merged under these, never over.

- Claude: `settingSources: []`, `strictMcpConfig`, the skills filter, the MCP servers, the deny list, workflows, hooks, connectors, bundled skills, remote control, artifacts, auto memory and transcript retention.
- Codex: the sandbox and approval policy, web search, MCP servers, features, skills and shell environment.
- Both: the model and effort, which come from My settings, `/model` and `/effort`.

With `CLAUDE_BIN` set, runs start another Claude Code build than the one the list was typed against. The Claude screen says so.

## Recurring tasks

For the owner and executors. A task is a schedule plus a payload. It is stored in the `tasks` table and run by a cron loop inside the bot process.

| Kind | Payload | Runs |
| --- | --- | --- |
| `prompt` | text sent to the agent as the owner | in a run slot of its own, so it never interrupts a live conversation. Only the final answer is delivered. |
| `script` | code replayed through Executor, no model | free per run. Executor v1 uses its REST API; v2 uses its MCP `execute` tool. |

- By default a `prompt` session is not kept (see Which conversation a task keeps).
- After a `prompt` delivery, the bot reads the answer once more. If it says the work could not be done (an expired token, no access, a refusal), the owner gets a short notice. The report, stored status and retry do not change. A report that checked and found nothing new counts as done.
- A `script` result is tidied by one cheap read-only pass, unless the task sets `raw`.
- A failed script reports and waits for the next fire, with no retry.

### Script approvals

A script that pauses for an approval reports an id, with the tool and its question. On v1 the id is the execution's; on v2 it is the request's.

Send back "approve <id>" or "decline <id>". For an input request, send the answer and the id. You have 15 minutes, before Executor drops the request. The bot then calls Executor's `resume`.

v2 approves nothing by itself, but a read-only script never pauses. A resumed v2 run answers in that conversation. A gated script's state does not move on from it.

### Which conversation a task keeps

Three modes, the same for both kinds:

- **fresh** (the default): every fire starts a new conversation.
- **own**: the task keeps one conversation across fires, so a fire can build on the last one ("compare with yesterday"). Nobody else sees it. It is never the private chat's conversation. It grows with every fire, and the provider sums it up on its own when it gets long. «Start over» (below) resets it. It also starts anew on a move to another provider or project, or when someone else's edit makes the task theirs. Nobody continues a conversation built on another person's powers. A fire that falls back to another provider, because the task's own cannot run right now, runs fresh and keeps the stored conversation for later.
- **route**: each fire runs in the conversation of the task's chat and topic, as if its writer sent the instruction there. The answer streams into the chat. The topic's own provider, model and project apply, not the task's own choice. A message sent there afterwards continues it.

A route task needs a chat: the writer's own private chat with the bot, or the work chat. It cannot be silent and needs to know who wrote it. A task an executor wrote with no user id on it is refused rather than run as the owner. A route fire spends no daily budget.

### Busy conversations

A fire that finds its conversation busy waits and checks again every 15 s. Busy means a run of anyone's, a queue being drained, `/compact`, or a plan waiting for an answer. The fire never interrupts anyone, and `/stop` of the run it waits for does not drop it.

- Fires of one task run one after another. «Run now» does not interrupt a running fire.
- At most one fire per task waits. Another press, cron tick or retry joins it.
- A waiting fire lives in memory. A restart drops it quietly, and the next tick runs the task.
- A route fire that never reached the chat (a refusal, a script failure, a pause for approval) is reported like any failure. One that did is shown only there; if its retry fails too, a short notice goes to the notify route.
- A report a task's chat no longer takes (its topic was deleted) goes to the notify route.

### Background work in a fire

On Claude, with the owner's or an executor's full access, a fire of a fresh or own `prompt` task waits for its background work, as a conversation does. That is a dynamic workflow, a Monitor, a background command or a wake-up. A route fire waits as its chat does. The fire's last answer, once the work reported, is its report, and the success check reads it.

A fire fails at once with a notice, even for a silent task, and is not retried, when:

- it has no free waiting slot (`MAX_BACKGROUND_RUNS`), unless its report still lands while the work finishes
- it waited on wake-ups alone for 70 minutes with nothing happening

While a fire waits:

- Later ticks join one fire that runs after it. «Run now» says so.
- A Monitor or wake-up the agent sets again each time keeps the fire waiting. So the fire is told its schedule brings the next run.
- «Stop» ends the running or waiting fire with nothing sent (a fire still starting included), and drops the run queued behind it and a pending retry. Deleting the task does the same.
- For a script with its own conversation, «Stop» while the script runs cannot end it in Executor. The script runs to its end, and what it hands back (a prompt and its state) is dropped.
- A task deleted or paused through `tasks-cli.ts` is noticed within a minute. A deleted task's fire ends. A paused task's fire ends if it waits on background work; a turn still running ends with its report. Nothing is sent. A fire started with «Run now» on a paused task keeps going.

A restart does not lose the work. The fire is stopped as the restart begins. Once the bot is back, it is continued in the same session, one at a time with the conversations' resumes (workflows relaunched, a wake-up alone when it was due).

It is not continued, and nothing is said, when the task was paused or deleted meanwhile, started over, or switched between fresh and own (its next fire starts afresh). It is not continued, and the notify route is told the cause, when the task:

- was retyped, switched to route, or moved to another provider or project
- lost full access, or its provider is not available at boot
- was already continued three times in a row

A fire stopped while the bot was continuing it stays stopped, and nothing runs in its place. A gated script's fire waits but is never continued; its next fire runs the script again.

A fresh fire keeps its Claude session only while it may be continued, and deletes it once it ended. One the bot's process died in (a crash, an out-of-memory kill) is deleted at the next boot.

### Gate scripts

A `script` task with a mode is a gate. Executor runs it with no model on every fire. The model runs only when the script hands back a prompt, in the task's own or its chat's conversation.

The script sees what it kept last time as `taskState` (`null` at first; do not declare it yourself). It returns `{ state, prompt }`:

- `state` is kept for the next fire. At most 64 KiB of JSON; on Executor v2, it and the script together.
- `prompt` is what the model is told.

| Script output | Result |
| --- | --- |
| `{ state }` with no `prompt` (or a null one), `null`, `{}`, empty output, or exactly `__TASK_SKIP__` | successful fire, no model run, nothing sent |
| plain text | the prompt, as it is |

- A failed model run keeps the old state, so the retry sees the same change.
- A gated fire is never tidied, sent raw or judged. The model's answer is the report.
- A plain script given a mode sends its output to the model as an instruction. A gate set back to fresh gets no `taskState` and posts its output as is. The Session screen of a script says so. The CLI refuses `--session fresh` on a gate without a new `--payload`.
- Only the person who set up the script, or the owner, can switch it between fresh and a mode. A gate's output, often text someone else wrote, becomes an instruction on its writer's powers.

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
| `session: own` or `session: route` | the mode. Route is not allowed with `silent: true`, and works only in your private chat with the bot or the work chat. |

### Manage tasks

`/tasks` lists them, each with these buttons:

| Button | Does |
| --- | --- |
| Pause/Resume | pauses or resumes the task |
| Run now | runs it. On a task with a mode, it says it may wait. A second press says it already waits its turn, and runs it even if the task was paused meanwhile. |
| Delete | deletes it |
| Stop | ends the running, starting or waiting fire with nothing sent, drops a queued run and a pending retry, and keeps a fire the restart cut from being continued. The next scheduled run fires as usual. For fresh or own prompt tasks and gated scripts with their own conversation. A route task uses its chat's `/stop`. |
| Session | picks the mode. Once one is set, it also offers «Start over». |

«Start over» on an own task starts a new conversation at its next fire. On a route task, it clears the chat conversation as `/new` does there, and a plan waiting for an answer is dropped too. This happens at once when nothing runs there, else as soon as the chat is free. In a private chat outside a topic, and in the work chat's General topic, it is the conversation of the current project.

Picking a mode does not make the task yours. It keeps the powers of whoever wrote it.

A Codex run can manage tasks through `packages/agent/scripts/tasks-cli.ts` (`list|add|update|delete`). Cron and time zone are checked the same way.

- `--session <fresh|own|route>` and `update --reset-session` set the mode and start over, without changing who wrote the task.
- Repeating the mode a task already has keeps its conversation.
- `--session route` is refused for a task whose writer has no user id, or in another user's private chat.
- `list` ends each row with the mode and `session <id|none>`, plus `reset pending`.
- The bot notices a change made there within a minute, a reset included.

### What a prompt task runs on

By default, a prompt task runs on what its writer's new conversations start on (New chats in `/settings`), read again at every fire. Example: set the default provider to Claude and the model to Sol, and the next fire runs on Opus.

- If that provider cannot run, the fire goes to the first one that can. A chosen model and depth carry over. An Auto one takes that provider's own default.
- When the default model or effort is Auto, the first fire routes the task's text and keeps that pick. Editing the text or the choice below, or a move to another provider, routes it again.
- The task's Model button in `/tasks` sets its own Who answers, Model and Depth. A route task has none (the chat's own choice applies). A gated script with its own conversation has it for the model it wakes. «As in settings» follows the writer's defaults.
- `tasks-cli` sets the same with `--provider`, `--model <tier>` and `--effort <level>`. `auto` follows the defaults again.

### Executor setup

Script tasks need `EXECUTOR_MCP_URL` and `EXECUTOR_API_KEY`.

- On v1, the REST base comes from the MCP url's origin.
- On v2, the script goes to the MCP url itself.
- `EXECUTOR_VERSION` picks the generation. Unset, it follows the url: `mcp.executor.sh` is v2, anything else v1.

## Personal rules and skills

Anything you ask the assistant to remember is written into your workspace, not into its code:

```
<work dir>/AGENTS.md                        your standing rules
<work dir>/.agents/skills/<slug>/SKILL.md   one workflow, when a rule is too small
```

Say «remember …» (a preference, a shortcut, a convention, how a recurring job should be done). The run appends it to `AGENTS.md` and tells you it saved it. Every later session reads that file first, so a rule survives `/new`, a restart and a redeploy. For a multi-step workflow for one service (an API, a dashboard, a report), the run writes a skill under `.agents/skills/` and links it from `AGENTS.md`.

Both files are yours. Edit them by hand any time. No restart is needed: they are read at the start of each session.

- On Claude and pi, the bot puts the text of `AGENTS.md` into the run, with your global rules for that CLI (`~/.claude/CLAUDE.md`, pi's `~/.pi/agent/AGENTS.md`), read again on every message. So the run does not spend a step reading them.
- A line that is only `@<path>` (for example `@~/notes/CONTEXT.md`) brings that file in too, as Claude Code's own imports do, up to about 40,000 characters in all.
- Codex reads `AGENTS.md` itself.
- Neither file lives in this repo, so a self-update or a fresh clone does not touch them. They are created on first use; nothing needs to exist beforehand.
- Only your own and executor runs see them (private chats, the workspace forum and their tasks). A group, guest or member run is sandboxed elsewhere and never sees them.
