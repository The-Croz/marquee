# Choose from lists, and Clean up — design (2026-11-24)

## Why

1. Josh switched on his Plex watchlist. Marquee read it at once and asked for every title on it; his requests skip approval, so dozens of searches and downloads started. He wants to pick, title by title, which of what's *already* on a list to take, and have only what's added *later* go through by itself.
2. He suspects leftovers on disk beyond what upgrades set aside, and wants to see them in detail and clean them up, with a recycle bin he can empty.

## Decisions (Josh)

- The choose step applies to **every list** (Plex watchlists, Trakt, IMDb, Letterboxd), not only Plex.
- **Going forward only**: what the watchlist already asked for stays; no undo screen for it.
- Clean up finds **all four**: two copies of one title, set-aside files one by one, downloads nobody uses, library files with no title.
- Getting rid of something **sets it aside first** (undoable); deleting happens in a **recycle bin**, by hand, which can also be emptied whole.

## Approaches considered

- **Lists**: (a) the first read records titles as waiting, chosen later (picked); (b) a preview before switching on, nothing saved until confirmed (reads the list twice, and doesn't cover off-then-on); (c) every new title waits forever (goes against "future titles automatic").
- **Clean up**: (a) one page, four tabs, each worked out when opened (picked: what's on disk changes slowly, and a fresh look is what you want before removing things); (b) a nightly job that keeps findings (stale by the time you act; more state).

## Design

### Lists

- `import_lists.started_at` (migration 34): null until a read succeeds. A read with it null records each new title as `waiting` (with TMDB's name, year and poster; exclusions still `excluded`) and then sets it. Existing lists get it filled in, so nothing changes for them.
- Switching a list (or watchlist) back on sets it to null again, so titles new since then wait too; ones already handled stay handled.
- `POST /api/lists/:id/choose { take, leaveOut }`: `take` runs the usual handling (request as the owner for a watchlist, Wanted with the list's profile and episodes choice otherwise) on waiting or left-out titles; `leaveOut` marks waiting ones `skipped` ("Left out when you added the list"), which can be taken later.
- UI: a banner on the list with **Choose**, opening a full-height sheet: tick boxes, Select all / Select none / Only what isn't here yet, nothing ticked to start, each title's standing (In your library, Already Wanted, Already asked for).

### Clean up (`/library/clean-up`, admins)

- **Two copies**: media files grouped by movie, and by episode (files sharing an episode merge). Suggested keep: highest resolution, then profile tier and points, then size, then newest. *Builder's call:* resolution first, because the 4K preset can rank an old 4K Blu-ray encode below a 720p web copy, which nobody would want kept.
- **Recycle bin**: files under `.marquee-replaced` in the movies, TV and downloads folders, each with its original place, title (by folder), set-aside time (ctime), and space freed (nlink). Put back (only when the original place is free, then a scan), Delete for good (confirm), Empty (the existing endpoint, now covering the downloads folder too).
- **Unused downloads**: entries in the downloads folder that no torrent's content path (via folder pairs) is, is inside, or contains; qBittorrent's save and category folders are always looked inside. Lists nothing when qBittorrent isn't set up or can't answer, or when none of its torrents sit in the downloads folder (folder pairs missing).
- **No title**: video files under the library folders not in `media_files` (hidden, extras and sample files skipped), with a reason and a link.
- **Set aside** (`POST /api/cleanup/set-aside`): only paths the page would list right now; never a title's last copy (409, pointing to Remove from Marquee). Library files move with their subtitles into that library's `.marquee-replaced` and drop out of `media_files`; Plex and Jellyfin are asked to rescan the folder; History records it. Downloads move into `<downloads>/.marquee-replaced`.
- History events `set_aside`, `put_back`, `deleted` (migration 34 rebuilds the table's check, as migration 26 did).

## Non-goals

- No automatic deletion or emptying, ever, in this change.
- No undo for what the watchlist already asked for.
- No hashing to find identical files under different names.
