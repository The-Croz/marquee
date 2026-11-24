# Marquee plan

Status key: ✅ done · 🔨 in progress · ⬜ not started

Mockups (web + iPhone): https://claude.ai/artifact/68JrXjWP9SqwwzaUoxcPWT
UI audit and proposal (Nov 2026): https://claude.ai/artifact/VqXFR6MSiZtBvCFA1jgcC7 · `docs/design/ui-audit-2026-11.md`

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

## Milestone 2: Finding copies ✅

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
     - **Kids & Cartoons**: 720p Blu-ray/WEB first, then a 1080p web copy only if it's at most 40 MB a minute (movies, about 3.6 GB for 90 minutes) or 50 MB a minute (TV). *HD* rules (so the same "never" rules: low-quality groups, full discs, upscales, x265 at HD). Confirmed by Josh.
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
6. ✅ **Comparison mode against Radarr** (gate for movie cutover; `apps/server/src/compare/service.ts`, page at `/compare`)
   - Migration 5: `comparisons` (Radarr's history id, movie, when, Radarr's download, Marquee's judgement of it and its own pick, profile, verdict, how it was judged).
   - Reads Radarr's grab history (`/api/v3/history/since?eventType=1&includeMovie=true`, read-only; the first run looks back 30 days). Each run compares up to 5 waiting downloads, newest first, each with a search of Marquee's own Sources (counts toward Source limits). "Check every hour" runs it in the background; **Check now** runs it at once.
   - **Judge Radarr's own list** (`/api/v3/release?movieId=`) judges exactly the copies Radarr saw. **Search my Sources again** redoes one.
   - Verdicts: *same copy*, *same quality, different copy*, *Marquee picks higher quality*, *Marquee picks lower quality*, *Marquee found nothing*, each with a plain sentence, plus why Marquee would turn Radarr's copy down. Higher/lower uses a neutral ladder (resolution, then remux > Blu-ray > web download > web capture > TV), not Marquee's own points. Agreement = same copy + same quality.
   - Compare page: agreement rate, counts per verdict (click to filter), "To review" by default, each item with both copies side by side and their rules.
   - Tests: `test/compare.test.ts` with a fake Radarr (`test/fakes/radarr.ts`), also used by demo mode.
   - **Needs Josh on the LAN:** connect Radarr in Settings → Services, turn on "Check every hour" and let it run for a while. Josh's Radarr profiles come from Profilarr, not TRaSH, so some disagreement is expected; that's what the review is for.

7. ✅ **Which profile a title gets** (after M2 review)
   - The Cinema preset is now called **4K Quality** (renamed once on existing installs unless you'd renamed it; its key stays `cinema`).
   - Migration 6: `profile_choices` (rules: any of these TMDB genres and any of these US ratings → a profile; checked in order, first match wins, else the library default) and `profile_by_hand` on movies and shows. Picked by what kind of title it is, never by who asked for it.
   - Starting rules. Movies: Animation or Family rated G/PG → Kids & Cartoons; Documentary → Everyday HD; everything else → 4K Quality. TV: Kids → Kids & Cartoons; rated TV-Y/TV-Y7/TV-G → Kids & Cartoons; Reality, Talk, News, Soap or Documentary → Everyday HD; everything else → 4K Quality.
   - New titles from the scanner use the rules. A profile picked on a title's page is "by hand" and never changed by the rules; "Let the rules pick" hands it back.
   - Quality page: "Which profile a new movie/show gets" card to add, edit, reorder and remove rules and set "everything else"; **Sort my library by these rules…** previews every change before moving anything.

8. ✅ **Profile rules with conditions**
   - Migration 7: movies and shows keep TMDB's original language, studios (TV: networks and studios) and keywords; the next library scan fills them in once for titles matched before. `profile_choices.conditions` replaces the genre/rating columns (older rules are converted).
   - A rule is a list of conditions that must all fit: genre is any/all/none of; age rating is any/none of; released (TV: first aired) between years, either end open; studio or network is any/none of; original language is any/none of; keyword is any/all/none of.
   - New starting rules for movies: Documentary → Everyday HD; Animation or Family, rated G or PG, released 2009 or earlier → Kids & Cartoons; everything else → 4K Quality. Installs still on the first movie rules are moved to these once.
   - Kids & Cartoons for TV now prefers 1080p, then 720p, then SD (no size cap); updated once on installs that never edited it.
   - Quality page editor: each rule as one sentence with how many titles it picks (live, even before saving); click to edit conditions one per line, with your library's studios and keywords suggested; "Try a movie/show from your library" says which rule picks it and why earlier ones don't fit.

### Ideas from HolyArrs to reuse later (ideas only; it's AGPL)

- Glossary with an "older apps call it" column, and a test that keeps arr jargon off screens (done in PR 1).
- Every health state has a plain label, a fix, and "tries again by itself at…" with **Try now** (done in PR 1).
- M3: **Import from other apps** (Radarr/Sonarr/Prowlarr/qBittorrent/Seerr) where you pick what comes over and can **undo** it later; "what is read" page so people trust it.
- M3: a Health page per stage (search, downloads, import) with recent calls and failures over 7/30/90 days.
- M3/M4: "Held" copies waiting out a delay; "Find a better copy" as a button and a plain phrase.
- Docs: each feature page ends with a "If it doesn't work" symptom → fix table and a collapsed "For experts" reference.

Not in M2: grabbing, qBittorrent, RSS polling (M4), native indexer definitions to replace Prowlarr (decided at M4).

## Milestone 3: Downloads ✅ (movies can switch over here)

Goal: Marquee sends the copy it picked to qBittorrent, follows it in plain words, puts the finished file in the library with a hardlink and a clean name, keeps seeding by your rules, and tells Plex and Jellyfin. Then Radarr can stop.

Seven PRs, in order, like M2: each with tests (fake qBittorrent, never the real one), a `PLAN.md` tick and demo-mode fakes. Nothing is ever deleted from disk in M3 (only qBittorrent's own copy of a torrent Marquee sent, and only when you say so).

1. ✅ **Downloader connection** (`apps/server/src/downloads/qbittorrent.ts`; read-only)
   - qBittorrent Web API v2 client: sign in (username and password; session cookie kept and renewed when it runs out), app and API version, preferences (save folder), connection status, free space, categories. Only reads in this PR.
   - Settings → Downloader: address, username, password (never sent back; a saved password is never sent to a different address), category (default `marquee`), Test connection.
   - Health in plain words with what to do: **Working**, **Can't reach it**, **Password turned down**, **Too many wrong passwords** (qBittorrent banned Marquee's address for a while), **Not qBittorrent**, **Too old** (needs Web API 2.8+, qBittorrent 4.5+), and VPN-aware states from qBittorrent's own connection status: **No internet for downloads** (the VPN, e.g. gluetun, is down) and **Others can't connect to you** (firewalled: downloads work but slower; check port forwarding).
   - Demo mode: a fake qBittorrent at `http://qbittorrent:8080` (admin / adminadmin).
   - Learned live: qBittorrent 5.2 (Web API 2.15) answers a correct sign-in with 204 and no body, not "Ok.", and a wrong one with 401. Josh's qBittorrent lets LAN addresses in without signing in, but not the Marquee container.
   - Idea for later: qBittorrent 5.2 also takes an API key instead of a password.
2. ✅ **Send a copy** (`apps/server/src/downloads/send.ts`, `torrent.ts`, `releases/upgrade.ts`)
   - Migration 8: `downloads` (title or season/episode, copy name, info-hash, Source, profile, quality, points, size, who and when, state, adopted, progress).
   - Searches are kept in memory for an hour (`downloads/cache.ts`), so **Download this** points at a copy by id and download links still never leave the server.
   - Marquee fetches the `.torrent` itself (following redirects, including Prowlarr's redirect to a magnet), works out the info-hash, makes the category in qBittorrent if it's missing, and adds the torrent under it tagged `marquee`. Errors say what happened without the Source key.
   - Copies Marquee would turn down, and copies that aren't better than your file, ask "Download it anyway?" first.
   - **Better than yours?** Your file's name is judged by the same profile, then compared by quality group first and points second. It respects "keep looking for better" and "good enough". A season counts as good as its worst episode. Shown on each copy Marquee would take ("Better than your 1080p web download.").
   - Duplicate guard: if qBittorrent already has the torrent (say Radarr sent it), Marquee adopts it and follows it in its existing category. A second download for a movie, or for an episode that already has one on the way, is refused, saying which.
   - `POST /api/downloads`, `GET /api/downloads` (admin). Members' "Download this" waits for requests in M5.
3. ✅ **Downloads page** (`apps/server/src/downloads/monitor.ts`, `view.ts`, `search.ts`; page at `/downloads`)
   - Migration 9: what qBittorrent last said about each download (state, speed, time left, people sharing, when it finished) and `never_pick` (copies turned down for a title, with the reason).
   - Checks qBittorrent every minute in the background, and when the page asks if the last check is over 10 s old (the page refreshes every 10 s). Follows downloads by info-hash.
   - Plain states (see `GLOSSARY.md`), each with what it means and what happens next. qBittorrent's own words never reach the screen.
   - **Stuck**: no progress for 6 hours (paused, queued and checking time doesn't count). After 24 hours Marquee **tries another copy** by itself: it adds the copy to "Never pick" for that title, removes it from qBittorrent with its files, searches again and sends the best copy left (one better than your file). If none suits, it says so. Both times and the switch are in Settings → Downloader.
   - **Fakes**: as soon as the file list arrives, a program (`.exe`, `.scr`, `.lnk`…, including `movie.mkv.exe`) or only archives with no video gets the copy replaced the same way.
   - Buttons: Pause/Resume (qBittorrent 5's stop/start, falling back to 4's pause/resume), Try another copy, Remove (with or without its files).
   - Downloads Marquee adopted from another app (Radarr) are only watched: never paused, removed or replaced; Remove just stops following them.
   - Movie and show pages list their downloads above "Copies we found".
   - "Copies we found" and "Try another copy" share one search (`downloads/search.ts`), and searches skip "Never pick" copies.
   - Gone from qBittorrent is not replaced by itself (you might have removed it on purpose); Try another copy does it.
4. ✅ **Put it in the library** (`apps/server/src/downloads/importer.ts`, `library/naming.ts`)
   - Migration 10: where qBittorrent saved each download, when it went into the library, which files it became, the last import problem, and whether it had to be copied.
   - As soon as a download Marquee sent finishes: picks the video file(s) (skipping samples, extras folders and tiny files), checks a season pack's files are the right season and episodes, and **hardlinks** each into the library folder under a clean name. The download stays where it is so qBittorrent keeps sharing. Falls back to a copy only across disks, and the Downloads page says so ("In your library · copied", with how to fix it).
   - Clean names from patterns in Settings → Services → "How Marquee names files" (For experts), with a live example and checks. Defaults: movies `{Title} ({Year}) {tmdb-{TmdbId}}/{Title} ({Year}) {Edition} [{Quality}][{HDR}]`, TV `{Show} ({Year}) {tvdb-{TvdbId}}/Season {Season:00}/{Show} - S{Season:00}E{Episode:00} - {Episode Title} [{Quality}][{HDR}]`. A title that already has a folder (from Radarr) keeps it.
   - Upgrades: the file it replaces is moved into a hidden `.marquee-replaced` folder in the same library folder (same disk, instant; Plex and Jellyfin skip hidden folders). Nothing is deleted.
   - Records the new files in the library (`media_files`) and the title's folder.
   - Problems say what to do: can't see the download (with qBittorrent's folder and the folder-pair fix), not allowed to write (PUID/PGID), read-only, disk full, no video, wrong episodes. Retried every 15 minutes, or **Try again** on the Downloads page.
   - Folder pairs ("qBittorrent's folder" / "Marquee's folder") in Settings → Downloader → For experts.
   - Not done here: importing finished downloads that Radarr or Sonarr sent (Marquee leaves those to them during the side-by-side), and emptying `.marquee-replaced` (no automatic deletion yet).
5. ✅ **Seeding rules** (`apps/server/src/downloads/seeding.ts`)
   - Migration 11: a seeding rule per Source (ratio, days; blank uses the default, 0 means no limit for that part), and each download's ratio, time sharing and when it shared enough.
   - Default rule in Settings → Downloader → "Sharing after a download": ratio 2.0 or 14 days, whichever comes first. Private sites keep sharing until you remove them unless their Source has its own rule (their minimums vary and missing them can cost you the account).
   - Marquee follows downloads in the library while they share: "In your library · sharing" with progress ("ratio 0.8 of 2.0 or 3 of 14 days"), then "In your library · done sharing".
   - "Remove from qBittorrent once it has shared enough" (off by default) removes the torrent with the download's files, but only after checking every library file is still there (the library file is a hardlink, so it stays). Otherwise it keeps the files and says why. **Remove from qBittorrent** does the same by hand.
   - Marquee doesn't set limits inside qBittorrent itself, so qBittorrent's own "when ratio is reached" setting can't remove anything behind Marquee's back.
6. ✅ **Tell Plex and Jellyfin** (`apps/server/src/library/mediaServers.ts`)
   - Settings → Services gets Plex (address and token) and Jellyfin (address and API key), each with Test connection and pickers for the movie and TV library ("Let Marquee pick" by default: the only library of that kind, or the one whose folder ends like Marquee's). Tokens and keys are never sent back, and never sent to a different address.
   - Right after an import, Marquee asks each connected server to scan just the new folder: Plex `GET /library/sections/{id}/refresh?path=`, Jellyfin `POST /Library/Media/Updated`.
   - Servers that see the library under another path (Plex at `/media/movies`, say) get their own path: the folder's place under Marquee's library folder, put under that library's folder. No folder pairs to set.
   - The Downloads row says "Told Plex and Jellyfin to scan it." A server that didn't answer is named with the reason and asked again every 15 minutes for a day.
   - Migration 12: whether a scan is still owed, and what happened.
7. ✅ **Switch movies over** (page at `/switch-over`; `apps/server/src/compare/cutover.ts`, `downloads/wanted.ts`)
   - A checklist page where Marquee checks what it can itself, each step saying what it found and what to do:
     1. Marquee picks what Radarr would: at least 80% agreement over at least 10 compared downloads in the last two weeks.
     2. qBittorrent is connected.
     3. A movie went all the way into the library.
     4. Plex or Jellyfin is connected and answering.
     5. Radarr's queue is empty (read via `/api/v3/queue`).
     6. Radarr watches no movies. You turn that off in Radarr; the page gives the exact clicks. Marquee never changes Radarr.
     7. **Marquee looks for wanted movies**.
   - Step 7 is a switch, off by default. When it's on, Marquee searches for monitored movies with no file every 6 hours and checks movies you have for a better copy once a day. Each run takes 10 movies, longest-waiting first, and skips any with a download on the way. A copy is sent only when it beats your file under the title's profile ("good enough" and "keep looking for better" respected). Turning it on before the other steps are done asks first and warns about double downloads. **Look now** buttons and the last few runs, with what was sent, are on the page.
   - Migration 13: when Marquee last searched each movie.
   - **Josh, on the LAN**: work down the checklist, turn Radarr's monitoring off, then turn on step 7.

Milestone 3 is done in code. The real switch-over happens on Josh's server when the checklist is all ticks.

Later ideas from HolyArrs for M3 (ideas only): a History page per title and overall; "Downloader can change things" switch for a qBittorrent shared with Radarr during side-by-side; per-stage Health page.

## Milestone 4: TV ✅ (TV and Prowlarr can switch over here)

Goal: Marquee does Sonarr's job: it catches new episodes as they come out, finds the ones you're missing (whole seasons when that's better), upgrades until "good enough", and shows what's airing. Then Sonarr can stop, and once Sources live in Marquee, Prowlarr too.

1. ✅ **Switch TV over** (page at `/switch-over/tv`; `apps/server/src/downloads/wantedTv.ts`, `library/airing.ts`, `compare/cutover.ts`)
   - Migration 14: when Marquee last searched each episode, and an index on air dates.
   - **Marquee looks for wanted episodes** (a switch at the end of the TV checklist, off by default, separate from movies):
     - Every 30 minutes it reads each Source's **newest copies** for TV (older apps call this RSS; Torznab `t=tvsearch` with no terms) and sends any that are a missing episode of a show you watch, or better than yours. Copies are matched to shows by TVDB ID, else by name. Episodes TMDB doesn't list are ignored, and a whole-season copy only counts once the season has finished airing.
     - Every 6 hours it searches for aired episodes you don't have. When at least half of a finished season is missing it looks for the **whole season** in one copy first, then falls back to single episodes. Newest air dates first among the longest-waiting; 10 searches per run.
     - Once a day it checks finished seasons you have for a better whole-season copy, skipping seasons already "good enough" (or whose profile doesn't look for better copies), so Sources aren't asked for nothing.
     - **Specials** (season 0) are only searched when you ask, from the show's page.
     - Anything with a download on the way is left alone; a whole-season copy is never sent while an episode of that season is downloading.
   - Newest copies count toward a Source's daily limit, so a Source with a limit is only read while it has used under half of it; searches for titles keep the rest.
   - TV checklist: movies switched over first (instead of "picks what Radarr would": comparison mode only reads Radarr), qBittorrent connected, an episode went all the way into the library, Plex/Jellyfin connected, Sonarr's queue empty, Sonarr watches no shows (with the exact clicks), then the switch. Look-now buttons for each job and the last runs.
   - **Calendar** page (`/calendar`, everyone; kids see kids' shows only): episodes by day, each "In your library", "Downloading", "Not here yet", "Coming" or "Not watched", with what happens next. `GET /api/calendar?from=&days=`.
   - Shows still on the air are re-read from TMDB twice a day (up to 20 an hour), so new episodes and moved dates show up without a scan.
   - **Coming up this week** on Home is real once there are shows in the library, and links to each show and the calendar.
   - Demo mode: fake Sonarr at `http://sonarr:8989`, and Severance season 2 airs around today.
   - **Josh, on the LAN**: work down the TV checklist, turn Sonarr's monitoring off, then turn on the last step.
   - Not done: picking which episodes or seasons to watch inside a show (Marquee watches whole shows), and air *times* (TMDB gives dates only).
2. ✅ **Sources without Prowlarr** (`apps/server/src/sources/sites/`; design in `docs/superpowers/specs/2026-11-18-built-in-sources-design.md`)
   - Marquee runs sites itself from Prowlarr's catalogue of site files (Cardigann YAML, format v12, about 585 sites): `https://indexers.prowlarr.com/master/12/package.zip` is downloaded on your server once a day and never shipped with Marquee. Sites dropped from the catalogue stay while a Source uses them.
   - Your own files in `<data>/sites/*.yml` are added to the list and replace the catalogue's file with the same id.
   - The engine (`cardigann.ts`, `template.ts`, `filters.ts`, `text.ts`) behaves like Prowlarr's: Go-style templates (`if`/`else`/`range`, `and`/`or`/`eq`/`ne`/`join`/`re_replace`, off checkboxes as `.False`), CSS selectors through cheerio, JSON paths with `..` parent fields, the usual filters (dates in Go or .NET layouts, "3 hours ago", sizes), sign-in by form, post, get or cookie with error and test checks, signing in again when the session runs out, download links found on the copy's page, magnets built from a bare info-hash. 442 of the 481 movie/TV sites can run; the rest need a captcha to sign in and say "Not supported yet" with why.
   - Built in (Prowlarr has these in code, not files): **IPTorrents** (cookie and user agent) and **Knaben** (its JSON search service), ported from Prowlarr (GPL-3.0).
   - Settings → Sources → **Add a site**: search the list, fill in the form the site asks for (plain labels, help as text, secrets never sent back and kept when left blank), pick another of its addresses if one stops working. Checked straight away.
   - Downloads from sites carry the site's cookies and browser name, sent only to the site's own host.
   - **Bring sites over** (on the Prowlarr card): each Prowlarr site in Marquee's list becomes a site Marquee runs, keeping name, priority, limits and settings (Prowlarr's dropdown numbers converted). Prowlarr hides passwords and cookies, so those sites say what to type. **Put back to Prowlarr** undoes it; syncing leaves brought-over sites alone; unlinking keeps them.
   - New Source states: **Sign-in turned down** and **Not supported yet**.
   - Tried by hand against the real sites (`scripts/try-site.ts`): YTS, The Pirate Bay, LimeTorrents and Knaben search fine; EZTV and 1337x answer with a Cloudflare check, which needs item 3.
3. ✅ **Built-in bot-check solving** (`sources/sites/solver.ts`, `http.ts`)
   - Marquee speaks FlareSolverr's protocol. FlareSolverr (MIT, v3.5.2, with its own Chrome, checksum-pinned) is inside the image at `/opt/flaresolverr`; Marquee starts it as its own user on 127.0.0.1 the first time a site needs it, only when **Solve bot checks** is on (off by default).
   - For experts: any FlareSolverr-compatible solver's address instead (Byparr, a FlareSolverr container).
   - The pass (cookies and browser name) is kept per Source and reused until a bot check comes back. A solver that fails, or gets the check again, says so.
   - CI's container smoke test turns it on and checks it answers inside the image.
   - Kept up to date by `.github/workflows/flaresolverr.yml`: every Monday it checks for a new FlareSolverr release and opens a PR bumping the version and checksum, then runs the container test on it. Merge when green.
4. ✅ **Josh, on the LAN**: all Sources are set up inside Marquee (sites brought over, IPTorrents, bot-check solving working, including the sites that need it). Working so far; Prowlarr stops after a week of good searches.

5. ✅ **Wanted / not wanted** (`library/wanted.ts`, `downloads/wantedLimits.ts`)
   - Migration 16: every existing movie and show becomes **Not wanted**, and episodes get their own Wanted flag (on by default, only counts while the show is Wanted). Titles added by the scanner start Not wanted.
   - **Wanted** (the old "monitored" flag) is the only thing the wanted jobs look at. Movie and show pages (admin) have **Look for it / Stop looking for it**; shows also have a tick per season and per episode. Wanting a season or episode turns the show on. The TV jobs skip episodes you left out and never take a whole-season copy for a season with one left out.
   - Movies and Shows lists: a **Wanted** badge, a Wanted filter, and **Choose several** to change many at once.
   - Search: **Add and look for it** or **Just add** (new titles are Not wanted unless you choose the first).
   - Switch-over pages: how many are Wanted (with a link to choose), a **daily limit** on copies sent by itself (10 unless changed, 0 = no limit, movies and TV together, the run stops and says so), and **Preview** buttons that search as usual but send nothing and aren't remembered. The "Turn on" text says plainly when nothing is Wanted.
   - Calendar says "This show isn't Wanted" or "You left this episode out".
   - **Josh:** mark what you want (Movies/Shows → Choose several), press Preview, then turn on looking.

Later ideas: captcha sign-ins, proxies per site, a downloader per site, paging past the first page of results.

## Milestone 5: Family 🔨

Goal: the family can find something and ask for it, and Marquee tells the right people. Seerr retires. Ideas from HolyArrs's Explore and Requests pages (ideas only; it's AGPL).

Decided with Josh (2026-11-18):
- **Order:** Discover from charts and services first, then requests, then the personal rows get smarter after M6 brings watch history.
- **Requests:** an admin's request is approved at once, then searched and downloaded. A member's or kid's request waits for an admin, as in Seerr. (This replaces the older "members go straight through" line: every non-admin request now needs approval.) A request is for a whole show or chosen seasons. Approving makes the title **Wanted** (see M4 item 5), with the profile the rules pick unless the admin swaps it while approving. Declines carry a reason the requester can see. A title already in the library says "already here". No weekly limit by default; an admin can set one per person, as in Seerr.
- **Users** come from the Plex and Jellyfin user lists, not a Seerr import. Jellyfin sign-in and "pick people from the server's list" (Plex too, like HolyArrs) are added when they fit.
- **Kids** see Discover filtered by age rating only (the same G/PG, TV-Y to TV-PG rule as the library); no per-title overrides.
- **No "popular with the household" row.**

1. ✅ **Discover** (`/discover`, `apps/server/src/discover/`)
   - Rotating **hero banner** at the top (backdrop, title, rating, year, short blurb, Request button, trailer), then rows of cover art that show more on hover or focus (rating, year, genres, blurb, status, Request).
   - Tabs: **All / Movies / Shows**, plus **service chips** for Netflix, Max, Disney+, Apple TV+, Prime Video, Hulu, Paramount+ and Peacock (US catalogue). Each person can hide the ones they don't want in their settings. Service data comes from TMDB's watch providers (JustWatch); the page carries the attribution TMDB asks for.
   - Rows: Trending, Popular, Top rated, Upcoming, Now in cinemas, New this week on each service, Browse by genre, and for each person **Because you watched…**, **Because you asked for…**, **Because you have…** and **Top picks for you**. Rows only show when they have enough titles and each title shows once per page.
   - "Because you watched" reads each person's own Plex and Jellyfin history (matched to their account by Jellyfin link or name; episodes count for their show when it's in the library).
   - **Trailers** play on hover (desktop) or in the hero and title page, through YouTube's no-cookie player; each person can turn trailers off. Respects reduced motion.
   - Every card shows its state: in your library, downloading, requested, declined, not here yet.
   - Kids get only age-appropriate rows and titles. A title with no US rating is hidden from kids.
   - Demo mode gets a fake TMDB for all of this.
2. ✅ **Requests** (`/requests`, `apps/server/src/requests/`)
   - Request a movie, a whole show or chosen seasons from any card or title page. Admins' requests go through at once; others wait. Admin screen: approve (with a profile picker and season ticks), decline with a reason, approve all, remove, undo for a few seconds after declining. People see their own requests and a plain state for each: **Waiting for approval**, **Approved · looking for it**, **Downloading**, **Ready to watch**, **Declined** (with the reason).
   - Settings → Requests: optional weekly limit per person or role (none by default), which profile approved titles get.
   - Menu badge for how many wait, and Home's "Needs your OK" shows real waiting requests with an Approve button.
   - Approving adds the title, marks it Wanted (only the asked seasons for a show), sets the profile if picked, and searches at once, without the daily limit (that limit is for the automatic jobs). Ongoing looking for new episodes still needs the switch-over's "look for wanted" turned on.
   - Built and tested: ask (admins' go straight through), approve with a profile and seasons, turn down with a reason, undo, take back, remove, "already here", "already asked for", kids can only ask for kid-safe titles, "Ready to watch" told once.
3. ✅ **Notifications** (the layer everything funnels through, built to carry what Radarr, Sonarr, Seerr and Tautulli send)
   - Channels: **Pushover** and **ntfy** (sent as JSON, so any title or emoji arrives as written), the **bell** inbox for everyone, iPhone push in M7. Each channel has a Test button and says plainly when it can't send.
   - **Settings → Notifications** has three parts: **For me** (everyone: a grid of every message down the side and the Bell plus your own phones across the top, with a switch for a whole group at once; your own Pushover/ntfy, only your messages go there), **Shared alerts** (admins: the shared places, like a family ntfy topic, as columns in the same grid) and **Wording** (admins).
   - **Wording**: every message has a title, message and picture made from its facts (`{{title}}`, `{{user}}`, `{{poster}}`…, plus `{{link}}`, `{{time}}`, `{{event}}` on all). `{{#reason}}…{{/reason}}` shows a part only when there's a value, `{{^reason}}…{{/reason}}` only when there isn't. Tap a fact to insert it, live preview with example facts, unknown names pointed out, "Put Marquee's wording back". Pictures: Pushover gets the picture itself (up to 2.5 MB), ntfy attaches it, the bell shows it. Migration 21: `notification_templates`, `notification_channels.user_id`, `notifications.image`.
   - Events (groups): **Requests** (waiting, approved, turned down, ready to watch, new episode of a show you asked for), **Downloads** (finished, stuck or failed, added to the library, upgraded, wanted episode aired), **Problems** (Source, downloader, Plex/Jellyfin), **Watching** (started, finished, converting, paused, resumed; off until you turn them on), **Marquee** (updated to a new version; quiet on first start and dev builds).
   - Muting an event (unticking it under Bell) stops it everywhere for that person, phones included.
4. ✅ **Users from Plex and Jellyfin**: Settings → Users → "Add people from Plex or Jellyfin" lists the server's people (Plex: you and the friends it's shared with; Jellyfin: its enabled users), you tick who and pick a role, and they get a password-less account linked to that server. Plex people sign in with Plex (as before); Jellyfin people use "Sign in with my Jellyfin password" (Marquee passes it to Jellyfin and never stores it). Nobody is created at sign-in, so only people you picked can get in. Migration 18 adds the Jellyfin link.
5. ✅ **Retire Seerr**: Switch over → Seerr. Marquee checks Discover works, the family has accounts and has signed in, a push channel has delivered, and a request reached the library; the last two steps (tell the family, turn Seerr off) are yours. No import from Seerr.

## Milestone 6: Stats 🔨

How it works (the way Tautulli does it, for Plex and Jellyfin both):
- **Live line + a quick look.** Marquee keeps a websocket open to Plex (`/:/websockets/notifications`) and to Jellyfin (`/socket`, asking for `SessionsStart`). Each message is only a nudge: Marquee then reads what is really playing from the server, compares it with what it saw before, and records the difference. While anything plays it also looks every 10 s (5 s with no live line); idle, every 60 s (30 s). A dropped line reconnects by itself (5 s, doubling to 1 min), so nothing depends on it.
- **Streams are recorded as they happen** (`streams` table, migration 20): who, what, device, app, picture size, converted or direct, start and end, and **watched time that only counts while playing** (a pause doesn't count; gaps over a minute aren't counted). Autoplay's next episode is its own stream. If the server stops answering, streams are kept for 2 minutes and then closed; a restart closes any left open.
- **History is copied too** (`plays`, migration 19) from each server's own history every 15 minutes, so the time before Marquee was watching is included.
- Read-only towards Plex and Jellyfin, except stopping a stream when an admin asks.

Done:
- ✅ **Activity page** (admin only): Watching now, pushed live to the page (server-sent events, falling back to asking every 15 s); 30-day chart; busiest hours and days; time watched, streams, most at once, direct vs converted; top people, movies, shows, apps and picture quality; library size by picture size and video format; people list; history with Update now.
- ✅ **Stop a stream**: "Stop…" on any stream, with an optional message the viewer sees. Plex: `/status/sessions/terminate` (Plex only allows this with a Plex Pass; the page says so when it refuses). Jellyfin: shows the message, then stops playback.
- ✅ **People pages**: what each person watches most, recent streams (how long, which device, picture size) and history. People are matched to Marquee accounts by name.
- ✅ **Who's watched** on every movie and show page.
- ✅ **Notifications**: someone started watching, finished watching (30 s or more, with how long), a stream is being converted, paused, resumed (all off until you turn them on, per channel), and Plex or Jellyfin stopped answering (on by default).
- ✅ **Retire Tautulli** checklist (Switch over → Tautulli).

Not done, on purpose:
- ✅ **Watched sync** (Settings → Watched sync, admin; replaces WatchState): watched on either server means watched on both. Marquee only adds ticks, never removes them. A person is a Marquee account linked to both Plex and Jellyfin. Titles are matched by TMDB, TVDB or IMDb id (episodes by the show's id, season and episode). Plex family members' own server keys come from plex.tv's sharing list, using the admin token, so nobody's token is stored. Off by default; "See what would change" previews per person, then every 30 minutes when turned on. Every tick is logged (`watch_sync_log`, migration 22), and a whole run can be undone. Not tried against real servers yet: check the preview on your LAN before turning it on.
- ✅ **My history** (`/history`, everyone but admins in the menu; `GET /api/activity/mine`): what you watch most, recent streams and everything you watched, only your own. Admins see everyone's on Activity.
- ⬜ Tautulli's old history isn't imported; IP addresses and locations and newsletters are left out for privacy and upkeep.
- ⬜ Rules to stop streams automatically (limits per person); only stopping by hand.

## UI overhaul ✅ (before the iPhone app)

From the [UI audit](design/ui-audit-2026-11.md) (scored 24/40). Six phases; the iPhone app copies the result.

1. ✅ **Clear out**
   - Compare, the four switch-over checklists (Movies, TV, Seerr, Tautulli), their routes (`/api/compare`, `/api/cutover`, `/api/retire-*`), the hourly comparison job and the Radarr history client are gone. The `comparisons` table stays (migrations are append-only).
   - Their live controls moved to **Settings → Automatic searching** (`/api/automation`): the "look for wanted" switches, the daily limit, Look now with a "Preview only" switch, and recent runs.
   - **Home is real**: `/api/home` returns a hero (Now showing → Ready to watch → Just arrived), Needs you (requests to approve, stuck or failed downloads, qBittorrent, failing Sources, Plex/Jellyfin problems, folders to match; problems first), On its way, your own requests (members and kids), Just arrived, This week and a footer of numbers. No sample data anywhere.
   - Discover's carousel dots no longer cover the Trailer button on phones.
2. ✅ Tokens and shared components: type scale (caption → display), three radii, status ink colours, no raw hex or arbitrary sizes left. `components/Page.tsx`: PageHeader (Inter title, ⓘ for how-it-works, sets the tab title), InfoTip, StatusDot, Tabs, EmptyState; `Switch` in ui.tsx; `Bulbs`. Every page heading now uses PageHeader. `components/Overlay.tsx`: **Menu** (arrow keys, Escape returns focus; the avatar menu uses it), **Sheet** (native `<dialog>`; slides up on phones, centred on desktop), **Toast** with **Undo** (Library's "Look for these / Stop looking for these" uses it; Undo puts each title back as it was). `components/CommandBar.tsx`: **⌘K / Ctrl K** or "Go to…" in the sidebar finds pages, Settings pages and library titles, and offers "Look for … to add".
3. ✅ Navigation done: grouped sidebar (main · Activity · Manage), phone tab bar of five, avatar menu with Sign out (no bare icon); checked in the demo at desktop and 375px. One **Library** page with a Movies/Shows switch (`/library/movies`, `/library/shows`; `/library` opens the one you used last; old `/movies` and `/shows` list links redirect, title pages keep their URLs). **Settings home** grouped You · Getting things · Your servers · Marquee, each with a one-line summary; on wide screens a side list, on phones a back link. **Quality** lives at `/settings/quality` (`/quality` redirects). Longer explainers on Settings pages cut to one sentence, the rest behind ⓘ; ⓘ notes stay on screen.
4. ✅ Decided: Calendar is no longer in the nav; Home's This week links to it ("Full calendar →") and ⌘K finds it. The word "Wanted" stays. Done: **Get set up** checklist for admins (`HomeData.setup`; TMDB key, scan, qBittorrent, a Source, then optional Plex/Jellyfin and family; gone once the four musts are done). Members and kids get a row from Discover ("Because you watched…" or Top picks); kids also get "Ask for something". **Poster colour**: `library/posterColor.ts` (sharp) picks each poster's main colour from TMDB's smallest image, nudged to work on the dark background, and saves it with the poster it came from (migration 23). A job runs every 10 minutes for new titles, changed posters and the first backfill; network failures retry, missing images aren't fetched again. Library cards, Home titles and the Home hero carry it; poster tiles use it while loading and the hero glow takes it.
5. ✅ Art and motion: title pages glow in their poster's colour and put admin tools in tabs (Files or Episodes · Copies · Downloads · Watched, `?tab=`); posters in Library and Home grow into the title page (View Transitions, off with reduced motion); Home rows get a faint wash of their first poster's colour; the sign-in screen has a drifting wall of popular TMDB posters (`/api/auth/wall`, never your library, cached 6 h); Downloads rows lead with the poster and plain status, with Pause / Try another copy / Remove in a ⋯ menu and the copy name under Details.

### UI round 2 (Nov 2026) ✅

- **Bell**: the notifications panel opens towards whichever side has room, and the sidebar sits above the page so nothing covers it.
- **Discover**: a search box (`/api/discover/search`, kid-safe for kids; results open the title page to ask for it). Row order: Trending → services' Top 10s → **Latest releases** (movies out to stream or buy in the last month, by US digital release date, plus new shows on your services) → the other everyday rows → "Top picks" and "Because you…" last.
- **Top 10s, done like HolyArrs**: TMDB's "popular on Netflix" ranks by overall popularity, so the same big titles showed on every service. With an optional **Streaming Availability** key (Settings → Services; RapidAPI or Movie of the Night, kept 12 h in `tmdb_cache`) each service's own Top 10 is shown, numbered. Without one, or for Peacock (no list there), TMDB's popular list is shown **unnumbered** as "Popular on …", and admins are told why. Services now carry every TMDB provider id they use: Paramount+ is 531 + 2303 + 2616 (most titles moved to the Essential/Premium ids, which is why it looked nearly empty), HBO Max 1899 + 384, Netflix 8 + 1796, Prime 9 + 2100, Peacock 386 + 387.
- **Library**: no Scan bar once the library has been scanned. A **More ⋯** menu at the end of the filter row: Scan for new files (with when it last ran), folders that need a match, Choose several, Add a movie/show, What's coming out, Quality profiles, Library folders and file names. The scan only takes space while running, after a failure or warnings, or before the first scan.
- **Home**: a **Recent requests** row (admins: everyone's; others: their own) with each one's state (waiting, approved, downloading, ready, turned down). The banner shows the TMDB score and votes, age rating, kind (Show · 2 seasons), year, length, genres and the description.
- **Calendar**: Wanted movies' US **in cinemas**, **out to stream or buy** and **on disc** dates (migration 24 adds `cinema_release`, `digital_release`, `physical_release`; filled by the scanner and refreshed twice a day for Wanted movies and anything from the last year) next to episodes, on the Calendar page (Everything/Shows/Movies) and Home's This week.
- **Downloads** is a dense table: Title, Status, Done, Size, Speed ↓/↑, Left, People, Shared (ratio), Quality/Source, Added; columns drop out on narrower screens. Filters (Everything, On the way, Finished, Needs a look) and a text filter. Opening a row reads qBittorrent live (`GET /api/downloads/:id`): fetched and shared bytes, speeds, people connected of known, added/finished, running and sharing time, save folder, category, tracker host only (tracker addresses can carry keys), info-hash, library files and the file list with progress, for finished downloads too. Migration 24 also keeps upload speed, peers and bytes shared on each check.
- Tests: `test/ui-round.test.ts`, plus Top 10, search and row-order tests in `test/requests.test.ts`. Demo mode has a fake Streaming Availability.

### UI round 3 (Nov 2026) ✅

- **One title page** (`pages/Title.tsx`) for library and Discover titles. Discover's page sends you to the library page once the title is there (or a request for it is approved), so asking for something lands you on its own page with no "Open it" link. Discover cards open the library page directly when there is one.
- **Hero**: age rating, year, length, genres; **scores** for TMDB and, with an optional **OMDb** key (Settings → Services, `library/omdb.ts`, kept 3 days), IMDb, Rotten Tomatoes and Metacritic; one plain **status line**; Request / Trailer / Find a copy / **Wanted** switch in one row; "Streaming on" with service logos. Add-on channels and ad plans fold into the service (`cleanProviders`: "HBO Max Amazon Channel" → HBO Max).
- **Tabs and the Wanted bar are gone.** Movies: **Your copy** (quality, size, "Where it is" folded away) with Find a copy / Find a better copy in a Sheet. Shows: **Seasons** with a progress bar, a Wanted switch and **Find copies** on each season, and Wanted + **Find / Replace** on each episode (the Sheet opens on that season and episode and searches at once). **On its way** shows active downloads; **History** is one timeline of downloads, plays (Plex/Jellyfin) and when it arrived.
- **Cast with photos** in a row; each opens a **person page** (`/discover/person/:id`, `GET /api/discover/person/:id`): photo, born, bio, and everything they've been in (Everything/Movies/Shows), each with its state. **More like this** and Details on every title page.
- **Request flow**: approval answers within 1.5 s; a slower first search carries on in the background and the request says **Searching…** (new `searching` state), then moves on by itself (the page checks every few seconds). A sent copy reads "Found a copy. The download is starting." until it has progress, then "Downloading now · 42%". A **progress strip** (Approved → Searching/Still looking/Waiting for it to come out → Downloading → Ready) shows on the title page. Requesting updates every Discover row, search result and Home at once. **Downloads** in the menu and phone tab bar shows a count while anything is on its way (`GET /api/downloads/summary`).
- **When a movie is out** (`library/availability.ts`): in cinemas isn't out. A movie is searched for once its digital or disc date has come, or 90 days after the cinema date when TMDB has no digital date (like the arrs' "Released"). Requests and title pages say "In cinemas now · to stream or buy around Feb 18, 2027"; Details shows each US date, plus the 90-day guess marked as one.
- **Scan prompt**: Marquee remembers that the library has been read (`library.last_scan_at`, or any known files) after a restart, so Library no longer asks to scan again.
- **Discover**: the Everything/Movies/Shows chips and the genre dropdown are gone. Search works as you type, with a Movies/Shows switch on the results when both turn up. **Browse by genre** tiles open a genre's rows, which have their own Movies/Shows switch.
- **Home**: no search box. "Needs you" and "On its way" moved into a pill on the banner that opens a Sheet, so the banner is taller. Just arrived is one sideways row; **This week** is a row of pictures with the day on each; Recent requests moved below, with short labels that stay on one line; **Your library in numbers** tiles (movies, shows, episode files, added this week, size, free space, automatic searching).
- Sideways rows line up with the page edge (scroll padding) and use the phone's 16px gutter; checked at 375px with no sideways scroll.
- Tests: `test/title-page.test.ts` (scores, OMDb key, people, providers, when a movie is out), plus the searching state in `test/requests.test.ts`, cinema rules in `test/wanted.test.ts`, the scan memory in `test/library.test.ts`. Demo mode has a fake OMDb.

## Replace everything ✅ (gaps from the replacement audit)

[`docs/design/replacement-audit-2026-11.md`](design/replacement-audit-2026-11.md) compares Radarr, Sonarr, Prowlarr, Seerr, Tautulli, WatchState, Profilarr and their helpers screen by screen, with Josh's decisions (2026-11-22). Seven rounds; **1 (backups, logs, Health page, disk space) and 2 (unpack .rar, Never pick list, one History page) come before Radarr and Sonarr are turned off.** Then library care (remove, rename with preview, manual import, subtitles along), getting titles in (show presets, collections, Plex watchlist and Trakt/IMDb/Letterboxd lists), profiles (Dictionarry as the default database with TRaSH kept, rule updates in the app, own rules, test a name), family (Something wrong?, webhook, iCal) and watching (sync on stop, resume points, Tautulli import).

### Round 1: Run it safely ✅

- **Backups** (S1, Settings → Backups, `system/backups.ts`): SQLite's online backup to `<data>/backups/marquee-YYYYMMDD-HHMMSS-<nightly|by-hand|before-restore>.sqlite`. A nightly backup (the job checks hourly, backs up when the last nightly one is a day old) kept **14 days**, never removing the newest. **Back up now**, **Download**, and **Restore** behind a confirm sheet: the backup is checked first (whole, a Marquee database, not from a newer version), a "before a restore" backup of how things are is taken, then every table is replaced in one transaction (all or nothing, in place, so no restart) and an older backup is brought up to this version by the usual migrations. Restoring that safety backup undoes it.
- **Logs** (S2, Settings → Logs, `system/logs.ts`): every `console` line is kept in memory (newest 5,000, until a restart) and still printed for the container log. Secrets are taken out before a line is kept or printed: keys and tokens in addresses, `user:password@`, `Authorization`/`Bearer`/`X-Api-Key`/cookies, and every saved secret by value (settings, Source keys, site settings, notification channels; re-read each minute). Filter Everything / Warnings and problems / Problems only, find words, **Download** as a text file.
- **Health** (S3 + S4, Settings → Health, `system/health.ts`, `system/jobs.ts`): every connection with the same state words and fixes as their own pages (each Source, qBittorrent, Plex, Jellyfin, TMDB, bot-check solver), each linking to where it's fixed. Every background job is now registered in one `Jobs` list (follow downloads, wanted searches, connection checks, copy watches, watched sync, air and release dates, poster colours, Prowlarr sync, site list, nightly backup, sign out old sessions, and the library scan by hand) with what it does, how often, last run and how it went (kept across restarts), next run, and **Run now**. A job never runs twice at once; a switched-off job says where to turn it on. Home's "Needs you" shows a nearly full disk or a failed job.
- **Free space** (S5 + L20, `system/disk.ts`): downloads, movies and TV folders with free space and a bar. Marquee **keeps 20 GB free** by default (Health → For experts, with the downloads folder; 0 turns it off): it won't send a copy to qBittorrent, or copy a finished download into the library, when that would leave less, and says so with what to do ("Not enough room on the downloads disk (/data/torrents): 12.0 GB free, this needs 18.0 GB, and Marquee keeps 20 GB spare…"). Hardlinks take no space, so they still go ahead; an import that waits tries again by itself. Admins are told once when a disk goes under the minimum (new **A disk is nearly full** notification).
- Tests: `test/system.test.ts` (jobs, Health, backups and restore, logs and scrubbing, free space and the notification), plus the send guard in `test/automation.test.ts` and the copy guard in `test/importer.test.ts`. Demo mode lists a few jobs, takes real backups of the demo database, and fakes plenty of free space.

### Round 2: Downloads that don't fail quietly ✅

- **Unpack .rar copies** (D3, Unpackerr's job; `downloads/unpack.ts`): a finished download whose video is only inside a `.rar` set (`name.rar`, `name.r00`… or `name.part01.rar`…; sets in Subs/Sample/Proof folders are left alone; one set per episode in a whole season) is no longer called a fake. Marquee looks inside first (7-Zip's listing): a **password**, **no video**, or files that climb out of their folder mean a fake, which is turned down and replaced like any other. Then it checks the **free-space guard** (unpacked size on the downloads disk) and unpacks in the background into `<download folder>/.marquee-unpacked/<download id>/`, so the torrent is untouched and keeps sharing. The video goes into the library from there (hardlinked from Marquee's own folder, which is then removed, so it ends up moved: its own file, not a hardlink to the download) and the row says **In your library · sharing · unpacked** with what that costs in space. States: **Finished · unpacking**; **Couldn't unpack it** with what to do (damaged or missing parts wait for you, with Force recheck in qBittorrent then Try again; no room or no tool are tried again every 15 minutes). **Try another copy** now also works on a finished copy that never made it into the library. The tool is **7-Zip's official `7zz` 26.06** (RAR 4, RAR5, split sets), pinned by checksum in the Dockerfile (`MARQUEE_UNPACK_BIN`), installed in CI for the real-unpacking tests, and checked by the container smoke test (unpacks `test/fixtures/archives`, Health says Ready). Health has an **Unpacking .rar copies** row. `node-unrar-js` was ruled out: no split sets.
- **Never pick** (D1): `GET /api/never-pick` (all, or `?movieId=` / `?seriesId=`) and `DELETE /api/never-pick/:id` (**Remove from list**, admins). Title pages show a **Never pick** section (copy, reason, when) when there are any; **Downloads → Never pick** lists every title's.
- **One History** (D2): a `history` table (migration 25, only ever added to; filled in from existing downloads when it runs) records **Sent**, **In your library**, **Upgraded** (with the file set aside), **Replaced** (turned down, with why), **Removed** (by hand, done sharing, or in qBittorrent), **Couldn't put it in your library** (once per new reason) and **Taken off Never pick**, with who did it. `GET /api/history` filters by what happened (`event=a,b`), words in the title or copy name (`q`), days (`from`/`to`, YYYY-MM-DD) and title (`movieId`/`seriesId`), newest first, paged (`before` = the last page's `next`). **Downloads → History** has chips for each kind, a words box and From/To dates; each row links to its title. The title page's History timeline reads the same table and links to "Every download of it, in the History".
- Tests: `test/unpack.test.ts` (finding sets, reading 7-Zip, every unpack path with a fake 7-Zip, the real `7zz` against RAR5/RAR 4 files from our own writer `test/fakes/rar.ts` when it's installed), `test/history.test.ts` (events, filters, paging, Never pick, the migration's backfill), plus updated fake rules in `test/monitor.test.ts`. Demo mode: copies ending in `-SCENE` finish as `.rar` files and unpack with a fake 7-Zip in a few seconds.

### Round 3: Library care ✅

- **Remove a title** (L1, title page → More, `library/remove.ts`): a preview lists its files (with subtitles), downloads on the way (stop and remove from qBittorrent, or just stop following) and requests (taken away). Removing never touches disk; **Also delete its files** names every file, needs a tick that it can't be undone, and only deletes exactly that list (409 if it changed); a folder goes only when empty. **Don't add it back when scanning** puts it on `left_out` (migration 26); scans skip its folder and TMDB id; Library → More → Left out of scans → Let it back in. Adding it again by hand or a request lets it back in.
- **Rename files** (L2, `library/rename.ts`): per title (More) or whole library (Library → More), always a preview (old → new), same-disk moves only. A renamed folder brings everything in it along; subtitles are renamed to match; a clash leaves the title alone. Applies only moves that match a fresh plan, whole titles only. Updates library records and downloads' imported paths, tells Plex/Jellyfin, records the run in `renames` with Undo (toast, and Earlier renames).
- **Put files in your library** (L3, `/library/import`, `library/manualImport.ts`): browse the downloads or library folders, Marquee guesses each video (library, then TMDB), change it, put in: hardlinked with clean names, or moved when already in a library folder.
- **Refresh from TMDB** (L6): clears that title's cached TMDB answers and fetches again, keeping folder, profile and Wanted.
- **Library filters** (L9, `library/filters.ts`): Wanted, nothing yet (shows: Wanted episodes missing) and Not good enough yet; **Look for these** now marks Wanted and searches right away (`/look-now`).
- **Subtitles come along** (L16, `library/extras.ts`): `.srt .ass .ssa .vtt .sup .sub/.idx` beside a video or in Subs folders, renamed with language/forced/SDH tags; set aside with the video on an upgrade.
- **Replaced files** (L18): Settings → Health shows the `.marquee-replaced` size and what emptying frees (hardlinks still shared free nothing); Empty behind a confirm.
- History gains **Renamed** and **Removed from Marquee** (migration 26 rebuilds its check). L13 skipped: no real misses. Tests: `test/libraryCare.test.ts`. Demo mode has Radarr-style names, two finished downloads to put in, and a replaced file.

### Round 4: Getting titles in ✅

- **Which episodes** (L8, `library/showPresets.ts`): every episode, only new episodes, the latest season, the first season, or nothing, chosen when adding a show (Search), approving a request, on an admin's own request, and on the show's page (Want in one go). Specials are never wanted by a choice. A new `series.want_new` decides whether seasons that appear later are wanted ("the first season" says no).
- **Collections** (L7, `library/collections.ts`, `/collections/:id`): TMDB's collections with where each film stands; a movie's page links to its collection; **Want the whole collection** adds every film as Wanted and follows it, so the daily **Follow collections** job adds films TMDB lists later (never one you removed). Kids see only kid-safe films already in the library.
- **Lists** (L19 + R2, `library/lists.ts`, Settings → Lists): each person's **Plex watchlist** (read every 15 minutes with their own Plex token, now kept from signing in with Plex, never shown and scrubbed from logs) becomes their request, approved by role as usual (kids: not-for-kids titles are left out and say so). **Trakt** (needs a free app key), **IMDb** (public lists and watchlists) and **Letterboxd** (lists and watchlists; each film page read once for its TMDB id) add new titles as Wanted every 6 hours, with the list's profile and episodes choice. A title is handled once, when it first appears; nothing is ever removed. **Never add from lists** (exclusions). Each list shows what it added and why not. Migration 28.
- Tests: `test/gettingIn.test.ts` (fake TMDB collections and our own made-up list pages). Demo mode answers any Letterboxd, IMDb list or Plex watchlist with a few titles.

### Round 5: Profiles (replaces Profilarr) ✅

- **Dictionarry is the default** (P3, `releases/dictionarry.ts`, `catalog.ts`, `dictWords.ts`). Its v2 database is SQL steps on a schema; `pnpm --filter @marquee/server dictionarry:update [commit]` replays them into a throwaway SQLite and writes `releases/dictionarry/{radarr,sonarr}.json` (pinned like TRaSH; MIT, declared in its `pcd.json`, schema's MIT licence kept in `LICENSE`). Every test maps to the Radarr/Sonarr test the engine already runs (release title/group patterns, resolution, source, quality modifier, language incl. "original", site flags, size, release type, and a new year test); per-app tests and points are kept apart (Sonarr's own source numbers and remux names). Nothing in the pinned copy is unmapped; the flags Marquee can't see (Golden Popcorn, 25/50/75% freeleech) never match and say so. Every rule has plain words built from its name (tiers of trusted groups, streaming services, sound…) and sits under a heading from Dictionarry's own tags.
- **Presets rebased**: 4K Quality on **2160p Efficient**, Everyday HD on **1080p Efficient**, Kids & Cartoons on **1080p Compact** (was 720p; Josh to confirm), for movies and TV. Like Profilarr sets them up: one quality group ranked by points (min 200,000, "good enough" at 1,000,000 so better copies are still checked a few a day), and repacks win by their small points rather than outright (new per-profile **"A fixed copy beats others first"**, off for Dictionarry, on for TRaSH and older profiles). Dictionarry sets no size limits. Existing installs: built-in profiles never edited move to Dictionarry **once** (migration 27 + `profiles.dictionarry_rebased`); ones you'd changed stay on TRaSH, and the Quality page says which (dismissable). **Put back Dictionarry's values** moves a kept one over. TRaSH stays a choice: New profile → Start from lists every Dictionarry and TRaSH profile.
- **Rule updates** (P2, `releases/ruleUpdates.ts`): a weekly job (**Check for rule updates**, on the Health page) downloads Dictionarry's newest commit and its schema as two tarballs, builds it and keeps it waiting. Settings → Quality → Rule updates shows what changes per profile (new points, rules added/no longer counted, settings) and rules whose tests changed; **Apply update** does a three-way merge: points you never changed follow Dictionarry, yours are kept, and where both changed the rule is flagged (**Use theirs** / **Keep mine**). A failed check says why and tries again in a day.
- **Your own rules** (L22/P4/L23): words in the name, made by a group, has a language (incl. the title's own), or a pattern (for experts), each with points in any profile; they show in the profile under "Your own rules".
- **Try a name** (P5): paste a copy's name on any profile: would it be taken, why not, its quality and group, and every rule's points.
- Tests: `test/dictionarry.test.ts` (reading our own small Dictionarry, tarballs, the pinned copy's rules and words, the presets on real-looking names and the real corpus, the once-only move with its note, Try a name, own rules, rule updates with conflicts), engine tests kept on TRaSH-built profiles (`trashPreset`/`trashPresets` in `test/helpers.ts`). Demo mode has a rule update waiting.

### Round 6: Family ✅

- **Something wrong?** (R1, `requests/issues.ts`, `/api/issues`): on every title in the library, for anyone: picture, sound, subtitles, the wrong title or something else, for the whole show, a season or one episode, with a note (needed for "something else"). Admins hear about it (new **Someone says something's wrong** notification) and see every report under Requests → Something wrong?, with **Find a better copy** (opens the title's search) and **Mark fixed**. Replies go both ways with notifications (**A reply about a problem you reported**, **Someone replied about a problem**, **A problem you reported is fixed**). Everyone else sees their own reports; a title page notes its open reports.
- **Requests skip approval** (R4): a per-person switch in Settings → Users. Kids can only ever ask for kids' titles, so for them it applies to those.
- **Weekly limits** (R11): a per-person "requests a week" (0 = none) in Settings → Users, enforced when asking (turned-down requests don't count; it says when the next one frees up), and shown before asking on title pages and Requests ("2 of 5 requests left this week"). `GET /api/requests/allowance`.
- **Webhook channel** (R9): Settings → Notifications → Add → Webhook: one JSON POST per message (`event`, `title`, `body`, `link`, `image`, `vars`, `sentAt`), with an optional secret sent as `Authorization: Bearer`. Works for shared and personal channels.
- **Calendar link** (S13): Calendar → In your calendar app: a private iCal link per person (`/api/calendar/ical/<secret>.ics`, 30 days back to 120 ahead, all-day events), New link turns the old one off; kids get kids' titles only.
- Migration 29 (rebuilds `notification_channels` for the webhook kind). Tests: `test/family.test.ts`.

### Round 7: Watching ✅

- **Sync right after a play stops** (W3): Activity's live line to Plex and Jellyfin calls back when a play of 30 seconds or more ends, and watched sync runs about 20 seconds later (plays ending close together share one run), as well as every 30 minutes. No webhook receiver needed.
- **Resume points** (W1): watched sync now also copies where someone stopped, for titles neither server counts as watched: the server played more recently passes its place on (differences under a minute are ignored). On by default, **Resume points too** on Settings → Watched sync. Plex: `/:/progress`; Jellyfin: `POST /Users/{id}/Items/{item}/UserData` (PlaybackPositionTicks).
- **Why it's converting** (W12): Plex's decisions (subtitles drawn on, picture or sound converted from → to) and Jellyfin's TranscodeReasons, in plain words, on Activity and in the **A stream is being converted** notification (`{{reason}}`).
- **Not watched** (W16, `activity/unwatched.ts`, Library → More → Not watched): titles with a file nobody has played, or not in a year, from the plays Marquee copies (and Tautulli's, if brought in). Read-only.
- **Tautulli's history** (W5, `activity/tautulli.ts`, Watching → Bring in Tautulli's history): reads its API (`get_history`, 1,000 at a time) once; plays Plex already gave Marquee (same person and item within six hours) aren't added twice; each import can be undone (migration 30, `plays.import_batch`). The key is used for that import and not kept.
- Tests: `test/watching.test.ts`, plus `test/watchSync.test.ts` for the servers' resume fields. Demo mode brings in two old plays from any Tautulli address.

## Milestone 7: iPhone app ⬜

- ⬜ SwiftUI app against the same API (token auth for the app)
- ⬜ Home, Request, Downloads screens from the mockup
- ⬜ Push notifications (APNs) for "ready to watch" and approvals; Lock Screen Live Activity for downloads
- ⬜ Needs a Mac with Xcode and an Apple developer account
