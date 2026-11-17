# Marquee plan

Status key: ✅ done · 🔨 in progress · ⬜ not started

Mockups (web + iPhone): https://claude.ai/artifact/68JrXjWP9SqwwzaUoxcPWT

## Milestone 0: Foundation ✅

- ✅ Monorepo (server, web, shared), GPL-3.0
- ✅ SQLite with append-only migrations
- ✅ Accounts: first-run admin setup, username + password, roles (admin/member/kid), sessions (30-day sliding, hashed tokens), login rate limiting
- ✅ Optional OIDC sign-in (Pocket ID or any OIDC provider), auto-create or link-only
- ✅ Optional Plex sign-in (PIN flow), link-only or auto-create for people with access to your Plex server
- ✅ Settings → Account (name, password, link/unlink Plex and OIDC) and Settings → Users (admin)
- ✅ Web shell + Home screen from the mockup, with sample data
- ✅ Dockerfile with PUID/PGID entrypoint, CI (typecheck/test/build + container smoke test), image published to `ghcr.io/the-croz/marquee`
- ✅ Unraid template (`docker/unraid/marquee.xml`)

## Milestone 1: Library ✅

Goal: Marquee knows every movie and show you already have, without touching a file.

- ✅ TMDB client (search, movie, show, seasons/episodes, find by TVDB/IMDb id, US age ratings); v3 key or v4 token; responses cached in SQLite; retries on rate limits
- ✅ Data model: `movies`, `series`, `episodes`, `media_files` (path, size, quality parsed from names), `scan_items` (needs a match), `tmdb_cache`
- ✅ Settings → Services: TMDB key (falls back to `TMDB_API_KEY`), Radarr and Sonarr (read-only, optional), library folders; test-connection buttons; secrets never sent back
- ✅ Library scanner (read-only, background, with progress): ID tags in folder names → Radarr/Sonarr records → TMDB search (exact title, year ±1). Skips extras folders and samples. Forgets files deleted from disk on rescan.
- ✅ "Needs a match" screen with TMDB suggestions, search, and ignore
- ✅ Movies and Shows pages (filters, sort, quality badges), movie and show detail (files, seasons, episodes, missing/not aired)
- ✅ Search TMDB and add a missing title (admin)
- ✅ Kid profiles only see G/PG movies and TV-Y…TV-PG shows
- ✅ Home: real "Recently added", library counts, free disk space
- ✅ `pnpm --filter @marquee/server demo`: runs with a fake TMDB and a generated sample library (no internet needed)

Later polish (not blocking M2): refresh metadata on demand, change a title's quality profile, per-kid rating limits (M5), Plex/Jellyfin artwork fallback.

## Milestone 2: Finding copies 🔨

Goal: given a wanted title, Marquee finds and ranks releases the way you'd want, and shows why. Still read-only: nothing is downloaded until Milestone 3.

Six PRs, in order. Each lands with tests, a `PLAN.md` tick, and demo-mode fakes so it runs without the LAN.

