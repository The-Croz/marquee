# Handoff: build the Marquee iPhone app (all four phases)

You are picking this up cold, probably on Sonnet. Josh wants it built end to end without stopping to ask. Everything below is already decided; don't reopen it.

## Read first, in this order

1. `CLAUDE.md` (project rules: tests for server logic, append-only migrations, JSON writes, plain words, no arr jargon).
2. `docs/superpowers/specs/2026-11-25-iphone-app-design.md` (the design; every phase argues from it).
3. `docs/superpowers/plans/2026-11-25-iphone-app-phase-1.md` (Phase 1, ready to execute).
4. `docs/GLOSSARY.md` (on-screen words, including the new app words below).
5. Mockups: the "iPhone app · D + E" row on https://claude.ai/artifact/68JrXjWP9SqwwzaUoxcPWT (read the `project/App*.dc.html` files with the Artifact tool if you need exact layout). These are the look to match.

## Standing decisions (Josh, 2026-11-25)

1. **Scope: all four phases, back to back.** Phase 1 from its plan. For phases 2, 3 and 4, write the plan first with `superpowers:writing-plans` (save as `docs/superpowers/plans/2026-11-25-iphone-app-phase-N.md`, same shape as Phase 1, from the spec's Delivery list), then build it. Don't come back to Josh between phases.
2. **Branches: stacked, one PR per phase, never merge.** `iphone-app-1` (off `main`, already created with these docs), `iphone-app-2` off `iphone-app-1`, and so on. Push each and open a PR against the branch below it (phase 1 against `main`). Never merge: merging to `main` publishes `ghcr.io/the-croz/marquee:latest`, and Josh's live server takes it.
3. **Apple account.** Sign only with Josh's personal team, `DEVELOPMENT_TEAM = 5BHPMRU3T8`, set explicitly in `apps/ios/project.yml`. **Never** the Renovation Church team `P73FA44C6D`, even though Xcode is signed in to it. Josh is enrolling the personal account in the paid program; until a new team id is given, build Phase 3 (push, Live Activity) and test it against a **fake Apple push server**, and add the real-key steps to Josh's steps.
4. **Steps only Josh can do never stop you.** Add each to the **Josh's steps** checklist at the end of Milestone 7 in `docs/PLAN.md`, then carry on. These include: installing on his iPhone, the Pangolin `/api/*` rule, the Apple .p8 key and team id, the TestFlight upload, and checking the live `marquee` container's logs.
5. **Done means:** `pnpm test`, `pnpm typecheck` and `make -C apps/ios test` pass. The UI smoke test passes against demo mode. You've taken simulator screenshots of every new screen (`mcp__Claude_Code_iOS_Simulator__control` screenshot) and compared them with the mockups, fixing obvious differences. Then run **one review of the whole phase** before its PR (`superpowers:requesting-code-review`, or a single review subagent) and fix what it finds.
6. **Demo mode keeps up.** Each phase adds whatever fakes the screens need to `apps/server/scripts/demo.ts` (Phase 3: a fake Apple push server that logs what it would send; Phase 4: plays in progress for Watching). Every screen must be checkable with no real services.
7. **Stuck rule.** If something fails three times in a row with no progress, write what you tried in the PR body and in Josh's steps, skip that piece, and continue. Only stop the whole run if the stuck piece blocks everything after it, and leave a clear note in `docs/PLAN.md` when you do.
8. **Icon and name:** a placeholder icon (amber "M" on ink, `#F2B33D` on `#0A0C10`) and the name "Marquee". A real icon comes later.

## Words (settled, already in `docs/GLOSSARY.md`)

- **Watching** = someone is playing it right now. **Wanted / Not wanted** = Marquee looks for it by itself. Never use "Watched / Not watched" for the second meaning. As a small cleanup in Phase 2, rename any web screen that still says Watched/Not watched for "looks for it" to Wanted/Not wanted. "Never watched" (nobody has played it) is fine as it is. `test/words.test.ts` must still pass.
- **Phone** on screen ("Your phones", "Sign out this phone"); `device` stays in code and the API.
- **Home address** (your Wi-Fi) and **Outside address** (from anywhere, through Pangolin, `https://`).
- **Follow on Lock Screen** for the Live Activity button; "Live Activity" appears at most once, in help text.

## How to run it (keep token use down)

- Execute plans yourself with `superpowers:executing-plans` (inline), task by task, ticking the checkboxes in the plan file as you go. Don't spawn a subagent per task. The one review per phase is the only fresh-context check.
- Use the iOS simulator tools for building, launching, screenshots and taps. Use the `build` tool from `mcp__Claude_Code_iOS_Simulator__*` when it's available, else `xcodebuild`. Don't open the live panel unless Josh is watching.
- Demo mode: `pnpm build && pnpm --filter @marquee/server demo` (port 9797). It starts empty: `POST /api/auth/setup`, then `POST /api/library/scan`. Restart after rebuilding the web app.
- Commit after every task with plain-English messages ending with the Co-Authored-By line. Push each phase branch when its PR is ready. Open PRs with the `pr` skill's body style.
- Update `docs/PLAN.md` Milestone 7 as phases finish (✅ the lines you've built).

## Order

1. Phase 1: Foundations (plan ready).
2. Phase 2: Browse (Library, title pages, episode up close, Discover with asking, Search, Calendar, the Watched→Wanted wording cleanup).
3. Phase 3: Push (apns channel and Shared alerts setup, notification extension with cover art, Approve / Turn down on the Lock Screen needing Face ID, Follow on Lock Screen), against the fake Apple server.
4. Phase 4: Manage and family (Watching with the live stream, Manage screens, member and kid polish, TestFlight archive settings, an "Install Marquee on your iPhone" page in the web app).

When all four PRs are open, finish with a short summary at the top of Milestone 7: what's built, each PR link, and Josh's steps.
