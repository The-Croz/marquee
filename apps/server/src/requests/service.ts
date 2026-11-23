import { and, desc, eq, gte, inArray, isNull, ne, or } from 'drizzle-orm';
import type { CardState, NewRequest, RequestAllowance, RequestState, RequestView } from '@marquee/shared';
import type { Db } from '../db/index.js';
import { downloads, episodes, mediaFiles, movies, profiles, requests, series, users, type Download, type RequestRow, type User } from '../db/schema.js';
import { HttpError } from '../http.js';
import type { Clients } from '../http.js';
import type { LibraryScanner } from '../library/scanner.js';
import { TmdbError, type TmdbApi } from '../library/tmdb.js';
import { setMoviesWanted, setSeasonWanted, setShowsWanted } from '../library/wanted.js';
import { lookForWanted } from '../downloads/wanted.js';
import { lookForWantedTv } from '../downloads/wantedTv.js';
import type { SourceService } from '../sources/service.js';
import { ProfileService } from '../releases/profiles.js';
import { notifyAdmins, tell, type NotifyDeps } from '../notify/service.js';
import { posterUrl, requestVars } from '../notify/vars.js';
import { isKidSafe } from '../discover/kids.js';
import { movieHomeDate, movieStage } from '../library/availability.js';
import { applyShowPreset, type ShowPreset } from '../library/showPresets.js';

/**
 * Requests, like Seerr's. An admin's request goes straight through: the title
 * is added, marked Wanted, and searched for at once. Everyone else's waits for
 * an admin, who can pick the profile and the seasons when approving, or turn
 * it down with a reason the person sees.
 */

export interface RequestDeps {
  db: Db;
  scanner: LibraryScanner;
  tmdb: TmdbApi;
  clients: Pick<Clients, 'qbittorrent' | 'fetchTorrent'>;
  sources: SourceService;
  notify: NotifyDeps;
  now: () => number;
  /** How long an approval waits for its first search before answering "searching" (ms). */
  firstSearchWait?: number;
}

/** First searches still running after their approval answered, by "movie:12" / "series:3". */
const searching = new Map<string, Promise<void>>();
const searchKey = (kind: 'movie' | 'series', id: number) => `${kind}:${id}`;
export const isSearching = (kind: 'movie' | 'series', id: number) => searching.has(searchKey(kind, id));
/** Resolves once every first search has finished (for tests and shutdown). */
export const searchesSettled = () => Promise.all([...searching.values()]).then(() => undefined);

const seasonsOf = (r: Pick<RequestRow, 'seasons'>): number[] | null => (r.seasons ? (JSON.parse(r.seasons) as number[]) : null);

// ---------------- Where a title stands ----------------

/** Episodes of a show: how many have aired in the given seasons (null = all regular seasons), and how many of those you have. */
export function showCoverage(db: Db, seriesId: number, seasons: number[] | null, today: string): { aired: number; have: number; any: boolean } {
  const files = db.select({ season: mediaFiles.season, episodes: mediaFiles.episodes }).from(mediaFiles).where(eq(mediaFiles.seriesId, seriesId)).all();
  const have = new Set<string>();
  for (const f of files) for (const e of JSON.parse(f.episodes ?? '[]') as number[]) have.add(`${f.season}:${e}`);
  let aired = 0;
  let got = 0;
  for (const e of db.select().from(episodes).where(eq(episodes.seriesId, seriesId)).all()) {
    if (e.season === 0 || (seasons && !seasons.includes(e.season)) || !e.airDate || e.airDate > today) continue;
    aired++;
    if (have.has(`${e.season}:${e.episode}`)) got++;
  }
  return { aired, have: got, any: files.length > 0 };
}

const todayOf = (now: number) => new Date(now).toISOString().slice(0, 10);

function activeDownload(db: Db, kind: 'movie' | 'series', id: number): boolean {
  const active = or(inArray(downloads.state, ['sent', 'downloading']), and(eq(downloads.state, 'done'), isNull(downloads.importedAt)));
  return !!db
    .select({ id: downloads.id })
    .from(downloads)
    .where(and(eq(downloads.kind, kind === 'movie' ? 'movie' : 'tv'), kind === 'movie' ? eq(downloads.movieId, id) : eq(downloads.seriesId, id), active))
    .get();
}

