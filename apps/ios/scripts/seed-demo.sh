#!/usr/bin/env bash
# Puts demo mode in a state the app has something to show: an admin, a scanned library,
# a member (mia) and a kid (kiddo) who have each asked for something.
# Usage: seed-demo.sh [http://localhost:9797]
set -euo pipefail
BASE="${1:-http://localhost:9797}"
JSON=(-H 'Content-Type: application/json')
ADMIN_JAR=$(mktemp)

post() { curl -fsS "${JSON[@]}" -X POST "$@"; }

post -c "$ADMIN_JAR" -d '{"username":"josh","password":"correct horse battery","displayName":"Josh"}' "$BASE/api/auth/setup" >/dev/null || \
  post -c "$ADMIN_JAR" -d '{"username":"josh","password":"correct horse battery"}' "$BASE/api/auth/login" >/dev/null
post -b "$ADMIN_JAR" -d '{}' "$BASE/api/library/scan" >/dev/null
for _ in $(seq 1 30); do
  state=$(curl -fsS -b "$ADMIN_JAR" "$BASE/api/library/scan" | python3 -c "import json,sys; print(json.load(sys.stdin).get('running'))")
  [ "$state" = "False" ] && break
  sleep 1
done

person() { # username displayName role
  post -b "$ADMIN_JAR" -d "{\"username\":\"$1\",\"displayName\":\"$2\",\"role\":\"$3\",\"password\":\"$1 password\"}" "$BASE/api/users" >/dev/null || true
}
person mia Mia member
person kiddo Kiddo kid

MIA_JAR=$(mktemp); KID_JAR=$(mktemp)
post -c "$MIA_JAR" -d '{"username":"mia","password":"mia password"}' "$BASE/api/auth/login" >/dev/null
post -c "$KID_JAR" -d '{"username":"kiddo","password":"kiddo password"}' "$BASE/api/auth/login" >/dev/null
post -b "$MIA_JAR" -d '{"kind":"movie","tmdbId":402431}' "$BASE/api/requests" >/dev/null || true   # Wicked
post -b "$MIA_JAR" -d '{"kind":"movie","tmdbId":1064213}' "$BASE/api/requests" >/dev/null || true  # Anora
post -b "$KID_JAR" -d '{"kind":"movie","tmdbId":1184918}' "$BASE/api/requests" >/dev/null || true  # The Wild Robot
echo "Demo is ready: josh / correct horse battery (admin), mia / mia password (member), kiddo / kiddo password (kid)."
