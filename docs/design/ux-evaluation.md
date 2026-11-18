# Marquee web app, as of the downloads-send branch (Nov 2026)

## Anti-Pattern Verdict
Clean. No deceptive, urgency, consent or addictive patterns. The issues are ordinary UX failures: dead controls, a filter that silently writes, and dense screens.

## Priority Issues

### Critical

None. Every task that is built can be finished.

### Major

**Changing the Profile dropdown on a title quietly reassigns that title**
- **What happens:** In "Copies we found", the Profile select looks like a search filter. Changing it saves a new profile for the title at once (`components/Copies.tsx:208`), with no confirmation and no undo.
- **Why it matters:** Josh tries "what would Everyday HD pick?" and has changed what Marquee downloads for that title from now on, without knowing it.
- **Breaks:** user control and freedom; consistency and standards (a filter that writes).
- **Change:** Make the dropdown a preview ("Search as"). Changing the title's profile becomes its own labelled action, with undo.

**Buttons on Home do nothing, or go to the wrong place**
- **What happens:** Pause, Approve and Decline have no handler (`pages/Home.tsx:95, 129-132`). "Open title" goes to `/movies`, not to the title. All of them sit on sample data with nothing to say so.
- **Why it matters:** The first thing a new user clicks on the best-looking screen fails silently. That teaches them not to trust the rest.
- **Breaks:** visibility of system status; silent failure.
- **Change:** Mark sample blocks as Sample and turn their actions off until the feature exists. Link the hero to the real title.

**"Download this" ends in a line of text**
- **What happens:** After sending a copy, the result is one line of teal text. There is no link to where the download is, no way to cancel it, and nothing on the title shows it is now on its way.
- **Why it matters:** This is the most important action in the product, and the user cannot follow up on it or undo a mistake.
- **Breaks:** visibility of system status; user control and freedom.
- **Change:** Show a result that says where the copy went and where it will land, with a way to see it and a way to cancel it. Give the title's status line the new state.

**A family member has nowhere to ask for something**
- **What happens:** Discover and Requests are placeholders, and Search tells members that requests are coming in Milestone 5. A title page gives a member no action at all, since copies are admin-only.
- **Why it matters:** Members and kids, who are two of the three roles, reach a dead end on the one thing they came to do.
- **Breaks:** dead-end pages; flexibility and efficiency of use.
- **Change:** Until requests ship, give members a clear "Not yet: ask Josh" state instead of a dead end. Design Home around the person's role (see proposal).

**The Quality screen asks for every decision at once**
- **What happens:** One scrolling page holds the profile list, a create form, the kids' default, rules for assigning profiles, a test box, the quality ladder, and around 60 rules each with a points field. Only sizes are behind "For experts".
- **Why it matters:** The everyday question ("what does Cinema aim for?") gets buried under expert controls. Delete sits beside Save.
- **Breaks:** aesthetic and minimalist design; error prevention.
- **Change:** Split it into a list of profiles and one page per profile. Put rules and points behind "For experts", with a plain summary above them. Move assignment rules to their own view. Move Delete away from Save.

**On phones, the main nav is a 10-item strip that scrolls sideways**
- **What happens:** Quality, Compare and Settings sit off-screen. A bare sign-out icon sits beside the avatar.
- **Why it matters:** Most of the household will use Marquee on a phone. Hidden destinations get forgotten, and an accidental tap signs you out.
- **Breaks:** recognition rather than recall.
- **Change:** Use a bottom tab bar of at most five items, put the rest under the avatar, and move sign-out into that menu.

### Minor

**The same thing is called different names on different screens**
- **What happens:** A profile appears as "4K Quality" on Quality and the title page, "Cinema · efficient" on Home, and "Cinema" in the plan. Users says "Add someone" but its button reads "Add user". Settings pages save in different ways (one Save for four cards, a Save on each card, or no Save at all).
- **Why it matters:** People can't tell whether two names mean the same thing, or whether their edit was saved.
- **Breaks:** consistency and standards.
- **Change:** Use one name for each thing everywhere, and one way of saving across all of Settings.

**Raw file paths take over the Files card**
- **What happens:** Full `/data/...` paths in monospace are the most prominent text on a title page.
- **Why it matters:** The plain facts (quality, size, whether it's good enough) lose to text only an admin debugging needs.
- **Breaks:** aesthetic and minimalist design.
- **Change:** Lead with the plain description and show the path on request.

**Pointers to other screens are plain text**
- **What happens:** "Add some in Settings → Sources" is not a link. "Nothing found on TMDB for that." gives no next step.
- **Why it matters:** The user has to find their own way to the fix the app just named.
- **Breaks:** help users recognize, diagnose and recover from errors.
- **Change:** Every "go here" becomes a link, and every empty result suggests what to try next.

**Home shows numbers that contradict the real ones**
- **What happens:** Free space on Home (18.4 TB, sample) disagrees with the Downloader page (4.2 TB, real). Movies says "7 matched" over a list of 5 movies.
- **Why it matters:** Mismatched numbers make people doubt every number.
- **Breaks:** visibility of system status.
- **Change:** Show real numbers or a clear Sample mark, and count movies and shows separately.

**Some targets are under 44px**
- **What happens:** Section links on Home are 20px tall, the settings tabs 38px, number inputs 40px, the mobile nav 43px, and "Add a Source by hand" 28px.
- **Why it matters:** Harder to hit on a phone, and it breaks the project's own rule.
- **Breaks:** accessibility (WCAG 2.5.8, and the project's 44px convention).
- **Change:** Bring every interactive element up to 44px.

**No accelerators for the admin**
- **What happens:** There are no keyboard shortcuts, no bulk search, and no way to search for everything that's missing.
- **Why it matters:** Josh manages a whole library one title at a time.
- **Breaks:** flexibility and efficiency of use.
- **Change:** Add a command bar for jumping and searching, plus bulk actions on library lists.

### Cosmetic

**Small polish**
- **What happens:** The browser tab says "Marquee" on every page. The title is printed on the placeholder poster and again underneath it. On mobile, the divider under the nav covers only part of the width. Unmatched has a "Search TMDB" label beside a "Search TMDB" button.
- **Why it matters:** Small roughness that adds up.
- **Breaks:** aesthetic and minimalist design.
- **Change:** Give each page its own title, show the title once, fix the divider, and remove the duplicate label.

## Positive Findings
- The voice is the product's best asset: "1 person sharing", "Fake 4K (upscaled)", "then straight to Plex and Jellyfin". Keep it.
- The explainable picker (points per rule, "Best pick", "vs yours") turns a black box into a reason.
- Setup help is written for this household's real setup (the gluetun hint, "/data is your data share", read-only promises).
- "Nothing downloads until you press Download this" is exactly the reassurance that moment needs.
- "Show 22 qualities you don't take" is a good disclosure pattern; use it more.
- The code scan was clean, there's no horizontal scroll on phones, and text contrast passes everywhere that was measured.