/** In your library, downloading, asked for…, for a list of TMDB ids of one kind. Declines only show for `userId`. */
export function titleStates(db: Db, kind: 'movie' | 'series', tmdbIds: number[], userId: number | null, now: number): Map<number, { state: CardState; libraryId: number | null }> {
  const out = new Map<number, { state: CardState; libraryId: number | null }>();
  if (!tmdbIds.length) return out;
  const reqs = db.select().from(requests).where(and(eq(requests.kind, kind), inArray(requests.tmdbId, tmdbIds))).all();
  const rows =
    kind === 'movie'
      ? db.select({ id: movies.id, tmdbId: movies.tmdbId }).from(movies).where(inArray(movies.tmdbId, tmdbIds)).all()
      : db.select({ id: series.id, tmdbId: series.tmdbId }).from(series).where(inArray(series.tmdbId, tmdbIds)).all();
  const lib = new Map(rows.map((r) => [r.tmdbId, r.id]));
  const filed = new Set(
    kind === 'movie'
      ? db.selectDistinct({ id: mediaFiles.movieId }).from(mediaFiles).where(inArray(mediaFiles.movieId, [...lib.values()])).all().map((r) => r.id)
      : db.selectDistinct({ id: mediaFiles.seriesId }).from(mediaFiles).where(inArray(mediaFiles.seriesId, [...lib.values()])).all().map((r) => r.id),
  );
  for (const tmdbId of tmdbIds) {
    const libraryId = lib.get(tmdbId) ?? null;
    const mine = reqs.filter((r) => r.tmdbId === tmdbId);
    let state: CardState = 'none';
    if (libraryId !== null && filed.has(libraryId)) state = 'in_library';
    else if (libraryId !== null && activeDownload(db, kind, libraryId)) state = 'downloading';
    else if (mine.some((r) => r.status === 'approved')) state = 'approved';
    else if (mine.some((r) => r.status === 'pending')) state = 'pending';
    else if (userId !== null && mine.some((r) => r.status === 'declined' && r.requestedBy === userId)) state = 'declined';
    out.set(tmdbId, { state, libraryId });
  }
  return out;
}

// ---------------- Views ----------------

const STATE_TEXT: Record<RequestState, string> = {
  pending: 'Waiting for an admin to approve it.',
  unreleased: 'Approved. It isn’t out yet, so Marquee will look for it when it is.',
  searching: 'Approved. Marquee is searching for a copy now.',
  looking: 'Approved. No good copy has turned up yet. Marquee keeps looking.',
  downloading: 'Downloading now.',
  ready: 'Ready to watch.',
  declined: 'Turned down.',
};

/** What an approved request is up to right now. */
export function approvedState(db: Db, r: RequestRow, now: number): RequestState {
  if (r.titleId === null) return 'looking';
  if (r.kind === 'movie') {
    if (db.select({ id: mediaFiles.id }).from(mediaFiles).where(eq(mediaFiles.movieId, r.titleId)).get()) return 'ready';
    if (activeDownload(db, 'movie', r.titleId)) return 'downloading';
    if (isSearching('movie', r.titleId)) return 'searching';
    return isReleased(db, 'movie', r.titleId, now) ? 'looking' : 'unreleased';
  }
  const cov = showCoverage(db, r.titleId, seasonsOf(r), todayOf(now));
  if (cov.aired > 0 && cov.have >= cov.aired) return 'ready';
  if (activeDownload(db, 'series', r.titleId)) return 'downloading';
  if (isSearching('series', r.titleId)) return 'searching';
  return cov.aired === 0 ? 'unreleased' : 'looking';
}

/** A movie is out once it can be streamed or bought, not just seen in cinemas (no dates counts as out). */
export function isReleased(db: Db, kind: 'movie' | 'series', id: number, now: number): boolean {
  if (kind !== 'movie') return true;
  const m = movieDates(db, id);
  return !m || movieStage(m, todayOf(now)) === 'out';
}

const movieDates = (db: Db, id: number) =>
  db.select({ releaseDate: movies.releaseDate, cinemaRelease: movies.cinemaRelease, digitalRelease: movies.digitalRelease, physicalRelease: movies.physicalRelease }).from(movies).where(eq(movies.id, id)).get();

