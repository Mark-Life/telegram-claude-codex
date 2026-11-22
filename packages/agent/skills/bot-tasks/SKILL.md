---
name: bot-tasks
description: Use when the user wants something done on a schedule (every morning, weekly, hourly, a periodic digest or check) or asks to list, change, pause or delete a recurring task. Covers the tasks CLI, script vs prompt tasks, and where results are delivered. A one-off reminder is not a recurring task.
---

# Recurring tasks

The CLI's path is this file's path with `skills/bot-tasks/SKILL.md` replaced by `scripts/tasks-cli.ts`. Call it by that absolute path: `bun <absolute path to tasks-cli.ts> <list|add|update|delete> [args]`. The scheduler picks a change up within a minute.

```
list
add    --title <t> --cron '<5-field cron>' --tz <IANA zone> --type <prompt|script> --payload <text>
       [--project <dir>] [--chat <id>] [--thread <id>] [--raw] [--disabled]
       [--provider <codex|claude>] [--model <luna|terra|sol|astra>] [--effort <low|medium|high|xhigh>]
       [--session <fresh|own|route>]
update --id <id> [--title <t>] [--cron <c>] [--tz <z>] [--payload <p>] [--project <dir>]
       [--chat <id|none>] [--thread <id|none>] [--enabled <true|false>] [--raw <true|false>]
       [--provider <p|auto>] [--model <tier|auto>] [--effort <level|auto>]
       [--session <fresh|own|route>] [--reset-session]
delete --id <id>
```

`--cron` is `m h dom mon dow`. `--disabled` and a bare `--raw` work only on `add`: `update` takes `--enabled false` to pause a task and `--raw true|false`. `--chat none` makes a task silent; `--thread none` clears only the topic.

`--session` picks which conversation the fires keep. `fresh` (the default) starts a new one each fire. `own` keeps one conversation of the task's own, so a fire can build on the last: use it when the work compares with earlier runs. `route` runs each fire in the conversation of `--chat` (and `--thread`) as if the writer had sent the instruction there, so the answer lands in that chat and a human message continues it; it needs `--chat`, and that chat must be the writer's own private chat with the bot (the requester's user id) or the work chat, else every fire is refused. A run that does not stamp the requester's id cannot set `--session route` at all, and a `--chat` that is another user's private chat is refused: the CLI refuses both. Repeating the mode a task already has changes nothing; only a new mode starts its conversation over. An edit that re-stamps an own task to another writer starts its conversation over too. A route task ignores `--provider`, `--model`, `--effort` and `--project`: the chat's own apply. A fire into a busy conversation waits; it never interrupts. `--reset-session` starts a kept conversation over (in route mode it clears that chat's conversation, as `/new` there); it does not go with `--session`. `list` ends each row with the mode and `session <id|none>`.

A prompt task runs on its writer's `/settings` defaults for new conversations, read at every fire. Pass `--provider`, `--model` or `--effort` only when the user asks for a specific one for this task. `--model` takes a tier, which each provider runs on its own model (Sol is Opus on Claude). `auto` follows the defaults again.

## Pick the type

- `script` replays the payload as an Executor program with no model, which costs almost nothing. Prefer it whenever the work is a deterministic fetch. Test the code with the Executor tools first, then save it as a script task. On Executor v1 use full 5-segment tool addresses (`tools.<integration>.<owner>.<connection>.<tool>`); a tool answers `{ ok, data }`, so check `ok` and read `data`, and approvals are given for you. On v2 (an `EXECUTOR_MCP_URL` on `mcp.executor.sh`, or `EXECUTOR_VERSION=v2`) use the exact `path` and input shape `search` and `describe` return; a tool returns the response body itself and throws on failure, with no `{ ok, data }` wrapper, and a tool that needs approval pauses the task, so keep a v2 script read-only. A v2 script is plain JavaScript: type annotations, `as` casts and interfaces fail to parse. Its output gets one cheap formatting pass unless the task is `--raw`. To send nothing on a fire, make the whole output exactly `__TASK_SKIP__`.
- `prompt` re-runs the payload as an agent prompt every time, which costs tokens. Use it only when the work needs judgment. For a `fresh` task, write the payload so it stands alone: no "this chat" or "as before". An `own` or `route` task may refer to earlier fires. On Claude with full access a fire may start background work (a workflow, a Monitor, a background command) and waits for it; its last answer is the report. The schedule brings the next fire, so the payload should not ask for wake-ups to poll.
- A `script` with `--session own|route` is a gate: the script runs with no model on every fire and wakes the model only when there is something to judge. It sees what it kept last time as `taskState` (`null` on the first fire; it is declared for you, so never declare `taskState` yourself) and ends with `return { state, prompt }`: `state` (JSON, at most 64 KiB; on v2 it and the script together) is kept for the next fire, `prompt` is what the model is told in the task's conversation. With no `prompt` or `prompt: null`, or output exactly `__TASK_SKIP__`, nothing runs and nothing is sent. Its output is never formatted: the model's answer is the report. A mode on a plain script therefore turns its output into an instruction for the model; `--session fresh` on a gate is refused unless `--payload` gives a script that works without `taskState`. Switching someone else's script between fresh and a mode is refused unless the run is the owner's or `--payload` replaces the script.

## Delivery

Unless the request already says where results go, ask whether they should be sent (and where) or the task should work silently.

- This conversation: the `--chat` and `--thread` your prompt gives for sending files.
- The requester's private chat: `--chat <the requester's user id>`, which your prompt gives on the `bot-tasks` line.
- The owner's private chat: `--chat "$ALLOWED_USER_ID"`.
- Silent: no `--chat`. Its output is dropped and only failures reach the owner. Each fire of a silent prompt task is told to answer `__TASK_FAILED__ <reason>` when its work fails, so the payload does not need to say it.

When done, tell the user the task's id, its schedule in words and where it reports.
