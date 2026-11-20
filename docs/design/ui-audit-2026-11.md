# Marquee UI audit (18 Nov 2026)

The visual version, with mockups of the new Home, navigation and Settings: https://claude.ai/artifact/VqXFR6MSiZtBvCFA1jgcC7

This is a proposal. Nothing in it is built yet. It replaces the order in [design-proposal.md](design-proposal.md); most of that proposal was never built and is folded in here.

## Heuristic score: 24/40 (Acceptable)

The scores were given by an independent reviewer using Impeccable's critique rubric. The automated detector ran in regex mode only, because there is no Chrome on this machine. It found nothing, which is an undercount.

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | System status | 2 | Home's "Watching now" and free space are hard-coded, and they disagree with the Activity and Downloader pages. |
| 2 | Match the real world | 3 | x264/x265, −10000 and "Direct play" leak through. The family sees "sample data until their milestones land". |
| 3 | User control | 3 | The Profile select in Copies saves as soon as you change it. Home's Pause does nothing. |
| 4 | Consistency | 2 | The same profile has two names. "Discover" is both a page and a Settings tab. Wanted and Watched both stand for "Monitored". |
| 5 | Error prevention | 3 | Delete sits next to Save on Quality. Sign-out sits next to the avatar on phones. |
| 6 | Recognition | 2 | 12 flat nav items, 9 of them off-screen on a phone. |
| 7 | Flexibility | 2 | No ⌘K and no shortcuts. "Look for everything missing" only exists inside Switch over. |
| 8 | Minimalist | 2 | 113 explainer paragraphs in `pages/`, and about 80 controls at once on Quality. |
| 9 | Error recovery | 3 | Home's Approve swallows errors, and "Something went wrong." is still used. |
| 10 | Help | 2 | Help only exists as paragraphs on the page. |

## Priority issues

- **P0. Home is a mockup.** `routes/home.ts` still returns the M0 sample hero, "Watching now" and stats.
- **P1. 13 flat nav items.** Proposed: Home, Discover, Library (Movies and Shows merged), Calendar; then **Activity**: Requests, Downloads, Watching; then **Manage**: Settings (Quality moves inside it). Phones get a 5-item bottom tab bar and an avatar sheet.
- **P1. Settings sprawl.** Replace the 9 pill tabs with a grouped settings home that has a status dot per page:
  - **You:** Account, Notifications, Preferences
  - **Household:** People, Requests, Shared alerts
  - **Library:** Quality, Folders & names, Plex & Jellyfin, Watched sync, Movie info
  - **Getting copies:** Sources, Downloader, Automatic searching
  - **System:** Status, Older apps, About
- **P1. Retire Compare and Switch over.**
  - The live controls move to Settings → **Automatic searching**: the wanted switches, the daily limit, Look now / Preview, and the last runs.
  - Delete `/compare`, `/switch-over/*`, `routes/compare.ts` and the comparison job.
  - Radarr and Sonarr move to Settings → Older apps.
  - New installs get a "Get set up" checklist on Home.
- **P1. Explainers.**
  - Page tops get a title only.
  - On screen, explain only what's unusual right now.
  - How-it-works text moves into an ⓘ popover or the docs.
  - Consider a `words.test.ts` check that fails when a page's first paragraph is over 120 characters.
- **P2. Generic look.**
  - The art leads: backdrop heroes, poster rows, and a poster wall on sign-in.
  - Colour comes from each poster and is stored at import.
  - The marquee-bulb row is the signature, used for "Now showing", live streams and loading.
  - The serif is for film titles only.
  - One transition: the poster grows into the title page.
- **P2. Tokens and primitives.**
  - Bring 26 font sizes down to 6 and 14 radii down to 3.
  - Add status colour roles with matching ink colours.
  - Amber is used only for the primary action.
  - Grow `ui.tsx` (5 pieces) to about 17: PageHeader, Tabs, Switch, StatusDot, Sheet, Menu, EmptyState, InfoTip, PosterRow, MediaRow, Toast with Undo, CommandBar.

## Home

**Admin**, in this order:

1. **Now showing.** A live stream with its backdrop. If nothing is playing, show "Just arrived". On a new install, show "Get set up".
2. **Needs you.** One inbox for requests, stuck downloads, import problems, unmatched folders, and failing Sources, the downloader or media servers. Each row has one action. When there's nothing, it says "Nothing needs you".
3. **On its way.** The real downloads.
4. **Just arrived.** The last 8 imports.
5. **This week.** A 7-day strip with art.
6. **Footer.** Library size, free space bar, Source health, last automatic search, and hours watched.

**Member:**

1. Ready to watch (theirs)
2. Their requests with plain states
3. Because you watched…

**Kid:** big posters, "New for you", their shows, then "Ask for something".

## Build order

1. Retire Compare and Switch over, after moving their controls. Remove Home's sample path. Fix the Discover phone overlap, where the Trailer button sits over the carousel dots.
2. Tokens and primitives.
3. Navigation, Settings home, Library merge, and the Quality split. Cut the explainers as each page is touched.
4. A real Home for each role, plus the poster colour at import.
5. Art and motion: backdrops, tinted rows, bulbs, the poster→title transition, the sign-in poster wall. Rebuild the title page and Downloads.
6. iPhone app (M7). It starts from the same tabs, components and words.

## Smaller items

- Make the Profile select a "Search as" preview.
- Set `document.title` per page.
- Show a poster's title once.
- The Files card should lead with quality, with the path behind "Show where".
- Show Home's approve errors instead of swallowing them.
- Settle Wanted vs Watched in GLOSSARY.md.
- Use plain words for x264/x265.
- Show "Never" instead of −10000.
- Activity's empty charts should collapse to a single line.
- The calendar's "Not wanted" note becomes a dot plus a filter.