/** "Dec 20, 2026" from "2026-12-20". */
export const prettyDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** When an approved request's title comes out, for the plain sentence. */
function comesOut(db: Db, r: RequestRow): string | null {
  if (r.titleId === null) return null;
  if (r.kind === 'movie') return db.select({ d: movies.releaseDate }).from(movies).where(eq(movies.id, r.titleId)).get()?.d ?? null;
  const seasons = seasonsOf(r);
  const dates = db.select({ s: episodes.season, d: episodes.airDate }).from(episodes).where(eq(episodes.seriesId, r.titleId)).all().filter((e) => e.s > 0 && e.d && (!seasons || seasons.includes(e.s))).map((e) => e.d!);
  return dates.sort()[0] ?? null;
}

function stateText(db: Db, r: RequestRow, state: RequestState, now: number): string {
  if (state === 'declined' && r.reason) return `Turned down: ${r.reason}`;
  if (state === 'unreleased') {
    if (r.kind === 'movie') return r.titleId !== null ? movieWaitText(db, r.titleId, now) : STATE_TEXT.unreleased;
    const date = comesOut(db, r);
    return `Approved. The first episode ${date ? `airs ${prettyDate(date)}` : 'hasn’t aired yet'}, and Marquee will look for it then.`;
  }
  if (state === 'downloading' && r.titleId !== null) {
    const d = db
      .select({ state: downloads.state, progress: downloads.progress })
      .from(downloads)
      .where(and(r.kind === 'movie' ? eq(downloads.movieId, r.titleId) : eq(downloads.seriesId, r.titleId), inArray(downloads.state, ['sent', 'downloading'])))
      .orderBy(desc(downloads.addedAt))
      .get();
    if (d && d.progress > 0) return `Downloading now · ${Math.floor(d.progress * 100)}%.`;
    if (d) return 'Found a copy. The download is starting.';
  }
  return STATE_TEXT[state];
}

/** "Approved. It's in cinemas now; Marquee looks for it once it's out to stream or buy, around Feb 18, 2027." */
function movieWaitText(db: Db, id: number, now: number): string {
  const m = movieDates(db, id);
  if (!m) return STATE_TEXT.unreleased;
  const home = movieHomeDate(m);
  const when = home ? `, ${home.known ? 'on' : 'around'} ${prettyDate(home.date)}` : '';
  const cinema = m.cinemaRelease ?? m.releaseDate;
  return movieStage(m, todayOf(now)) === 'cinemas'
    ? `Approved. It’s in cinemas now. Marquee looks for it once it’s out to stream or buy${when}.`
    : `Approved. It comes out${cinema ? ` in cinemas ${prettyDate(cinema)}` : ' later'}. Marquee looks for it once it’s out to stream or buy${when}.`;
}

export function requestView(db: Db, r: RequestRow, now: number): RequestView {
  const state: RequestState = r.status === 'pending' ? 'pending' : r.status === 'declined' ? 'declined' : approvedState(db, r, now);
  const by = r.requestedBy === null ? null : db.select({ id: users.id, name: users.displayName }).from(users).where(eq(users.id, r.requestedBy)).get() ?? null;
  const decider = r.decidedBy === null ? null : db.select({ name: users.displayName }).from(users).where(eq(users.id, r.decidedBy)).get()?.name ?? null;
  const profile = r.profile ? (db.select({ name: profiles.name }).from(profiles).where(eq(profiles.key, r.profile)).get()?.name ?? r.profile) : null;
  return {
    id: r.id,
    kind: r.kind,
    tmdbId: r.tmdbId,
    title: r.title,
    year: r.year,
    posterPath: r.posterPath,
    seasons: seasonsOf(r),
    requestedBy: by,
    state,
    stateText: stateText(db, r, state, now),
    profile,
    reason: r.reason,
    decidedBy: decider,
    createdAt: r.createdAt,
    decidedAt: r.decidedAt,
    href: r.titleId !== null && r.status === 'approved' ? `/${r.kind === 'movie' ? 'movies' : 'shows'}/${r.titleId}` : null,
  };
}

export function listRequests(db: Db, user: User, scope: 'mine' | 'all', now: number): RequestView[] {
  const where = scope === 'all' && user.role === 'admin' ? undefined : eq(requests.requestedBy, user.id);
  return db
    .select()
    .from(requests)
    .where(where)
    .orderBy(desc(requests.createdAt), desc(requests.id))
    .all()
    .map((r) => requestView(db, r, now));
}

export const pendingCount = (db: Db): number => db.select({ id: requests.id }).from(requests).where(eq(requests.status, 'pending')).all().length;

// ---------------- Asking ----------------

