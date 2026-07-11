#!/usr/bin/env bash
# Wide-event log viewer. Modes: runs | errors | stats | follow.
# Source file overridable via TG_LOG_FILE (default .data/events.jsonl).
set -euo pipefail

SRC="${TG_LOG_FILE:-.data/events.jsonl}"

# follow reads the file directly (poll-tail) and ignores stdin.
if [ "${1:-}" = "follow" ]; then
  exec bun scripts/logs-format.ts "$@"
fi

cat "$SRC" | bun scripts/logs-format.ts "$@"
