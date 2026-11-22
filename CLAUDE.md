# Marquee

Self-hosted, all-in-one replacement for Sonarr, Radarr, Prowlarr, Seerr, Tautulli, WatchState and Profilarr, with a companion iPhone app. One person (Josh, GitHub `The-Croz`) builds it with Claude, so keep things simple, explicit and well-tested.

**Read `docs/PLAN.md` first.** It has the milestones, what's done, and the next tasks. Update it when you finish something.

## Product decisions (settled, don't revisit without asking)

- Movies and TV only. **No anime** support.
- **Torrents only**, through **qBittorrent** (Web API v2). No Usenet.
- Quality profiles built on **Dictionarry** (Profilarr's database; Josh prefers space-efficient encodes that keep quality) by default, with the **TRaSH Guides** still available, explained in plain English. (Changed from TRaSH-first on 2026-11-22; see `docs/design/replacement-audit-2026-11.md` P3.) Profiles are stored in the database, editable in the app, and assigned per title; never hard-code profile behavior. Seeded presets: **4K Quality** (key `cinema`; 4K HDR, efficient sizes, 1080p fallback; skip remuxes), **Everyday HD** (1080p), **Kids & Cartoons** (720p).
- No automatic deletion for now.
- Roles: `admin` (requests go straight through), `member` and `kid` (kids-only Discover); members' and kids' requests wait for an admin. Planned (audit R4): a per-person "requests skip approval" switch (for kids, kid-safe titles only).
- Sign-in: username and password always; optional OIDC (Pocket ID) and Plex.
- Watches **both Plex and Jellyfin**.
- Rollout plan: run beside the existing arrs first (read-only import, then "decide but don't download" comparison), then take over movies, then TV.
- License: **GPL-3.0-or-later** (lets us learn from and reuse Sonarr/Radarr code if needed).
- **Friendlier than the arrs.** Use Marquee's own words from `docs/GLOSSARY.md` (Source, copy, rule, profile…), with the older word at most once as a bridge. `test/words.test.ts` fails on arr jargon in the web app. Every failure state gets a plain label *and* what to do about it. Advanced settings go behind a "For experts" disclosure with sensible defaults. Things retry by themselves and say when.
- **Reference: HolyArrs** (https://github.com/HolyArrs/HolyArrs, docs in its `docs/` folder) does this very well. Check how it handles a feature before building ours (wording, health states, import-from-old-apps with undo, troubleshooting tables). It is **AGPL-3.0**: borrow ideas and patterns only, never copy its code or doc text.
- Design: the "cinematic dark" direction. Tokens live in `apps/web/src/styles.css` (`@theme`). Copy is plain English, never jargon ("Stuck · nobody is sharing it", not "stalledDL").

## Josh's setup

- Unraid, TRaSH folder layout so hardlinks work: `/mnt/user/data/torrents` (downloads) and `/mnt/user/data/media/{movies,tv}` (library). Inside containers `/mnt/user/data` is mounted as `/data`, so the defaults are `/data/torrents`, `/data/media/movies`, `/data/media/tv`.
- Existing stack (keep working until cutover): Sonarr, Radarr, Prowlarr, Profilarr, qBittorrent (hotio, behind gluetun), Seerr, Tautulli, Plex, Jellyfin, Pocket ID, Pangolin.

## Layout

```
apps/server     Hono API on Node 22, SQLite via better-sqlite3 + Drizzle, bundled with esbuild
apps/web        React 19 + Vite + Tailwind v4 + TanStack Query + React Router
packages/shared Types shared by server and web (no runtime code)
docker/         Entrypoint (PUID/PGID) and the Unraid template
```

## Commands

```
pnpm install
pnpm dev          # API on :9797, web on :5173 (proxies /api)
pnpm test         # vitest (server)
pnpm typecheck
pnpm build        # web → apps/web/dist, server → apps/server/dist
pnpm start        # serve the built app (set MARQUEE_WEB_DIR=apps/web/dist)
pnpm build && pnpm --filter @marquee/server demo   # fake TMDB + sample library on :9797, no internet needed
```

## Conventions

- **Tests for server logic.** Every route and every piece of decision logic gets vitest coverage in `apps/server/test`. Use `makeApp()` / `call()` from `test/helpers.ts` (in-memory DB). External services (Plex, TMDB, indexers, qBittorrent) are injected and faked in tests. Never call real services from tests.
- **Migrations are append-only.** Add a new entry to the `migrations` array in `apps/server/src/db/index.ts` and update `schema.ts` to match. Never edit one that has shipped.
- **API writes are JSON.** POST/PUT/PATCH must send `Content-Type: application/json`. This is the CSRF guard; don't add form posts.
- Errors: throw `HttpError(status, code, plainEnglishMessage)`; zod validation errors become 400s automatically.
- Secrets (Plex tokens, API keys) never go in logs or API responses.
- Shared request/response types go in `packages/shared/src/index.ts`.
- Keep the web app accessible: real buttons/links/labels, 44px touch targets, visible focus.

## Working in the Claude cloud sandbox

- `nodejs.org` is blocked there, so building `better-sqlite3` needs local headers: prefix installs with `npm_config_nodedir=/opt/node22`.
- Docker Hub is blocked there too, so the image can only be built in GitHub Actions.
- Live services on Josh's LAN aren't reachable from the sandbox, nor is TMDB (api or images). Use demo mode and the fakes in `apps/server/test/fakes/`; use Claude Code on a machine on the LAN for integration work.
- Library code lives in `apps/server/src/library/` (parse, tmdb, arr, scanner, services). The scanner must stay read-only on disk until Milestone 3's import step.
- Sites Marquee searches itself live in `apps/server/src/sources/sites/`: an engine for Prowlarr's site files (downloaded at runtime, never committed: their repo has no license file), built-in IPTorrents and Knaben, and the FlareSolverr-protocol solver. Test sites are our own files in `apps/server/test/fixtures/sites/`. `scripts/try-site.ts` tries a site file against the real site by hand.
