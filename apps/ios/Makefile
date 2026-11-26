# The Marquee iPhone app. Xcode projects are generated, never committed.
#   make project   generate Marquee.xcodeproj from project.yml
#   make build     build for the iPhone 17 simulator
#   make test      MarqueeKit's tests (fast, no simulator)
#   make smoke     the UI smoke test against demo mode (see scripts/smoke.sh)
SIMULATOR ?= iPhone 17

.PHONY: archive project project-push build test smoke

project:
	xcodegen generate

# With the push entitlement (needs the paid Apple Developer Program; see project.push.yml).
project-push:
	xcodegen generate --spec project.push.yml

archive:
	scripts/archive.sh

build: project
	xcodebuild -project Marquee.xcodeproj -scheme Marquee -destination 'platform=iOS Simulator,name=$(SIMULATOR)' -derivedDataPath build build | tail -20

test:
	cd Packages/MarqueeKit && swift test

smoke:
	scripts/smoke.sh
