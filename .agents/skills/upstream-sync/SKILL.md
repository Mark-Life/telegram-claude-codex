---
name: upstream-sync
description: Use when the owner asks the bot to take the shared version's updates — "обновись", "update from upstream", "pull updates" — or to check the last one — "проверь обновление". Covers merging `upstream/main` into this fork, the conflict policy, the migration and lockfile fix-ups, the upgrade guides, the checks, and the detached restart.
---

# Merging upstream into the bot you are running inside

This bot is a fork. The shared version lives on the `upstream` remote; your own
branch is `@{u}`, the branch `git push` sends to. Run this only when the owner
asks for it. The order below is mandatory for the same reason as in self-update:
the service restarts from what is committed and pushed, and a bad merge that
restarts can leave the owner with a bot that does not come back.

Every command runs from the repo root at the path your prompt names. Read
`AGENTS.md` there first.

## Before you start

All three must hold. If one does not, change nothing, tell the owner in one
sentence what is wrong, and stop.

```bash
git status --porcelain          # must print nothing
git fetch
git log @{u}..HEAD --oneline    # must print nothing: no unpushed commits
git remote get-url upstream     # must succeed
```

A missing `upstream` remote is set up by the admin, not by you. Do not add it.

## The loop

1. Fetch and look at what is coming:

   ```bash
   git fetch upstream
   git log --oneline HEAD..upstream/main
   git rev-parse HEAD              # the pre-merge commit: keep it for rollback
   ```

   An empty `git log` means there is nothing to merge. Say so in one sentence and
   stop: no commit, no restart.
2. Merge. **Never rebase**: your branch is pushed and a rebase rewrites it.

   ```bash
   git merge --no-edit upstream/main
   ```

   On a conflict:
   - Keep the fork's side of every conflict in code the fork changed on purpose.
     Read both sides; keep upstream's new lines when they do not clash with the
     fork's edit.
   - `bun.lock`: take upstream's version (`git checkout --theirs bun.lock`);
     step 5 rebuilds it.
   - A migration file this fork also has under the same name: keep upstream's
     and delete the fork's copy.
   - A conflict you cannot resolve with confidence: `git merge --abort`, report
     which files, and stop.
3. Clean `packages/db/src/migrations/local.ts`, on a clean merge too, not only
   after a conflict. Drop from it every migration whose name
   `packages/db/src/migrations/index.ts` now lists, with its import. That
   migration came back from upstream under the same name; it is already
   applied and does not run again. A name in both lists fails the boot.
   Never edit `index.ts` or a migration upstream sent.
4. Follow the upgrade guides this merge brings, in name order (`YYYYMMDD-NN-slug`: date, then sequence).
   Each is written for you, for a change that needs a step on the fork's side:

   ```bash
   git diff --name-only --diff-filter=A <commit before the merge> upstream/main -- .docs/upgrades
   ```

   Do each guide's before-restart part now, except a step it marks for right
   before the restart: that one runs after step 10, before step 11. Its
   conflict rules for the files it names override step 2. A guide that says stop stops the whole sync. Its
   after-restart part runs on the owner's next message (see "Checking the last
   update").
5. Rebuild the lockfile, not frozen, so fork-only dependencies return to it:

   ```bash
   bun install
   ```

6. Commit the fix-ups, only if steps 2–5 changed anything:

   ```bash
   git add -A
   git commit --no-edit        # finishes a conflicted merge
   git commit -m "sync: fix up merge from upstream"   # after a clean merge
   ```

   Use the first form while the merge is still in progress, the second after
   a clean one.
7. Run what the service runs before it starts. It must pass:

   ```bash
   bun install --frozen-lockfile
   ```

8. Run the checks, all of them:
   - `bun run typecheck`
   - `bun test`
   - `bun x ultracite check`

   A red check means roll back (below), report, and do not restart. Do not fix
   upstream code to make a check pass.
9. Push:

   ```bash
   git push
   ```

   If the push fails, do not restart. Say so in one sentence and stop.
10. Snapshot the database. A new migration runs at the next boot, and a
    rollback resets the code, not the data:

    ```bash
    if systemctl --user cat bot-backup >/dev/null 2>&1; then
      systemctl --user start bot-backup
    else
      deploy/backup-bot-db.sh
    fi
    ```

    A failed snapshot means no restart: report and stop.
11. Tell the owner, in one sentence in their language, what changed and that you restart.
    Summarize the step 1 commit list in plain words, not hashes or file names
    ("пришли напоминания по часовому поясу и правка в задачах, перезапускаюсь").
    Read `.data/runs.json` and `systemctl --user show -p MainPID --value bot`
    the same way self-update does, and name other running work in the same
    sentence. When a step 4 guide has an after-restart part, end the sentence by
    asking the owner to write «проверь обновление» once the bot is back.
12. Schedule the restart detached, then finish the response:

    ```bash
    systemd-run --user --on-active=5s systemctl --user restart bot
    ```

    The bot posts "Я снова на связи." (English: "I am back online.") when it is
    back.

## Checking the last update

When the owner asks to check the update, run the after-restart part of every
guide the last upstream merge added, then report the result in one sentence
in the owner's language:

```bash
git diff --name-only --diff-filter=A "$(git log --merges -1 --format=%H)^1" HEAD -- .docs/upgrades
```

An empty list means the update needs no check beyond the bot being back.

## Rollback

Before step 9, the pushed state is untouched:

```bash
git merge --abort               # still merging
git reset --hard @{u}           # merge or fix-up commit already exists
```

After a restart that does not come back:

```bash
git reset --hard <commit before the merge>
git push --force-with-lease
systemd-run --user --on-active=5s systemctl --user restart bot
```

`<commit before the merge>` is the hash step 1 printed. Without it, take the
first parent of the merge commit (`git log --merges -1 --format=%P`, first
hash), never `HEAD^1`: after a fix-up commit, `HEAD^1` is the merge itself.
Report what was rolled back and why.

## Rules

- Only when the owner asks. Never merge upstream as a side effect of other work.
- Never rebase, never push to `upstream`, never edit `.env`.
- Never restart with a conflict open, a check red, uncommitted changes, or
  commits that have not reached `@{u}`.
- Never restart twice in one run.
- A migration upstream sent is never edited, only the fork's `local.ts` is.
