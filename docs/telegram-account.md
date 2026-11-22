# Telegram account

The bot can act as the owner's own Telegram account through MTProto. It can:

- Read any chat you are in and public channels. Search one chat or all, find albums, download media.
- Send, reply, forward, edit, delete, send files and albums, react, pin, archive, mute, manage scheduled messages, post polls and vote.
- Leave a draft for you to send.
- Read your contacts, folders, forum topics, group members, scheduled messages, reactions, unread mentions and read receipts.

Only the owner and executors get these tools: in their private chat with the bot, and in scheduled tasks one of them set up. Members, guests, groups, the workspace forum and Business replies never get them. Grant `executor` only to people you trust to act as your account.

## Task rights

A task keeps the id of the person who last set what it does or where it reports. At each fire the bot checks that this person still has the tier the task was stamped with.

- Revoke an executor or make them a member: their tasks run without the account from the next fire.
- A task an executor wrote runs with the executor's rights, not the owner's admin helpers.
- A task written before this check holds the account only if the owner wrote it.
- A task written from a run without the account never holds it.

The check stops honest runs only. An executor's run has the whole machine and can forge the stamp.

## Setup

1. Open [my.telegram.org](https://my.telegram.org) → API development tools. Create an app. Put its id and hash in `.env` as `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`. Restart the bot.
2. Send `/login` and press «Sign in: Telegram account». The bot sends a QR code. On your phone open Settings → Devices → Link Desktop Device and scan it. The code renews every 30 seconds. After a scan, login can take up to 30 seconds.
3. If the account has a cloud password, the bot asks for it. Send it as a plain message. The bot deletes it after reading.

`/login` shows the status. «Sign out: Telegram account» ends the session. «Cancel sign-in: Telegram account» stops a login in progress.

The QR code, password prompt and results stay in the topic where you pressed «Sign in». Send the password only there. A password sent there while the bot waits is never read as a message to the agent, and any command, `/login` included, still works. A message in any other topic or in the main chat goes to that conversation as usual.

| Path | Holds |
| --- | --- |
| `.data/telegram-account.db` | The session. Survives restarts. |
| `.data/account-media/` | Media a run downloads. Cleared after a day. |
| `.data/account-outbox/` | Copies of files a run sends. Cleared after a day. |

## Confirming writes

By default every write waits for a button. The bot sends you, in your private chat, exactly what would happen: recipient and text, the message a reaction or pin goes on, the files, the poll. Buttons are named for the action ("Send", "Pin", "Archive"…) plus "Cancel". Only `ALLOWED_USER_ID` can press them. A request expires after 24 hours.

To skip the button, turn Confirm account actions off in `/settings` or set `TELEGRAM_ACCOUNT_WRITES=direct`. This applies to every run with the account. Then:

- A scheduled task can send on its own.
- A run that read a hostile message has nothing between it and your account. Runs are told to ignore instructions in messages they read, but that is a request to a model, not a guarantee.

| Case | Behaviour |
| --- | --- |
| `confirm`, executor's write | The button goes to you, with a line naming the executor. The executor cannot approve it. |
| `direct` | No button. |
| Run started over the [HTTP API](http-api.md) | Always waits for the button, with a line naming the API key. |

## Read marks

What a run reads stops showing as unread.

- `get_history` on the newest page marks the chat read to its newest message, every mention of you included.
- In a forum group only the page is marked: each topic on it up to its newest message, and its mentions. `mark_read` reads the rest.
- An older page (`before_id`) marks only the mentions it holds.
- `download_media` on a voice note or round video marks it listened. A view-once or self-destructing one is never marked, since that starts its timer.

This holds for every run, scheduled tasks too. A morning digest leaves the channels read. Turn Mark as read off in `/settings` to keep everything unread.

`mark_read` works whatever the switch says. It marks a whole chat or up to one message, every unread forum topic included. Mentions clear only when the whole chat is marked.

The switch covers Business replies too. After the bot answers in a Business chat, the chat is read to the newest message of the other person that the bot saw. This needs the Business connection's `can_read_messages` right. Without it the chat stays unread.

## Forwarding a channel post

Typical executor task: each morning read a few channels, pick one post, forward it to you. Example prompt: "every morning at 9 read @channel_a, @channel_b and @channel_c, pick the most interesting post and forward it to me". On each fire the run:

1. Reads the channels with `get_history`. Messages of one album share an `album_id`.
2. Calls `get_album` with any id of the chosen album to get all ids in order. A history page can cut an album in two.
3. Calls `forward_messages` once with the source chat, destination and all ids.

For one topic of a forum group, it also passes `to_thread_id`: the `topic_id` that `get_history` shows on a message of that topic. The confirmation names the topic.

You get a native forward: original media, caption and album, with the source shown. Nothing is downloaded or uploaded again. Under `direct` it happens at once. Under `confirm` the button waits in the bot chat.

A channel or message with `content_protected: true` cannot be forwarded. The tool refuses before any button, and the run reports that instead of rebuilding the post.

## Tools

| Kind | Tools |
| --- | --- |
| Reads, run at once | `list_dialogs`, `get_chat`, `get_history`, `get_album`, `get_messages`, `search_messages`, `download_media`, `list_drafts`, `list_topics`, `list_contacts`, `get_common_chats`, `list_members`, `list_scheduled`, `get_reactions`, `unread_mentions`, `read_date`, `transcribe_voice`, `translate`, `list_folders` |
| Changes only you see, run at once | `mark_read`, `mark_unread`, `save_draft` |
| Writes, follow Confirm account actions | `send_message`, `send_media`, `forward_messages`, `edit_message`, `delete_messages`, `react`, `pin`, `unpin`, `archive`, `mute`, `delete_scheduled`, `send_scheduled_now`, `create_poll`, `vote` |

Each write checks its target first (message, scheduled message, poll, file). You are never asked to approve what Telegram would refuse.

Never available: deleting a whole chat history, removing or banning members, handing over ownership, editing your profile, importing contacts.

### Drafts

Ask "draft a reply to Kirill, do not send it". `save_draft` puts the text in that chat's (or forum topic's) input field on all your devices. Nothing is sent, so there is no button. It replaces an existing draft, and the run is told what it replaced.

