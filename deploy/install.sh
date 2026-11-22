#!/bin/sh
# Install the systemd user units from this directory.
#
# The units in deploy/ are templates: a few values differ on every machine (the
# clone's path twice, and where bun lives). This script fills them in from the
# clone it is run out of, copies the result to ~/.config/systemd/user, enables
# lingering so the bot survives logout and reboots, and starts it. It replaces
# the copy-and-edit steps in the README, not the units themselves — they stay
# readable and editable by hand.
#
# Run it as the account that owns the clone. Not as root: these are user units,
# and root's systemd instance is not the one that should hold the bot.
#
# Usage: deploy/install.sh [options]
#
#   --dry-run        print the rendered units, write nothing, touch no service
#   --with-backup    also install bot-backup.service and bot-backup.timer
#   --no-start       install and enable, but do not start or restart the bot
#
# BUN_BIN overrides the bun lookup.
#
# Re-running is safe: an existing unit that differs from the rendered one is
# copied aside first, so a hand-edited copy is never silently lost.

set -eu

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

DRY_RUN=0
WITH_BACKUP=0
START=1

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --with-backup) WITH_BACKUP=1 ;;
    --no-start) START=0 ;;
    -h|--help) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

die() { echo "install.sh: $*" >&2; exit 1; }

# Escape a value for the right-hand side of a sed s|...|...| substitution.
esc() { printf '%s' "$1" | sed 's/[&|\\]/\\&/g'; }

# Root would install into root's own systemd instance and run the bot as root,
# which is neither what the units say nor where `codex login` put its account.
[ "$(id -u)" -ne 0 ] || die "do not run as root — run as the account that owns the clone"
command -v systemctl >/dev/null 2>&1 || die "no systemctl — this machine does not use systemd"
command -v loginctl >/dev/null 2>&1 || die "no loginctl — this machine does not use systemd-logind"
[ -f "$ROOT/apps/telegram/src/index.ts" ] || die "$ROOT does not look like the bot repo"

# --- the values --------------------------------------------------------------

SERVICE_USER="$(id -un)"
OWNER="$(stat -c '%U' "$ROOT")"
[ "$OWNER" = "$SERVICE_USER" ] || die "the clone belongs to $OWNER, not $SERVICE_USER — run this as $OWNER"

find_bun() {
  if [ -n "${BUN_BIN:-}" ]; then
    printf '%s\n' "$BUN_BIN"
    return
  fi
  # Prefer the persistent user install. Codex may put an ephemeral bun shim in
  # /tmp at the front of PATH; installing that path into systemd breaks on the
  # next reboot and also leaves bunx unavailable to child runs.
  for candidate in "$HOME/.bun/bin/bun" "$(command -v bun 2>/dev/null || true)" /usr/local/bin/bun; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
}

BUN="$(find_bun)"
[ -n "$BUN" ] || die "cannot find bun — install it or pass BUN_BIN=/path/to/bun"
[ -x "$BUN" ] || die "not executable: $BUN"
BUN_DIR="$(dirname "$BUN")"
[ -x "$BUN_DIR/bunx" ] || die "cannot find executable bunx beside $BUN"

# EnvironmentFile is not optional in the unit: systemd refuses to start the
# service if the file is missing, so catch it here where the message is useful.
[ -f "$ROOT/.env" ] || die "no $ROOT/.env — cp .env.example .env and fill it in first"

# Not fatal: without bubblewrap the bot still runs, but light runs get no
# sandbox view and Claude refuses members (docs/access.md, Sandbox view).
BWRAP="$(command -v bwrap 2>/dev/null || true)"
# Not fatal either: without socat the view shares the host network and
# Claude refuses members.
SOCAT="$(command -v socat 2>/dev/null || true)"

echo "clone:   $ROOT"
echo "user:    $SERVICE_USER"
echo "bun:     $BUN"
echo "bwrap:   ${BWRAP:-not found — sudo apt install bubblewrap, or light runs get no sandbox view; Claude refuses members}"
echo "socat:   ${SOCAT:-not found — sudo apt install socat, or sandbox views share the host network; Claude refuses members}"
echo "units:   $UNIT_DIR"
echo

