#!/bin/sh
# Nightly snapshot of the bot database, and of the Telegram account session
# when the account feature is on.
#
# The db runs in WAL mode, so copying bot.db on its own can miss committed
# writes that are still in the -wal file. `sqlite3 .backup` takes a consistent
# copy of a live database instead, which is why sqlite3 is a prerequisite.
#
# Usage: backup-bot-db.sh [repo-root]
# Defaults to the directory this script lives in, one level up.

set -eu

ROOT="${1:-$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)}"
DB="$ROOT/.data/bot.db"
DEST="$ROOT/.data/backups"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

if [ ! -f "$DB" ]; then
  echo "no database at $DB" >&2
  exit 0
fi

mkdir -p "$DEST"
SNAPSHOT="$DEST/bot-$(date -u +%Y%m%d).db"

sqlite3 "$DB" ".backup '$SNAPSHOT'"
gzip -f "$SNAPSHOT"
echo "backed up to $SNAPSHOT.gz"

# mtcute keeps the account session in its own WAL database; same rule.
ACCOUNT_DB="$ROOT/.data/telegram-account.db"
if [ -f "$ACCOUNT_DB" ]; then
  ACCOUNT_SNAPSHOT="$DEST/telegram-account-$(date -u +%Y%m%d).db"
  sqlite3 "$ACCOUNT_DB" ".backup '$ACCOUNT_SNAPSHOT'"
  chmod 600 "$ACCOUNT_SNAPSHOT"
  gzip -f "$ACCOUNT_SNAPSHOT"
  echo "backed up to $ACCOUNT_SNAPSHOT.gz"
fi

find "$DEST" -name 'bot-*.db.gz' -mtime "+$KEEP_DAYS" -delete
find "$DEST" -name 'telegram-account-*.db.gz' -mtime "+$KEEP_DAYS" -delete
