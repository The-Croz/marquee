# Built-in Sources (Milestone 4, items 2–3)

## Why

Retire Prowlarr. Marquee should search torrent sites itself, keep up as sites change, and get past bot checks without a separate container.

Josh's sites today: Knaben, IPTorrents, EZTV, 1337x, LimeTorrents, The Pirate Bay, YTS. He also wants to add or change other sites over time.

## Goals

- **The whole catalogue.** Marquee reads Prowlarr's site definitions (Cardigann YAML, format v12, about 580 sites). It downloads `https://indexers.prowlarr.com/master/12/package.zip` on your server once a day; Marquee does not ship the files.
- **Your own site files.** `.yml` files in `<data>/sites/` are added to the catalogue, or replace a catalogue site with the same id.
- **Hand-written sites** where Prowlarr has them in code: IPTorrents (cookie sign-in, HTML results) and Knaben (public JSON search service).
- **Add a site** from Settings → Sources: pick from the catalogue, fill in the form its definition asks for (text, password, checkbox, select, info), and Marquee checks it straight away. Secrets are never sent back to the browser.
- **Bring over from Prowlarr.** Sources linked from Prowlarr whose site is in Marquee's catalogue become Marquee-run sites, keeping name, priority and limits. Prowlarr doesn't share passwords and cookies, so sites that need them say so and ask once. **Put back** undoes it.
- **Bot checks.** Marquee speaks the FlareSolverr protocol (`POST /v1` `request.get`). FlareSolverr is bundled in the image and started by Marquee only when the switch is on. "For experts" takes another solver's address (Byparr or anything compatible). Cookies and the browser name the solver returns are kept per Source and reused until a bot check appears again.

## Non-goals (for now)

Captcha sign-ins (the site says "Not supported yet" with why), proxies, a downloader per site, Usenet, paging beyond the first page of results.

## Anti-goals

- Sites that half-work silently. Anything the engine can't do is a plain, visible state.
- Secrets in logs, API responses or error messages.
- Hammering sites: the existing gaps, daily limits and back-off apply to built-in sites too.

## Approaches considered

1. **Read Prowlarr's catalogue with our own engine** (picked). Covers the catalogue and updates itself; the cost is building an engine for the definition format (templates, CSS/JSON selectors, filters, sign-in).
2. Hand-write each site: small at first, but every new or changed site needs a Marquee release.
3. Run Jackett or Prowlarr inside Marquee: keeps the old app around, which is what we're removing.

Bot checks: **a swappable FlareSolverr-protocol solver, bundled** (picked) vs. Marquee driving its own Chromium. Both fit in one container; the size difference is small since both need Chromium. The solver communities keep up with Cloudflare, and swapping the solver is a setting rather than a code change.

## How it fits

- A Source is either a **feed** (Torznab, as today) or a **site** (`kind = 'site'`, `site_id`, settings JSON, kept cookies). `SourceService` builds a feed or site client behind the same `TorznabApi` (`caps`, `search`), so search, newest copies, limits and health are unchanged.
- Site copies can carry a way to fetch their torrent with the site's cookies (and, if the definition says so, by opening the copy's page first). The torrent fetch sends those headers only to the site's own host.
- Health gains **Sign-in turned down** and **Not supported yet**. Bot checks keep **Blocked by a bot check**, now fixable with the switch.

## Left to the builder

Which filters and template functions to support beyond what the seven sites and the common catalogue use; the exact shape of tables and routes; the Sources page layout, following the existing design.
