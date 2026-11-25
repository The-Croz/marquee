# Handoff: Clean up → "In qBittorrent" (reconcile the downloader)

Written 2026-11-24, after PR 49 (Library → Clean up) and PR 50 (episode details and remove). Not built yet. Read `CLAUDE.md` and `docs/PLAN.md` first.

## Why

Josh ran Sonarr and Radarr into the same qBittorrent for years. He suspects torrents that are stray (in no library), finished sharing, broken, or stuck, and wants to see them all in one place and clean them up. Clean up's **Unused downloads** tab answers the opposite question: files on disk that no torrent uses. This feature starts from qBittorrent's side: every torrent, and whether it's still earning its place.

## What exists to build on

- `apps/server/src/library/cleanup.ts`, Clean up's four tabs. Patterns to copy:
  - Each tab is worked out on demand.
  - When qBittorrent can't answer, the tab says why and lists nothing.
  - When folder pairs don't line up (none of qBittorrent's torrents sit in the downloads folder as Marquee sees it), it refuses to list anything.
  - The server only acts on what it would list itself, re-checked at the moment of acting.
- `apps/web/src/pages/Cleanup.tsx` holds the tabs (`?tab=`), `usePicks` and `SelectBar` (Select all / Select none), sticky action bars, and a confirm sheet that names each item.
- `QbitApi.allTorrents()` returns hash, name, `contentPath` and `savePath` for every category. `torrents(hashes)` returns the full state: ratio, seeding time, progress, state word, size, `completedOn`, tracker, category and tags. `files(hash)` returns each torrent's file list. `remove(hash, deleteFiles)`.
- `apps/server/src/library/episodeCare.ts` finds which torrent holds a library file by inode. It stats `mapPath(savePath/file, folderPairs)` and compares `dev:ino` with the library file. Reuse that idea, but build one index (dev:ino → title) from all `media_files` instead of checking per title.
- Download rows (`downloads` table) carry `infoHash`, `adopted`, `importedAt`, `sharedEnoughAt` and `qbitState`. `downloads/seeding.ts` has `seedRule(db, d)` and `sharedEnough(rule, ratio, seconds)`. `downloads/view.ts` has `describeDownload` for plain status words. `sharedMonitor(...).remove(id, deleteFiles, userId)` is the proper way to remove a torrent Marquee sent: it checks the library files are still there first, and records History.
- `docs/GLOSSARY.md` lists the words to use. `apps/server/test/words.test.ts` fails on arr jargon on screen. Never show qBittorrent's raw state words ("stalledDL"); `view.ts` already maps them.

## The feature

A fifth tab in Library → Clean up: **In qBittorrent** (`?tab=downloader`). It lists every torrent in every category, sorted into groups. The first group that fits wins:

| Group | Test | Default action |
|---|---|---|
| **Files missing** | qBittorrent's state is `missingFiles`, or `contentPath` doesn't exist as Marquee sees it | Remove from qBittorrent (no files to delete) |
| **Stuck or errored** | State `error`, or not finished with no progress for the stuck time (Settings → Downloader) | Remove with its files; for one Marquee follows, also **Try another copy** |
| **Not in your library** | Finished, and none of its video files share an inode with a library file | Remove with its files: this frees space |
| **Done sharing** | In your library, and past its seeding rule (`sharedEnough`, with `seedRule` per Source; for torrents another app sent, the default rule) | Remove; library files stay (hardlinks) |
| **Still sharing** | In your library, not yet shared enough | Nothing; listed with progress |
| **Downloading** | Not finished and moving | Nothing |

Each row shows:
- the torrent's name;
- **who sent it**: Marquee (a download row, not adopted), or Radarr/Sonarr/another app, guessed from its category and tags, with "another app" when unclear;
- which library title it feeds, as a link (from the inode index);
- size, and **what removing it frees**: the bytes of its files that have `nlink == 1`, because hardlinked files free nothing;
- ratio and time sharing;
- for private trackers, a warning that removing before the site's minimum can cost the account. The `seeding.ts` notes already say private sites keep sharing.

