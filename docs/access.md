# Access, groups and the sandbox

## Who may use the bot

Three things decide what a run may do: the owner id from `.env`, the tier stored in the `users` table, and the surface the message came from.

| Tier | Comes from | In private chat |
| --- | --- | --- |
| `owner` | `ALLOWED_USER_ID` | full access to the machine, real project directories, account apps/plugins, Executor and other MCP servers; sessions kept |
| `executor` | `users` table | owner execution profile and external tools in private chat, the owner's Telegram account included; sessions kept; no owner-only management |
| `member` | `users` table | read/write inside `.data/scratch/<user id>`, no account apps, plugins or MCP servers; with `bwrap`, inside the sandbox view, where each message starts a new conversation; on Claude only with both `bwrap` and `socat`, and the view holds Claude's login file |
| `guest` | no row — the default | a light run, like a group run, in `.data/scratch/<user id>`, 30 a day by default; ignored silently when `/settings` has Guests off |

Owner and `executor` runs leave the scratch directory and use the configured real working directory. This execution access does not grant owner identity: only `ALLOWED_USER_ID` resolves to `owner`, and owner-only management remains unavailable to stored tiers.

Anyone who writes to the bot in a private chat is a guest and gets a light run, which spends tokens. To stop that, the owner turns Guests off in `/settings`. Then every private update from a guest — text, voice, files, commands, button presses — is dropped before any handler: no reply, no transcription, no run. The log keeps one line with the user id, never the text. Members, executors, groups and Business replies are not affected. The switch is the `guests` row of `settings` (`off`; no row or `on` lets guests in) and takes effect at once. A member or executor whose row cannot be read counts as a guest, so with Guests off a db failure drops them too; the log then shows `Tier lookup failed` before the guest line.

Owner-only management, from the chat: `/users` lists everyone with buttons to change tier or remove them, `/grant <id> <executor|member>` adds someone by numeric user id (the person sees theirs in the bot's `/start`; the Bot API cannot resolve a private user's `@username`, so it is not accepted), and replying to their message with `/grant <executor|member>` works too. `/revoke <id>` or a reply drops them. A typed id always wins over the reply: inside a topic every message carries the topic root as its reply, so only a reply to someone else's message counts. The owner's own id is refused — the owner tier lives in `.env`. The same table can be edited by a run through `packages/agent/scripts/users-cli.ts`; only the owner's runs are pointed at its skill, `packages/agent/skills/bot-access/SKILL.md`. Every change is appended to `.data/events.jsonl` with who made it.

**HTTP API keys.** The owner and executors can make keys for the [HTTP API](http-api.md) with `/apikeys`. A key names its holder, never a tier: the tier is read on every request the same way as in the chat, so demoting or revoking a person disables their keys at once. Keys live in the `api_keys` table, the secret only as a hash; the access watcher reports any key that appears, moves or changes there without the bot, like a tier change.

**Groups.** Add the bot to any other group and it first checks that the owner is a member; if not it leaves immediately and silently. The answer is cached in the `groups` table and re-checked daily, and an API failure is treated as "unknown" so a Telegram blip never causes a leave.

Inside an owner-present group everyone is equal and every run is lightweight, the owner included: a model with web search, no file edits or account apps/plugins, quiet rendering, and a session that is thrown away. The bot records group text, voice transcripts, and photos and documents in SQLite without starting an agent: a file is recorded as a marker with its caption (`[photo ×6] caption`, `[document: a.pdf]`), and an album as one message once all its items arrived. A file is downloaded only when the message carrying it, or a message replying to it, is answered; a file with no caption is answered only when it replies to one of the bot's messages, like a typed reply. A GIF or a video is recorded but never downloaded: with a caption the caption is judged as usual and the run is told it cannot see the file; without one it is only recorded. It lands in the group's own directory, `.data/groups/<chat id>`, where every group run works read-only; a group run never sees another group's directory or a member's private scratch. Files there are kept 7 days and removed with the directory when the bot leaves the group. Only a run inside the sandbox view opens them (Codex with `bwrap`); on Claude and pi, or without `bwrap`, the bot hands the images to the model inside the message instead (photos, and documents Telegram names an image type; 5 MB each and 20 MB a message at most), and the run is told any other file is there and that it cannot open it. A run starts only for an `@mention`, a reply to one of the bot's messages, or its call name, set with `/callname <name>` (owner-only) and matched through Russian declensions (with no name set, the bot answers to both «Ассистент» and «Assistant»), then confirmed by an address judge that reads the last ten messages. The judge is TypeSafe Jev: it returns the probability that the bot was spoken to, and the bot answers from `0.75` up in a group, `0.8` in a Business chat. Without `TYPESAFE_API_KEY`, or when that call fails, a one-turn pass on the helper provider (Codex, Claude or pi, or the one picked in «Helpers» of `/settings`) decides instead. The run receives the latest 30 messages and durable facts, plus a narrow search/fact interface physically locked to the current `chat_id`; it cannot name or inspect another chat. Group voice messages are transcribed silently, so ordinary voice chatter gets no bot reply. Group runs are capped at 30 per person per day and 100 a day in total by default, counted in the database so a restart does not reset them; the owner is exempt. The owner changes all four daily budgets, group and private, in `/settings` (see [Settings](usage.md#settings)).