`list_drafts` lists your drafts. `send_message` with `clear_draft` clears that chat's draft once sent.

### Paging, filters and links

| Tool | Option | Does |
| --- | --- | --- |
| `get_history` | `before_id` | Pages back. |
| `get_history` | `to` / `from` | Starts before / stops at a date. |
| `get_history` | `after_id` | Reads forward, oldest first. |
| `search_messages` | `filter` | photo, video, document, url, voice, mention, pinned, poll… |
| `search_messages` | `from_user`, `thread_id` | By sender; by forum topic or channel-post comments. |
| `search_messages` | `cursor` | Pages. |
| `list_dialogs` | `offset` | Pages. |
| `list_members` | `query` | Searches all members by name or @username. Without it, lists the most recent. |

- Every message carries its t.me `link` (supergroups and channels only), `reactions` and, for a file, name, size and type. A dialog carries your unsent `draft`.
- `get_messages` opens a t.me link, fetches by id, follows a reply chain up, or opens a channel post's comments.
- `list_topics` gives a forum's topic ids, so a run never guesses one.
- `query` does not combine with the recent, bots or admins lists. A basic group has only the all, recent, admins and bots lists.

### Sending options

| `send_message` option | Does |
| --- | --- |
| `thread_id` | Sends into a forum topic. |
| `silent` | No sound. |
| `schedule` | Sends later: a date with time zone, 10 seconds to a year ahead. The confirmation shows the time in your home zone. |

The confirmation states each option used.

`edit_message`:

- Your own messages only. Notes in Saved Messages count. A forward saved there does not.
- Text or caption only. A caption is at most 1024 characters.
- A sticker, poll or other media with no caption gets no button.
- The confirmation shows old and new text. The old one is cut short when both do not fit.

`delete_messages` checks every id exists and deletes for everyone unless the run passes `revoke: false`. That is refused in a supergroup or channel, where Telegram always deletes for everyone. The confirmation names messages someone else wrote.

Approving late:

- A scheduled send approved after its time is not sent.
- A timed mute approved after its end is not applied. The chat's notifications stay as they are.
- A `delete_scheduled` approved after a message already went out deletes nothing.

The confirmation says so in each case. A confirmation too long for one Telegram message is never shown, and the run is told to shorten the text.

### Files

`send_media` sends one photo, video, document, voice note or audio file, or an album of up to ten.

| Rule | Value |
| --- | --- |
| Allowed path | A file the run made or you sent the bot: under the working directory (or `PROJECTS_DIR`) or the system temp dir. |
| Refused | `.data` (so downloaded media too), the repo's dotfiles, the provider CLIs' logins, and `.env*`, `credentials*`, `secrets*`, `*.pem`, `*.key`. Same list as `send-file-to-user`. |
| File size | At most 50 MB. |
| Photo size | At most 10 MB. |
| Album | Photos and videos, or only documents, or only audio. |
| Voice note | Goes alone. |

The extension decides how a file goes out, unless the run passes `as`.

Each file is copied to `.data/account-outbox/`. The copy is what you see and what is sent, so a later change never goes out. It is removed when the write is done, failed, cancelled or expired.

Under `confirm`, the bot first sends you the files, silently, exactly as they would go out. If that preview fails, nothing is asked and nothing is sent.

### Reactions, pins, chats, polls

| Tool | Does |
| --- | --- |
| `react` | Puts your reaction on a message. Without `emoji`, removes it. Custom emoji: `custom:<id>`. |
| `pin` / `unpin` | Pins silently unless the run passes `notify`. / Unpins. |
| `archive` | Moves a chat in or out of the archive. A chat already there gets no button. |
| `mute` | Silences a chat until a time or for good, or turns it back on. Sound, previews and story settings stay. |
| `delete_scheduled`, `send_scheduled_now` | Act on ids from `list_scheduled`. |
| `create_poll` | Anonymous and single-answer unless `public` or `multiple`. Same reply, topic, sound and schedule options as `send_message`. |
| `vote` | Votes by answer index, as the poll message lists them. `options: []` retracts. |