1. ✅ **Sources** (indexers; `apps/server/src/sources/`)
   - Torznab client: `t=caps` (categories, which ID searches each feed supports), `t=movie` by `tmdbid`/`imdbid`, `t=tvsearch` by `tvdbid` + season/episode, plain `t=search` fallback. Parses the XML into `Release { title, size, seeders, leechers, grabs, publishedAt, infoUrl, downloadUrl, indexerId, imdbId?, tmdbId?, freeleech }`.
   - Migration 3: `sources` (address, key never sent back, priority, used for movies/TV, limits, health, backoff) and `source_calls` (each call, for health numbers; kept 90 days).
   - Settings → Sources: health in plain words with what to do about it, timing and searches today, Test / Try now, Pause, settings with a "For experts" section, add a Torznab feed by hand.
   - **Link Prowlarr**: reads Prowlarr's `/api/v1/indexer` and adds one Source per enabled torrent site with movies or TV, at `{prowlarr}/{id}/api`. Re-syncs every 6 hours and on **Sync now**; names, priority, pause and limits you set are kept. Says which sites were left out and why. Unlink removes its Sources or keeps them as your own.
   - Searches all enabled indexers in parallel with a per-indexer timeout; one slow or broken indexer never fails the whole search. Failing indexers back off.
   - Polite by default: a per-indexer daily search cap (lower for private trackers like IPTorrents) and a small gap between searches to the same indexer. Comparison mode counts against the cap.
   - Import skips feeds with no movie or TV categories (e.g. MyAnonamouse) and searches only movie (2000) / TV (5000) categories.
   - Download links carry the Prowlarr API key, so they stay server-side and are scrubbed from logs and API responses.
   - Verified live against Josh's Prowlarr 2 (7 sites linked, MyAnonamouse left out): Dune: Part Two → 275 copies in about 1 s, Severance S02E03 → 127. Cleaned real answers are fixtures in `test/fixtures/torznab/real/`. `scripts/search.ts` runs a search from a dev machine.
   - Learned live: Prowlarr answers 429 "Indexer is disabled till … due to recent failures" for a site failing on its side (shown as **Set aside by Prowlarr**, not "slow down"). The Pirate Bay through Prowlarr returns nothing when given a standard `cat`, so Marquee sends none and filters by category itself. Knaben repeats The Pirate Bay's results: **PR 4 must merge copies with the same info-hash**. Some names arrive escaped twice (`R&amp;amp;H`).
2. ✅ **Release name parser** (`apps/server/src/releases/parse.ts`)
   - Title, year, season/episode (incl. full-season packs and multi-episode), resolution, source (Remux / Blu-ray / WEB-DL / WEBRip / HDTV / DVD / CAM-TS), codec, HDR/DV/HDR10+, audio, edition, streaming service, group, repack/proper/version, 3D, extras/sample flags.
   - Maps each release onto Radarr's quality names (`Bluray-2160p`, `WEBDL-1080p`…) so TRaSH profiles apply directly.
   - Fixture suite: about 100 hand-checked names, plus checks over 2,102 real names from 11 Prowlarr searches (`test/fixtures/releases/corpus.json`): titles right for 1,010 of 1,011 movie names and 793 of 794 show names, every stated resolution, source and SxxEyy found. The library scanner's `parseQuality` now reads through this parser.
   - Names with a resolution but no source are HDTV, like Radarr, so comparison mode lines up.
   - Checked against Radarr's own quality for Josh's 448 movie files (`scripts/check-radarr-quality.ts`): 443 the same (98.9%). The 5 others are files Radarr labelled from somewhere other than the name, or names with no source in them.
3. ✅ **TRaSH rules** (custom formats; `apps/server/src/releases/`)
   - `trash/{radarr,sonarr}.json`: TRaSH's rules, rule groups, base profiles (*UHD Bluray + WEB*, *HD Bluray + WEB*; *WEB-2160p*, *WEB-1080p*) and sizes, pinned to a TRaSH commit (MIT, license beside it). Anime and other-language groups left out. `pnpm --filter @marquee/server trash:update` refreshes it.
   - `formats.ts`: checks a rule against a copy exactly as Radarr does (tests grouped by type; required must pass, at least one must pass; negate), for title, group, resolution, source, quality modifier, language, indexer flag, size and release type. Unknown test types never match and are reported.
   - `defaultRules()` / `optionalRules()`: a profile's on-by-default rules (always-on + default groups) and its opt-in ones, with TRaSH's points.
   - `explanations.ts`: a short label and plain sentence for every rule (138); a test fails if TRaSH adds one without.
   - Checked against Radarr's own engine with Josh's 211 Profilarr formats on Dune: Part Two and The Matrix (`scripts/check-radarr-formats.ts`): 339 of 347 copies matched exactly the same formats (97.7%). Lessons now in the parser: Radarr's quality resolution (cam has none), Blu-ray with no resolution is 480p, DVD-R is its own quality, a trailing `[word]` is a group, MULTi adds no language.
