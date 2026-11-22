# Operations

## What you are deploying

One long-running Bun process. It polls Telegram (no webhook, no public port; the optional [HTTP API](http-api.md) listens on loopback only), spawns an agent child process (`codex`, `claude` or `pi`) per run, and keeps everything it remembers in a `.data/` directory next to the code:

| File | Holds |
| --- | --- |
| `.data/bot.db` | SQLite: compose drafts, settings, agent sessions (per provider, per forum topic and outside one), the `/history` list (with topic names and task runs), users, HTTP API keys (hashed) and the agent runs they started, group presence and memory, daily quota, recurring tasks, reminders |
| `.data/sessions.json` | only on an install older than the `sessions` table: Codex session ids outside a forum topic, copied into `bot.db` at the first boot on a newer build and left untouched so a rollback still finds them |
| `.data/state.json` | the active project |
| `.data/events.jsonl` | one JSON line per run, per access change, per API key made or revoked and API write, per judgment and per agent turn start and end |
| `.data/runs.json` | the agent turns running right now, rewritten on every start and end and emptied on a clean stop; transient, never backed up |
| `.data/scratch/<user id>` | sandbox directory for every private run that is not the owner's |
| `.data/groups/<chat id>` | a group's directory: its runs work there read-only, and the files its members send to an answered message land there, kept 7 days |
| `.data/relay/` | private sockets for sandboxed runs: the group memory relay and the network proxy, each removed when its run ends; transient, never backed up |
| `.data/claude-models.json` | the models Claude Code offers this account, read from the CLI at boot, once a day and when `/model` opens, so a restart has a list before the CLI answers; rebuilt on its own, never worth restoring |
| `.data/backups/` | nightly `bot.db` snapshots, if you install the timer |

`.data/` is git-ignored. It is the only thing worth backing up; everything else is a `git clone` away.

The code is a Turborepo workspace. `apps/telegram` is the bot itself, `packages/agent` drives Codex, Claude Code and pi, `packages/db` owns the SQLite file, `packages/env` parses configuration, `packages/core` has the logger, `packages/api` is the HTTP API's contract (the server runs inside the bot). `apps/web` and `packages/ui` are an unused Next.js template kept for a future dashboard — they are never started by the bot and do not need configuring. `AGENTS.md` and `.docs/architecture/` describe the layout.

## The service unit

These are systemd **user** units. The bot runs as the account that installs it, out of `~/.config/systemd/user`, so nothing here needs root and there is no privileged rule to grant. `deploy/install.sh` fills in the values that differ on every machine — `WorkingDirectory` and `EnvironmentFile` (this clone's real path) and the `bun` path in `ExecStartPre` and `ExecStart`, and `PATH` (that `bun`'s directory, then `~/.local/bin`, then the system directories) — then reloads the user manager, enables lingering, and starts the bot. `--with-backup` adds the nightly snapshot below; it is not on by default.

Useful flags: `--dry-run` prints the rendered units and writes nothing, `--no-start` installs without starting, and `BUN_BIN=/path/to/bun` overrides the bun lookup. Re-running it is the upgrade path — an installed unit that differs from the rendered one is copied to a `.bak` first, so a hand-edited copy is never lost.

**Lingering is the part that is easy to miss.** Without it the user manager is torn down when your last session ends and never comes back at boot, so the bot would live exactly as long as an ssh session. `install.sh` runs `loginctl enable-linger` for you, and polkit lets an account set its own linger, so this normally needs no privileges. If the box refuses, the script says so and an admin has to run `sudo loginctl enable-linger <user>` once.

