# Access, groups and the sandbox

## Who may use the bot

The owner id in `.env`, the tier in the `users` table and the chat type set what a run may do.

| Tier | Comes from | In private chat |
| --- | --- | --- |
| `owner` | `ALLOWED_USER_ID` | Full machine access, real project directories, account apps/plugins, Executor and other MCP servers. Sessions kept. |
| `executor` | `users` table | Owner execution profile and external tools, owner's Telegram account included. Sessions kept. No owner-only management. |
| `member` | `users` table | Read/write in `.data/scratch/<user id>`. No account apps, plugins or MCP servers. With `bwrap`: sandbox view, new conversation per message. On Claude it needs `bwrap` and `socat`, and the view holds Claude's login file. |
| `guest` | No row (default) | Light run in `.data/scratch/<user id>`, 30 a day by default. Ignored silently when `/settings` has Guests off. |

Owner and `executor` runs use the real working directory. Only `ALLOWED_USER_ID` is the owner.

Anyone who writes to the bot in private is a guest, and guest runs spend tokens. To stop them, turn Guests off in `/settings`. The bot then drops every private update from a guest before any handler: text, voice, files, commands, button presses. No reply, no transcription, no run. The log keeps the user id, never the text.

Members, executors, groups and Business replies are not affected. The switch is the `guests` row of `settings` (`off` blocks; no row or `on` allows) and applies at once. If a member's or executor's row cannot be read, they count as a guest. With Guests off, a db failure drops them too, and the log shows `Tier lookup failed`.

### Manage users

Owner only.

| Command | Does |
| --- | --- |
| `/users` | Lists everyone, with buttons to change tier or remove. |
| `/grant <id> <executor\|member>` | Adds a person by numeric user id. |
| `/grant <executor\|member>` as a reply | Adds the author of the replied message. |
| `/revoke <id>`, or as a reply | Removes a person. |

- The person sees their id in the bot's `/start`. `@username` does not work: the Bot API cannot resolve it.
- A typed id wins over a reply. In a topic every message replies to the topic root, so only a reply to someone else's message counts.
- The owner's own id is refused. The owner tier lives in `.env`.
- A run can edit the table with `packages/agent/scripts/users-cli.ts`. Only owner runs are pointed at its skill, `packages/agent/skills/bot-access/SKILL.md`.
- Every change goes to `.data/events.jsonl` with who made it.

### HTTP API keys

The owner and executors make keys for the [HTTP API](http-api.md) with `/apikeys`. A key names its holder, not a tier. The tier is read on every request, so demoting or revoking a person disables their keys at once.

Keys live in the `api_keys` table, secret as a hash only. The access watcher reports any key that appears, moves or changes without the bot, like a tier change.

### Groups

The bot silently leaves any group where the owner is not a member. The check is cached in the `groups` table and repeated daily. An API failure counts as "unknown", so it never causes a leave.

In an owner-present group everyone is equal, the owner too. Every run is lightweight: web search, no file edits, no account apps or plugins, quiet rendering, session thrown away.

**Recording.** The bot stores group text, voice transcripts, photos and documents in SQLite. No agent starts for them.

- A file is stored as a marker with its caption: `[photo ×6] caption`, `[document: a.pdf]`. An album is one message.
- A file is downloaded only when its message, or a reply to it, is answered. A file with no caption is answered only as a reply to one of the bot's messages.
- A GIF or video is never downloaded. With a caption, the caption is judged as usual and the run is told it cannot see the file. Without one, it is only recorded.

Files land in `.data/groups/<chat id>`, read-only for group runs. A run never sees another group's directory or a member's scratch. Files are kept 7 days, and removed when the bot leaves.

Only a run in the sandbox view (Codex with `bwrap`) opens them. On Claude and pi, or without `bwrap`, the bot passes images inline: photos and documents Telegram marks as images, 5 MB each, 20 MB a message at most. The run is told other files are there but it cannot open them.

**Triggers.** A run starts only for:

- an `@mention`;
- a reply to one of the bot's messages;
- its call name, set with `/callname <name>` (owner only), matched through Russian declensions. With no name set: «Ассистент» and «Assistant».

An address judge then confirms. It reads the last ten messages.

