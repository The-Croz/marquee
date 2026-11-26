#!/usr/bin/env bash
# The UI smoke test: demo mode, then the app on the iPhone 17 simulator signs in, sees Home and approves a request.
# Run it by hand on a Mac with Xcode. Nothing here touches a real Marquee.
set -euo pipefail
cd "$(dirname "$0")/../../.."
SIM="${SIMULATOR:-iPhone 17}"
PORT=9797

if curl -fsS "localhost:$PORT/api/health" >/dev/null 2>&1; then
  echo "Something already answers on port $PORT. Stop it (or the running demo) and try again." >&2
  exit 1
fi

pnpm build >/dev/null
LOG=$(mktemp)
pnpm --filter @marquee/server demo >"$LOG" 2>&1 &
DEMO=$!
trap 'kill $DEMO 2>/dev/null || true; pkill -P $DEMO 2>/dev/null || true' EXIT
for _ in $(seq 1 40); do curl -fsS "localhost:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "localhost:$PORT/api/health" >/dev/null || { echo "Demo mode didn't start. Its log:" >&2; cat "$LOG" >&2; exit 1; }

apps/ios/scripts/seed-demo.sh "http://localhost:$PORT"
make -C apps/ios project >/dev/null
xcodebuild test -project apps/ios/Marquee.xcodeproj -scheme Marquee \
  -destination "platform=iOS Simulator,name=$SIM" \
  -derivedDataPath apps/ios/build -only-testing:MarqueeUITests 2>&1 | tee "$LOG.test" | grep -E "error:|\*\* TEST" || tail -25 "$LOG.test"
