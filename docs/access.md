# Access, groups and the sandbox

## Who may use the bot

The owner is `ALLOWED_USER_ID`. Executors and members come from the `users` table. Everyone else is a guest.

| Tier | In private chat |
| --- | --- |
| `owner` | Full machine access, account apps, plugins, Executor and MCP servers. |
| `executor` | Same tools as the owner, the owner's Telegram account included. No owner-only commands. |
| `member` | Reads and writes in `.data/scratch/<user id>`. No account apps, plugins or MCP servers. On Claude it needs `bwrap` and `socat`. |
| `guest` | Light runs in `.data/scratch/<user id>`, 30 a day by default. |

Anyone who writes to the bot in private is a guest, and guest runs spend tokens. To stop them, turn Guests off in `/settings`. The bot then ignores guests silently.

If the `users` table cannot be read, members and executors count as guests. The log then shows `Tier lookup failed`.

### Manage users

Owner only.

| Command | Does |
| --- | --- |
| `/users` | Lists everyone, with buttons to change tier or remove. |
| `/grant <id> <executor\|member>` | Adds a person by numeric user id. |
| `/grant <executor\|member>` as a reply | Adds the author of the replied message. |
| `/revoke <id>`, or as a reply | Removes a person. |

The person finds their id in the bot's `/start`. `@username` does not work. Every change goes to `.data/events.jsonl`.

### HTTP API keys

The owner and executors make [HTTP API](http-api.md) keys with `/apikeys`. Demote or revoke a person, and their keys stop working at once.

### Groups

The bot silently leaves any group where the owner is not a member. In a group with the owner, everyone is equal, the owner too. Group runs are light: web search, no file edits, no account apps or plugins.

**Recording.** The bot stores group messages. It downloads a file only when it answers that message, never a GIF or video. Files go to `.data/groups/<chat id>` and are kept 7 days.

Only Codex with `bwrap` opens all files. On Claude and pi, or without `bwrap`, runs see only images: 5 MB each, 20 MB a message.

**Triggers.** A run starts only for:

- an `@mention`;
- a reply to one of the bot's messages;
- its call name, set with `/callname <name>` (owner only). With no name set: «Ассистент» and «Assistant».

An address judge then checks the last ten messages to confirm the bot was spoken to.

**Limits.** A group run sees the latest 30 messages of its own chat only. Voice is transcribed silently, so voice chatter gets no reply.

| Limit                         | Default |
| ----------------------------- | ------- |
| Group runs per person per day | 30      |
| Group runs per day, total     | 100     |

The owner is exempt, and changes all four daily budgets, group and private, in `/settings` (see [Settings](usage.md#settings)).

## Sandbox view

Groups, guests, members and Business replies run in the sandbox view. Owner, executor and task runs do not.

| Package | Install | Gives |
| --- | --- | --- |
| **bubblewrap** (`bwrap`) | `apt install bubblewrap` | The view |
| **socat** | `apt install socat` | A restricted network for the view |

**With `bwrap`:** root is read-only. Home directories, this repo, `.env`, `.data` and every provider's login are hidden. The boot log says `Sandbox view: <path>`, or warns if `bwrap` is missing or cannot create namespaces.

**Without `bwrap`,** a light run can read every file the service account can.

On Codex, the view holds only `~/.codex/auth.json`. With another `model_provider` or a keyring login, light runs fail once `bwrap` is installed.

**With `socat`:** a light run reaches only the provider's hosts, never a dev server, the LAN or the tailnet. The boot log reads `Sandbox view: <bwrap>, network through <socat>`. Blocked connections log as `Sandbox network refused`.

**Host network fallback.** Without `socat`, or when the bot's env sets `HTTPS_PROXY` or `HTTP_PROXY`, views share the host network and the log warns `host network`. Light runs can then reach ports on `127.0.0.1`.

## Forum supergroup (optional, recommended)

Topics let the owner run several conversations at once, in parallel.

1. Create a supergroup. In its settings, turn **Topics** on.
2. Add the bot as an **administrator** with permission to manage topics.
3. Create one topic per subject.
4. **Send `/setworkspace` in the group.** Owner only. Nothing else records the workspace.

Send it from the topic where the bot should post startup notices and task results. `/settings` shows the workspace and can forget it.

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

The workspace forum gets the owner's file access, but no account apps, plugins or inherited MCP servers.
