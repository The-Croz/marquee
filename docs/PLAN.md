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
3. ⬜ **TRaSH custom formats** (`apps/server/src/releases/trash/`)
   - Vendored JSON from TRaSH-Guides (MIT, license kept beside it): the Radarr CFs our profiles use plus the `uhd-bluray-web` and `hd-bluray-web` profiles. `pnpm --filter @marquee/server trash:update` refreshes them; a test fails if a vendored file changes shape.
   - Evaluator for the spec types TRaSH uses: release title (regex), release group, resolution, source, quality modifier, language, indexer flag, size; with `negate` and `required` semantics matching Radarr.
   - Test: every vendored regex compiles in JavaScript and matches the same sample titles Radarr would.
   - `explanations.ts`: one plain-English line per custom format we use, keyed by `trash_id` ("Dolby Vision with no HDR10 layer: shows purple and green on TVs without Dolby Vision. Never pick."). A test fails if a scored CF has no explanation.
4. ⬜ **Profiles and decision engine** (`apps/server/src/releases/profiles.ts`, `decide.ts`)
   - Profiles live in the database and are editable: allowed qualities and their order, the "good enough" cutoff, upgrades on/off, points per custom format (TRaSH's score by default, override per rule), size limits per quality, minimum score. Create, copy, rename, delete (only when no title uses it). Each movie and show is assigned one; `movies.profile` / `series.profile` already hold the key. A default profile per library (movies, TV) and one for kids' requests.
   - Three presets are seeded on first run and can be reset to TRaSH's values:
     - **Cinema**: TRaSH *UHD Bluray + WEB* (2160p Blu-ray encodes and WEB, HDR/DV scored, remuxes and disc images refused) with TRaSH *HD Bluray + WEB* 1080p as the fallback, upgrading to 4K when one appears.
     - **Everyday HD**: TRaSH *HD Bluray + WEB* (1080p).
     - **Kids & Cartoons**: 720p WEB/Blu-ray preferred, 1080p accepted under a size cap; same "never" rules (LQ groups, BR-DISK, upscales, x265 at HD).
   - Rejections, each with a plain reason: wrong title/year, wrong season/episode, quality not in the profile, too small/too big for the runtime (TRaSH quality-size), nobody sharing it (0 seeders), a "never" format scored at -10000, score below the profile minimum.
   - Ranking like Radarr: quality tier, then custom format score, then seeders, then indexer priority, then size closer to the preferred size.
5. ⬜ **Search API and screens**
   - `POST /api/movies/:id/search` and `/api/series/:id/search` (admin): runs the search and returns every release with its parsed details, score breakdown and rejections. Nothing is stored or grabbed.
   - "Copies we found" panel on movie and show detail, from the mockup: best pick first, each row expands to "why" (each matching rule, its points, its plain-English explanation and TRaSH name).
   - Settings → Quality: list and edit profiles, each rule in plain English with its TRaSH name; change a title's profile from its detail page.
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