const tmdbFailed = (err: unknown): never => {
  if (err instanceof HttpError) throw err;
  if (err instanceof TmdbError && err.status === 404) throw new HttpError(404, 'not_found', 'TMDB doesn’t have that title.');
  throw new HttpError(502, 'tmdb_failed', 'TMDB didn’t answer. Try again in a moment.');
};

const WEEK = 7 * 24 * 3_600_000;

/** How many requests this person has left this week (admins and people with no limit: no limit). */
export function allowance(db: Db, user: User, now: number): RequestAllowance {
  const limit = user.role === 'admin' ? 0 : user.weeklyLimit;
  const mine = db
    .select({ at: requests.createdAt })
    .from(requests)
    .where(and(eq(requests.requestedBy, user.id), gte(requests.createdAt, now - WEEK), ne(requests.status, 'declined')))
    .all()
    .map((r) => r.at)
    .sort((a, b) => a - b);
  const used = mine.length;
  const left = limit ? Math.max(0, limit - used) : null;
  return { limit, used, left, nextAt: left === 0 && mine.length ? mine[used - limit]! + WEEK : null, skipApproval: user.role === 'admin' || user.skipApproval };
}

export async function createRequest(deps: RequestDeps, user: User, input: NewRequest): Promise<RequestView> {
  const { db, tmdb, now } = deps;
  const left = allowance(db, user, now());
  if (left.left === 0) {
    throw new HttpError(429, 'limit_reached', `You’ve used all ${left.limit} of your requests this week. The next one frees up ${left.nextAt ? new Date(left.nextAt).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }) : 'soon'}.`);
  }
  let title: string;
  let year: number | null;
  let posterPath: string | null;
  let certification: string | null;
  let seasonList: number[] | null = null;
  try {
    if (input.kind === 'movie') {
      const m = await tmdb.movie(input.tmdbId);
      ({ title, year, posterPath, certification } = m);
    } else {
      const s = await tmdb.show(input.tmdbId);
      ({ title, year, posterPath, certification } = s);
      const real = s.seasons.map((x) => x.season).filter((n) => n > 0);
      if (input.seasons?.length) {
        const bad = input.seasons.find((n) => !real.includes(n));
        if (bad !== undefined) throw new HttpError(400, 'no_such_season', `${title} has no season ${bad}.`);
        seasonList = [...new Set(input.seasons)].sort((a, b) => a - b);
        if (seasonList.length === real.length) seasonList = null;
      }
    }
  } catch (err) {
    return tmdbFailed(err);
  }
  if (user.role === 'kid' && !isKidSafe(input.kind, certification)) {
    throw new HttpError(403, 'not_for_kids', 'That one isn’t for kid profiles. Ask a grown-up to add it.');
  }

  // Already here, or already asked for?
  const state = titleStates(db, input.kind, [input.tmdbId], user.id, now()).get(input.tmdbId)!;
  if (input.kind === 'movie' && state.state === 'in_library') throw new HttpError(409, 'already_here', 'That’s already in your library.');
  if (input.kind === 'series' && state.libraryId !== null) {
    const cov = showCoverage(db, state.libraryId, seasonList, todayOf(now()));
    if (cov.aired > 0 && cov.have >= cov.aired) throw new HttpError(409, 'already_here', seasonList ? 'Those seasons are already in your library.' : 'That’s already in your library.');
  }
  const open = db.select().from(requests).where(and(eq(requests.kind, input.kind), eq(requests.tmdbId, input.tmdbId), inArray(requests.status, ['pending', 'approved']))).all();
  if (input.kind === 'movie' ? open.length > 0 : covered(open, seasonList)) {
    throw new HttpError(409, 'already_requested', input.kind === 'movie' ? 'Someone already asked for that. You’ll hear when it’s ready.' : 'That’s already been asked for. You’ll hear when it’s ready.');
  }

  const row = db
    .insert(requests)
    .values({ kind: input.kind, tmdbId: input.tmdbId, title, year, posterPath, seasons: seasonList ? JSON.stringify(seasonList) : null, requestedBy: user.id, createdAt: now() })
    .returning()
    .get();
  if (user.role === 'admin') return approveRequest(deps, row.id, user, input.preset && input.kind === 'series' ? { preset: input.preset } : {});
  // "Their requests skip approval": straight through, for kids only when it's a title for kids (it is, or they'd have been stopped above).
  if (user.skipApproval) return approveRequest(deps, row.id, user, {});
  await notifyAdmins(deps.notify, 'request_pending', { vars: { ...requestVars(row), user: user.displayName }, link: '/requests' });
  return requestView(db, row, now());
}