## Sandbox view

**bubblewrap** (`bwrap`), for the sandbox view. `apt install bubblewrap`. Every run that is not full access — groups, guests, members, Business replies, the helper passes — then starts inside a view where the root is read-only, the home directories and this repo are empty, `.env`, `.data` and every provider's login are hidden, `/tmp` is private, `/var/log` is hidden and the run sees only its own processes. At boot the bot logs `Sandbox view: <path>`, or a warning when `bwrap` is missing or cannot create namespaces on this host (some kernels and AppArmor policies forbid it for unprivileged users). Without it Codex runs as before, under its own sandbox only, which still lets a light run read every file the service account can. Owner, executor and task runs are never wrapped. Inside the view Codex sees only `~/.codex/auth.json`, not `config.toml`: a light run uses the built-in OpenAI provider, so a Codex set up with another `model_provider` or a keyring login (`cli_auth_credentials_store`) fails its light runs once `bwrap` is installed. **socat**, for the sandbox view's network. `apt install socat`. With it, each view gets its own network namespace with only loopback. The one way out is a proxy the bot runs: it opens HTTPS tunnels only to the provider's own hosts (for Codex: `api.openai.com`, `auth.openai.com`, `chatgpt.com`), and never to an address on loopback, the LAN or the tailnet. So a light run cannot reach local services such as a dev server, a browser debug port or VNC. The boot log line reads `Sandbox view: <bwrap>, network through <socat>`. Without `socat`, or when the bot's env sets `HTTPS_PROXY` or `HTTP_PROXY` (the view's proxy dials directly and would skip it), it reads `host network` and a warning says why: views then share the host's network, so ports on `127.0.0.1` and abstract unix sockets stay reachable, and only Codex's own sandbox keeps the model's shell offline. Refused connections are logged as `Sandbox network refused`, once per host and port per run, at most 32 per run.

## Forum supergroup (optional, recommended)

Threads let the owner hold several conversations at once, each with its own session, queue and draft, running in parallel.

1. Create a supergroup, open its settings and turn **Topics** on.
2. Add the bot and make it an **administrator** with permission to manage topics (an admin sees every message regardless of privacy mode).
3. Create normal conversation topics yourself — one per subject. The bot routes whatever topic it sees; when a reminder becomes due, it creates that reminder's own topic automatically.
4. **Send `/setworkspace` in the group.** Only the owner may, and only that command records the group as the workspace, in the `workspace_chat_id` row of the `settings` table. Send it from the topic the bot should write to on its own (startup notices, task results) — that topic goes to `workspace_thread_id`; from the General topic it writes to General. Until then, those messages go to the owner's private chat. `/settings` shows the workspace and has a button that forgets it; unprompted messages then go to the private chat again.

Check it landed:

```bash
sqlite3 .data/bot.db "select key, value from settings"
```

To pin it by hand instead (the chat id of a supergroup is negative, e.g. `-1001234567890`):

```bash
sqlite3 .data/bot.db \
  "insert into settings (key, value, updated_at) values ('workspace_chat_id', '-1001234567890', unixepoch()*1000)
   on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at"
```

The workspace forum keeps the owner's filesystem and session capabilities, but receives no account apps, plugins or inherited MCP servers. Every other group is treated as a lightweight group (see below). The General topic and a private chat each stay a single conversation.
