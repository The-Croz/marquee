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
