# Marquee for iPhone: design

Date: 2026-11-25 · Milestone 7 · Mockups: "iPhone app · D + E" row on the [mockup canvas](https://claude.ai/artifact/68JrXjWP9SqwwzaUoxcPWT)

## Why

Josh runs Marquee and mostly reaches it from his phone: checking what's downloading, approving the family's requests, asking for things, seeing who's watching. The web app works on a phone but feels like a website. The iPhone app should feel like it belongs on iOS and put the artwork first. Later Josh may share it with the family (members and kids), so it must respect roles from day one even though admin use comes first.

## Goals

- A native iPhone app that covers what Josh does day to day on the web app (see Screens), with the same words (`docs/GLOSSARY.md`) and the cinematic dark look.
- Artwork-heavy: backdrops behind Home and title pages, posters in every row and list.
- Feels like iOS 26: Liquid Glass tab bar, floating buttons and sheets, swipe actions, pull to refresh, large titles, Dynamic Type, VoiceOver.
- Push notifications through Apple (APNs) as a new per-device channel in the existing notification system, with Approve / Turn down from the Lock Screen.
- A Live Activity for a download on its way.
- Role-aware: admin, member and kid see what they see on the web, enforced by the server as today.

## Non-goals

- Replacing the web app's setup screens. Services, lists, backups, logs, wording, automation, the full profile editor and Sources site setup stay on the web; the app links to them.
- Playing video. "Watch in Plex / Jellyfin" hands off to those apps.
- iPad, Mac, Apple TV, widgets, Siri/Shortcuts (later).
- App Store release. TestFlight for Josh and family is the target.
- Offline use beyond showing the last loaded data with a "Can't reach Marquee" banner.

## Anti-goals (would be a failure even if it works)

- A web view in a native wrapper, or screens that look like the web page squeezed.
- arr jargon or qBittorrent's own words on screen ("stalledDL", "indexer", "grab").
- A failure with no plain label and no "what to do".
- Weakening the server's security to make the app easier: no secrets in the app bundle, no API keys sent to the phone, no CSRF bypass for browsers.

## Constraints

- Server: Hono on Node 22, SQLite, append-only migrations, every route tested with `makeApp()`/`call()` and fakes (CLAUDE.md).
- Writes stay JSON (`Content-Type: application/json`); the app sends JSON anyway.
- Josh's Mac has Xcode 27.2 and iPhone 17/18 simulators.
- **Signing uses Josh's personal Apple account only, never the work (Renovation Church) team**, even though Xcode is signed in to both. `project.yml` sets `DEVELOPMENT_TEAM` explicitly to the personal team, never "automatic" team picking. As of 2026-11-25 the personal team is the free Personal Team of Josh's own Apple ID (`2PAYMW97LM`; `5BHPMRU3T8` is the church Apple ID's personal team and must never be used): it can build to Josh's own iPhone (the install expires after 7 days) but can't send push, use Live Activity push updates or TestFlight. Those need the personal account enrolled in the paid Apple Developer Program, which Josh is doing now (2026-11-25); when it's done the personal team id changes and `project.yml` is updated. Phases 1 and 2 don't depend on it.
- Marquee runs on Josh's LAN, reached from outside through Pangolin, and **Pangolin puts its own sign-in in front of Marquee** (Josh, 2026-11-25). An app call through it would get Pangolin's sign-in page, not JSON. Setup step (Josh, in Pangolin): a rule on the Marquee resource that skips Pangolin's sign-in for `/api/*`, so Marquee's own sign-in protects the API while the web pages stay behind Pangolin. The app's address check spots an HTML answer and says so: "Pangolin's sign-in is in the way. In Pangolin, add a rule to the Marquee resource that skips sign-in for /api/*." The OIDC/Plex sheet may show Pangolin's sign-in first; that's fine, it's a browser.
- App Transport Security: allow local networking (`NSAllowsLocalNetworking`) for the Home address (LAN IP or `.local`); the Outside (Pangolin) address must be HTTPS.
- TMDB images: the web app already loads sized images straight from `image.tmdb.org/t/p/w92…/w500…/original` and the server stores `posterPath`, `backdropPath` and a `posterColor` per title. The app does the same; no image proxy needed.

## Approaches considered

- **A. Native SwiftUI, iOS 26+, hand-written Swift models checked against server fixtures. (Chosen by Josh.)** Real Liquid Glass, Live Activities and notification actions with no workarounds. Costs re-building screens in Swift.
- **B. Native SwiftUI with types generated from `packages/shared`.** Needs an OpenAPI description Hono doesn't produce today; more tooling for what A's fixture tests already catch.
- **C. React Native / Expo reusing web code.** Most reuse, but glass, Live Activities and Lock Screen actions need native modules anyway and it's least likely to feel native.

## The design

### Project

- `apps/ios/` in this repo. `project.yml` (XcodeGen) generates `Marquee.xcodeproj`; the generated project is not committed. A `Makefile`/script: `make ios` (generate + build), `make ios-test`.
- Targets: `Marquee` (app), `MarqueeKit` (Swift package inside `apps/ios/Packages/MarqueeKit`: API client, models, stores; no UI), `MarqueeUI` (design system: tokens, components), `MarqueeWidgets` (Live Activity), `MarqueeNotify` (Notification Service Extension for cover art on pushes), `MarqueeTests`, `MarqueeUITests`.
- iOS 26.0 minimum, Swift 6 strict concurrency, SwiftUI + Observation (`@Observable`), async/await `URLSession`. No third-party dependencies to start. Fonts: Instrument Serif (OFL) bundled for titles; body text is the system font (SF Pro) so Dynamic Type works (a change from the web's Inter: native feel wins on iOS).
- Bundle id `marquee.ios.app` (Josh's pick; `app.marquee.ios` was taken by the church Apple ID's team). App group shared with the widget and notification extensions.

### Look (from the mockups)

- Tokens copied from `apps/web/src/styles.css`: ink `#0A0C10`, panel `#12151C`, raised `#1A1F29`, line `#1E2430`, text `#F3F4F6`, soft `#C3CAD5`, muted `#A3ACBA`, amber `#F2B33D` (accent, primary buttons), blue `#6AA6FF` (downloading), teal `#4FD1C5` (ready / watching), warn `#FF9E6B` (needs you / stuck). Dark only, like the web.
- Instrument Serif for film and show titles only; SF Pro for everything else, Dynamic Type sizes.
- **Backdrop hero** (Home, title pages, Discover's featured): TMDB backdrop full-bleed under the status bar, fading into ink; title in serif, a small amber/blue caps line above it; glass circle buttons floating over it.
- **Count tiles** (Home): On the way (blue), Watching (teal), Need you (warn); each opens its Activity section.
- **Wide progress cards** for downloads, poster rows (2:3) for titles, poster grid (3 across) in Library.
- System Liquid Glass (`TabView` with the search tab role, `.glassEffect` on floating buttons, sheets) rather than hand-drawn blur. Reduce Transparency and Increase Contrast fall back to solid panels.
- Placeholders: a title with no art uses its `posterColor` with the title in serif (as the web's `Poster` does).
- 44pt touch targets; every icon button has an accessibility label.

### Navigation

- Tabs: **Home**, **Discover**, **Library**, **Activity**, plus the system **Search** tab (iOS 26 shows it as the separate glass circle). Kids: Home, Discover (kids' rows), Library (kids' titles); no Activity, no Search (matching the web: kids can't use Search).
- Avatar (top right of each tab) opens the **You** sheet: Notifications on this iPhone, My requests and history, Calendar, Sign out; admins also get **Manage**: Health, Quality profiles, Sources, People, Library care; and "More in the web app" (opens Safari at the server address).
- Deep links: `marquee://title/movie/<id>`, `marquee://title/show/<id>`, `marquee://requests`, `marquee://downloads`. Push notifications carry one.

### Screens (each matches a web page and its API)

| Screen | Server | Notes |
|---|---|---|
| Home | `GET /api/home` | Backdrop hero (Now showing → Ready to watch → Just arrived), count tiles, Needs you (requests with Approve, stuck/failed downloads, qBittorrent, Sources, Plex/Jellyfin), On its way, Recent requests, Just arrived, This week. "3 need you" glass pill top left. |
| Discover | `/api/discover/*` | Featured carousel with Trailer (opens YouTube), All / Movies / Shows, service chips, rows, kids' Discover. Ask for a movie / whole show / chosen seasons (season sheet first), take back for 3 s, "already here", "already asked for". TMDB attribution in a footer. Person pages. |
| Search | existing search routes | Library and TMDB results together; admins add a missing title with profile and Which episodes. |
| Library | `/api/movies`, `/api/shows` | Movies / Shows segmented control, filter chips, sort, poster grid, count and size, collections. |
| Title (movie / show) | `/api/movies/:id`, `/api/shows/:id`, `/watch`, copies, history, issues | Backdrop, facts, Watch in Plex / Jellyfin, progress strip, profile and Which episodes, seasons and episodes with states, episode up close, Copies we found (best pick, Why?, send a copy), History, Something wrong?. Admin More menu: look again, rename (preview), remove (to recycle bin, with confirmation). |
| Activity → Downloads | `/api/downloads`, `/summary`, history, never-pick | qBittorrent status line, On the way / Sharing / History / Never pick chips, plain state + what happens next per row, swipe: pause/resume, find a better copy, remove (confirm). |
| Activity → Requests | `/api/requests` | Waiting: Approve, swipe for Approve with… (profile, seasons) and Turn down with a reason, Approve all, Undo toast. Recent with plain states. Members/kids see their own. |
| Activity → Watching (admin) | `/api/activity`, its SSE stream | Now watching (live via the existing server-sent events, falling back to every 15 s), 30-day numbers and chart (Swift Charts), most watched, people. |
| Calendar | `/api/calendar` | By day with states; kids' titles for kids. |
| Manage (admin) | health, profiles, sources, users, library care routes | Health with Run now; profiles list and per-title switch (editing stays on the web); Sources working/failing with Test; People roles and "requests skip approval"; Needs a match, Left out, Clean-up. |
| Sign in | auth routes | See below. |

Every list has a loading state (skeleton posters), an empty state in plain words, and an error state that says what happened and what to do ("Can't reach Marquee at 192.168.1.20:9797. Check you're on your home Wi-Fi or use your outside address." with Try again). Pull to refresh everywhere; screens refresh on return to foreground.

### Sign-in and tokens (server work)

- The server already stores hashed session tokens (`sessions` table) and reads them from the `marquee_session` cookie (`sessionToken(c)` in `http.ts`). Add: `Authorization: Bearer <token>` is accepted the same way. Browser requests keep using the cookie. Bearer requests skip nothing else (roles, rate limits stay).
- Why this keeps the CSRF guard meaningful: a browser can't attach a bearer token cross-site, and JSON-only writes stay.
- `POST /api/auth/login` gains `{ device: { id, name, kind: "ios" } }`; when present it returns the token in the JSON body instead of (not as well as) setting the cookie.
- *(Builder's call, recorded here)* A new **`devices`** table, separate from `sessions`: `id` (the app's `identifierForVendor`), user, name, kind, last used, current session id, push token, Live Activity tokens. Signing in again on the same phone reuses the device row, so its push channel survives a sign-out/sign-in and is never duplicated. App sessions slide like web ones but last **180 days** (web stays 30); signing out from the web's device list deletes the session and turns the device's push off.
- **Pocket ID (OIDC)** in the app: the app opens `GET /api/auth/oidc/start?app=1` in `ASWebAuthenticationSession`. On success the server redirects to `marquee://signed-in?code=<one-time code>` instead of `/`; the app swaps the code for a token with `POST /api/auth/app-token { code }`. The code lives in the existing `flows` table for 60 seconds, single use. The OIDC redirect URI stays the server's own callback, so Pocket ID needs no new setting.
- **Plex** is the existing PIN flow (`/plex/start`, then `/plex/check`): the app opens Plex's page in `ASWebAuthenticationSession` and asks `/plex/check` until done; with `device` in the request, a finished check returns the token. **Jellyfin** sign-in, where the server offers it, works the same way as password sign-in.
- Settings → Account (web and app) lists **Your phones** (name, kind, last used) with **Sign out this phone**.
- The token is kept in the iOS Keychain (shared with the app group so the notification extension can fetch cover art with it if needed).
- Server address: first screen asks for it ("Where is Marquee?"), checks `GET /api/health`, shows the version. Josh can save two addresses (Home address: LAN, Outside address: Pangolin) and the app tries Home first and falls back to the Outside address; this is in the address screen's "For experts" section.

### Push (server work)

- New channel kind **`apns`**, one per device, created by the app (`POST /api/me/devices/:id/push { token, environment }` after the user allows notifications). It appears as a column in Settings → Notifications → For me, like Pushover/ntfy, default on for the events the person already gets on the bell.
- Admin setup in Settings → Notifications → Shared alerts → **iPhone app**: Apple key (.p8), key id, team id, bundle id. Stored like other secrets (never sent back, kept out of logs). One Test button.
- Sending: HTTP/2 to `api.push.apple.com` (or sandbox for debug builds) with a JWT signed by the key, via Node's built-in `http2` and `crypto` (no new dependency). The existing `PushClient` gets an `apns` branch; tests use a fake.
- Levels map to iOS interruption levels: Silently → `passive` with no sound, Quietly → `passive`, Normally → `active`, Right away → `time-sensitive`. Title and message are the existing Wording templates. The poster URL rides along; the Notification Service Extension downloads it and attaches it.
- **Actionable**: "Waiting for approval" notifications have **Approve** and **Turn down** actions (category `request_waiting`). *(Builder's call)* Both need the phone unlocked (`.authenticationRequired`), so a locked phone can't approve; the Keychain item is "after first unlock". Approve calls `POST /api/requests/:id/approve` from the background with the default profile; Turn down opens the app on the reason sheet. Bad tokens (410 from Apple) remove the device's push channel.

### Live Activity

- **Admins only for now** (Josh, 2026-11-25): download progress stays admin-only on the server (`/api/downloads`), so members and kids see request states (Downloading, Ready to watch) but no % and no "Follow on Lock Screen" button. Their "Ready to watch" still arrives by push.
- When a title is on its way and an admin opens its title page or taps "Follow on Lock Screen" on a download row, the app starts a Live Activity (poster, title, %, state in plain words, time left). The app registers the activity's push token with the server (`POST /api/downloads/:id/live-activity { token }`), and the download monitor sends an update push when the % moves by 5 or the state changes, and ends it at "In your library" or after 8 hours. Without the Apple key set, Live Activities still work while the app is open, and the start button says updates need the iPhone app key.

### Data, caching and freshness

- `MarqueeKit.APIClient`: base URL + token, JSON in and out, maps the server's `{ error, message }` to a typed error carrying the plain message, which the UI shows as-is.
- In-memory store per screen with last-good data kept on disk (JSON in Caches) so the app opens instantly with the last view and refreshes.
- Images: `AsyncImage` replacement with a disk cache (URLCache with a bigger disk size is enough to start). Sizes: posters `w342` in grids and rows, `w185` in lists, backdrops `w1280`.
- Downloads and Home refresh every 5 s while visible (the web uses polling too), Watching uses the SSE stream.

### Testing

- **Server**: vitest for every new route and logic (bearer auth, device list and sign-out, app sign-in code exchange, apns channel and level mapping with a fake Apple, Live Activity updates, notification actions), as CLAUDE.md requires. A test that writes **fixtures**: real JSON responses from `makeApp()` for every endpoint the app uses, saved to `apps/ios/Packages/MarqueeKit/Tests/Fixtures/`. CI fails if they're out of date.
- **iOS**: MarqueeKit unit tests decode every fixture into the Swift models (catches drift), plus API client error mapping and the Home-to-Outside address fallback. A UI test smoke run against demo mode (sign in, Home loads, approve a request) on the simulator, run by hand on Josh's Mac; CI runs the unit tests on a macOS runner.
- By hand: demo mode (`pnpm --filter @marquee/server demo`, :9797) is the server for simulator work; then Josh's real server over LAN and Pangolin.

### Delivery (each phase is its own PR, the app usable after each)

1. **Foundations**: server bearer tokens + device list + app sign-in (password, OIDC, Plex) + fixture writer; iOS project, design system, sign-in, address screen, tab shell, Home, Activity (Downloads, Requests with approve/turn down). Josh can approve from his phone.
2. **Browse**: Library, title pages (movie, show, episode), Discover, Search, asking for things, Calendar.
3. **Push**: apns channel and setup, the notification extension, actionable requests, Live Activity.
4. **Manage and family**: Watching, Manage screens, kid and member polish, TestFlight build and a short "Install Marquee on your iPhone" page in the web app.

Each phase updates `docs/PLAN.md` Milestone 7.

## Left to the builder

- Exact Swift module layout inside the targets, view model shapes, file names.
- Bundle id and app group name (suggested `marquee.ios.app`, `group.app.marquee`).
- Skeleton and empty-state art, haptics, animation details, within the mockups' look.
- Which web components to mirror one-for-one versus simplify for the phone, as long as every feature in the Screens table is reachable.
- App icon: a first pass in the amber/ink look; Josh reviews.
