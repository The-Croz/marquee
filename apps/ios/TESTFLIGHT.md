# Putting Marquee on TestFlight

Needs the paid Apple Developer Program on Josh's **personal** account (never the Renovation Church team).

1. Put the new team id in `project.yml` (`DEVELOPMENT_TEAM`) and `ExportOptions.plist` (`teamID`).
2. In App Store Connect, create an app with the bundle id `marquee.ios.app` (and `.notify`, `.widgets` get made automatically).
3. `scripts/archive.sh --check` prints what will be built; `make -C apps/ios archive` archives and uploads.
4. In App Store Connect → TestFlight, add testers (family) by email. They install from the TestFlight app, then follow Settings → iPhone app in the web app.
5. Push: add the Apple key under Settings → iPhone app. Release builds use Apple's real push service; Xcode debug builds use the sandbox.