/** Does an earlier open request already cover these seasons? (null = the whole show.) */
function covered(open: RequestRow[], wanted: number[] | null): boolean {
  if (!open.length) return false;
  if (open.some((r) => seasonsOf(r) === null)) return true;
  if (wanted === null) return false;
  const have = new Set(open.flatMap((r) => seasonsOf(r) ?? []));
  return wanted.every((s) => have.has(s));
}

// ---------------- Deciding ----------------

export interface Approval {
  /** A profile key; leave out to let the profile rules choose. */
  profile?: string | undefined;
  /** Shows: change which seasons to take (null/undefined keeps what was asked). */
  seasons?: number[] | null | undefined;
  /** Shows: which episodes, as one choice (every episode, only new ones…); wins over `seasons`. */
  preset?: ShowPreset | undefined;
}

export async function approveRequest(deps: RequestDeps, id: number, admin: User, a: Approval): Promise<RequestView> {
  const { db, tmdb, scanner, now } = deps;
  const r = db.select().from(requests).where(eq(requests.id, id)).get();
  if (!r) throw new HttpError(404, 'not_found', 'That request isn’t there any more.');
  if (r.status === 'approved') throw new HttpError(409, 'already_decided', 'That request is already approved.');
  if (a.profile && !db.select({ id: profiles.id }).from(profiles).where(eq(profiles.key, a.profile)).get()) throw new HttpError(400, 'invalid_input', 'No such profile.');
  const seasons = a.seasons === undefined ? seasonsOf(r) : a.seasons?.length ? [...new Set(a.seasons)].sort((x, y) => x - y) : null;

  let titleId: number;
  try {
    if (r.kind === 'movie') {
      titleId = (await scanner.upsertMovie(tmdb, r.tmdbId, null, now())).id;
      setMoviesWanted(db, [titleId], true);
    } else {
      const show = await scanner.upsertSeries(tmdb, r.tmdbId, null, now());
      titleId = show.id;
      if (!show.monitored) db.update(episodes).set({ monitored: false }).where(eq(episodes.seriesId, titleId)).run();
      if (a.preset) applyShowPreset(db, titleId, a.preset === 'none' ? 'all' : a.preset, todayOf(now()));
      else if (seasons === null) setShowsWanted(db, [titleId], true);
      else for (const s of seasons) try { setSeasonWanted(db, titleId, s, true); } catch { /* a season TMDB hasn't listed yet */ }
    }
  } catch (err) {
    return tmdbFailed(err);
  }
  if (a.profile) new ProfileService(db, now).assign(r.kind === 'movie' ? 'movie' : 'tv', titleId, a.profile);

  const row = db
    .update(requests)
    .set({ status: 'approved', titleId, profile: a.profile ?? null, seasons: seasons ? JSON.stringify(seasons) : null, decidedBy: admin.id, decidedAt: now(), reason: null })
    .where(eq(requests.id, id))
    .returning()
    .get();

  // Look for it now; ongoing looking is Automatic searching's job. Never fails the approval.
  // A quick search answers with what it found; a slow one carries on in the background
  // while the request says "searching", so the app isn't left waiting.
  const key = searchKey(r.kind, titleId);
  const search = (async () => {
    try {
      const wanted = { db, clients: deps.clients, sources: deps.sources, now, only: { id: titleId }, manual: true };
      if (r.kind === 'movie') await lookForWanted(wanted, 'missing', 1);
      else await lookForWantedTv(wanted, 'missing', 50);
    } catch (err) {
      console.error('[requests] first search failed:', (err as Error).message);
    } finally {
      searching.delete(key);
    }
  })();
  searching.set(key, search);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([search, new Promise<void>((resolve) => (timer = setTimeout(resolve, deps.firstSearchWait ?? 1500)))]);
  clearTimeout(timer);

  if (r.requestedBy !== null && r.requestedBy !== admin.id) {
    tell(deps.notify, r.requestedBy, 'request_approved', { vars: { ...requestVars(r), by: admin.displayName }, link: '/requests' });
  }
  return requestView(db, row, now());
}

