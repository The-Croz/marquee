#!/bin/sh
# Runs Marquee as PUID:PGID (Unraid's default is 99:100, "nobody:users").
# Starting as root lets us make sure /config is writable first; we then drop
# privileges for good. Media under /data is never chowned.
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
CONFIG="${MARQUEE_DATA_DIR:-/config}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$CONFIG"
  # Only fix ownership when it's wrong, so restarts stay fast.
  if [ "$(stat -c '%u:%g' "$CONFIG")" != "$PUID:$PGID" ]; then
    echo "[marquee] setting owner of $CONFIG to $PUID:$PGID"
    chown -R "$PUID:$PGID" "$CONFIG"
  fi
  umask "${UMASK:-022}"
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups --inh-caps=-all -- "$@"
fi

# Already running as a non-root user (e.g. docker run --user): just start.
exec "$@"
