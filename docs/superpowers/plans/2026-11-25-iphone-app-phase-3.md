# iPhone app · Phase 3 (Push) Implementation Plan

> **For agentic workers:** execute inline with superpowers:executing-plans, task by task, ticking the boxes. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Marquee sends push notifications to the iPhone app through Apple (as a new per-phone channel next to Pushover and ntfy), with cover art, **Approve** and **Turn down** buttons on "someone asked for something", and a **Follow on Lock Screen** Live Activity for a download. All of it is built and tested against a **fake Apple push server**; the real Apple key is a step for Josh.

**Architecture:** A new channel kind `apns`, one per phone (created by the app after the person allows notifications). Admin setup (Apple key, key id, team id, bundle id) lives in Settings → Notifications → Shared alerts → iPhone app, stored like other secrets. `ApnsClient` signs a JWT with Node's `crypto` and talks HTTP/2 with `node:http2` (no new dependency); its address can be pointed at a fake for tests and demo mode. The app registers for remote notifications, the Notification Service Extension attaches cover art, notification actions call the API, and an ActivityKit Live Activity follows a download (updated by push when Apple's key is set, by the app while it is open otherwise).

**Spec:** `docs/superpowers/specs/2026-11-25-iphone-app-design.md` (Push, Live Activity). Words: "Follow on Lock Screen" (button); "Live Activity" at most once, in help text.

