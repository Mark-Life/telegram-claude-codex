---
name: self-update
description: Use when the owner asks the bot to change its own behaviour — "update yourself", "fix the way you reply", "add a command", "rollback". Covers where the bot's code lives, which checks must pass, and how to restart the running process without killing your own run.
---

# Updating the bot you are running inside

You are editing the process that is streaming your output. A restart asks the
bot to stop polling and drain accepted work before it exits, but the order below
is still mandatory: an edit that restarts before it commits and pushes can leave
the owner with a bot that does not come back. The VPS is the only machine holding
your work until you push: a commit that never reached your upstream branch (`@{u}`,
the branch `git push` sends to) dies with the box.

## Where things are

The bot repo is the checkout at the path your prompt names (the user's own files
live at `$WORK_DIR` itself, beside it). Every command below runs from that repo
root. Read `AGENTS.md` there first, then the notes in `.docs/architecture/` for
each area you change: they hold the rules that are easy to break.

The parts a behaviour change usually touches:

- `apps/telegram/src/handlers/` — one module per command or feature. Chat copy
  lives in `apps/telegram/src/i18n/`: `ru/` holds every key, `en/` must match
  it, so a new string goes into both.
- `apps/telegram/src/telegram/` — how a reply is rendered and streamed.
- `apps/telegram/src/access/` — who may do what. Never widen this on request
  without the owner saying so in the same message.
- `packages/agent/` — how a run is scheduled and how the provider is driven.

## Before you write code

Prefer the cheapest place a change can live, in this order:

1. The user's workspace: a standing rule in `$WORK_DIR/AGENTS.md`, or a workflow
   in `$WORK_DIR/.agents/skills/<slug>/SKILL.md`. No restart, nothing to merge.
2. A setting the bot already reads.
3. Code in this repo, only when neither of the above can do it.

Some paths belong to the shared upstream of this bot, and an edit there collides
with every later update. Never touch them:

- a migration you did not write in this repo, and `packages/db/src/migrations/index.ts`
- `apps/telegram/src/access/*`
- `deploy/*`
- `packages/env`

If a change needs one of them, do not make it: tell the owner in one sentence
that it has to come from the shared version, and stop.

A schema change of your own is a new file
`packages/db/src/migrations/steps/<YYYYMMDD-slug>.ts` (today's date), listed in
`packages/db/src/migrations/local.ts`. Additive only: new tables or new
nullable columns, touching only upstream tables or the ones your feature adds,
because a rollback resets the code and keeps the database.

## The loop

1. Make the edit in the repo.
2. Run the checks from the repo root, all of them:
   - `bun run typecheck`
   - `bun test`
   - `bun x ultracite check`
   Fix what you broke. A red check means stop and report, not restart.
3. Commit. `git add` the paths you touched and commit with a short message.
   **The running service restarts from committed code — an uncommitted edit is
   an edit that disappears.**
4. Push, in the same run as the commit:

   ```bash
   git push
   ```

   `git push` sends to your upstream branch; never name a remote or branch.
   **This is not optional.** The VPS holds the only copy until the push lands,
   and the rollback below resets to your upstream branch. If the push fails, do not
   restart — say so in one sentence and stop.
5. Tell the owner you are restarting, in one sentence, before you schedule it.
   First read what the bot is still running, so that sentence can say it:

   ```bash
   cat .data/runs.json
   systemctl --user show -p MainPID --value bot
   ```

   `runs.json` lists every agent turn the bot started and has not finished
   (`kind`, `label`, `provider`, `runKey` as `user:chat:topic`, `startedAt`);
   your own run is one of them. Trust it only when its `pid` equals the
   `MainPID` printed above — any other pid is a file left by an earlier
   process. A missing or unreadable file means you do not know what is
   running, not that nothing is; say that instead. Name what else is running
   in the same sentence
   ("перезапущусь, когда закончатся ещё две задачи"); do not wait for it
   yourself, the restart already does.
6. Schedule the restart detached, so it outlives your own process:

   ```bash
   systemd-run --user --on-active=5s systemctl --user restart bot
   ```

   Then finish the current response. Do not wait for the restart: the bot stops
   accepting updates, lets this run and every other agent turn it started
   finish (up to 30 minutes), and exits afterwards. The bot posts "Я снова на
   связи." when it is back — that message is the confirmation.

## When it does not come back

`Restart=on-failure` with `StartLimitBurst=3` means a bot that crashes on boot
stops trying instead of looping. If the owner reports silence after a restart:

```bash
cd <the repo>
git fetch
git reset --hard @{u}
systemd-run --user --on-active=5s systemctl --user restart bot
```

That returns the last pushed state, which is why step 4 is not optional.
Report what was rolled back and why, then fix it properly on the next run.

## Rules

- Never restart with checks failing, with uncommitted changes, or with commits
  that have not reached your upstream branch.
- Never restart twice in one run — the first one already ended you.
- One change per restart. A restart that follows three unrelated edits cannot be
  rolled back to anything useful.
- `.env` is never read, printed or committed.
