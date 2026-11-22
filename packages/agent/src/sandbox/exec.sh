#!/bin/sh
# Starts an agent CLI inside the bwrap view the bot built for one run. What
# spawns this file (an SDK, or a Codex run's app-server launch) takes a single
# executable path, so the view travels in BOT_SANDBOX_ARGV: bwrap, its flags
# and the real CLI, one per line. The CLI's own arguments arrive as "$@". The
# variable is dropped before bwrap starts, so nothing inside the view sees it.
set -eu
spec=${BOT_SANDBOX_ARGV:?BOT_SANDBOX_ARGV is not set}
unset BOT_SANDBOX_ARGV
set -f
IFS='
'
# shellcheck disable=SC2086 # split on newlines on purpose
set -- $spec "$@"
exec "$@"
