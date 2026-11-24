# HolyArrs releases: what to borrow (Nov 2026)

What HolyArrs shipped in its last few releases, and whether Marquee should do the same. Read on 2026-11-24:

- **1.3.0** (2026-11-23, the big one: about 190 lines of changes)
- **1.2.0** (2026-11-17)
- **1.1.0 to 1.1.4** (2026-11-12 to 11-14)

Where a note pointed at a feature, the matching page in HolyArrs' `docs/` was read too: `movies/downloads`, `downloads/vpn`, `run/health`, `run/updates`, `users/kids`, `requests/asking`, `library/media-servers`, `library/codecs-inspection`, `library/protected-copies`, `downloads/library-search`, `start/home-and-settings`.

**Status (2026-11-24):** ideas 1, 2, 3, 4, 6, 7 and 8 are built (see PLAN.md, "Ideas from HolyArrs 1.1–1.3"). Idea 5 is turned down (Josh).

**Ideas only.** HolyArrs is AGPL-3.0: nothing below copies its code or its doc text. Each idea is described in Marquee's own words (`docs/GLOSSARY.md`).

Checked against `docs/PLAN.md`, `docs/design/replacement-audit-2026-11.md` (codes like L5, S9 are its rows) and the code. Key: ✅ Marquee has it · 🟡 partly · ❌ not at all. Size: **S** about a day or less, **M** a few days, **L** more.

## Ideas, most worthwhile first

### 1. A dead VPN shouldn't cost you good copies · ❌ · S

**HolyArrs:** a download that stops making progress is still "stalled" after 6 hours and searched again after 24, but being stuck on its own no longer turns the copy down or deletes what's downloaded. The same copy can be picked again and carry on once the connection is back. A copy that keeps getting stuck waits longer each time before it's sent again. Their VPN guide is written around this: gluetun can look healthy while passing no traffic.

**Marquee today:** `downloads/monitor.ts:238` calls `tryAnother` once a download has had no progress for the give-up time (24 h). `tryAnother` (`monitor.ts:552`) puts the copy on **Never pick**, removes it from qBittorrent **with its files**, and sends the next best copy. Nothing checks whether *everything* is stuck at once, or whether qBittorrent says **No internet for downloads**.

