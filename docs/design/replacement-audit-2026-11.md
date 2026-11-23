# Replacement audit (Nov 2026)

What Radarr, Sonarr, Prowlarr, Seerr, Tautulli and WatchState can do, screen by screen, against what Marquee does today. Also the helpers around them (Profilarr, Unpackerr, qbit_manage, Wizarr, Homepage widgets, the arr phone apps) since turning the arrs off can quietly break those too.

Key: ✅ Marquee has it · 🟡 partly · ❌ missing.
**Lean** is Claude's suggestion: **Add** (needed to fully replace), **Later** (nice, not blocking), **Skip** (fine without, or against a settled decision), **Ask** (Josh's call).
**Decision** is filled in together.

## What's already covered (no action)

Most of the day-to-day is done. Tautulli's core (Activity, People, History, stop a stream) is section 4; Profilarr is section 6. For the record, these match or beat the old apps: library scan and match, TRaSH profiles and rules with plain reasons, profile-picking rules, interactive search ("Copies we found") with "Why?", automatic search for wanted movies/episodes, newest-copies polling (RSS), whole-season packs, upgrades until good enough, stuck/fake detection and "Try another copy", hardlink import with clean names, seeding rules per Source, Plex/Jellyfin scan on import, Calendar, Sources with built-in site engine and bot-check solving, Discover with rows/services/Top 10s/trailers/search, requests with approval and limits, cast and person pages, notifications (Pushover, ntfy, bell) with editable wording, Activity/People/History (Tautulli), stop a stream, watched-tick sync (WatchState).

## 1. Library and title management (Radarr / Sonarr)

