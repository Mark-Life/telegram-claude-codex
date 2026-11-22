# Telegram account

The bot can act as your own Telegram account. It can read your chats and public channels, search, and download media. It can also send, reply, forward, edit, delete, react, pin, archive, mute, post polls and vote, or leave a draft for you to send.

Only the owner and executors get these tools, in their private chat with the bot and in scheduled tasks they set up. Members, guests, groups, the workspace forum and Business replies never get them. Grant `executor` only to people you trust to act as your account.

## Task rights

A task belongs to the person who last set what it does or where it reports. If you revoke that executor or make them a member, their tasks run without the account from the next fire.

This check stops honest runs only. An executor's run has full access to the machine and can forge it.

## Setup

1. Open [my.telegram.org](https://my.telegram.org) → API development tools and create an app. Put its id and hash in `.env` as `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`, then restart the bot.
2. Send `/login` and press «Sign in: Telegram account». On your phone open Settings → Devices → Link Desktop Device and scan the QR code. Login can take up to 30 seconds after the scan.
3. If the account has a cloud password, send it as a plain message in the topic where you pressed «Sign in». The bot deletes it after reading.

`/login` shows the status. «Sign out: Telegram account» ends the session. «Cancel sign-in: Telegram account» stops a login in progress.

| Path | Holds |
| --- | --- |
| `.data/telegram-account.db` | The session. Survives restarts. |
| `.data/account-media/` | Media a run downloads. Cleared after a day. |
| `.data/account-outbox/` | Copies of files a run sends. Cleared after a day. |

## Confirming writes

By default every write waits for your button. The bot shows you in your private chat what will happen, with a button named for the action and "Cancel". Only `ALLOWED_USER_ID` can press it. A request expires after 24 hours.

To skip the button, turn Confirm account actions off in `/settings` or set `TELEGRAM_ACCOUNT_WRITES=direct`. Then scheduled tasks send on their own. A run that reads a hostile message can then act on your account with nothing to stop it.

| Case | Behaviour |
| --- | --- |
| `confirm`, executor's write | The button goes to you, naming the executor. The executor cannot approve it. |
| `direct` | No button. |
| Run started over the [HTTP API](http-api.md) | Always waits for the button. |

## Read marks

What a run reads stops showing as unread, scheduled tasks included. A morning digest leaves its channels read. To keep everything unread, turn Mark as read off in `/settings`.

The switch covers Business replies too. There it needs the Business connection's `can_read_messages` right.

## Forwarding a channel post

Example task prompt: "every morning at 9 read @channel_a, @channel_b and @channel_c, pick the most interesting post and forward it to me". You get a native forward with the original media, caption and album.

A channel or message with content protection cannot be forwarded. The run reports this instead.

## Tools

| Kind | Tools |
| --- | --- |
| Reads, run at once | `list_dialogs`, `get_chat`, `get_history`, `get_album`, `get_messages`, `search_messages`, `download_media`, `list_drafts`, `list_topics`, `list_contacts`, `get_common_chats`, `list_members`, `list_scheduled`, `get_reactions`, `unread_mentions`, `read_date`, `transcribe_voice`, `translate`, `list_folders` |
| Changes only you see, run at once | `mark_read`, `mark_unread`, `save_draft` |
| Writes, follow Confirm account actions | `send_message`, `send_media`, `forward_messages`, `edit_message`, `delete_messages`, `react`, `pin`, `unpin`, `archive`, `mute`, `delete_scheduled`, `send_scheduled_now`, `create_poll`, `vote` |

Never available: deleting a whole chat history, removing or banning members, handing over ownership, editing your profile, importing contacts.

### Drafts

Ask "draft a reply to Kirill, do not send it". The text appears in that chat's input field on all your devices. Nothing is sent, so there is no button. It replaces an existing draft.

### Paging, filters and links

A run can page back through history, read by date, search by file type or sender, and open a t.me link.

### Sending options

A message can go into a forum topic, without sound, or scheduled from 10 seconds to a year ahead. You can edit only your own messages, text or caption only.

A delete removes the messages for everyone by default.

A scheduled send or timed mute approved after its time does nothing.

### Files

A run can send one file or an album of up to ten. A file must be one the run made or you sent the bot.

| Rule | Value |
| --- | --- |
| Allowed path | Under `WORK_DIR` or the system temp dir. |
| Refused | `.data`, the repo's dotfiles, the provider CLIs' logins, and `.env*`, `credentials*`, `secrets*`, `*.pem`, `*.key`. |
| File size | At most 50 MB. |
| Photo size | At most 10 MB. |

Under `confirm`, the bot first sends you the files exactly as they will go out.

### Reactions, pins, chats, polls

A run can react, pin and unpin, archive or mute a chat, act on scheduled messages, create polls and vote. Each of these follows Confirm account actions.

## Raw Telegram API

For anything the tools above do not do, a run can call the Telegram API directly with `tg_call`. It finds methods with `tg_search_methods` and `tg_describe`.

Each method falls in one of four classes:

| Class | Behaviour                     |
| ----- | ----------------------------- |
| read  | Runs at once.                 |
| mark  | Runs at once.                 |
| write | Always waits for your button. |
| deny  | Refused.                      |

### read

`get…`, `search…`, `check…`, `resolve…` methods. They run at once.

### mark

Methods that only move a read mark, such as `messages.readHistory`. They run like `mark_read`.

### write

Everything else. It **always** waits for your button, even with Confirm account actions off or `TELEGRAM_ACCOUNT_WRITES=direct`. The confirmation warns that this is a direct API call and lists every argument. Read it with care before you press.

### deny

Refused in every mode:

- logins, sessions, password and account deletion
- payments, calls, file upload and download
- deleting a channel or group, handing over ownership
- reads that can spend your Stars or count a view

### Limits

One `tg_call` holds at most 200 items in a list and 50 chats. Thousands of @username lookups at once earn a long flood wait from Telegram.

## Output size

One tool answer is at most 48 KB. A longer list is cut and says `truncated: true`.
