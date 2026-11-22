#!/bin/sh
# Runs first inside a bwrap view that has its own network namespace. Starts
# socat on the view's loopback, forwarding to the bot's proxy socket, waits
# until it listens, then becomes the CLI. Arguments: socat, port, socket, the
# CLI and its arguments.
set -eu
socat=$1
port=$2
socket=$3
shift 3
"$socat" TCP-LISTEN:"$port",bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:"$socket" &
# Port in /proc/net/tcp is upper-case hex; state 0A is LISTEN.
hex=$(printf '%04X' "$port")
tries=0
until grep -q ":$hex 00000000:0000 0A" /proc/net/tcp; do
  tries=$((tries + 1))
  if [ "$tries" -gt 100 ]; then
    echo "net.sh: socat did not listen on $port" >&2
    exit 1
  fi
  sleep 0.02
done
exec "$@"
