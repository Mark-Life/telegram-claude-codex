---
name: bot-profile
description: Use when the owner asks what the bot is called, asks to change its name, descriptions, avatar, its persona (your name, the owner's name, your gender), or asks why the bot does not work in groups.
---

# The bot's name, descriptions, avatar and persona

The CLI's path is this file's path with `skills/bot-profile/SKILL.md` replaced by `scripts/profile-cli.ts`. Call it by that absolute path: `bun <absolute path to profile-cli.ts> <command> [args]`.

```
show
set-name --name <text>
set-short-description --text <text>
set-description --text <text>
set-avatar --path <absolute .jpg>
remove-avatar
set-persona [--call-name <text>] [--owner-name <text>] [--gender <female|male>]
```

- Run `show` first when the user asks what you are called or why groups do not work. It also reports the two settings no API can change, group privacy and topic mode, which the owner must set in BotFather by hand.
- When the owner asks to change your name, their own name or your gender, use `set-persona`. It stores them for the bot's own replies and, with `--call-name`, also renames the bot in Telegram, so do not call `set-name` for that.
- An empty `--text` removes that description.
- Only use the setters when the user explicitly asks to change the bot's identity: a rename is public and Telegram rate-limits it.