| Item | Value |
| --- | --- |
| Judge | TypeSafe Jev: probability that the bot was spoken to |
| Threshold, group | `0.75` and up |
| Threshold, Business chat | `0.8` and up |
| Fallback | One-turn pass on the helper provider (Codex, Claude or pi, or the one picked in «Helpers» of `/settings`). Used without `TYPESAFE_API_KEY` or when the call fails. |

**Limits.** The run gets the latest 30 messages and durable facts. Its search and facts are locked to the current `chat_id`: it cannot name or inspect another chat. Voice is transcribed silently, so ordinary voice chatter gets no reply.

| Limit                         | Default |
| ----------------------------- | ------- |
| Group runs per person per day | 30      |
| Group runs per day, total     | 100     |

A restart keeps the counts. The owner is exempt and changes all four daily budgets, group and private, in `/settings` (see [Settings](usage.md#settings)).

## Sandbox view

Every run that is not full access starts in the view: groups, guests, members, Business replies, helper passes. Owner, executor and task runs are never wrapped.

| Package | Install | Gives |
| --- | --- | --- |
| **bubblewrap** (`bwrap`) | `apt install bubblewrap` | The view |
| **socat** | `apt install socat` | A restricted network for the view |

**With `bwrap`:** root is read-only. Home directories and this repo are empty. `.env`, `.data` and every provider's login are hidden. `/tmp` is private, `/var/log` is hidden, and the run sees only its own processes.

The boot log says `Sandbox view: <path>`. It warns if `bwrap` is missing or cannot create namespaces (some kernels and AppArmor policies forbid it for unprivileged users).

Without `bwrap`, Codex runs under its own sandbox only. A light run can read every file the service account can.

Codex caveat: the view holds only `~/.codex/auth.json`, not `config.toml`. With another `model_provider` or a keyring login (`cli_auth_credentials_store`), light runs fail once `bwrap` is installed.

**With `socat`:** each view gets its own network namespace, loopback only. The one way out is a bot-run proxy. It opens HTTPS tunnels only to the provider's hosts (Codex: `api.openai.com`, `auth.openai.com`, `chatgpt.com`). It never connects to loopback, the LAN or the tailnet, so a light run cannot reach a dev server, a browser debug port or VNC. The boot log reads `Sandbox view: <bwrap>, network through <socat>`.

Refused connections log as `Sandbox network refused`, once per host and port, at most 32 per run.

**Host network fallback.** The log reads `host network`, with a warning, when `socat` is missing or the bot's env sets `HTTPS_PROXY` or `HTTP_PROXY` (the view's proxy dials directly and would bypass it). Views then share the host network. Ports on `127.0.0.1` and abstract unix sockets stay reachable. Only Codex's own sandbox keeps the shell offline.

## Forum supergroup (optional, recommended)

Threads let the owner hold several conversations at once. Each has its own session, queue and draft, and they run in parallel.

1. Create a supergroup. In its settings, turn **Topics** on.
2. Add the bot as an **administrator** with permission to manage topics. An admin sees every message regardless of privacy mode.
3. Create one normal topic per subject. The bot routes any topic it sees. A due reminder gets its own topic automatically.
4. **Send `/setworkspace` in the group.** Owner only. It is the only way to record the workspace (`workspace_chat_id` in `settings`).

Send `/setworkspace` from the topic the bot should write to on its own (startup notices, task results). That topic goes to `workspace_thread_id`. From General, the bot writes to General. Until then, those messages go to the owner's private chat. `/settings` shows the workspace and has a button that forgets it. Unprompted messages then go to the private chat again.

Check it landed:

```bash
sqlite3 .data/bot.db "select key, value from settings"
```

To pin it by hand instead (a supergroup chat id is negative, e.g. `-1001234567890`):

```bash
sqlite3 .data/bot.db \
  "insert into settings (key, value, updated_at) values ('workspace_chat_id', '-1001234567890', unixepoch()*1000)
   on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at"
```

The workspace forum keeps the owner's filesystem and session capabilities, but gets no account apps, plugins or inherited MCP servers. Every other group is a lightweight group (see above). The General topic and a private chat each stay one conversation.
