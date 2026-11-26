#!/usr/bin/env bash
# Archives Marquee for TestFlight and uploads it. Needs the paid Apple Developer Program, and the team id in
# project.yml / ExportOptions.plist to be the paid personal team (never the Renovation Church team).
# `archive.sh --check` only prints the release build settings and the steps, so it can run on any Mac.
set -euo pipefail
cd "$(dirname "$0")/.."
make project-push >/dev/null
if [ "${1:-}" = "--check" ]; then
  xcodebuild -project Marquee.xcodeproj -scheme Marquee -configuration Release -showBuildSettings 2>/dev/null | grep -E "DEVELOPMENT_TEAM|PRODUCT_BUNDLE_IDENTIFIER|MARKETING_VERSION|CURRENT_PROJECT_VERSION" | sort -u | head -8
  echo "Would run: xcodebuild archive -scheme Marquee -configuration Release -archivePath build/Marquee.xcarchive -allowProvisioningUpdates"
  echo "Then: xcodebuild -exportArchive -archivePath build/Marquee.xcarchive -exportOptionsPlist ExportOptions.plist -allowProvisioningUpdates"
  exit 0
fi
xcodebuild archive -project Marquee.xcodeproj -scheme Marquee -configuration Release -destination 'generic/platform=iOS' -archivePath build/Marquee.xcarchive -allowProvisioningUpdates
xcodebuild -exportArchive -archivePath build/Marquee.xcarchive -exportOptionsPlist ExportOptions.plist -allowProvisioningUpdates
