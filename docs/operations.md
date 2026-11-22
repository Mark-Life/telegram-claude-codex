# Operations

## What you are deploying

One long-running Bun process. It polls Telegram, so it needs no webhook or public port. The optional [HTTP API](http-api.md) listens on loopback only.

All state lives in `.data/` next to the code. It is git-ignored and is the only thing worth backing up.

| File | Holds |
| --- | --- |
| `.data/bot.db` | SQLite: settings, sessions, history, users, API keys, tasks, reminders |
| `.data/events.jsonl` | One JSON line per run, access change and API key change |
| `.data/runs.json` | Agent turns running now |
| `.data/scratch/<user id>` | Work directory for private runs that are not the owner's |
| `.data/groups/<chat id>` | A group's files, kept 7 days |
| `.data/backups/` | Nightly `bot.db` snapshots, if you install the timer |

`AGENTS.md` describes the code layout.

## The service unit

The bot runs as systemd **user** units, from `~/.config/systemd/user`, so it needs no root. `deploy/install.sh` fills in the paths, enables lingering and starts the bot.

| Flag                   | Does                                       |
| ---------------------- | ------------------------------------------ |
| `--with-backup`        | Adds the nightly snapshot (off by default) |
| `--dry-run`            | Prints the rendered units, writes nothing  |
| `--no-start`           | Installs without starting                  |
| `BUN_BIN=/path/to/bun` | Overrides the bun lookup                   |

Re-run it to upgrade. It saves a changed installed unit to `.bak` first.

**Lingering.** Without it, the bot stops when your last ssh session ends. If `install.sh` cannot enable it, an admin runs `sudo loginctl enable-linger <user>` once.

### Start and stop behaviour

Every start runs `bun install --frozen-lockfile`, so a `bun.lock` that does not match `package.json` stops the start. After three failed starts in two minutes, systemd stops trying.

On stop, the bot lets running turns finish for up to 30 minutes. The journal lists the turns still running once a minute. Background work stops and resumes after the next boot.

**Keep these unit settings.**

| Setting | Why |
| --- | --- |
| `TimeoutStopSec=32min` | Must stay above the 30-minute drain |
| `KillMode=mixed` | With the default `control-group`, systemd kills running Codex turns at once on stop |

After you change the unit template, re-run `deploy/install.sh`, or update `~/.config/systemd/user/bot.service` and run `systemctl --user daemon-reload`. Check that `systemctl --user show -p KillMode bot` prints `KillMode=mixed`.

### Self-update

The owner can ask the bot to change its own code. It runs the checks, commits, pushes to the clone's tracking branch, then restarts itself. The deploy user needs an SSH key with push access to that branch. To roll back, run `git fetch && git reset --hard @{u}`.

On a fork, "update from upstream" merges `upstream/main`, runs the checks, pushes and restarts. Add the remote once by hand: `git remote add upstream <shared repo URL>`.

## Nightly database backup

`deploy/install.sh --with-backup` installs this for you. By hand:

```bash
cp deploy/bot-backup.service deploy/bot-backup.timer ~/.config/systemd/user/
nano ~/.config/systemd/user/bot-backup.service   # WorkingDirectory, ExecStart
systemctl --user daemon-reload
systemctl --user enable --now bot-backup.timer
systemctl --user list-timers bot-backup
```

`deploy/backup-bot-db.sh` writes `.data/backups/bot-YYYYMMDD.db.gz` and keeps 14 days (`BACKUP_KEEP_DAYS`). Run it any time with `systemctl --user start bot-backup`.

Cron equivalent:

```
20 3 * * * /home/bot/workspace/owner-telegram-bot/deploy/backup-bot-db.sh
```

**Restore.** Stop the bot. `gunzip` a snapshot over `.data/bot.db`, and delete `bot.db-wal` and `bot.db-shm` beside it. Start the bot.

**Telegram account.** When the account is logged in, the backup also saves `.data/telegram-account.db`. That file is a live login to the owner's account, so keep backups as private as `.env`. Restore it the same way, with the bot stopped.

## Operating it

```bash
systemctl --user status bot    # is it up
journalctl --user -u bot -f    # live logs
journalctl --user -u bot -S -1h  # the last hour
systemctl --user restart bot   # after an .env change
```

- An `.env` change needs a restart.
- If `API_PORT` is busy, the bot runs without the HTTP API and messages the owner. Free or change the port, then restart.
- A failed run shows the user one plain sentence. The details go to `journalctl`.

### Events log

`.data/events.jsonl` has one JSON object per run: who, where, which model, how long, how much. Judgment lines carry the question, the probability and the decision.

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to send the same events and a trace per run to a backend.
