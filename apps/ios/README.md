# Marquee for iPhone

A native SwiftUI app (iOS 26+, Liquid Glass) for the Marquee server. Design: `docs/superpowers/specs/2026-11-25-iphone-app-design.md`.

## Build it

You need Xcode 26 or newer and XcodeGen (`brew install xcodegen`).

```bash
make -C apps/ios project   # generate Marquee.xcodeproj from project.yml (never committed)
make -C apps/ios build     # build for the iPhone 17 simulator
make -C apps/ios test      # MarqueeKit's tests: fast, no simulator
apps/ios/scripts/smoke.sh  # UI smoke test against demo mode
```

`MarqueeKit` (`Packages/MarqueeKit`) holds the models, API client and logic with no UI. The app (`Marquee/`) holds the design system and screens.

## Signing: personal team only

`project.yml` sets `DEVELOPMENT_TEAM` to Josh's **personal** Apple team and nothing else. **Never** the Renovation Church team (`P73FA44C6D`), even though Xcode is signed in to it. When the paid personal account is set up its team id replaces the one in `project.yml`.

## The server's answers are checked

`apps/server/test/appFixtures.test.ts` saves real server responses to `Packages/MarqueeKit/Tests/MarqueeKitTests/Fixtures/`, and MarqueeKit's tests decode every one. After changing a response on purpose, run `pnpm --filter @marquee/server fixtures:ios` and commit the files.