- Confirmations of a reaction, pin, unpin and scheduled-message action quote the message they act on.
- A vote goes to the answers the confirmation named. If the answers changed before you press, Telegram refuses it.
- A poll that forbids changing a vote gets no button for a second one.

## Raw Telegram API

For anything the tools above do not do, a run has three more tools on the same server.

| Tool | Does |
| --- | --- |
| `tg_search_methods` | Searches the bundled API schema (layer 229, mtcute 0.32.2) by words in a method's name or description, optionally in one namespace. Shows signature and class. |
| `tg_describe` | Explains a method, type or constructor: arguments with types and which are optional, return value, possible errors. |
| `tg_call` | Calls one method. |

Rules for `tg_call`:

- A peer takes `"me"`, a chat id as the other tools give it, or a @username. An object such as `inputPeerUser` is refused (only `inputPeerSelf` and empty constructors pass), so the confirmation can name every chat.
- A basic group's bare `chat_id` (`messages.editChatTitle`, `addChatUser`…), the user ids of `contacts.editCloseFriends` and the chats of a privacy rule are looked up and named too.
- A raw answer adds `marked_id` next to every peer, chat and channel, since Telegram's bare `channelId` and `chatId` would read as a person's id.
- A 64-bit number is a decimal string. Bytes are base64.
- Every call is checked against the schema first. An unknown argument or wrong type is refused before it reaches Telegram.

One classifier (`apps/telegram/src/account/raw-policy.ts`) puts each method in one of four classes. At layer 229 a user account may call 783 methods.

| Class | Methods | Behaviour                     |
| ----- | ------- | ----------------------------- |
| read  | 236     | Runs at once.                 |
| mark  | 8       | Runs at once.                 |
| write | 309     | Always waits for your button. |
| deny  | 230     | Refused.                      |

### read

`get…`, `search…`, `check…`, `resolve…`. The answer is `{method, class, untrusted_content: true, result}`. Access hashes and file references are removed, long texts and lists are cut, and the whole answer stays within 48 KB.

### mark

Only methods that move a read mark: `messages.readHistory`, `channels.readHistory`, `readDiscussion`, `readMentions`, `readReactions`, `readSavedHistory`, `readFeaturedStickers`, `readPollVotes`. Runs like `mark_read`.

`readMessageContents` (both namespaces) and `readEncryptedHistory` are writes. They mark a voice or round note played for its sender and start the countdown of a view-once, timed or secret-chat message.

### write

Everything else. It **always** waits for your button, even with Confirm account actions off or `TELEGRAM_ACCOUNT_WRITES=direct`, because the class is a guess from the method's name. The confirmation:

- Opens with a warning that this is a direct API call, then names the method and what it does.
- Lists every argument, nothing cut. Chats show by name, bytes by size (short ones, such as a report reason, as text or hex).
- Is refused if over 3500 characters.
- Reads as one plain sentence for a reaction, joining or leaving a channel, joining by invite link, and blocking or unblocking someone.

A chat named by @username is resolved when the run asks and kept by id, so the write reaches the chat you saw even if the username changes hands. A raw send with a `scheduleDate` approved after that time is not sent, as with `send_message`.

### deny

Refused in every mode.

- Logins and sessions: `auth.*`, and the account's password, passkey, authorization, takeout, email, phone, passport and push-device methods.
- Deleting the account or changing its self-destruct timer.
- Payments, calls, file upload and download, SMS jobs, Fragment.
- Deleting a channel or group, handing over ownership.
- Web apps, URL logins, pressing a bot's inline button.
- `messages.sendVote`: use `vote`, whose confirmation names the answers.
- Reads that act, since their result could not come back from behind a button:
  - Counting a view: `messages.getMessagesViews`, `account.resolveBusinessChatLink`.
  - Asking an inline bot: `messages.getInlineBotResults`.
  - The people-nearby list, which can publish your location: `contacts.getLocated`.
- Reads that can spend your Stars or record a bot's referral (an `allow_paid_stars` or `referer` argument): `channels.searchPosts`, `contacts.resolveUsername`, `help.getRecentMeUrls`.
- Bot-only methods.
- Wrappers (`invokeWithLayer`, `invokeAfterMsg`…) that would carry another call past the check.

A namespace a future API layer adds stays denied until reviewed.

### Limits

One `tg_call` holds at most 200 items in any list and at most 50 chats given as `"me"`, an id or a @username. Each @username is a lookup on your account, and thousands at once earn a long flood wait.

Prefer the typed tools when one fits. They check more (message exists, file allowed) and their confirmations say more.

## Output size

One tool answer is at most 48 KB. A longer list is cut at the end and says `truncated: true`. Its next-page cursor continues from the last item kept.
