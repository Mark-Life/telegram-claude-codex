# Operations

## What you are deploying

One long-running Bun process. It polls Telegram: no webhook, no public port. The optional [HTTP API](http-api.md) listens on loopback only. It spawns one agent child process (`codex`, `claude` or `pi`) per run. It keeps its state in `.data/` next to the code.

| File | Holds |
| --- | --- |
| `.data/bot.db` | SQLite: drafts, settings, agent sessions (per provider and forum topic), `/history` (with topic names and task runs), users, HTTP API keys (hashed) and their runs, group presence and memory, daily quota, recurring tasks, reminders |
| `.data/sessions.json` | Old installs only: Codex session ids, copied into `bot.db` at first boot on a newer build, then left so a rollback still finds them |
| `.data/state.json` | The active project |
| `.data/events.jsonl` | One JSON line per run, access change, API key change, API write, judgment, and agent turn start and end |
| `.data/runs.json` | Agent turns running now. Rewritten on every start and end, emptied on a clean stop. Never backed up |
| `.data/scratch/<user id>` | Sandbox directory for every private run that is not the owner's |
| `.data/groups/<chat id>` | A group's directory. Its runs work there read-only. Member files land there, kept 7 days |
| `.data/relay/` | Private sockets for sandboxed runs: group memory relay and network proxy. Removed when the run ends. Never backed up |
| `.data/claude-models.json` | Models Claude Code offers this account. Read from the CLI at boot, daily and when `/model` opens. Rebuilt on its own, never worth restoring |
| `.data/backups/` | Nightly `bot.db` snapshots, if you install the timer |

`.data/` is git-ignored. It is the only thing worth backing up. Everything else is a `git clone` away.

The code is a Turborepo workspace:

- `apps/telegram`: the bot.
- `packages/agent`: drives Codex, Claude Code and pi.
- `packages/db`: the SQLite file.
- `packages/env`: config.
- `packages/core`: the logger.
- `packages/api`: the HTTP API contract. Its server runs inside the bot.
- `apps/web`, `packages/ui`: an unused Next.js template. The bot never starts them, and they need no config.

`AGENTS.md` describes the layout.

## The service unit

These are systemd **user** units. The bot runs as the account that installs it, from `~/.config/systemd/user`. No root, no privileged rule.

`deploy/install.sh` fills in the per-machine values, reloads the user manager, enables lingering and starts the bot. The values are `WorkingDirectory` and `EnvironmentFile` (this clone's path), the `bun` path in `ExecStartPre` and `ExecStart`, and `PATH` (that `bun`'s directory, `~/.local/bin`, then system directories).

| Flag                   | Does                                       |
| ---------------------- | ------------------------------------------ |
| `--with-backup`        | Adds the nightly snapshot (off by default) |
| `--dry-run`            | Prints the rendered units, writes nothing  |
| `--no-start`           | Installs without starting                  |
| `BUN_BIN=/path/to/bun` | Overrides the bun lookup                   |

Re-run it to upgrade. A changed installed unit is copied to `.bak` first, so a hand-edited copy is kept.

**Lingering.** Without it, the user manager stops when your last session ends and does not return at boot. The bot would live only as long as an ssh session. `install.sh` runs `loginctl enable-linger`, and polkit normally allows it. If the box refuses, an admin runs `sudo loginctl enable-linger <user>` once.

### Start and stop behaviour

- `ExecStartPre` runs `bun install --frozen-lockfile` before every start. A `bun.lock` that does not match `package.json` stops the start.
- `Restart=on-failure` restarts after a crash. `StartLimitBurst=3` stops it after three failed starts in two minutes, so a broken deploy stays visible.
- Telegram keeps updates that arrive while the service is stopping.

**Graceful stop.** `SIGTERM` stops polling. Accepted runs, their queues and every agent turn the bot started (runs, compactions, task formatting, address-judge and topic-title turns) get up to 30 minutes to finish. Then the process exits 0.

- A second signal does not cut the drain short.
- Polling that stops on its own drains the same way and exits 1, so `Restart=on-failure` restarts it.
- The journal says once a minute which turns are still running. `.data/runs.json` shows the same list.
- A Codex started from a terminal is not the bot's and is not waited for.

