# Marquee design proposal: "the cinema, not the projection booth"

A proposal, not a decision. Nothing here is built yet. It builds on the issues in [ux-evaluation.md](ux-evaluation.md).

## The idea in one line

Make the **films** the color and the **app** quiet. Today the chrome does the cinematic work: amber everywhere, serif titles, rounded panels inside rounded panels. Real posters and backdrops should carry the mood. The interface around them goes neutral, flat and precise, the way a cinema dims the house lights so the screen is the brightest thing in the room.

Keep "cinematic dark", Instrument Serif and amber. Use each of them less often, so each use means more.

## 1. Who sees what (structure)

**Two front doors, one app.**

| Role | Lands on | Main tabs |
|---|---|---|
| Family / kid | **Discover**: rows of posters, "Ask for it" on everything, "Your requests" with plain states | Discover · Library · Requests |
| Admin | **Home**: "Needs you" first, then what's on its way, then what's new | Home · Library · Downloads · Requests · (Manage) |

- **Movies and Shows merge into one Library** with a Movies/Shows switch. That's one tab instead of two, and the same filters on both.
- **Manage** groups the admin's setup screens: Quality, Settings, and the takeover check (today's Compare). On desktop it's a sidebar section. On phones it lives under the avatar.
- **Activity** joins Home ("Watching now") and the title pages ("Watched by…") until Milestone 6 makes it worth a tab.
- **Phones get a bottom tab bar** of 3 to 5 items. The avatar opens a sheet with Manage, your account, and Sign out. There's no bare sign-out icon any more.
- **Command bar (⌘K / `/`)**: search titles, jump to any setting, run "Find copies for everything missing". One accelerator that serves both the power user and the person who can't find something.

## 2. Home: one inbox, not a dashboard

Replace the stat tiles and scattered notices with a single **"Needs you"** list, ordered by urgency. Each row has a plain label, the fix, and one button:

- "Stuck · nobody is sharing it: *Severance S2 E7*" → **Find another copy**
- "Key turned down: *TorrentLeech*" → **Fix in Sources**
- "1 folder needs a match" → **Match it**
- "Mia asked for *Moana 2*" → **Approve** / **Not now**

When it's empty, say so with pride: "Nothing needs you. 3 things arriving tonight." Stats move to one quiet line ("212 movies · 48 shows · 18.4 TB free") instead of four tiles.

**Sample data is always labelled** with a "Sample" tag. Its buttons are switched off and say why. The app never has a button that does nothing.

## 3. Title page: the hub for one film or show

```
┌──────────── full-bleed backdrop (blurred, darkened) ─────────────┐
│ [poster]  Dune: Part Two                    (serif, the only one) │
│           2024 · PG-13 · 2 h 46 m · Sci-fi                        │
│           ● On disk · 4K Dolby Vision · Good enough               │
│           [ Look for a better copy ]  ⋯                           │
└───────────────────────────────────────────────────────────────────┘
  Profile: Cinema  (Change…)       About · Files · Copies we found
```

- **One status line, in plain words**, with one status dot (see §5). It answers "do we have it, and is it good?" before anything else.
- **One primary action, chosen by state.** Missing → **Find a copy**. On disk but below good enough → **Look for a better copy**. Good enough → nothing loud. Member → **Ask for it**.
- **Copies we found opens in a side sheet** (a bottom sheet on phones) over the title. The page stays put, and the results get the full width.
- **"Search as" replaces the silent Profile select.** Changing the profile for good is a separate "Change…" action with an Undo toast.
- **After "Download this"**, the sheet closes. A toast says "Sent to qBittorrent · 21.4 GB · lands in Movies", with **See it** and **Cancel** buttons. The status line becomes "↓ On its way · 4 %".
- **Files**: lead with "4K Dolby Vision · WEB · 22.5 GB · by FLUX". The path goes behind "Show where it is".

## 4. Quality: answer the everyday question first

