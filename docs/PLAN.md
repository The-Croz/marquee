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

## Milestone 2: Finding copies ⬜

Goal: given a wanted title, Marquee finds and ranks releases the way you'd want, and shows why.

- ⬜ Indexers: Torznab client (works with your current Prowlarr/Jackett feeds first); manage indexers in settings; health/timing per indexer
- ⬜ Release name parser (title, year, season/episode, resolution, source, codec, HDR/DV, group, repack/proper) with a big fixture-based test suite
- ⬜ Quality profiles: Cinema / Everyday HD / Kids & Cartoons, built from TRaSH custom format JSON (vendored + periodically updated), each rule shown in plain English with its TRaSH name
- ⬜ Decision engine: score, reject with reasons (too big, blocked group, wrong episode...), pick best
- ⬜ "Copies we found" UI and Quality screen from the mockup
- ⬜ **Comparison mode**: for titles Radarr grabs, record what Marquee *would* have picked and report agreement. Gate for cutover.

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
- ⬜ Cutover checklist for TV; retire Sonarr, then Prowlarr

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