4. ✅ **Profiles and decision engine** (`apps/server/src/releases/profiles.ts`, `decide.ts`; screens are in PR 5)
   - Migration 4: `profiles` (kind movie/TV, key, name, quality groups best first, "good enough", upgrades, minimum points, size overrides) and `profile_rules` (TRaSH rule, on/off, points). Movie and TV profiles are separate because TRaSH's rules and quality names differ; titles point at one by key (`movies.profile`, `series.profile`), so renaming never breaks them.
   - Presets seeded on first run (once; deleting one doesn't bring it back), each for movies and for TV, resettable to TRaSH's values (the name you gave it is kept):
     - **Cinema**: movies = TRaSH *UHD Bluray + WEB* plus *HD Bluray + WEB*'s rules, taking Blu-ray/WEB 2160p, then Blu-ray/WEB 1080p; TV = *WEB-2160p* with WEB 1080p fallback. Remuxes and full discs refused.
     - **Everyday HD**: movies = *HD Bluray + WEB* (Blu-ray 1080p, WEB 1080p, Blu-ray 720p); TV = *WEB-1080p* plus Blu-ray 1080p.
     - **Kids & Cartoons**: 720p Blu-ray/WEB first, then a 1080p web copy only if it's at most 40 MB a minute (movies, about 3.6 GB for 90 minutes) or 50 MB a minute (TV). *HD* rules (so the same "never" rules: low-quality groups, full discs, upscales, x265 at HD). **Josh to confirm** this fallback.
     - Each preset also carries TRaSH's opt-in rules, switched off, so they can be turned on from the screen.
   - API (admin): `GET/POST /api/settings/profiles` (new = copy of another, or of Everyday HD), `GET/PATCH/DELETE /api/settings/profiles/:id`, `POST …/:id/reset`, `PUT …/defaults` (new movies, new shows, kids' requests), `PUT /api/movies/:id/profile` and `/api/shows/:id/profile`. Delete is refused while a title uses it or it's a default, with the count and what to do. Edits are checked: every quality has one place, at least one is on, "good enough" is on, sizes in order, rules known. New titles from the scanner get the library's default.
   - `decide(wanted, copies, profile)`: merges the same torrent from several Sources by info-hash (keeps the most people sharing, lists every Source), then turns copies down with plain reasons: wrong title (or a Source ID for another title), wrong year (±1), a TV episode when looking for a movie, wrong season/episode, a season pack for a one-episode search, no episode in the name, sample, quality not in the profile, too small/too big for the runtime (TRaSH's MB-per-minute sizes; skipped when the runtime is unknown; season packs sized by episode count), nobody sharing, a "never" rule (-10000), points below the minimum.
   - Ranking like Radarr's: accepted first, then quality group, then proper/repack, then points, then Source priority, then freeleech, then people sharing (log scale, so 120 vs 130 ties), then size closest to the preferred size.
   - Tests: `test/decide.test.ts` (picks, every reason, merging, ranking, and real names from the corpus for six searches) and `test/profiles.test.ts` (presets, API, validation messages, delete guards, defaults).
   - Not yet: upgrade decisions against a file you already have ("is this better than what's on disk?"), which M3 needs for grabbing.
5. ✅ **Search API and screens**
   - `POST /api/movies/:id/search` and `/api/shows/:id/search` (`{ season, episode? }`), admin only: searches every Source by ID and returns each copy judged against the title's profile, best first, with points, rules and plain reasons. Download links never leave the server. Nothing is stored or grabbed. Shows don't store an episode length yet, so TV searches skip size limits.
   - **Copies we found** on movie and show pages (admins): profile picker (changes the title's profile), season and episode pickers for shows, best pick first with badges, "Why?" with each rule's points and meaning, near misses before copies of other titles, Sources that failed with what happens next.
   - **Quality** page (`/quality`): Movies and TV profile lists with title counts and defaults; every setting editable (qualities on/off and order, good enough, keep looking for better, each rule on/off and points with TRaSH's value shown when changed, minimum points, sizes under "For experts"); new profile as a copy of any profile or straight from a TRaSH profile; put a built-in profile back to TRaSH's values; delete; defaults for new movies, new shows and kids' requests.
   - Demo mode has a richer set of copies (Dune: Part Two, Severance) so both screens can be tried without the LAN. Checked in the browser against demo mode.
6. ⬜ **Comparison mode against Radarr** (gate for movie cutover)
   - Migration: `comparisons` (movie, when, Radarr's release, Marquee's pick, both scores, verdict, reasons).
   - Background job reads Radarr's grab history (`/api/v3/history?eventType=grabbed`, read-only). For each new grab, Marquee runs its own search and records what it would have picked.
   - "Explain this one" uses Radarr's own release list for that movie (`/api/v3/release?movieId=`) so both engines judge the exact same releases.
   - Verdicts: *same release*, *same quality, different copy*, *Marquee prefers better*, *Marquee prefers worse*, *Marquee found nothing*. Comparison page with the agreement rate and the disagreements to review. Note: Josh's Radarr profiles come from Profilarr, not TRaSH, so some disagreement is expected and is the point of the review.

### Ideas from HolyArrs to reuse later (ideas only; it's AGPL)

- Glossary with an "older apps call it" column, and a test that keeps arr jargon off screens (done in PR 1).
- Every health state has a plain label, a fix, and "tries again by itself at…" with **Try now** (done in PR 1).
- M3: **Import from other apps** (Radarr/Sonarr/Prowlarr/qBittorrent/Seerr) where you pick what comes over and can **undo** it later; "what is read" page so people trust it.
- M3: a Health page per stage (search, downloads, import) with recent calls and failures over 7/30/90 days.
- M3/M4: "Held" copies waiting out a delay; "Find a better copy" as a button and a plain phrase.
- Docs: each feature page ends with a "If it doesn't work" symptom → fix table and a collapsed "For experts" reference.

Not in M2: grabbing, qBittorrent, RSS polling (M4), native indexer definitions to replace Prowlarr (decided at M4).

## Milestone 3: Downloads ⬜ (movies can switch over here)

- ⬜ qBittorrent client (add, pause, resume, delete, categories, progress, ratio); VPN-aware health check
- ⬜ Queue page from the mockup; stall detection → "try another copy" automatically after N minutes
- ⬜ Import: hardlink from `/data/torrents/...` to `/data/media/movies/...` and `/data/media/tv/...`, rename to a clean scheme, verify, record `media_files`
- ⬜ Seeding rules (ratio goal / max days) and cleanup of finished torrents
- ⬜ Tell Plex and Jellyfin to scan the folder
- ⬜ Cutover checklist for movies: turn off Radarr's monitoring, Marquee takes over

## Milestone 4: TV ⬜ (TV can switch over here)

- ⬜ Airing calendar from TMDB; RSS polling of indexers for new episodes
- ⬜ Season packs vs single episodes; specials; upgrades until the profile's cutoff
- ⬜ "Coming up this week" on Home
- ⬜ Cutover checklist for TV; retire Sonarr, then Prowlarr (needs the two items below)
- ⬜ **Sources without Prowlarr**: add and manage sites in Marquee itself (pick from a list of known public and private sites, sign in with your tracker's key or cookie, search settings per site), not only Torznab feeds. "Bring over from Prowlarr" turns linked Sources into Marquee-managed ones, keeping names, priority and limits. Check how HolyArrs does built-in sites first.
- ⬜ **Built-in bot-check solving** (FlareSolverr inside Marquee or alongside it): Sources marked "Blocked by a bot check" or "Set aside by Prowlarr" for Cloudflare can be fixed with one switch, no separate container to set up.

## Milestone 5: Family ⬜

- ⬜ Discover (trending, upcoming, by genre) from TMDB; kid profiles only see kid-safe titles (certification + genre rules, admin overrides)
- ⬜ Requests: members go straight through; kids need approval; notifications
- ⬜ Retire Seerr

## Milestone 6: Stats ⬜

- ⬜ Plex sessions + history; Jellyfin sessions + history (watch state per user, both servers)
- ⬜ "Watching now", per-title "Who's watched", Activity page
- ⬜ Retire Tautulli and WatchState

## Milestone 7: iPhone app ⬜

- ⬜ SwiftUI app against the same API (token auth for the app)
- ⬜ Home, Request, Downloads screens from the mockup
- ⬜ Push notifications (APNs) for "ready to watch" and approvals; Lock Screen Live Activity for downloads
- ⬜ Needs a Mac with Xcode and an Apple developer account