| # | Feature | From | Marquee today | Lean | Decision |
|---|---|---|---|---|---|
| L1 | **Remove a title** from Marquee (with or without its files, optionally "don't add it back on scan") | Radarr, Sonarr | ✅ More → Remove from Marquee; delete files behind a confirm naming them; Left out of scans with undo | Add | ✅ **Done** (round 3) |
| L2 | **Rename existing files** to Marquee's naming, with a preview first | Radarr, Sonarr | ✅ Rename files, per title and whole library, preview, undo | Ask | ✅ **Done** (round 3) |
| L3 | **Manual import**: point at a folder of finished downloads (or one that failed to import) and say what each file is | Radarr, Sonarr | ✅ Library → More → Put files in your library | Add | ✅ **Done** (round 3) |
| L4 | **Edit a file's details** (quality, edition) when the name is wrong | Radarr, Sonarr | ❌ | Later | ⏸ Later *(suggested)* |
| L5 | **Media info** from the file itself (codec, audio channels, audio/subtitle languages, HDR from the stream, real runtime) | Radarr, Sonarr | ❌ quality is from the name only | Ask (needs ffprobe in the image) | ⏸ Later |
| L6 | **Refresh one title** from TMDB on demand | Radarr, Sonarr | ✅ More → Refresh from TMDB | Add | ✅ **Done** (round 3) |
| L7 | **Movie collections** (see a collection, want the whole thing, auto-add new films in it) | Radarr, Seerr | ✅ Collection pages, Want the whole collection, new films added daily | Ask | ✅ **Done** (round 4) |
| L8 | **Show monitoring presets** when adding: all, future episodes only, missing only, first season, latest season, none; and "want new seasons when they appear" | Sonarr | ✅ Which episodes: every episode, only new ones, latest season, first season, nothing (Add, approve, show page) | Add (at least "future only" and "latest season") | ✅ **Done** (round 4) |
| L9 | **Wanted → Missing / Not good enough yet** lists (everything wanted without a file, everything below "good enough") with bulk search | Radarr, Sonarr | ✅ Library filters with Look for these | Add | ✅ **Done** (round 3) |
| L10 | **Multiple library folders** per kind (e.g. a second disk, or a separate Kids folder) and pick one per title | Radarr, Sonarr | 🟡 one movie folder, one TV folder | Ask | ⛔ Skip: one of each |
| L11 | **Move a title** to another folder | Radarr, Sonarr | ❌ | Later (only matters with L10) | ⛔ Skip |
| L12 | **Tags** (label titles, Sources, notifications; filter by them) | all arrs | ❌ | Skip (profile rules cover what tags did) | ⛔ Skip *(suggested)* |
| L13 | **Alternate titles / original-language titles** used when matching copies | Radarr, Sonarr | 🟡 TMDB title, original title and ids; no alternate titles (e.g. "La Casa de Papel") | Add if real searches miss | ⛔ Skip for now: no name in `test/fixtures` misses for want of one (only other shows, or dubbed copies with the English title in brackets) |
| L14 | **Daily shows** (talk shows named by date, not SxxEyy) | Sonarr | ❓ parser handles SxxEyy; date-named copies untested | Ask (do you keep any?) | ⛔ Skip: no daily shows |
| L15 | **Scene numbering** (XEM: shows where TVDB and release names number episodes differently) | Sonarr | ❌ | Skip unless a real show breaks | ⛔ Skip *(suggested)* |
| L16 | **Extra files** next to the movie: subtitles (.srt), .nfo — import them with the video | Radarr, Sonarr | ✅ subtitles come along, renamed with language/forced tags | Add | ✅ **Done** (round 3) |
| L17 | **Metadata files** written for Kodi/Emby (nfo, posters in the folder) | Radarr, Sonarr | ❌ | Skip (Plex/Jellyfin fetch their own) | ⛔ Skip *(suggested)* |
| L18 | **Recycle bin** with cleanup after N days | Radarr, Sonarr | 🟡 `.marquee-replaced` kept forever | Ask (show its size and an "Empty" button?) | ✅ **Done** (round 3): Settings → Health → Replaced files |
| L19 | **Import lists**: Trakt, IMDb, Letterboxd, TMDB lists, **Plex watchlist** → added and wanted automatically, with exclusions | Radarr, Sonarr, Seerr (watchlist) | ✅ Settings → Lists: Plex watchlists, Trakt, IMDb, Letterboxd, exclusions | Ask (Plex watchlist → request is the big one) | ✅ **Done** (round 4) |
| L20 | **Minimum free space** before importing; checks free space on the download disk | Radarr, Sonarr | 🟡 "disk full" error after the fact | Add (cheap) | ✅ **Done** (round 1) |
| L21 | **Delay before grabbing** (wait N hours for a better copy, preferred protocol) | Radarr, Sonarr | ❌ HolyArrs idea "Held copies" noted for later | Later | ⏸ Later *(suggested)* |
| L22 | **Release must / must-not contain** words (release profiles) | Radarr, Sonarr | ✅ Settings → Quality → Your own rules: words, groups, a language or a pattern, with points per profile | Ask | ✅ **Done** (round 5) |
| L23 | Language preference per profile (e.g. original language, English audio) | Radarr, Sonarr | ✅ an own rule "Has a language" (English, the title's own language…) | Ask | ✅ **Done** (round 5, with L22) |

## 2. Downloads and queue (Radarr / Sonarr / Prowlarr / helpers)

| # | Feature | From | Marquee today | Lean | Decision |
|---|---|---|---|---|---|
| D1 | **Blocklist page** (every copy turned down, with reason, remove from it) | Radarr, Sonarr | ✅ Never pick on the title page and Downloads → Never pick, with Remove from list | Add (on the title page + one list) | ✅ **Done** (round 2) |
| D2 | **History page** across everything (grabbed, imported, failed, upgraded, deleted) with filters | Radarr, Sonarr, Prowlarr | ✅ Downloads → History, filter by kind, words and days | Add (one overall page) | ✅ **Done** (round 2) |
| D3 | **Unpack archives** (.rar copies, common on private sites / scene) | Unpackerr | ✅ unpacked with 7-Zip next to the download, then moved into the library | **Add** (otherwise IPTorrents scene copies fail) | ✅ **Done** (round 2) |
| D4 | **Manual search across all Sources** by free text, grab straight to qBittorrent | Prowlarr | ❌ search is always for a title | Ask | ⛔ Skip |
| D5 | **Source stats**: searches, grabs, failures, response time per site over time | Prowlarr | 🟡 health, today's count, timing; no history chart | Later | ⏸ Later *(suggested)* |
| D6 | Per-site **proxy** (HTTP/SOCKS) | Prowlarr | ❌ (already listed as later) | Skip unless a site needs it | ⛔ Skip *(suggested)* |
| D7 | **Minimum age / maximum size** per Source | Prowlarr, arrs | 🟡 sizes per profile | Skip | ⛔ Skip *(suggested)* |
| D8 | qBittorrent housekeeping: orphaned files, tracker errors ("unregistered torrent"), tags by tracker | qbit_manage | ❌ | Ask (do you run qbit_manage?) | ⛔ Skip: not in use |
| D9 | **cross-seed** (seed the same file on several sites) | cross-seed | ❌ | Ask | ⛔ Skip: not in use |
| D10 | Failed-download handling for a download that errors in qBittorrent (not just stuck) | Radarr, Sonarr | ✅ "Problem in qBittorrent" with what to do (usually disk/folder, so not replaced by itself) | — | ✅ Covered |

## 3. Requests and Discover (Seerr)

| # | Feature | From | Marquee today | Lean | Decision |
|---|---|---|---|---|---|
| R1 | **Report a problem** with a title (bad audio, wrong subtitles, wrong file) → admin sees it, fixes, replies; "Find a better copy" from there | Seerr (Issues) | ✅ Something wrong? on title pages (per episode for shows), Requests → Something wrong? with Find a better copy, replies, notifications | **Add** (family-facing, big for "totally replace") | ✅ **Done** (round 6) |
| R2 | **Plex watchlist auto-request** (add to your Plex watchlist → request appears) | Seerr | ✅ Each person’s Plex watchlist becomes their requests | Ask (see L19) | ✅ **Done** (round 4) |
| R3 | **Separate 4K requests** / 4K server | Seerr | Skip: one library, profiles decide | Skip | ⛔ Skip *(suggested)* |
| R4 | Per-user permissions finer than roles (auto-approve, request TV but not movies, see others' requests) | Seerr | ✅ Settings → Users: Requests skip approval (kids: kids’ titles only) | Ask (is "auto-approve this member" needed?) | ✅ **Done** (round 6) |
| R5 | Request **advanced options** (profile, folder, language) when asking | Seerr | 🟡 admin picks profile on approve | Skip | ⛔ Skip *(suggested)* |
| R6 | **Hide a title** from Discover (blocklist) | Seerr | ❌ | Later | ⏸ Later *(suggested)* |
| R7 | Discover by **studio / network / keyword** pages | Seerr | 🟡 genres only; person pages exist | Later | ⏸ Later *(suggested)* |
| R8 | Admin can **customise Discover rows** (order, add a TMDB list/keyword row) | Seerr | ❌ fixed order | Later | ⏸ Later *(suggested)* |
| R9 | **Email** and **web push** (PWA) notifications; **Discord / Telegram / webhook** | Seerr, arrs, Tautulli | ✅ Webhook channel (JSON POST, optional Bearer secret) | Ask (anyone in the family need email/Discord? a generic webhook is cheap) | ✅ **Done** (round 6) |
| R10 | **Invite** a new person (link that creates their Plex/Jellyfin access and Marquee account) | Wizarr | ❌ people must already be on the server | Ask | ⏸ Later |
| R11 | Request quota shown to the requester ("2 of 5 left this week") | Seerr | ✅ Weekly limit per person, shown before asking ("2 of 5 left this week") | Add (cheap) | ✅ **Done** (round 6) |

## 4. Watching and stats (Tautulli / WatchState)

| # | Feature | From | Marquee today | Lean | Decision |
|---|---|---|---|---|---|
| W1 | **Resume points sync** (stopped at 40 min on Plex → continue on Jellyfin) | WatchState | ❌ ticks only | Ask | ✅ Add |
| W2 | **Unwatched sync** (untick on one → untick on both) | WatchState | ❌ adds only, on purpose | Skip (safer) | ⛔ Skip *(suggested)* |
| W3 | Real-time sync from server webhooks instead of every 30 min | WatchState | ❌ | Later (live line from M6 could trigger it) | ✅ Add: sync right after a play stops, using the live line Activity already keeps to Plex and Jellyfin (same signal WatchState's webhooks give, no Plex Pass needed); a webhook receiver only if the live line misses things |
| W4 | Backup / export of watch state | WatchState | 🟡 log + undo | Later (covered by app backups, S1) | ⏸ Later *(suggested)* |
| W5 | **Import Tautulli's old history** | Tautulli | ❌ (left out on purpose) | Ask (Plex's own history is copied; Tautulli has more detail) | ✅ Add |
| W6 | Libraries page: media info tables (bitrate, codec, audio) per title | Tautulli | 🟡 library size by picture size and format | Later (depends on L5) | ⏸ Later (after L5) |
| W7 | Graphs: source vs stream resolution, by platform, by month | Tautulli | 🟡 most of it on Activity | Skip | ⛔ Skip *(suggested)* |
| W8 | **Newsletters** (weekly "new on the server" email) | Tautulli | ❌ left out | Ask (could be a weekly ntfy/Pushover digest instead) | ⛔ Skip |
| W9 | Concurrent stream / bandwidth warnings, buffering warnings | Tautulli | 🟡 "most at once"; no alert | Later | ⏸ Later *(suggested)* |
| W10 | Plex/Jellyfin **server update available** notice | Tautulli | ❌ | Skip | ⛔ Skip *(suggested)* |
| W11 | Automatic stream limits per person | Tautulli (scripts) | ❌ (listed) | Skip | ⛔ Skip *(suggested)* |
| W12 | **Why it's converting** (Plex/Jellyfin's transcode reason: subtitle burn-in, audio codec, bandwidth) on a stream | Tautulli | 🟡 converted vs direct only | Ask | ✅ Add |
| W13 | Notification **conditions** (only when this person, this library, only 4K converting…) | Tautulli | 🟡 per-event on/off per channel | Ask | ⛔ Skip |
| W14 | Per-library stats page (plays, most watched, never watched, last played) | Tautulli | 🟡 Activity tops are server-wide | Ask | ⛔ Skip |
| W15 | Per person: last seen, devices and apps used, totals by period | Tautulli | 🟡 People pages have recent streams and tops | Later *(suggested)* | ⏸ Later *(suggested)* |
| W16 | **Never watched** / not played in a year list (helps decide what to clear by hand) | Tautulli | ❌ | Ask | ✅ Add (read-only list; no deleting, per the no-automatic-deletion rule) |
| W17 | Export metadata/history to CSV | Tautulli | ❌ | Skip *(suggested)* | ⛔ Skip *(suggested)* |

## 6. Profiles (Profilarr)

Profilarr (v2) keeps a shared database of profiles and rules (Dictionarry), lets you edit them, and pushes them into Radarr/Sonarr. You'd planned it but hadn't finished setting it up; the 211 rules checked in M2 came from it.

| # | Feature | From | Marquee today | Lean | Decision |
|---|---|---|---|---|---|
| P1 | Edit profiles and rules in a UI | Profilarr | ✅ Quality page, every setting | — | ✅ Covered |
| P2 | **Follow an upstream database** and get its updates, keeping your own changes (shows a conflict when both changed) | Profilarr | ✅ Rule updates: weekly check of Dictionarry, see what changes, Apply; your points kept, flagged with Use theirs / Keep mine when both changed | Ask | ✅ **Done** (round 5) |
| P3 | Choose the database: **TRaSH** or **Dictionarry** (Profilarr's own, e.g. its 1080p/2160p "Quality"/"Efficient" profiles) | Profilarr | ✅ Dictionarry pinned (MIT, declared in its pcd.json) and the default; presets on 2160p Efficient, 1080p Efficient, 1080p Compact; TRaSH still a choice | Ask | ✅ Add, **Dictionarry is the default**, TRaSH kept as a choice. Josh prefers space-efficient encodes that keep quality. Check Dictionarry's licence first; then the presets (4K Quality, Everyday HD, Kids & Cartoons) are rebased on its efficient profiles. ✅ **Done** (round 5); Radarr comparison skipped (Josh) |
| P4 | **Write your own rules** (regex on name, group, source, size…) and reuse patterns across rules | Profilarr | ✅ (= L22): one rule, points in any profile | ✅ with L22 | ✅ **Done** (round 5) |
| P5 | **Test a copy name** against a profile: paste a name, see each rule's points and whether it'd be taken | Profilarr | ✅ Try a name on each profile | Add *(suggested)* | ✅ **Done** (round 5) |
| P6 | **History of profile edits** with undo / versions | Profilarr | ❌ | Ask | ⛔ Skip: backups are enough |
| P7 | Import/export a profile as a file (share or back up) | Profilarr | ❌ (backups S1 cover safety) | Later *(suggested)* | ⏸ Later *(suggested)* |
| P8 | Sync to several Radarr/Sonarr instances | Profilarr | n/a: Marquee uses its own | — | ⛔ Skip |
| P9 | Media management settings in the database (propers/repacks preference, naming) | Profilarr | 🟡 naming patterns editable; repack/proper is in ranking, no setting | Skip *(suggested)* | ⛔ Skip *(suggested)* |

## 7. System and running it (all of them)

| # | Feature | From | Marquee today | Lean | Decision |
|---|---|---|---|---|---|
| S1 | **Backups**: scheduled database backup, download one, restore one | every arr, Seerr, Tautulli | ❌ | **Add** (one SQLite file replacing six apps' state) | ✅ **Done** (round 1) |
| S2 | **Logs page** (recent, filter by level, download for a bug report) | every app | ❌ only container logs | Add | ✅ **Done** (round 1) |
| S3 | **Scheduled jobs page** (every background job, last/next run, Run now) | arr System → Tasks | 🟡 Automatic searching shows its runs; scans, syncs, refreshes don't | Add (folds in HolyArrs' Health page) | ✅ **Done** (round 1) |
| S4 | **Health page** in one place (Sources, downloader, Plex/Jellyfin, disk, TMDB, solver) | arr System → Status | 🟡 spread over Home "Needs you" and Settings cards | Add (one page linking to each fix) | ✅ **Done** (round 1) |
| S5 | **Disk space** per folder (downloads, movies, TV) | arrs | 🟡 free space total | Add (cheap) | ✅ **Done** (round 1) |
| S6 | **API key** for other tools (Homepage widgets, scripts, Home Assistant) | every app | ❌ session sign-in only | Ask (needed for M7 anyway as tokens) | ⏸ Later: nothing yet (widgets/apps go dark at cutover; M7 brings app tokens) |
| S7 | **Radarr/Sonarr-compatible API** so Homepage, Bazarr, Kometa, LunaSea/nzb360 keep working | arrs | ❌ | Ask (big; only if something you use depends on it) | ⛔ Skip for now |
| S8 | URL base (run under `/marquee` behind a proxy) | every app | 🟡 `MARQUEE_BASE_URL` sets the public origin; no sub-path | Skip if Pangolin gives it a subdomain | ⛔ Skip *(suggested)* |
| S9 | Update notice / changelog in the app | arrs | 🟡 "updated" notification | Later | ⏸ Later *(suggested)* |
| S10 | **Import from the old apps** (Radarr/Sonarr monitored state & profiles, Seerr requests & users, Prowlarr done) with undo | HolyArrs idea | 🟡 Prowlarr sites brought over; Radarr/Sonarr read-only for matching; no Seerr import (decided) | Ask (bring over Wanted from Radarr/Sonarr's monitored flags?) | ⛔ Skip: Josh marks Wanted by hand |
| S11 | Profile updates from TRaSH at runtime (Profilarr pulls new formats) | Profilarr | 🟡 `trash:update` at build time; ships with releases | Skip (new Marquee release = new rules) | ⛔ Skip *(suggested)* |
| S12 | Subtitles (download missing subtitles) | Bazarr | ❌ | Ask (is Bazarr in your stack?) | ⛔ Skip: Bazarr not in use |
| S13 | iCal calendar feed (subscribe in Apple Calendar) | Radarr, Sonarr | ✅ Calendar → private link (iCal), kids get kids’ titles | Ask (cheap) | ✅ **Done** (round 6) |

## Plan

Decided with Josh on 2026-11-22. Rows marked *(suggested)* are Claude's call and stand unless Josh changes them. Nothing left open.

Roughly in order: the first two rounds come before Radarr and Sonarr are turned off.

1. ✅ **Run it safely** (before cutover; one SQLite file now holds six apps' state). Done: Settings → Health, Backups and Logs; see PLAN.md.
   - S1 Backups: nightly database backup kept 14 days, Back up now, download, restore
   - S2 Logs page: recent lines, filter by level, download (secrets scrubbed)
   - S3 + S4 one **Health** page: every background job (last/next run, Run now) and every connection's state with its fix
   - S5 + L20 disk space per folder; don't import or send when the disk is nearly full, and say so
2. ✅ **Downloads that don't fail quietly** (before cutover). Done: unpacking, Downloads → History and Never pick; see PLAN.md.
   - D3 Unpack `.rar` copies (Unpackerr's job), then import as usual; the unpacked file is the only one that isn't a hardlink, and the row says so
   - D1 "Never pick" list on the title page and in one place, with Remove from list
   - D2 one **History** page across everything (sent, in the library, upgraded, replaced, removed), filterable
3. ✅ **Library care**. Done: see PLAN.md.
   - L1 Remove a title from Marquee; delete its files only behind a confirm; "don't add it back on scan"
   - L2 Rename files to Marquee's pattern, per title and whole library, preview first
   - L3 Manual import: pick a folder, say what each file is
   - L6 Refresh from TMDB on a title page
   - L9 Library filters "Wanted, nothing yet" and "Not good enough yet", with Look for these
   - L16 Bring subtitles (`.srt`, `.ass`) and other extras along with the video
   - L18 `.marquee-replaced`: size shown in Settings, Empty button behind a confirm
   - L13 alternate titles when matching, only if real searches miss
4. ✅ **Getting titles in**. Done: see PLAN.md.
   - L8 Show presets when adding or approving: everything, future episodes only, latest season, first season, nothing
   - L7 Movie collections: collection page, want the whole collection, new films in it added
   - L19 + R2 Lists: **Plex watchlist** (each person's, becomes their request, approved by role as usual), Trakt, IMDb, Letterboxd; an exclusions list
5. ✅ **Profiles** (replaces Profilarr). Done: see PLAN.md. The Radarr comparison was skipped (Josh, 2026-11-23).
   - P3 **Dictionarry as the default database**, TRaSH still available: licence check, import its rules and profiles, rebase the three presets on its efficient encodes
   - P2 Rule updates in the app: weekly check, see what changed, apply; your edits kept and flagged on conflict
   - L22/P4 Your own rules: words, groups or patterns in the name, with points (covers L23 language preference)
   - P5 Paste a copy name and see how a profile judges it
6. ✅ **Family**. Done: see PLAN.md.
   - R1 **Something wrong?** on title pages (picture, sound, subtitles, wrong title, other), a list for admins with Find a better copy, replies both ways
   - R4 Per person, "Their requests skip approval" (Settings → Users; kids still need approval for anything not kid-safe)
   - R11 Show what's left of a weekly limit before asking
   - R9 Generic webhook channel (JSON POST)
   - S13 iCal link per person (kids get kids' titles)
7. **Watching**
   - W3 Sync watched state right after a play stops, from the live line Activity already keeps (what WatchState's webhooks did)
   - W1 Resume points sync between Plex and Jellyfin
   - W12 Why a stream is converting (Plex/Jellyfin's reason)
   - W16 Never-watched / not played in a year list
   - W5 Import Tautulli's history (read its database or API once, with undo)

**Later:** P7 profile export, W15 more per-person stats, L4 edit a file's details, L5/W6 media info (ffprobe), L21 delay before sending, D5 Source stats over time, R6 hide from Discover, R7 studio/network pages, R8 custom Discover rows, R10 invites, S6 API keys (comes with M7's tokens), S9 changelog, W4 watch-state export, W9 stream warnings.

**Skipped:** L10/L11 more folders, L12 tags, L14 daily shows, L15 scene numbering, L17 Kodi metadata, D4 free-text search, D6 proxies, D7 Source size/age limits, D8 qbit_manage, D9 cross-seed, R3 4K requests, R5 request options, S7 arr-compatible API, S8 sub-path, S10 bring Wanted over, S11 runtime TRaSH updates, S12 subtitles download, W2 unwatched sync, W7 extra graphs, W8 newsletters, W10 server updates, W11 automatic stream limits, W13 notification conditions, W14 per-library stats, W17 CSV export, P6 profile edit history, P8 multi-instance sync, P9 media settings in the database.

**Heads-up at cutover:** dashboard widgets and phone apps that talk to Radarr/Sonarr go dark (decided: nothing yet).