**Why it matters for Josh:** qBittorrent runs behind gluetun. If the tunnel dies on a Friday night, by Saturday night every download on the way is on Never pick with its data deleted, and a new copy has been sent for each one (also stuck, also counted against Source limits like IPTorrents'). When the VPN comes back, Marquee refuses the copies it had already half downloaded.

**What to do:** don't count stuck time while the Downloader's health is **No internet for downloads**, or while every followed download stopped at about the same time (that's the connection, not the copy). Stuck because nobody is sharing a copy should still replace it. Optionally: stuck alone doesn't add to Never pick (a copy only goes on the list for a real reason, such as a fake or "you asked"), and a title whose downloads keep getting stuck waits longer before the next try. Add a symptom → fix row ("Everything says Stuck at once" → check gluetun; recreate gluetun and qBittorrent together).

### 2. A backup right before an update changes the database · ❌ · S

**HolyArrs:** when a new version needs to change stored data, it takes a backup first, and an older version started on the newer data offers to put that backup back (behind a one-time code from the container log).

**Marquee today:** nightly backups and Restore (`system/backups.ts`; kinds are `nightly`, `by-hand`, `before-restore`). Migrations run at start-up with no backup taken just before. The newest backup can be almost a day old when a migration runs, and Restore refuses a backup from a newer version.

**Why it matters for Josh:** there are 30 migrations and more land every round, all written with Claude and shipped straight to his Unraid box. One SQLite file now holds what six apps held. A backup named `before-update-<version>` whenever the stored schema version is behind costs a few lines, and makes "pull the previous image and restore" a real way back. Keep it with the nightly ones (14 days).

### 3. Requests say why nothing has been picked yet · 🟡 · S–M

**HolyArrs:** a request whose search found copies, none of which fit the rules, says so, instead of only "searching".

**Marquee today:** the **Looking** state says "Approved. No good copy has turned up yet. Marquee keeps looking." (`requests/service.ts:111`). The search already knows the reasons each copy was turned down (`releases/decide.ts`), but they're thrown away for requests.

**Why it matters for Josh:** the family sees "Looking" for a week and asks him why. He sees nothing unless he opens Find copies. With Dictionarry's 2160p Efficient profile turning down remuxes and many big encodes, "found 23 copies, none fit 4K Quality: most were too big" is often the real answer, and the fix is his (another profile for this title). Keep the last search's counts and the top two reasons on the request; show the plain version to the requester ("Copies exist, but none good enough yet") and the detail plus **Find copies** to admins. Bonus: say plainly when automatic searching is off, since "Marquee keeps looking" is only true with it on.

### 4. Text boxes don't zoom the page on iPhone · ❌ · S

**HolyArrs:** fixed iPhone zooming in whenever a text field is tapped.

**Marquee today:** inputs are `text-body`, which is 15px (`apps/web/src/styles.css:38`, `components/ui.tsx:32`). iOS Safari zooms any field under 16px when it's focused, and the page stays zoomed after.

**Why it matters for Josh:** the phone pass (PR #44) just made every page work at 375px. Tapping Discover's search, the Library filter, or the sign-in form still zooms. Use 16px for inputs, selects and textareas on narrow screens (not `maximum-scale=1`, which stops people zooming on purpose). Worth doing before the iPhone app copies the look.

### 5. Skip what's already on your streaming services · ❌ · M · ask Josh

**HolyArrs:** a setting to not download titles that are on services you pay for, and a list of titles in the library that are on one now (candidates to remove by hand).

**Marquee today:** knows each title's US services for "Streaming on" (TMDB watch providers, with `cleanProviders` folding add-on channels into the service), and each person can hide services in Discover. Neither Wanted searching nor requests use it.

**Why it matters for Josh:** he wants a space-efficient library. A per-profile or per-request choice, "Don't download it while it's on Netflix or Disney+", plus a read-only Library filter "On your services" (next to Not watched) would save real space. Needs care: titles leave services, so it should re-check (the twice-daily refresh already re-reads Wanted movies) and start the download when the title leaves. Ask Josh which services the household actually keeps.

### 6. Plex labels on requested titles · ❌ · S–M

**HolyArrs:** once a requested title is in Plex, adds a label to it (your own text), optionally the requester's name too, and can label titles requested earlier.

**Marquee today:** tells Plex to scan new folders (`library/mediaServers.ts`), nothing more.

**Why it matters for Josh:** an "Asked for by <name>" label lets Plex build smart collections per person. More useful for kids: Plex can limit a managed user to titles with a label, so labelling kid-safe titles that arrive through Marquee (or through kids' requests) keeps their Plex view in step with Marquee's kids' rules. Jellyfin has tags that work the same way, if wanted. Never removes labels it didn't add.

### 7. Open in Plex or Jellyfin from a title page · ❌ · S

**HolyArrs:** a button on library title pages that opens the title in Jellyfin's or Emby's web app (not Plex).

**Marquee today:** title pages don't link to the media server (`apps/web/src/plex.ts` is sign-in only).

**Why it matters for Josh:** the family lands on a title page from a "Ready to watch" notification and then has to go find it in Plex. Marquee already finds each item to scan and sync watched ticks, so it knows the Plex item and server. A **Watch in Plex** / **Watch in Jellyfin** button (Plex's web app link with the server id and item key; on iPhone, the app's own link) closes that loop, and the iPhone app will want the same link.

### 8. Try another copy reuses the last search · ❌ · S

**HolyArrs:** a failed download picks the next copy from the search results it already has, instead of searching every Source again.

**Marquee today:** `tryAnother` always calls `searchTitle` again (`monitor.ts` after line 570). Searches are kept for an hour (`downloads/cache.ts`), but that cache is only used by **Download this**.

**Why it matters for Josh:** each replacement costs a search on every Source, and IPTorrents has a low daily cap. If the title was searched in the last hour (or the last few, with Never pick applied), take the next best copy from that. Fall back to a fresh search when the cached list has nothing suitable left.

### 9. "Your copy" says whether it's good enough · 🟡 · S

**HolyArrs:** shows the file's current points next to the good-enough points.

**Marquee today:** Library has a **Not good enough yet** filter, and each copy in Find copies says "Better than your 1080p web download". The title page's **Your copy** card (`pages/Title.tsx`) shows quality and size but not whether Marquee will keep looking.

**Why it matters for Josh:** Dictionarry's numbers are large (good enough for 4K Quality movies is 957,000), so raw points mean little. A plain line is enough: "Good enough for 4K Quality" or "Not good enough yet: Marquee looks for a better copy once a day (needs Wanted)". Points under "For experts".

### 10. Whole seasons: first episodes first, in as they finish · ❌ · M

**HolyArrs:** a whole-season download fetches a few episodes at a time, in order.

**Marquee today:** a whole-season copy downloads in whatever order qBittorrent likes, and goes into the library only when the whole torrent is finished (`downloads/importer.ts`).

**Why it matters for Josh:** someone asks for a show; the season is 40 GB; nobody can start episode 1 until all of it is here. Set qBittorrent's file priorities so the first episodes come first, and put each episode in the library as its file completes (qBittorrent reports per-file progress, which the Downloads detail already reads). Check the hardlink and "wrong episodes" checks still hold per file.

### 11. Prefer copies the family's devices play without converting · ❌ · M

**HolyArrs:** a rule that favours copies your devices play directly.

**Marquee today:** Activity records every stream and, since round 7, **why it's converting** (Plex's decisions, Jellyfin's reasons). Nothing feeds that back into profiles.

**Why it matters for Josh:** if most conversions are for the same thing (TrueHD or DTS sound on the TV app, Dolby Vision with no HDR10 fallback, burned-in subtitles), Marquee can say so on the Quality page ("12 of the last 20 conversions were for DTS sound") and offer one-click **Your own rule** with negative points for it. Marquee is unusual in having both halves; it uses data already kept.

### 12. Health: "working again", and Marquee's own folder · 🟡 · S

**HolyArrs:** health alerts wait for a problem to hold for a couple of checks, then send one message when it breaks and one when it's fixed. Health also warns when the config folder isn't mapped to the host (everything is lost when the container goes) and when its disk is low.

**Marquee today:** `notify/health.ts` tells admins once a problem starts (Sources after 3 failures) and silently forgets it when it clears. Free space is checked for downloads, movies and TV (`system/disk.ts`), not for Marquee's own data folder, where the database and 14 days of backups live (on Unraid, usually the cache pool).

**Why it matters for Josh:** a "qBittorrent can't reach the internet" push at 2 am with no "it's back" leaves him checking by hand. Add a **… is working again** message (same notification group, off by default per channel if noisy). Add Health rows for the data folder's free space and for the data folder not being a mount (a container started without the Unraid template).

### 13. Content notes for parents · ❌ · M · ask Josh

**HolyArrs:** title pages list what a title contains, like nudity, gore or a pet dying. Their request for it asks for short notes other people leave, not ratings.

**Marquee today:** kids see titles by US age rating only (G/PG, TV-Y to TV-PG), with no detail.

**Why it matters for Josh:** "PG" covers a lot. A few lines on the title page (and on kids' request approvals) would help decide. Needs a data source with an API and terms that allow it (a crowd-sourced service such as Does the Dog Die; TMDB keywords are a weak fallback). Check the source's licence before building.

### 14. Connection tests say what a name became, and test what you typed · 🟡 · S

**HolyArrs:** connection tests name the exact problem and show what a host name resolved to; Test checks the address and password in the form before you save.

**Marquee today:** tests give plain states with fixes (Downloader, Sources, Plex, Jellyfin). Not checked: whether every Test button uses the unsaved form values, and none shows what `gluetun` or `qbittorrent` resolved to.

**Why it matters for Josh:** Docker names are the usual cause of "Can't reach it" on Unraid. "Can't reach it · `gluetun` is 172.18.0.5, nothing answered on 8080" points at the port, not the name.

### 15. Tell me when there's a new version · 🟡 · S (audit S9, Later)

**HolyArrs:** checks for new releases (can be switched off), shows it on Health, and never installs anything itself.

**Marquee today:** an "updated to a new version" notification after the fact. No check before.

**Why it matters for Josh:** low; he builds it. Worth it once family members' phones run the iPhone app and the server falls behind. Read the GitHub releases (or ghcr tags) once a day, show it on Health. Pairs with idea 2.

### 16. Keys per app with limited rights · ❌ · M (audit S6, Later; part of M7)

**HolyArrs:** apps connect with keys you make and can revoke (including over MCP); actions made by an app are marked as such in Requests and History.

**Marquee today:** session sign-in only; M7 plans token auth for the iPhone app.

**Why it matters for Josh:** when M7 adds tokens, make them per device or app, revocable from Settings → Account, with a short list of what each may do (read, request, admin). Record "from the iPhone app" in History. A read-only key would also let a Home Assistant or Homepage widget come back (they go dark at cutover).

### Smaller ones

- **Admin password reset from the container** (❌, S): HolyArrs prints a one-time code to the container log. Marquee has no way back if the only admin forgets their password and OIDC/Plex sign-in isn't linked. A `node dist/reset-password.js <user>` run with `docker exec` would do.
- **A short welcome on a new person's first visit** (❌, S): what they can do (ask for things, Something wrong?, notifications). Fits right after "Add people from Plex or Jellyfin".
- **Jobs say how long each run took** (🟡, S): Health's job list has last run, how it went and next run (`system/jobs.ts`), not the time taken. Helps spot a scan or sync getting slow.
- **Pocket ID groups set the role** (❌, S–M): OIDC sign-in could map a group to admin/member/kid. Low: family accounts come from Plex and Jellyfin.

### Quick checks (bugs HolyArrs fixed that Marquee might share)

Not features: things to try in Marquee, each a test or two.

- **Apostrophes and accents in plain searches.** `sources/torznab.ts:225` sends the title as it is (`Schitt's Creek`, `Pokémon`) when a Source can't search by id. Some sites return nothing for those.
- **Hybrid and v2-only torrents.** `downloads/torrent.ts` works out the v1 info-hash only. Check a hybrid torrent is followed under the same hash qBittorrent reports, and that a v2-only one gives a plain message.
- **qBittorrent's "keep unfinished downloads in" folder.** Check the import reads the final folder when that setting is on (the files move at the moment the download finishes).
- **qBittorrent dropping an idle connection.** `downloads/qbittorrent.ts` has no retry; a first call on a connection qBittorrent closed can fail once. One retry on a reset connection is enough.
- **Two episodes in one file** named `1x01-02` (and `S01E01-02`): check the parser and import treat it as both episodes.
- **Air dates near midnight:** an episode "today" for one time zone shouldn't read "yesterday" on the Calendar or Home.
- **Coming back to a hidden tab:** Activity's live page should reconnect straight away, not on the next timer.

## Already in Marquee

Things in these releases Marquee already does: **Try a name** (paste a copy's name), every copy's points and reasons in Find copies, copy names linking to their page on the Source (`components/Copies.tsx:124`), Put files in your library, imports that retry by themselves, `{tmdb-…}` folder names, IPTorrents and Knaben without Prowlarr, friends' Plex watchlists, ntfy/Pushover/webhook, unpacking .rar copies, removing a request, a fixed proper/repack ranking, age-rating limits for kids, "Ready to watch" only when it's all there, remove a title with Don't add it back, the TRaSH folder layout with hardlinks, keeping your file when upgrades are off (turn Wanted off; HolyArrs calls it a protected copy).

## Skip

- **Plugin system** (and the Tailscale plugin): a large, risky surface for a one-person project; Pangolin already does remote access.
- **Hands-off mode** (send only, never touch files): the side-by-side with Radarr/Sonarr is over; Marquee owns import now.
- **Pick several qualities, or 4K, when asking**: settled (audit R3); one library, profiles decide.
- **Request a whole movie series in one go**: admins have **Want the whole collection**; members asking per film is fine for now.
- **Sign in with Trakt**: username/password, Pocket ID, Plex and Jellyfin cover the household.
- **Trakt charts as lists** (trending, box office): Discover already has trending and popular rows.
- **44 languages, titles in each person's language**: English-speaking household.
- **Which Discover rows get opened and requested**: too few people for the numbers to mean anything.
- **"Watched titles you can clean up"**: no automatic deletion; **Not watched** already covers the read-only side.
- **Streaming-drive links, loose movie files, A–Z folders, a watched drop folder**: Josh's TRaSH layout and hardlinks make these unnecessary.
- **Default audio language, waiting for a dub, French versions**: **Your own rules** ("Has a language") covers it; no need here.
- **Subtitle sites, subtitle cleaning, default subtitle language in Plex/Jellyfin**: Bazarr isn't used (audit S12).
- **Music, Navidrome, Kodi, Emby, SABnzbd/NZBGet, aria2, rdt-client, more than one Downloader**: out of scope (movies and TV, torrents through one qBittorrent).
- **arr-compatible API for Kometa and arr phone apps**: settled (audit S7); the iPhone app replaces them.
- **Bring history, profiles and the blocklist over from Sonarr/Radarr; a setup that finds old apps**: settled (audit S10); Josh is already set up.
- **Automatic updates and one-click roll back**: Unraid manages the image; idea 2 gives the safe part.
- **Skip sign-in on the home network**: kids' limits need everyone signed in.
- **Each library folder its own quality**: one folder per kind (audit L10); profile rules pick by title.
- **Episode order (aired, DVD, original)** and **alternative titles**: no real search has missed yet (audit L13, L15).
- **Video codec page and checking files after download**: needs reading the files (audit L5, Later). Worth knowing when L5 comes up: HolyArrs reads the file's track list itself, with no ffprobe in the image.
- **Invite links**: audit R10, Later; family accounts come from Plex and Jellyfin.
