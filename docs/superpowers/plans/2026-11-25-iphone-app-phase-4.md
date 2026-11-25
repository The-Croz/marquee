# iPhone app · Phase 4 (Manage and family) Implementation Plan

> **For agentic workers:** execute inline with superpowers:executing-plans, task by task, ticking the boxes. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Josh can see who's watching right now, check on and fix the things he looks after (health, Sources, people, quality profiles, library care) from his phone, the family's members and kids get a polished, safe app, and the app can go to TestFlight. The web app gets a short "Install Marquee on your iPhone" page.

**Architecture:** Same as before: fixtures from the server decoded by `MarqueeKit` models, `Loader`/`LoadedView` screens, plain words. Watching uses the existing server-sent events stream (`/api/activity/live`) with a 15-second polling fallback. Manage lives behind the You sheet for admins. No new server routes except what the install page needs (none: it is a static web page).

**Spec:** `docs/superpowers/specs/2026-11-25-iphone-app-design.md` (Screens: Activity → Watching, Manage; Delivery phase 4). Words: Watching = someone is playing it now; Wanted = Marquee looks for it by itself.

**Not in Phase 4:** the full profile editor, Sources site setup, lists, backups, logs, wording, automation (they stay on the web, linked from "More in the web app"); widgets, iPad.

## Global Constraints

Same as phases 1 to 3. Additionally:

- Admin-only data (Watching, Manage) is only requested for admins; the server's 403 for anyone else shows "Only admins can see this." Members and kids never see an admin row.
- A change made on the phone (a role, "requests skip approval", a Source check) shows what happened in plain words and can't strand the household: the last admin can't be demoted (the server says so; show its words).
- TestFlight needs the paid program: the build settings, `ExportOptions.plist` and a `make archive` target exist and are checked without a signing identity (an archive for the simulator isn't possible, so the script is verified up to `xcodebuild -showBuildSettings` and a dry list of steps) and Josh's steps say how to upload.

## Review Focus

1. **Roles**: a member or kid can never reach Watching, Manage or an admin action, even through a deep link. (Tasks 2, 3, 6)
2. **Live stream cleanup**: the Watching stream stops when the screen goes away or the app leaves the foreground, and falls back to polling when the stream drops. (Task 1)
3. **Destructive actions** ask first, in plain words (sign someone out, remove, clean-up). (Tasks 3, 4)

---

### Task 1: Watching (Activity → Watching, admin)

**Files:** fixtures `activity-now.json`, `activity-stats.json`, `activity-people.json` (server fixture test: play something through the fake Plex), models `Models/Activity.swift`, `Marquee/Features/Activity/{WatchingList,WatchingModel,SSEStream}.swift`, `ActivityTabs` gains `.watching` for admins (+ test).

**Interfaces:** `GET /api/activity/now` (`sessions`, `problems`, `live`), `GET /api/activity/stats?days=30`, `GET /api/activity/people`, stream `GET /api/activity/live` (`event: sessions`, `data: {sessions, problems, live}`). `SSEStream` (MarqueeKit, tested with a stubbed byte stream) parses `event:`/`data:` lines into events. Screen: **Now watching** cards (poster, title, who, device, quality, progress, "being converted" when transcoding), 30-day numbers (hours, plays, people) with a Swift Charts bar chart by day, most watched, people. Sessions come over the stream; if it drops, poll every 15 s and retry the stream.

- [ ] Fixture test plays a movie through the fake Plex; decode tests; `SSEStream` tests (partial chunks, ping lines, unknown events).
- [ ] Build the screen; Home's **Watching** tile opens it. **Commit.**

### Task 2: You sheet for admins and the Manage hub

**Files:** `Features/You/YouSheet.swift`, `Features/Manage/{ManageView,ManageModel}.swift`, fixtures `health.json` (admin `/api/settings/health`), `sources.json`, `users.json`.

**Interfaces:** admins get **Manage**: Health (count of problems), Quality profiles, Sources, People, Library care, each with a small status on the right (from the lists below). Members and kids don't get the section.

- [ ] Models and decode tests for health, sources, users; build the hub with live counts. **Commit.**

### Task 3: Health, Sources, People

**Files:** `Features/Manage/{HealthView,SourcesView,PeopleView}.swift`.

**Interfaces:** Health: `GET /api/settings/health` (each check's plain label and what to do), **Run now** per job (`POST /api/settings/jobs/:id/run`). Sources: `GET /api/settings/sources` (working or failing in plain words), **Check** (`POST /api/settings/sources/:id/check`), switch on/off (`PUT /api/settings/sources/:id`); adding stays on the web. People: `GET /api/users`, role picker (admin/member/kid), **Requests skip approval**, weekly limit stepper (`PATCH /api/users/:id`); sign someone's phones out; deleting a person stays on the web. The server's last-admin message shows as it is.

- [ ] Build the three screens; check in demo mode (change a role, switch a Source off and on, run a check). **Commit.**

### Task 4: Quality profiles and Library care

**Files:** `Features/Manage/{ProfilesView,LibraryCareView}.swift`.

**Interfaces:** Profiles: `GET /api/settings/profiles` (name, what it's for, how many titles use it, which is the default); read-only here, with "Edit on the web". Switching a title's profile already lives on the title page. Library care: **Needs a match** (`GET /api/library/unmatched`, pick a candidate: `POST /api/library/unmatched/:id/match`, or **Leave it out**: `.../ignore`), **Left out** (`GET /api/library-care/left-out`, **Put back**), **Clean-up** summary (`GET /api/cleanup/…`) that opens the web page for anything destructive.

- [ ] Build; check in demo mode (the demo has folders that need a match). **Commit.**

### Task 5: Members, kids and polish

**Files:** across `Marquee/Features`.

- [ ] Kids: nothing with "download", "Source" or admin words anywhere; Discover shows the kids' rows only; asking tells them an admin will look; the You sheet has no Manage. Members: Activity shows only their requests; no admin controls on title pages (checked by a UI test for each role).
- [ ] Accessibility pass: every icon-only button labelled, Dynamic Type at the largest size doesn't clip the main screens (screenshots at `accessibility-extra-extra-large`), Reduce Motion respected in the toast and the carousel.
- [ ] Haptics on approve, ask and undo (light). Empty states reviewed for every list. **Commit.**

### Task 6: TestFlight and the install page

**Files:** `apps/ios/ExportOptions.plist`, `apps/ios/scripts/archive.sh`, `Makefile` (`archive`), `apps/ios/TESTFLIGHT.md`, web `apps/web/src/pages/InstallApp.tsx` + route + a link in Settings → Account → Your phones.

**Interfaces:** `make archive` archives `Marquee` for release (`-allowProvisioningUpdates`, the team id from `project.yml`) and exports for the App Store (TestFlight). The web page **Install Marquee on your iPhone** says, in plain steps: get the TestFlight invitation from Josh (until the app is on the App Store), install, open Marquee, type this server's address (shown on the page with a copy button, from `window.location.origin`), sign in; what Pangolin needs (the `/api/*` rule, shown to admins only); which sign-ins work.

- [ ] Web page with a test that it renders the address and the steps; `words.test.ts` passes. Archive script and doc; verify with `xcodebuild -showBuildSettings -scheme Marquee -configuration Release`. **Commit.**

### Task 7: Smoke test, plan and PR

- [ ] Extend the smoke test: Activity → Watching opens (admin), You → Manage → People shows Mia and Kiddo. Seed demo mode with a playing stream (the demo's fake Plex).
- [ ] Screenshots of every new screen; compare with the mockups (`AppWatching`, `AppMe`). `pnpm test`, `pnpm typecheck`, `make -C apps/ios test`, smoke all pass.
- [ ] Update `docs/PLAN.md` Milestone 7 (all four phases ✅, Josh's steps complete: TestFlight upload, tester invitations) and put a short summary with every PR link at the top. One review, fix, push `iphone-app-4`, PR against `iphone-app-3`.