# --- rendering ---------------------------------------------------------------

render_bot() {
  sed \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=$(esc "$ROOT")|" \
    -e "s|^EnvironmentFile=.*|EnvironmentFile=$(esc "$ROOT")/.env|" \
    -e "s|^Environment=PATH=.*|Environment=PATH=$(esc "$BUN_DIR"):$(esc "$HOME")/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin|" \
    -e "s|^ExecStartPre=.*|ExecStartPre=$(esc "$BUN") install --frozen-lockfile|" \
    -e "s|^ExecStart=.*|ExecStart=$(esc "$BUN") run apps/telegram/src/index.ts|" \
    "$ROOT/deploy/bot.service"
}

render_backup() {
  sed \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=$(esc "$ROOT")|" \
    -e "s|^ExecStart=.*|ExecStart=$(esc "$ROOT")/deploy/backup-bot-db.sh|" \
    "$ROOT/deploy/bot-backup.service"
}

# Write $2 to $1, keeping a dated copy of anything different that was there.
place() {
  target="$1"
  source="$2"
  if [ -f "$target" ] && ! cmp -s "$source" "$target"; then
    backup="$target.$(date -u +%Y%m%d%H%M%S).bak"
    cp -p "$target" "$backup"
    echo "  kept the previous $target as $backup"
  fi
  install -m 0644 "$source" "$target"
  echo "  wrote $target"
}

if [ "$DRY_RUN" -eq 1 ]; then
  echo "=== $UNIT_DIR/bot.service ==="
  render_bot
  if [ "$WITH_BACKUP" -eq 1 ]; then
    echo
    echo "=== $UNIT_DIR/bot-backup.service ==="
    render_backup
    echo
    echo "=== $UNIT_DIR/bot-backup.timer ==="
    cat "$ROOT/deploy/bot-backup.timer"
  fi
  echo
  echo "dry run — nothing was written"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$UNIT_DIR"

render_bot > "$TMP/bot.service"
place "$UNIT_DIR/bot.service" "$TMP/bot.service"

if [ "$WITH_BACKUP" -eq 1 ]; then
  command -v sqlite3 >/dev/null 2>&1 || echo "  warning: sqlite3 is not installed, the backup will fail until it is"
  render_backup > "$TMP/bot-backup.service"
  place "$UNIT_DIR/bot-backup.service" "$TMP/bot-backup.service"
  place "$UNIT_DIR/bot-backup.timer" "$ROOT/deploy/bot-backup.timer"
fi

# Without linger the user manager is torn down when the last session ends and
# never comes up at boot: the bot would live exactly as long as an ssh session.
# polkit's set-self-linger is open to an account for itself, so this needs no
# privileges — but a hardened box can still refuse, hence the fallback message.
if [ "$(loginctl show-user "$SERVICE_USER" --property=Linger --value 2>/dev/null || echo no)" = "yes" ]; then
  echo "  linger already enabled"
elif loginctl enable-linger "$SERVICE_USER" 2>/dev/null; then
  echo "  enabled linger for $SERVICE_USER"
else
  echo "  warning: could not enable linger — the bot will stop when you log out"
  echo "           and will not start at boot. Ask an admin to run:"
  echo "             sudo loginctl enable-linger $SERVICE_USER"
fi

systemctl --user daemon-reload

systemctl --user enable bot >/dev/null
echo "  enabled bot"

if [ "$WITH_BACKUP" -eq 1 ]; then
  systemctl --user enable --now bot-backup.timer >/dev/null
  echo "  enabled bot-backup.timer"
fi

if [ "$START" -eq 1 ]; then
  # restart, not start: this is also the upgrade path, and restart starts a unit
  # that is not running.
  systemctl --user restart bot
  echo "  started bot"
fi

echo
echo "done. next:"
echo "  systemctl --user status bot"
echo "  journalctl --user -u bot -f"