**Not in Phase 3:** Watching, Manage, TestFlight (phase 4). Real Apple delivery (needs Josh's key and the paid program).

## Global Constraints

Same as phases 1 and 2. Additionally:

- Secrets (the .p8 key, push tokens, Live Activity tokens) never appear in API responses, logs, errors or the fixtures. Settings answers say `keySet: true`, never the key.
- No new server dependencies (Node `http2` and `crypto` only).
- Signing: personal team only. The free personal team can't use push or App Groups, so those entitlements live in `project.push.yml` (included only by `make project-push`); the default project builds and runs on a free team without them. Josh's steps say when to switch.
- Levels: `silent` → `passive`, no sound; `quiet` → `passive`; `normal` → `active`; `high` → `time-sensitive` (Apple interruption levels).
- Approve needs the phone unlocked (`.authenticationRequired`); Turn down opens the app on the reason sheet. Both categories are `request_waiting`.
- Apple answers 410, or 400 `BadDeviceToken` / `Unregistered`, remove that phone's channel, so a deleted app stops being tried.
- Live Activity updates: push when the percent moves by 5 or the state changes; end at "In your library" or after 8 hours. Admins only (download progress is admin-only on the server).

## Review Focus

1. **No secrets out**: key, tokens never in responses, logs or error messages. (Tasks 1, 2)
2. **A phone is never duplicated or left dangling**: registering twice keeps one channel; a bad token removes it; signing out turns push off. (Tasks 3, 4)
3. **Only the right person gets, and acts on, a push**: a member can't approve; the action uses their own token. (Task 6)
4. **Live Activity ends**: no update after done, none after 8 hours, none for a download the person can't see. (Task 5)

---

### Task 1: Apple key settings (server and web)

**Files:** `apps/server/src/notify/apnsSettings.ts`, `apps/server/src/routes/notifications.ts`, `packages/shared/src/index.ts`, web `NotificationSettings.tsx`, test `apps/server/test/apns.test.ts`.

**Interfaces:** `GET /api/settings/notifications/apns` → `ApnsSettingsView { keySet, keyId, teamId, bundleId, environment: 'production' | 'sandbox' }` (never the key); `PUT` takes `{ key?: string (the .p8 text), keyId, teamId, bundleId }` (a blank key keeps the saved one; checks it parses as an EC private key and says so plainly if not); `POST …/apns/test` sends a test to the admin's own phones. Stored with `setSetting` (`apns.*`); the key is encrypted the same way other secrets are (see `library/services.ts`).

- [ ] Tests first: saved but never sent back; a bad key is refused with a plain message; blank key keeps the old one; admin only.
- [ ] Implement the routes, the shared types and the **iPhone app** card under Shared alerts (explains what the key is, where to get it, a Test button).
- [ ] Commit.

### Task 2: Sending through Apple (`ApnsClient`) and a fake Apple

**Files:** `apps/server/src/notify/apns.ts`, `apps/server/test/fakes/apns.ts`, `PushClient` branch in `notify/push.ts`, test `apns.test.ts`.

**Interfaces:** `ApnsClient { send({ token, environment, topic, payload, pushType, priority, collapseId, expiration }): Promise<{ status: number; reason: string | null }> }`, address from `APNS_URL` (tests and demo point it at the fake; default `api.push.apple.com` / `api.sandbox.push.apple.com`). JWT ES256 (kid = key id, iss = team id, `iat`), cached for 50 minutes. `levelFor(priority)` → `{ interruptionLevel, sound }`. `apnsPayload(message)`: `aps.alert` title and body, `interruption-level`, `mutable-content: 1`, `category: 'request_waiting'` for `request_pending`, and top-level `link`, `image`, `requestId`. The fake Apple is a local HTTP/2 server that checks the JWT (signature, `kid`, `iss`), the `apns-topic` and the token, records each push, and can answer 410 or 400 on request.

- [ ] Tests: the right headers and signed JWT arrive; level mapping for all four; the category and `requestId`; 410 and `BadDeviceToken` mark the send as "gone".
- [ ] Implement. **Commit.**

### Task 3: The phone's channel

**Files:** `apps/server/src/routes/account.ts`, `apps/server/src/notify/service.ts`, `apps/server/src/db/schema.ts` (`kind` gains `'apns'`), web `NotificationSettings.tsx`.

**Interfaces:** `POST /api/me/devices/:id/push { token, environment }` (own phone only; creates or updates this phone's one `apns` channel, with the events a person gets by default); `DELETE /api/me/devices/:id/push` (turns push off); `GET /api/me/devices` gains `push: boolean`. `sendTo` deletes an `apns` channel when Apple says the token is gone. Removing a phone (Your phones, or sign out from the web) removes its channel. The channel shows under Settings → Notifications → For me as "<phone name> (iPhone app)".

- [ ] Tests: registering twice keeps one channel; another person's phone → 404; sign-out from the web removes it; a gone token removes it; events default to the bell's; muted events don't send.
- [ ] Implement. **Commit.**

### Task 4: Actions and the request id

**Files:** `apps/server/src/notify/vars.ts`, `notify/events.ts`, test `apns.test.ts`.

- [ ] `requestVars` carries the request's id so the payload has `requestId`; a test checks that "Someone asked for something" to an admin's phone has category `request_waiting` and the right id, and that "Your request was approved" has no category.
- [ ] **Commit.**

### Task 5: Live Activity (server)

**Files:** migration (append-only; `UNDO_NEWEST` updated), `db/schema.ts`, `apps/server/src/downloads/liveActivity.ts`, `routes/downloads.ts`, hook in the download monitor, test `liveActivity.test.ts`.

**Interfaces:** table `live_activities (id, download_id, device_id, token, last_percent, last_state, started_at)`; `POST /api/downloads/:id/live-activity { token }` (admin; one row per phone and download); the monitor's check calls `updateLiveActivities` which pushes (`apns-push-type: liveactivity`, topic `<bundle>.push-type.liveactivity`, `content-state { progress, status, eta }`) when the percent moved by 5 or the state changed, and ends it (`event: end`) at done/failed/removed or after 8 hours, then deletes the row. A 410 deletes the row.

- [ ] Tests with the fake Apple: updates at +5% only; ends at done; ends at 8 hours; admin only; gone token removes the row.
- [ ] Implement. **Commit.**

### Task 6: The app asks, registers and acts

**Files:** `apps/ios/Marquee/App/AppDelegate.swift`, `Marquee/Support/Notifications.swift`, `Features/You/YouSheet.swift`, `Features/Activity/TurnDownSheet.swift`; MarqueeKit `PushRegistration.swift` (+ tests).

**Interfaces:** After sign-in the You sheet's **Notifications on this iPhone** row shows On / Off / "Turn on". Turning on asks permission, registers for remote notifications and posts the token (`POST /api/me/devices/:id/push`, the id from `GET /api/me/devices` where `current` is true). Hex token encoding and the register/unregister bodies live in MarqueeKit and are tested. Category `request_waiting` has **Approve** (`.authenticationRequired`, calls `POST /api/requests/:id/approve` with the Keychain token, from the background) and **Turn down** (`.foreground`, opens the reason sheet). Tapping a notification opens its `link` (`marquee://…` or the web path) through the Phase 2 router. In the foreground a push shows as a banner.

- [ ] Tests (MarqueeKit): token hex, bodies, action parsing (`request_waiting` + `requestId` → approve target).
- [ ] Build the delegate, registration, You row, actions. **Commit.**

### Task 7: Cover art on pushes (Notification Service Extension)

**Files:** `apps/ios/MarqueeNotify/NotificationService.swift`, `project.yml` (target `MarqueeNotify`, an app extension embedded in `Marquee`).

- [ ] The extension downloads the `image` address (only `https://image.tmdb.org/` addresses, 8 s limit, 2.5 MB cap) and attaches it; on any failure it delivers the plain notification. Pure checks (address allowed, size) live in MarqueeKit with tests.
- [ ] Build; check with `xcrun simctl push` using a payload file with `mutable-content`. **Commit.**

### Task 8: Follow on Lock Screen (Live Activity)

**Files:** `apps/ios/Shared/DownloadActivityAttributes.swift`, `apps/ios/MarqueeWidgets/{DownloadLiveActivity,MarqueeWidgetsBundle}.swift`, `Marquee/Features/Activity/{DownloadsList,LiveActivityController}.swift`, `Marquee/Features/Title/TitleView.swift`, `project.yml`.

**Interfaces:** `DownloadActivityAttributes { title, posterPath, downloadId }` with state `{ progress, status, eta }`. **Follow on Lock Screen** (a swipe action on a download row and a button on its title page, admins only): starts the activity with `pushType: .token`, posts its push token to `/api/downloads/:id/live-activity` when the server has an Apple key (otherwise the app updates it itself while open, and the button says "Updates on the Lock Screen need the iPhone app key" once). `NSSupportsLiveActivities` in the app's Info.plist.

- [ ] Build the activity UI (lock screen card and compact/expanded Dynamic Island), the controller (start, update from the 5-second Downloads refresh, end at done), the button. Check on the simulator.
- [ ] **Commit.**

### Task 9: Demo mode, smoke test, push settings, plan and PR

**Files:** `apps/server/scripts/demo.ts`, `apps/ios/scripts/{seed-demo,smoke}.sh`, `project.push.yml`, `Makefile` (`project-push`), `docs/PLAN.md`.

- [ ] Demo mode starts a fake Apple server, fills in the Apple key settings, and logs each push ("[demo] Apple push to <token…>: <title>"); `seed-demo.sh` registers a fake push token for the demo phone, so approving or asking in demo mode shows the pushes in the log. Header of `demo.ts` says so.
- [ ] Smoke test: turn on notifications in the You sheet (the simulator's permission prompt is accepted by an interruption monitor), then a member asks for something and the fake Apple server logs the push.
- [ ] Screenshots; `pnpm test`, `pnpm typecheck`, `make -C apps/ios test`, smoke all pass. Update `docs/PLAN.md` (Josh's steps: the .p8 key, key id, team id, bundle id in Settings → Notifications → iPhone app; switch to `make project-push` after the paid enrollment; test on the phone). One review, fix, push `iphone-app-3`, PR against `iphone-app-2`.