Admins can tick rows (nothing ticked to start with) and use **Remove from qBittorrent** or **Remove with its files**. A confirm sheet names each torrent and the space it frees.

## Server

- `apps/server/src/library/reconcile.ts`:
  - `downloaderView(deps)` → `{ ok, problem, groups: { key, label, explain, items: ReconcileTorrent[] }[], checkedAt }`.
  - Steps:
    1. `allTorrents()`, then `torrents(all hashes)` for state, ratio and so on. Do it in chunks of about 200 hashes so the URL stays short.
    2. Build the inode index from `media_files`: stat each path.
    3. For finished torrents, call `files(hash)` and stat each video file through `mapPath`. A video file whose inode is in the index feeds that title.
    4. Group the torrents as in the table above.
  - Cost: one `files()` call per finished torrent. Run up to 8 at a time and keep the result in memory for 10 minutes (key: torrent hash + `completedOn`), with a **Check again** button that clears it. The tab says "Checking 312 downloads…" while it works.
- `POST /api/cleanup/downloader/remove { hashes, deleteFiles, confirm: true }`:
  - Recompute the view, and refuse (409) any hash that isn't listed, or whose group no longer allows that action. For example, refuse "with files" for a torrent whose library files would be the last copy. That can't really happen with hardlinks, but check `nlink` anyway.
  - For a torrent Marquee follows and didn't adopt, use `monitor.remove(id, deleteFiles, userId)`. Otherwise call `qbit.remove(hash, deleteFiles)`, mark any download row removed, and `recordHistory('removed', …)`.
  - Answer with `CleanupResult`.
- Routes go in `apps/server/src/routes/cleanup.ts` (admins only). Shared types go in `packages/shared/src/index.ts`.
- Never removes anything by itself: no job, no automation.

## Web

- `Cleanup.tsx`: add the tab "In qBittorrent". Show one collapsible section per group, each with a line of plain explanation and what to do about it ("Finished, but nothing in your library uses it. Removing it with its files frees 48 GB.").
- Per-group shortcuts in `SelectBar`: "Tick all not in your library", "Tick all done sharing".
- The confirm sheet follows the recycle bin's.
- Phone width: rows stack, 44px touch targets.

## Tests (`apps/server/test/reconcile.test.ts`)

Use `FakeQbit` and temp folders, like `test/cleanup.test.ts` and `test/episodes.test.ts`. The fake needs `state`, `ratio`, `seedingSeconds` and `completedOn` per torrent (it already has most of these via `qbitTorrent()`), plus `fileLists`.

Cases:
1. **Grouping:**
   - a torrent hardlinked into the library and past its rule → Done sharing;
   - the same, but under the rule → Still sharing;
   - finished with no library link → Not in your library, with freed bytes;
   - `missingFiles` → Files missing;
   - `error` → Stuck or errored;
   - downloading → Downloading.
2. Who sent it: a Marquee download row, an adopted row, `radarr` and `tv-sonarr` categories, and no category.
3. Lists nothing when qBittorrent fails, or when folder pairs don't line up.
4. Remove:
   - refuses unlisted or stale hashes;
   - a followed torrent goes through `monitor.remove`, and an adopted or other-app one through `qbit.remove`;
   - History is recorded;
   - with files: the library hardlink survives.
5. Admins only.
6. `words.test.ts` still passes.

Add demo-mode data in `apps/server/scripts/demo.ts`: a few torrents in each group, with sparse files.

## Open questions for Josh (ask before building)

- Should "Done sharing" use each Source's rule for torrents Sonarr or Radarr sent, when the tracker can be matched to a Source? Or always the default rule?
- Should private-tracker torrents be hidden from "Done sharing" unless their Source has its own rule? That's what the seeding code does today.
- Should **Not in your library** include torrents under 50 MB (samples, subtitles packs), or hide them behind a "Show small ones" switch?

## Done when

The tab works against Josh's real qBittorrent from Claude Code on the LAN, with Dozzle logs clean. PLAN.md has an entry. The PR follows the `pr` skill's template.
