# iPhone app · Phase 2 (Browse) Implementation Plan

> **For agentic workers:** execute inline with superpowers:executing-plans, task by task, ticking the boxes. Steps use checkbox (`- [x]`) syntax.

**Goal:** From the app, Josh (and later the family) can browse the library, open any title, see where it stands, ask for things from Discover, search, and see the Calendar, with the same words as the web app.

**Architecture:** Phase 1's pieces carry on: server fixtures decoded by `MarqueeKit` models, `APIClient`, `@Observable` models per screen, the design system. Phase 2 adds Discover, Library and Search as tabs (Search as the system search tab), a title page for movies and shows, episode up close, copies found, and the Calendar and "My requests" in the You sheet. Admin-only actions (Wanted, profile, copies, remove) show only for admins; the server already enforces it.

**Spec:** `docs/superpowers/specs/2026-11-25-iphone-app-design.md` (Screens table: Discover, Search, Library, Title, Calendar). Mockups: "iPhone app · D + E" row (`AppDiscover`, `AppLibrary`, `AppMovie`, `AppShow`, `AppEpisode`, `AppCalendar` where they exist).

**Not in Phase 2:** push and Live Activity (phase 3); Watching, Manage, TestFlight (phase 4). Rename-with-preview and Remove-to-recycle-bin for a title stay on the web ("More in the web app" opens the title's web page); person pages open in Safari.

## Global Constraints

Same as Phase 1 (words from `docs/GLOSSARY.md`, personal team only, JSON writes, plain failures with what to do, 44pt targets, Dynamic Type, Reduce Transparency fallbacks). Additionally:

- **Wanted / Not wanted** is Marquee looking for it by itself. **Watching** is someone playing it now. Never "Watched" for either. "Never watched" (nobody has played it) is fine.
- Kids: Discover (kids' rows), Library (kids' titles) and Home only. No Search tab, no Activity (the server answers 403 to a kid's search; show "Ask a grown-up to search for new things to watch." if it happens).
- Members: Discover, Search, Library, Activity → Requests. They can ask (an admin approves unless "requests skip approval" is on) and take a request back for 3 seconds.
- Admin-only title actions: Wanted switch, profile, Which episodes, Look again / Copies found, send a copy, History.
- Pictures: posters `w342` (grids, rows), `w185` (lists), backdrops `w1280`. Image cache: `URLCache.shared` with 50 MB memory and 400 MB disk, set at launch.
- Deep links: `marquee://title/movie/<id>`, `marquee://title/show/<id>`, `marquee://requests`, `marquee://downloads` (phase 3 pushes use them).

## Review Focus

1. **Kids and members never see an admin control or a dead end**: a 403 anywhere shows a plain message, never a blank screen. (Task 8 test, Task 4/5 behavior)
2. **Asking twice**: pressing Ask twice, or asking for something already here or already asked for, never makes two requests and says why. (Task 6)
3. **Take-back window**: the 3-second take-back removes exactly that request. (Task 6)
4. **Library lists stay cheap**: grids load lazily and images come from the cache. (Task 3)
5. **Words**: no "Watched" for Wanted; every failure has a plain label and what to do. (Task 9)

---

### Task 1: Fixtures and models for browsing

**Files:** Modify `apps/server/test/appFixtures.test.ts`; create `apps/ios/Packages/MarqueeKit/Sources/MarqueeKit/Models/{Library,Title,Discover,Calendar}.swift`; modify `FixtureDecodingTests.swift`.

**Interfaces:**
- New fixtures (written by the fixture test, same rules as phase 1): `movies.json`, `shows.json`, `movie-detail.json`, `show-detail.json`, `movie-watch.json`, `episode-detail.json`, `discover.json`, `discover-kids.json`, `discover-title-movie.json`, `discover-title-series.json`, `discover-season.json`, `library-search.json`, `discover-search.json`, `calendar.json`, `copies.json`, `history-title.json`, `issues-title.json`.
- Swift (all `Decodable, Sendable, Hashable`, unions as `WireString` enums with `unknown`): `LibraryCard`, `MovieDetail`, `ShowDetail` (+ `SeasonView`, `EpisodeView`, `MediaFileView`, `QualityView`), `EpisodeDetailView`, `WatchLink`, `DiscoverPage`, `DiscoverRow`, `DiscoverCard`, `DiscoverTitle` (+ details, ratings, cast, providers, seasons), `SeasonPreview`, `SearchResult`, `CalendarView`, `CalendarItem`, `CopiesResult`, `CopyView`, `HistoryView`, `IssueView`, `CardState`.

- [x] **Step 1:** Extend the fixture test with a library (two movies, a show with episodes and files), calls as admin/kid, a Wanted toggle, one copies search through the fake sources, and a calendar.
- [x] **Step 2:** Run `pnpm --filter @marquee/server fixtures:ios`, then write the Swift decoding tests (one per fixture) → FAIL → write the models → PASS (`make -C apps/ios test`).
- [x] **Step 3: Commit** `Fixtures and models for browsing the library, Discover and the Calendar`.

### Task 2: Navigation shell: Discover, Library, Activity, Search, deep links

**Files:** `Marquee/App/RootView.swift`, `Marquee/App/Router.swift`, `Marquee/Support/ImageCache.swift`, `MarqueeKit/DeepLink.swift` (+ test).

**Interfaces:** `DeepLink.parse(URL) -> DeepLink?` (`.title(kind, id)`, `.requests`, `.downloads`) in MarqueeKit, tested. `Router` (`@Observable`) holds a `NavigationPath` per tab and `open(_ link:)`. Tabs by role: admin and member → Home, Discover, Library, Activity (member: Requests only), Search (system search role); kid → Home, Discover, Library.

- [x] **Step 1:** Test `DeepLink.parse` (`marquee://title/movie/12`, `title/show/3`, `requests`, `downloads`, junk → nil) → FAIL → implement → PASS.
- [x] **Step 2:** Build the tab shell, router and the image cache setup; `onOpenURL` calls the router. Placeholders for the new tabs until their tasks.
- [x] **Step 3: Commit** `iPhone app: tabs for Discover, Library and Search, deep links`.

### Task 3: Library

**Files:** `Marquee/Features/Library/{LibraryView,LibraryModel,PosterGrid}.swift`.

**Interfaces:** `GET /api/movies`, `/api/shows` (query `q`, `filter` = all/have/missing/wanted_missing/not_good_enough, `sort` = added/title/year, `wanted`). Movies / Shows segmented control, filter chips (Everything, Have it, Missing, Wanted · nothing yet), sort menu, a search field, 3-across poster grid (`LazyVGrid`) with a badge ("4K HDR", "Missing", "5 of 8 episodes"), count and size at the bottom. Tapping a poster pushes the title page (Task 4). Empty and error states in plain words.

- [x] **Step 1:** Build the screen; check against demo mode (movies and shows lists, filters, sort, kid sees only kids' titles).
- [x] **Step 2: Commit** `iPhone app: Library`.

### Task 4: Title page (read)

**Files:** `Marquee/Features/Title/{TitleView,TitleModel,SeasonsView,EpisodeView,FactsView}.swift`.

**Interfaces:** `GET /api/movies/:id`, `/api/shows/:id`, `/watch`, `GET /api/requests?scope=all|mine` (progress strip from the matching request), `GET /api/episodes/...` (episode up close, admins). Backdrop hero (title serif, kicker with the state), facts line (year · rating · runtime or seasons · genres), overview, **Watch in Plex / Jellyfin** buttons (open the link), a progress strip Approved → Searching → Downloading → Ready from the request, a files and quality line, seasons as disclosure rows with episodes and their states (Have it / Wanted / Not out yet / Missing), tapping an episode (admins) opens **episode up close** (files, torrents, Remove).

- [x] **Step 1:** Build movie and show pages; check in demo mode (a title with a file, a Wanted one with none, a show with episodes).
- [x] **Step 2: Commit** `iPhone app: title pages and episodes`.

### Task 5: Title actions (admin)

**Files:** `Marquee/Features/Title/{TitleActions,ProfilePicker,CopiesSheet,HistoryList,IssueSheet}.swift`.

**Interfaces:** `PUT /api/movies|shows/:id/wanted` `{wanted}`; `PUT .../seasons/:s/wanted`, `.../episodes/:e/wanted`; `PUT .../profile` `{profile}` with `GET /api/profiles` for the choices; `POST /api/movies|shows/:id/search` then `POST /api/downloads` `{searchId, copyId}` (Copies we found: best pick first, **Why?** text, near misses collapsed, **Send this copy**; asks first when the server says so, with the server's words); `GET /api/history?movieId|seriesId` (History); `GET/POST /api/issues` (Something wrong? for everyone). More menu: **Look again** (runs the copies search), **Open in the web app**.

- [x] **Step 1:** Wanted switch and the profile picker, Which episodes per season, with the plain words; Copies found; History; Something wrong?.
- [x] **Step 2:** Check in demo mode: switch Wanted, change profile, search copies and send one (the fake qBittorrent takes it), report a problem as a member.
- [x] **Step 3: Commit** `iPhone app: Wanted, profile, copies, history and problems on a title`.

### Task 6: Discover and asking

**Files:** `Marquee/Features/Discover/{DiscoverView,DiscoverModel,FeaturedCarousel,TitleSheet,AskFlow,SeasonPickerSheet}.swift`.

**Interfaces:** `GET /api/discover?type&service&genre`, `GET /api/discover/title/:kind/:id`, `GET /api/discover/title/series/:id/season/:n`, `POST /api/requests` `{kind, tmdbId, seasons?, preset?}`, `DELETE /api/requests/:id`. Featured carousel (Trailer opens YouTube), All / Movies / Shows, service chips, rows of posters, genre browse; a title card sheet with facts, where to watch, cast, **Ask for it** (movies), **Ask for the whole show** and **Choose seasons…** (a sheet that previews each season's episodes first); after asking, a toast with **Undo** for 3 seconds (`DELETE`). States: "Already in your library" (opens it), "Already asked for" (with the request's state), "Not out yet" with its date. TMDB attribution at the bottom. Kids get kids' rows only (the server decides). Members who must wait say "An admin will look at it" (the server's `stateText`).

- [x] **Step 1:** Build Discover and the title sheet; ask for a movie, a show and chosen seasons in demo mode; press twice; undo within 3 s.
- [x] **Step 2: Commit** `iPhone app: Discover and asking for things`.

### Task 7: Search

**Files:** `Marquee/Features/Search/{SearchView,SearchModel}.swift`.

**Interfaces:** `GET /api/library/search?q&kind` (TMDB results with `libraryId`), `GET /api/movies?q`, `/api/shows?q` (in the library), `POST /api/library/add` (admin: add a missing title, Wanted or not, with Which episodes). System search tab with a search field (`.searchable`), results grouped **In your library** and **Not in your library yet**, each opening the title page (library) or the Discover sheet (TMDB). Admins get **Add** with a profile and Which episodes choice.

- [x] **Step 1:** Build; check in demo mode as admin (find and add a missing title) and as member (ask instead of add).
- [x] **Step 2: Commit** `iPhone app: Search`.

### Task 8: Calendar and My requests (You sheet)

**Files:** `Marquee/Features/Calendar/{CalendarView,CalendarModel}.swift`, `Marquee/Features/You/{MyRequestsView}.swift`, modify `YouSheet.swift`.

**Interfaces:** `GET /api/calendar?from&days`; `GET /api/requests`. The You sheet gains **My requests & history** and **Calendar · N this week**. Calendar groups by day (Today, Tomorrow, weekday), each row with its poster, title, state in plain words from the server's `note`, tapping opens the title. Kids' Calendar comes filtered from the server.

- [x] **Step 1:** Build; check in demo mode (Severance airs this week).
- [x] **Step 2: Test** a member's and a kid's 403 never blanks a screen (UI states for `MarqueeError.isForbidden`) with a MarqueeKit test where the logic lives.
- [x] **Step 3: Commit** `iPhone app: Calendar and My requests`.

### Task 9: Words, deep links, smoke test and the plan

**Files:** web copy if any, `apps/ios/MarqueeUITests/SmokeTests.swift`, `docs/PLAN.md`, `apps/ios/scripts/seed-demo.sh`.

- [x] **Step 1:** Search the web app and the app for "Watched" / "Not watched" meaning "looks for it" and rename to Wanted / Not wanted; keep "Never watched". `test/words.test.ts` passes.
- [x] **Step 2:** Extend the smoke test: open Library, open a title, go to Discover and ask for something, undo it.
- [x] **Step 3:** Screenshots of every new screen on the simulator; compare with the mockups; fix obvious differences.
- [x] **Step 4:** `pnpm test && pnpm typecheck && make -C apps/ios test && apps/ios/scripts/smoke.sh` all pass. Update `docs/PLAN.md` Milestone 7. **Step 5:** one review, fix, push `iphone-app-2`, open the PR against `iphone-app-1`.

**Built differently from the plan:** Step 1 of Task 9 found nothing to rename (every "Watching" on the web already means someone is playing it, and "Not watched" means never played). The 3-second take-back holds the ask on the phone before sending, like the web, so `AskCoordinator` (tested) replaced a DELETE-based undo. Rename and Remove-to-recycle-bin stay on the web, as planned.