**Background work.** A conversation or `prompt` task that answered and only waits for background work is stopped when the drain starts. Its `background_runs` row is kept. After boot, the bot resumes it: workflows relaunch from their journals and the wake-up timer re-arms (see Usage). A crash resumes them too, at most three times in a row.

**Keep these unit settings.**

| Setting | Why |
| --- | --- |
| `TimeoutStopSec=32min` | Must stay above the 30-minute drain |
| `KillMode=mixed` | With the default `control-group`, systemd sends `SIGTERM` to every `codex app-server` and `codex exec` child with the bot, and turns the drain waits for die at once |

The installed unit is a copy. After you change the template, update `~/.config/systemd/user/bot.service` (or re-run `deploy/install.sh`) and run `systemctl --user daemon-reload`. Before you rely on a graceful restart, check that `systemctl --user show -p KillMode bot` prints `KillMode=mixed`.

### Self-update

The owner can ask the bot to change its own code. `.agents/skills/self-update/SKILL.md` tells it to run the checks, commit, `git push` to the clone's tracking branch, then schedule a detached `systemd-run --user --on-active=5s systemctl --user restart bot`. The restart needs no sudo rule.

- The push keeps the VPS from being the only copy. It also makes the rollback useful: `git fetch && git reset --hard @{u}`.
- So the deploy user needs an SSH key with push access to the tracked branch.
- The skill avoids paths shared with upstream: migrations it did not write, `access/*`, `deploy/*`, `packages/env`.
- It prefers the workspace `AGENTS.md` or a setting over a code change.

On a fork, "обновись" or "update from upstream" points the run at `.agents/skills/upstream-sync/SKILL.md`. It merges `upstream/main`, runs the checks, pushes and restarts. Add the remote once by hand: `git remote add upstream <shared repo URL>`. The run never adds it.

## Nightly database backup

`deploy/install.sh --with-backup` installs this for you. By hand:

```bash
cp deploy/bot-backup.service deploy/bot-backup.timer ~/.config/systemd/user/
nano ~/.config/systemd/user/bot-backup.service   # WorkingDirectory, ExecStart
systemctl --user daemon-reload
systemctl --user enable --now bot-backup.timer
systemctl --user list-timers bot-backup
```

`deploy/backup-bot-db.sh` takes a consistent snapshot with `sqlite3 .backup` and gzips it to `.data/backups/bot-YYYYMMDD.db.gz`. It deletes snapshots older than 14 days (change with `BACKUP_KEEP_DAYS`). Run it any time with `systemctl --user start bot-backup`, or call the script.

Cron equivalent:

```
20 3 * * * /home/bot/workspace/owner-telegram-bot/deploy/backup-bot-db.sh
```

**Restore.** Stop the bot. `gunzip` a snapshot over `.data/bot.db`. Delete the stale `bot.db-wal` and `bot.db-shm` beside it. Start the bot. The ledger is a separate file and is not in the snapshot.

**Telegram account.** When the account is logged in, the same run also snapshots `.data/telegram-account.db` to `telegram-account-YYYYMMDD.db.gz`, mode 600. That file is a live login to the owner's account. Keep backups as private as `.env`. Restore it the same way, with the bot stopped.

## Operating it

```bash
systemctl --user status bot    # is it up
journalctl --user -u bot -f    # live logs
journalctl --user -u bot -S -1h  # the last hour
systemctl --user restart bot   # after an .env change
```

- An `.env` change needs a restart. It is read once at boot.
- With `API_ENABLED=true` and `API_PORT` busy, the bot runs without the HTTP API and tells the owner in a private message. Free the port or change it, then restart.
- A failed run tells the user one plain sentence. The exit code, stderr and provider message go only to the log. Check `journalctl` when someone says it did not work.

### Events log

`.data/events.jsonl` has one JSON object per run: who, where, the model and effort it started with, how long, how much.

- Access changes and judgments are tagged `telegram.user` and `telegram.judge`.
- A judgment line carries the question, the probability and the decision. Use it to re-tune a threshold on real traffic.
- A `model_route` judgment carries all seven scores and the tier and effort they produced. With routing off it says `via: "default"` and carries only the effort.

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to send the same events to a backend. You also get a trace per run (`Run.prompt`), per task fire (`Task.fire`), per reminder pass and per cleanup pass.