export function declineRequest(deps: RequestDeps, id: number, admin: User, reason: string): RequestView {
  const { db, now } = deps;
  const r = db.select().from(requests).where(eq(requests.id, id)).get();
  if (!r) throw new HttpError(404, 'not_found', 'That request isn’t there any more.');
  if (r.status !== 'pending') throw new HttpError(409, 'already_decided', 'That request has already been decided.');
  const row = db.update(requests).set({ status: 'declined', reason: reason.trim() || null, decidedBy: admin.id, decidedAt: now() }).where(eq(requests.id, id)).returning().get();
  tell(deps.notify, r.requestedBy, 'request_declined', { vars: { ...requestVars(r), reason: reason.trim() || null, by: admin.displayName }, link: '/requests' });
  return requestView(db, row, now());
}

/** Undo a decline (within a few seconds in the app, but allowed any time): back to waiting. */
export function reopenRequest(deps: RequestDeps, id: number): RequestView {
  const { db, now } = deps;
  const r = db.select().from(requests).where(eq(requests.id, id)).get();
  if (!r) throw new HttpError(404, 'not_found', 'That request isn’t there any more.');
  if (r.status !== 'declined') throw new HttpError(409, 'not_declined', 'Only a turned-down request can be put back.');
  return requestView(db, db.update(requests).set({ status: 'pending', reason: null, decidedBy: null, decidedAt: null }).where(eq(requests.id, id)).returning().get(), now());
}

/** Takes a request away. Its person can take back one that's still waiting; admins can remove any. The title itself is never touched. */
export function removeRequest(db: Db, id: number, user: User): void {
  const r = db.select().from(requests).where(eq(requests.id, id)).get();
  if (!r) throw new HttpError(404, 'not_found', 'That request isn’t there any more.');
  if (user.role !== 'admin') {
    if (r.requestedBy !== user.id) throw new HttpError(403, 'forbidden', 'That isn’t your request.');
    if (r.status !== 'pending') throw new HttpError(409, 'already_decided', 'It’s already been decided, so it can’t be taken back.');
  }
  db.delete(requests).where(eq(requests.id, id)).run();
}

/** Tells people when what they asked for has reached the library (once each). Called after an import and every few minutes. */
export function markReady(deps: Pick<RequestDeps, 'db' | 'notify' | 'now'>): number {
  const { db, now } = deps;
  let n = 0;
  for (const r of db.select().from(requests).where(and(eq(requests.status, 'approved'), isNull(requests.readyAt))).all()) {
    if (approvedState(db, r, now()) !== 'ready') continue;
    db.update(requests).set({ readyAt: now() }).where(eq(requests.id, r.id)).run();
    tell(deps.notify, r.requestedBy, 'request_ready', { vars: requestVars(r), link: r.titleId !== null ? `/${r.kind === 'movie' ? 'movies' : 'shows'}/${r.titleId}` : '/requests' });
    n++;
  }
  return n;
}

/**
 * After an episode reaches the library: tells each person who asked for the
 * show (and whose request already said "Ready to watch") that a new one is in.
 * Requests for other seasons stay quiet.
 */
export function tellNewEpisodes(deps: Pick<RequestDeps, 'db' | 'notify' | 'now'>, d: Pick<Download, 'kind' | 'seriesId' | 'season' | 'episodes'>): number {
  const { db } = deps;
  if (d.kind !== 'tv' || d.seriesId === null) return 0;
  const show = db.select().from(series).where(eq(series.id, d.seriesId)).get();
  if (!show) return 0;
  const eps = d.episodes ? (JSON.parse(d.episodes) as number[]) : null;
  const pad = (n: number) => String(n).padStart(2, '0');
  const which = d.season === null ? 'New episodes' : eps?.length ? eps.map((e) => `S${pad(d.season!)}E${pad(e)}`).join(', ') : `Season ${d.season}`;
  let n = 0;
  const told = new Set<number>();
  for (const r of db.select().from(requests).where(and(eq(requests.kind, 'series'), eq(requests.titleId, show.id), eq(requests.status, 'approved'))).all()) {
    if (r.readyAt === null || r.requestedBy === null || told.has(r.requestedBy)) continue;
    const seasons = r.seasons ? (JSON.parse(r.seasons) as number[]) : null;
    if (seasons && d.season !== null && !seasons.includes(d.season)) continue;
    told.add(r.requestedBy);
    tell(deps.notify, r.requestedBy, 'new_episode', { vars: { show: show.title, episodes: which, season: d.season, poster: posterUrl(show.posterPath ?? r.posterPath) }, link: `/shows/${show.id}` });
    n++;
  }
  return n;
}