`ExecStartPre` runs `bun install --frozen-lockfile` before every start, so a pulled or self-made change that touched dependencies boots on them; a `bun.lock` that does not match `package.json` stops the start there. `Restart=on-failure` brings the bot back after a crash, and `StartLimitBurst=3` stops it after three failed starts in two minutes, so a broken deploy is visible rather than hidden behind a restart loop. `SIGTERM` is the graceful path: polling stops, then accepted runs, their in-memory queues and every agent turn the bot started (runs, compactions, task formatting, address-judge and topic-title turns) get up to 30 minutes to finish, then the runtime is disposed and the process exits 0. A second signal does not cut the drain short. Polling that stops on its own, with no signal, drains the same way and exits 1, so `Restart=on-failure` brings the bot back. While it waits, the journal says once a minute which turns are still running; `.data/runs.json` shows the same list. Codex started from a terminal is not the bot's and is not waited for. A conversation or a `prompt` task's fire that answered and is only waiting for background work (below) is stopped as the drain starts, and its row in `background_runs` is kept: after boot the bot resumes it, relaunching its workflows from their journals and re-arming its wake-up on its own timer (see Usage). A crash leaves the same rows, so a crash resumes them too, at most three times in a row. `TimeoutStopSec=32min` in the unit must stay above that 30-minute drain, and `KillMode=mixed` must stay set: with the default `control-group`, systemd sends `SIGTERM` to every `codex app-server` and `codex exec` child at the same moment as the bot, and the turns the drain means to wait for die at once. The installed unit is a copy, so after changing the template update `~/.config/systemd/user/bot.service` (or re-run `deploy/install.sh`), run `systemctl --user daemon-reload`, and check `systemctl --user show -p KillMode bot` prints `KillMode=mixed` before relying on a graceful restart. Telegram retains updates that arrive while the service is stopping.

The bot can update itself — the owner can ask it to change its own code, and `.agents/skills/self-update/SKILL.md` tells it to run the checks, commit, `git push` to the clone's tracking branch, and only then schedule a detached `systemd-run --user --on-active=5s systemctl --user restart bot`. Because the bot owns its own unit, that restart needs no sudo rule at all. The push keeps the VPS from being the only copy of a change and is what makes the rollback (`git fetch && git reset --hard @{u}`) return something useful, so the deploy user needs an SSH key with push access to the branch the clone tracks. The skill also keeps the run out of the paths shared with upstream (migrations it did not write, `access/*`, `deploy/*`, `packages/env`) and prefers the workspace `AGENTS.md` or a setting over a code change. When the instance runs from a fork, "обновись" points the run at `.agents/skills/upstream-sync/SKILL.md`, which merges `upstream/main`, runs the same checks, pushes and restarts; add that remote once by hand (`git remote add upstream <shared repo URL>`), the run never adds it.

## Nightly database backup

`deploy/install.sh --with-backup` installs this for you. By hand:

```bash
cp deploy/bot-backup.service deploy/bot-backup.timer ~/.config/systemd/user/
nano ~/.config/systemd/user/bot-backup.service   # WorkingDirectory, ExecStart
systemctl --user daemon-reload
systemctl --user enable --now bot-backup.timer
systemctl --user list-timers bot-backup
```

`deploy/backup-bot-db.sh` takes a consistent snapshot with `sqlite3 .backup`, gzips it to `.data/backups/bot-YYYYMMDD.db.gz`, and deletes snapshots older than 14 days (`BACKUP_KEEP_DAYS` changes that). Run it by hand any time with `systemctl --user start bot-backup`, or by calling the script directly.

The cron equivalent, if you prefer:

```
20 3 * * * /home/bot/workspace/owner-telegram-bot/deploy/backup-bot-db.sh
```

To restore: stop the bot, `gunzip` a snapshot over `.data/bot.db`, delete the stale `bot.db-wal` and `bot.db-shm` beside it, start the bot. The ledger is a separate file and is not in the snapshot.

When the Telegram account is logged in, the same run also snapshots `.data/telegram-account.db` to `telegram-account-YYYYMMDD.db.gz`, mode 600. That file is a live login to the owner's account: keep backups as private as `.env`. Restore it the same way, with the bot stopped.

## Operating it

```bash
systemctl --user status bot    # is it up
journalctl --user -u bot -f    # live logs
journalctl --user -u bot -S -1h  # the last hour
systemctl --user restart bot   # after an .env change
```

An `.env` change needs a restart — it is read once at boot. With `API_ENABLED=true` and `API_PORT` busy, the bot runs without the HTTP API and tells the owner so in a private message; free the port or change it, then restart. A run that fails tells the user one plain sentence; the exit code, stderr and provider message go to the log only, so `journalctl` is where you look when someone says it did not work.

`.data/events.jsonl` is one JSON object per run: who, where, which model and effort it actually started with, how long, how much. Access changes and judgments land there too, tagged `telegram.user` and `telegram.judge`; a judgment line carries the question, the probability and the decision, which is how a threshold gets re-tuned on real traffic. A `model_route` judgment carries all seven scores and the tier and effort they produced, for the same reason; with routing off it says `via: "default"` and carries only the effort. Point `OTEL_EXPORTER_OTLP_ENDPOINT` at a backend to get the same events there as well, plus a trace per run (`Run.prompt`), per task fire (`Task.fire`), per reminder pass and per cleanup pass.
