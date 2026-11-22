---
name: bot-send-file
description: Use when the user explicitly asks you to send, share or download a file into their Telegram chat. Covers the helper script, which file you may send and what to do when the file is unclear.
---

# Sending a file to the user's Telegram chat

Only when the user explicitly asks you to send, share or download a file.

The helper's path is this file's path with `skills/bot-send-file/SKILL.md` replaced by `scripts/send-file-to-user.ts`. Call it by that absolute path:

```
bun <absolute path to send-file-to-user.ts> --path <absolute-file-path> --chat <id> [--thread <id>]
```

Pass `--chat` and `--thread` exactly as your prompt gives them for this turn, unchanged, so the file reaches the conversation that asked for it. When the prompt gives no `--thread`, leave it out.

## Which file

- An incoming attachment: use only the exact `absolute_path` from its `[Incoming Telegram attachment]` block in the current request or reply context. Never search `user-sent-files`, pick a recent file, or guess which file the user meant.
- A file you made: use only the exact absolute path you created during the current turn.
- If the requested file has no exact path in the current context, ask the user to resend it or reply to it. Do not send anything.

## Rules

- Never bypass this helper by calling the Telegram API directly.
- The helper refuses `.env` files, keys, the bot's own data and every provider login, and sends only to the owner or an executor. If it refuses, say so; do not look for another way to send the file.