- **Profiles list**: one card per profile, each with a one-sentence summary written from its settings, e.g. "Aims for 4K HDR, takes 1080p if that's all there is, skips remuxes · 212 movies". A **New profile** button opens a small dialog; the create form no longer sits on the page.
- **Profile page**, in three layers:
  1. **What it aims for**: the quality ladder and "Good enough at". That's all most visits need.
  2. **What it avoids and prefers**: a readable summary ("Never picks fake 4K, 3D, cinema-recorded sound… 14 in all · Prefers Atmos, Dolby Vision…"). Each line opens its rule.
  3. **For experts**: rules and points, plus sizes. Show "Never" instead of −10,000; the number appears only inside the expert view.
- **"Who gets which profile"** becomes its own tab: the assignment rules, the kids' default, and the test box. It's a different question, so it gets its own screen.
- **Delete** moves into a ⋯ menu, away from Save.

## 5. Visual system: fewer, firmer tokens

What exists today is good material used loosely: 6+ corner radii, a dozen one-off font sizes in px, and amber doing five jobs. Proposed tokens in `styles.css`:

**Color roles** (no new hues, new jobs):

| Token | Use it for | Never for |
|---|---|---|
| `amber` | The single primary action on a screen, the active nav item, focus | Links, eyebrows, decoration |
| `text` / `soft` / `muted` | Content, secondary, tertiary | Status |
| `ok` (teal) | Working, on disk, good enough | |
| `busy` (blue) | On its way, checking | |
| `attention` (amber-hi) | Needs you, waiting for OK | |
| `problem` (warn) | Can't reach, stuck, turned down | |
| `surface-1/2/3` | Page, raised, overlay | Nested boxes inside boxes |

Links become `text` with an underline on hover, not amber. Amber then only ever means "this is the thing to press".

**One status component** for Sources, Downloader, Services, files and downloads: a dot, a plain label, and an optional "what to do" link. It uses the exact wording in GLOSSARY.md, so the same failure looks the same everywhere.

**Type scale** as tokens instead of `text-[13px]`/`[15px]`/`[56px]`:
`display` (serif, film titles only) · `title` 28 · `heading` 18 · `body` 15 · `label` 13 · `caption` 12.
The serif is for **content** (film and show titles, the wordmark) and never for screen headings. "Settings" and "Quality" set in Inter semibold read as tools. That's the point: the serif then always means "a film".

**Surfaces**: drop most card borders. Group with spacing and a single hairline divider, and keep panels for things you act on as a unit (a form, a dialog, the inbox). Three radii: `sm` 8 (inputs, chips), `md` 12 (buttons, rows), `lg` 20 (posters, sheets, hero).

**Posters**: no title printed on the art. Placeholder posters use a soft gradient from the title's hue with a film-strip glyph, and the title appears once, underneath. Use real TMDB art wherever there's a key.

**Motion**: one ease (`cubic-bezier(.2,.8,.2,1)`, 180 ms) for sheets and toasts; progress bars move smoothly; respect reduced motion.

## 6. Consistency rules (UX that just makes sense)

1. **One save model.** Simple settings save on change and show "Saved ✓" beside the field. Connection forms (Prowlarr, qBittorrent, Plex) keep **Test** + **Save** together, per card.
2. **Every "go there" is a link.** No more "Settings → Sources" as plain text.
3. **Every destructive action** is away from the primary button, names what it removes, and offers Undo where it can.
4. **Every empty state** says why it's empty and gives one next step.
5. **Every page has its own browser title** ("Dune: Part Two · Marquee").
6. **44px everywhere**, including inline section links (make them buttons with padding) and the settings tabs.
7. **One name per thing** across the seeded presets, Home, the title page and the docs.

## Suggested order

1. **Trust fixes** (small, high value): label sample data, turn off dead buttons, "Search as" instead of the silent profile write, the send toast with Cancel, links for "go there", 44px targets, page titles.
2. **Tokens and the status component**: color roles, type scale, radii, then sweep the screens to use them.
3. **Navigation**: role-aware landing, merged Library, phone tab bar, avatar sheet, command bar.
4. **Title page hub**, with Copies in a sheet.
5. **Quality split** into list, profile page and "Who gets which profile".
6. **Home inbox** when Downloads (Milestone 3) gives it real rows.
