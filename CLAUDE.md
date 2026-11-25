# Marquee

Self-hosted, all-in-one replacement for Sonarr, Radarr, Prowlarr, Seerr, Tautulli, WatchState and Profilarr, with a companion iPhone app. One person (Josh, GitHub `The-Croz`) builds it with Claude, so keep things simple, explicit and well-tested.

**Read `docs/PLAN.md` first.** It has the milestones, what's done, and the next tasks. Update it when you finish something.

## Product decisions (settled, don't revisit without asking)

- Movies and TV only. **No anime** support.
- **Torrents only**, through **qBittorrent** (Web API v2). No Usenet.
- Quality profiles built on **Dictionarry** (Profilarr's database; Josh prefers space-efficient encodes that keep quality) by default, with the **TRaSH Guides** still available, explained in plain English. Profiles are stored in the database, editable in the app, and assigned per title; profile behavior always comes from the profile's data. Seeded presets, each on a Dictionarry profile: **4K Quality** (key `cinema`; 2160p Efficient: 4K HDR, efficient sizes, 1080p fallback; skip remuxes), **Everyday HD** (1080p Efficient), **Kids & Cartoons** (1080p Compact, small x265 encodes down to SD; Josh still to confirm this over the old 720p). Dictionarry is pinned in `releases/dictionarry/` (refresh with `pnpm --filter @marquee/server dictionarry:update`); installs pick up its changes through Settings → Quality → Rule updates.
- No automatic deletion for now.
- Roles: `admin` (requests go straight through), `member` and `kid` (kids-only Discover). Members' and kids' requests wait for an admin unless that person's "requests skip approval" switch is on (kids: kid-safe titles only).
- Sign-in: username and password always; optional OIDC (Pocket ID) and Plex.
- Watches **both Plex and Jellyfin**.
- Rollout: run beside the existing arrs first, then take over movies, then TV.
- License: **GPL-3.0-or-later** (lets us learn from and reuse Sonarr/Radarr code if needed).
- **Friendlier than the arrs.** Use Marquee's own words from `docs/GLOSSARY.md` (Source, copy, rule, profile…), with the older word at most once as a bridge. `test/words.test.ts` fails on arr jargon in the web app. Every failure state gets a plain label *and* what to do about it. Advanced settings go behind a "For experts" disclosure with sensible defaults. Things retry by themselves and say when.
- **Reference: HolyArrs** (https://github.com/HolyArrs/HolyArrs, docs in its `docs/` folder) does this very well. Check how it handles a feature before building ours (wording, health states, import-from-old-apps with undo, troubleshooting tables). It is **AGPL-3.0**: borrow ideas and patterns only, never copy its code or doc text.
- Design: the "cinematic dark" direction. Tokens live in `apps/web/src/styles.css` (`@theme`). Copy is plain English ("Stuck · nobody is sharing it", not "stalledDL").

## Josh's setup

- Unraid, TRaSH folder layout so hardlinks work: `/mnt/user/data/torrents` (downloads) and `/mnt/user/data/media/{movies,tv}` (library). Inside containers `/mnt/user/data` is mounted as `/data`, so the defaults are `/data/torrents`, `/data/media/movies`, `/data/media/tv`.
- Existing stack (keep working until cutover): Sonarr, Radarr, Prowlarr, Profilarr, qBittorrent (hotio, behind gluetun), Seerr, Tautulli, Plex, Jellyfin, Pocket ID, Pangolin.
- The live app runs in the `marquee` container (image `ghcr.io/the-croz/marquee:latest`). When the Dozzle tools are available, they read its logs: the first place to look when something works in the demo but not for Josh.

## Layout

```
apps/server     Hono API on Node 22, SQLite via better-sqlite3 + Drizzle, bundled with esbuild
apps/web        React 19 + Vite + Tailwind v4 + TanStack Query + React Router
packages/shared Types shared by server and web (no runtime code)
docker/         Entrypoint (PUID/PGID) and the Unraid template
```

## Demo mode

`pnpm build && pnpm --filter @marquee/server demo` serves the app on :9797 with fake TMDB, Sources, qBittorrent, Plex, Jellyfin and arrs (the header of `apps/server/scripts/demo.ts` lists their addresses and keys). It's the way to check UI changes by hand:

- It starts empty: create an admin (`POST /api/auth/setup`), then scan (`POST /api/library/scan`, a few seconds) before the library has titles.
- It serves the web build it found at startup. After rebuilding the web app, restart the demo.
- Each start is a fresh database, so setup and scan again after a restart.

## Conventions

- **Tests for server logic.** Every route and every piece of decision logic gets vitest coverage in `apps/server/test`. Use `makeApp()` / `call()` from `test/helpers.ts` (in-memory DB). External services (Plex, TMDB, MDBList, Sources, qBittorrent) are injected and faked (`test/fakes/`). Tests only ever talk to fakes.
- **Migrations are append-only.** Add a new entry to the `migrations` array in `apps/server/src/db/index.ts` and update `schema.ts` to match. Shipped entries stay as they are. `test/system.test.ts` undoes the newest migration (`UNDO_NEWEST`) to test restoring an older backup: update it with each new migration.
- **API writes are JSON.** POST/PUT/PATCH send `Content-Type: application/json`; that is the CSRF guard, so every write stays JSON.
- Errors: throw `HttpError(status, code, plainEnglishMessage)`; zod validation errors become 400s automatically.
- Secrets (Plex tokens, API keys) stay out of logs and API responses.
- Shared request/response types go in `packages/shared/src/index.ts`.
- Keep the web app accessible: real buttons/links/labels, 44px touch targets, visible focus.
- Sites Marquee searches itself live in `apps/server/src/sources/sites/`: an engine for Prowlarr's site files, built-in IPTorrents and Knaben, and the FlareSolverr-protocol solver. Prowlarr's site files are downloaded at runtime and never committed (their repo has no license file); test sites are our own files in `apps/server/test/fixtures/sites/`. `scripts/try-site.ts` tries a site file against the real site by hand.

## Working in the Claude cloud sandbox

- `nodejs.org` is blocked there, so building `better-sqlite3` needs local headers: prefix installs with `npm_config_nodedir=/opt/node22`.
- Docker Hub is blocked there too, so the image can only be built in GitHub Actions.
- Josh's LAN and TMDB (api and images) aren't reachable from the sandbox. Use demo mode and the fakes there; do integration work from Claude Code on a machine on the LAN.
