import { Hono } from 'hono';
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type {
  EpisodeView,
  LibraryCard,
  MediaFileView,
  MovieDetail,
  QualityView,
  SearchResult,
  SeasonView,
  ShowDetail,
  UnmatchedItem,
} from '@marquee/shared';
import { episodes, mediaFiles, movies, scanItems, series, type MediaFile, type User } from '../db/schema.js';
import { readServices } from '../library/services.js';
import type { ScanSources } from '../library/scanner.js';
import { HttpError, requireAdmin, requireUser, type Ctx, type Env } from '../http.js';
import { ProfileService } from '../releases/profiles.js';
import { useRules } from '../releases/choose.js';

// Ratings a kid profile can see. Unrated titles are hidden from kids.
// (Milestone 5 makes this adjustable per profile.)
export const KID_MOVIE_RATINGS = ['G', 'PG'];
export const KID_TV_RATINGS = ['TV-Y', 'TV-Y7', 'TV-Y7-FV', 'TV-G', 'TV-PG'];

const today = () => new Date().toISOString().slice(0, 10);

export function qualityLabel(f: Pick<MediaFile, 'resolution' | 'hdr'>): string {
  const res = f.resolution === '2160p' ? '4K' : (f.resolution ?? 'Unknown quality');
  if (!f.hdr || f.resolution !== '2160p') return res;
  return f.hdr === 'Dolby Vision' ? `${res} DV` : `${res} HDR`;
}

function quality(f: MediaFile): QualityView {
  return { resolution: f.resolution, source: f.source, hdr: f.hdr, codec: f.codec, group: f.releaseGroup, label: qualityLabel(f) };
}

function fileView(f: MediaFile): MediaFileView {
  return { id: f.id, path: f.path, sizeBytes: f.size, quality: quality(f), addedAt: f.addedAt };
}

const isKid = (u: User) => u.role === 'kid';

/** Everything a library scan needs, or a plain-English reason it can't run yet. */
export function scanSources(c: Ctx): ScanSources {
  const { db, config, clients } = c.get('deps');
  const s = readServices(db, config);
  if (!s.tmdbApiKey) throw new HttpError(400, 'tmdb_missing', 'Add your TMDB API key in Settings → Services first.');
  return {
    tmdb: clients.tmdb(s.tmdbApiKey),
    radarr: s.radarrUrl && s.radarrApiKey ? clients.arr('radarr', s.radarrUrl, s.radarrApiKey) : null,
    sonarr: s.sonarrUrl && s.sonarrApiKey ? clients.arr('sonarr', s.sonarrUrl, s.sonarrApiKey) : null,
    moviesRoot: s.moviesRoot,
    tvRoot: s.tvRoot,
  };
}

export const libraryRoutes = new Hono<Env>();

// ---------------- Scanning ----------------

libraryRoutes.post('/scan', (c) => {
  requireAdmin(c);
  const { scanner } = c.get('deps');
  void scanner.start(scanSources(c));
  return c.json(scanner.status, 202);
});

libraryRoutes.get('/scan', (c) => {
  requireAdmin(c);
  return c.json(c.get('deps').scanner.status);
});

// ---------------- Needs a match ----------------

libraryRoutes.get('/unmatched', (c) => {
  requireAdmin(c);
  const rows = c.get('deps').db.select().from(scanItems).where(eq(scanItems.status, 'unmatched')).orderBy(asc(scanItems.path)).all();
  const items: UnmatchedItem[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    path: r.path,
    folder: r.path.split('/').filter(Boolean).at(-1) ?? r.path,
    parsedTitle: r.parsedTitle,
    parsedYear: r.parsedYear,
    reason: r.reason,
    candidates: JSON.parse(r.candidates),
  }));
  return c.json({ items });
});

libraryRoutes.post('/unmatched/:id{[0-9]+}/match', async (c) => {
  requireAdmin(c);
  const { tmdbId } = z.object({ tmdbId: z.number().int().positive() }).parse(await c.req.json());
  const sources = scanSources(c);
  try {
    await c.get('deps').scanner.matchFolder(sources.tmdb, Number(c.req.param('id')), tmdbId);
  } catch (err) {
    throw new HttpError(400, 'match_failed', (err as Error).message);
  }
  return c.json({ ok: true });
});

libraryRoutes.post('/unmatched/:id{[0-9]+}/ignore', (c) => {
  requireAdmin(c);
  c.get('deps').db.update(scanItems).set({ status: 'ignored' }).where(eq(scanItems.id, Number(c.req.param('id')))).run();
  return c.json({ ok: true });
});

// ---------------- Search and add ----------------

libraryRoutes.get('/search', async (c) => {
  const user = requireUser(c);
  if (isKid(user)) throw new HttpError(403, 'forbidden', 'Ask a grown-up to search for new things to watch.');
  const { db } = c.get('deps');
  const q = z.string().trim().min(1).max(200).parse(c.req.query('q') ?? '');
  const kind = z.enum(['movie', 'series', 'all']).parse(c.req.query('kind') ?? 'all');
  const { tmdb } = scanSources(c);
  const [m, s] = await Promise.all([
    kind !== 'series' ? tmdb.searchMovie(q) : Promise.resolve([]),
    kind !== 'movie' ? tmdb.searchShow(q) : Promise.resolve([]),
  ]);
  const movieIds = new Map(
    m.length ? db.select({ id: movies.id, tmdbId: movies.tmdbId }).from(movies).where(inArray(movies.tmdbId, m.map((x) => x.tmdbId))).all().map((r) => [r.tmdbId, r.id]) : [],
  );
  const showIds = new Map(
    s.length ? db.select({ id: series.id, tmdbId: series.tmdbId }).from(series).where(inArray(series.tmdbId, s.map((x) => x.tmdbId))).all().map((r) => [r.tmdbId, r.id]) : [],
  );
  const results: SearchResult[] = [
    ...m.map((r) => ({ kind: 'movie' as const, ...r, libraryId: movieIds.get(r.tmdbId) ?? null })),
    ...s.map((r) => ({ kind: 'series' as const, ...r, libraryId: showIds.get(r.tmdbId) ?? null })),
  ]
    .sort((a, b) => (b as unknown as { popularity: number }).popularity - (a as unknown as { popularity: number }).popularity)
    .slice(0, 30)
    .map(({ kind, tmdbId, title, year, posterPath, overview, libraryId }) => ({ kind, tmdbId, title, year, posterPath, overview, libraryId }));
  return c.json({ results });
});

/** Adds a title you don't have yet. It shows as "Missing" until Milestone 3 can download it. */
libraryRoutes.post('/add', async (c) => {
  requireAdmin(c);
  const { db, scanner, now } = c.get('deps');
  const input = z.object({ kind: z.enum(['movie', 'series']), tmdbId: z.number().int().positive() }).parse(await c.req.json());
  const { tmdb } = scanSources(c);
  if (input.kind === 'movie') {
    const existing = db.select().from(movies).where(eq(movies.tmdbId, input.tmdbId)).get();
    const row = existing ?? (await scanner.upsertMovie(tmdb, input.tmdbId, null, now()));
    return c.json({ id: row.id, kind: 'movie' }, existing ? 200 : 201);
  }
  const existing = db.select().from(series).where(eq(series.tmdbId, input.tmdbId)).get();
  const row = existing ?? (await scanner.upsertSeries(tmdb, input.tmdbId, null, now()));
  return c.json({ id: row.id, kind: 'series' }, existing ? 200 : 201);
});

// ---------------- Movies ----------------

const listQuery = z.object({
  q: z.string().trim().max(200).optional(),
  filter: z.enum(['all', 'have', 'missing']).default('all'),
  sort: z.enum(['added', 'title', 'year']).default('added'),
});

export const movieRoutes = new Hono<Env>();

movieRoutes.get('/', (c) => {
  const user = requireUser(c);
  const { db } = c.get('deps');
  const { q, filter, sort } = listQuery.parse(c.req.query());
  const rows = db
    .select()
    .from(movies)
    .where(
      and(
        isKid(user) ? inArray(movies.certification, KID_MOVIE_RATINGS) : undefined,
        q ? sql`lower(${movies.title}) like ${'%' + q.toLowerCase() + '%'}` : undefined,
      ),
    )
    .orderBy(sort === 'title' ? asc(movies.sortTitle) : sort === 'year' ? desc(movies.year) : desc(movies.addedAt))
    .all();

  // Best file per movie: highest resolution, then largest.
  const files = rows.length ? db.select().from(mediaFiles).where(isNotNull(mediaFiles.movieId)).all() : [];
  const byMovie = new Map<number, MediaFile[]>();
  for (const f of files) byMovie.set(f.movieId!, [...(byMovie.get(f.movieId!) ?? []), f]);
  const rank = (r: string | null) => ['480p', '576p', '720p', '1080p', '2160p'].indexOf(r ?? '');

  const cards: LibraryCard[] = rows
    .map((m) => {
      const fs = byMovie.get(m.id) ?? [];
      const best = [...fs].sort((a, b) => rank(b.resolution) - rank(a.resolution) || b.size - a.size)[0];
      return {
        id: m.id,
        kind: 'movie' as const,
        title: m.title,
        year: m.year,
        posterPath: m.posterPath,
        certification: m.certification,
        complete: !!best,
        badge: best ? qualityLabel(best) : 'Missing',
        sizeBytes: fs.reduce((n, f) => n + f.size, 0),
        addedAt: m.addedAt,
      };
    })
    .filter((card) => filter === 'all' || (filter === 'have') === card.complete);
  return c.json({ items: cards });
});

movieRoutes.get('/:id{[0-9]+}', (c) => {
  const user = requireUser(c);
  const { db } = c.get('deps');
  const m = db.select().from(movies).where(eq(movies.id, Number(c.req.param('id')))).get();
  if (!m || (isKid(user) && !KID_MOVIE_RATINGS.includes(m.certification ?? ''))) throw new HttpError(404, 'not_found', 'No such movie.');
  const files = db.select().from(mediaFiles).where(eq(mediaFiles.movieId, m.id)).orderBy(desc(mediaFiles.size)).all();
  const detail: MovieDetail = {
    id: m.id,
    tmdbId: m.tmdbId,
    imdbId: m.imdbId,
    title: m.title,
    year: m.year,
    overview: m.overview,
    posterPath: m.posterPath,
    backdropPath: m.backdropPath,
    runtime: m.runtime,
    certification: m.certification,
    genres: JSON.parse(m.genres),
    path: m.path,
    monitored: m.monitored,
    profile: m.profile,
    profileByHand: m.profileByHand,
    addedAt: m.addedAt,
    files: files.map(fileView),
  };
  return c.json(detail);
});

// ---------------- Shows ----------------

export const showRoutes = new Hono<Env>();

/** Have / aired episode counts per show, ignoring specials (season 0). */
function episodeCounts(c: Ctx, seriesIds: number[]) {
  const { db } = c.get('deps');
  const counts = new Map<number, { have: number; aired: number }>();
  if (seriesIds.length === 0) return counts;
  const eps = db.select().from(episodes).where(inArray(episodes.seriesId, seriesIds)).all();
  const files = db.select().from(mediaFiles).where(inArray(mediaFiles.seriesId, seriesIds)).all();
  const have = new Set(files.flatMap((f) => (JSON.parse(f.episodes ?? '[]') as number[]).map((n) => `${f.seriesId}:${f.season}:${n}`)));
  const t = today();
  for (const e of eps) {
    if (e.season === 0) continue;
    const row = counts.get(e.seriesId) ?? { have: 0, aired: 0 };
    const got = have.has(`${e.seriesId}:${e.season}:${e.episode}`);
    if (got) row.have++;
    if (got || (e.airDate && e.airDate <= t)) row.aired++;
    counts.set(e.seriesId, row);
  }
  return counts;
}

showRoutes.get('/', (c) => {
  const user = requireUser(c);
  const { db } = c.get('deps');
  const { q, filter, sort } = listQuery.parse(c.req.query());
  const rows = db
    .select()
    .from(series)
    .where(
      and(
        isKid(user) ? inArray(series.certification, KID_TV_RATINGS) : undefined,
        q ? sql`lower(${series.title}) like ${'%' + q.toLowerCase() + '%'}` : undefined,
      ),
    )
    .orderBy(sort === 'title' ? asc(series.sortTitle) : sort === 'year' ? desc(series.year) : desc(series.addedAt))
    .all();
  const counts = episodeCounts(c, rows.map((r) => r.id));
  const sizes = new Map(
    rows.length
      ? db
          .select({ id: mediaFiles.seriesId, size: sql<number>`sum(${mediaFiles.size})` })
          .from(mediaFiles)
          .where(inArray(mediaFiles.seriesId, rows.map((r) => r.id)))
          .groupBy(mediaFiles.seriesId)
          .all()
          .map((r) => [r.id!, r.size])
      : [],
  );
  const cards: LibraryCard[] = rows
    .map((s) => {
      const n = counts.get(s.id) ?? { have: 0, aired: 0 };
      return {
        id: s.id,
        kind: 'series' as const,
        title: s.title,
        year: s.year,
        posterPath: s.posterPath,
        certification: s.certification,
        complete: n.aired > 0 && n.have >= n.aired,
        badge: n.aired === 0 ? 'Not aired yet' : n.have >= n.aired ? `All ${n.aired} episodes` : `${n.have} of ${n.aired} episodes`,
        sizeBytes: sizes.get(s.id) ?? 0,
        addedAt: s.addedAt,
      };
    })
    .filter((card) => filter === 'all' || (filter === 'have') === card.complete);
  return c.json({ items: cards });
});

showRoutes.get('/:id{[0-9]+}', (c) => {
  const user = requireUser(c);
  const { db } = c.get('deps');
  const s = db.select().from(series).where(eq(series.id, Number(c.req.param('id')))).get();
  if (!s || (isKid(user) && !KID_TV_RATINGS.includes(s.certification ?? ''))) throw new HttpError(404, 'not_found', 'No such show.');
  const eps = db.select().from(episodes).where(eq(episodes.seriesId, s.id)).orderBy(asc(episodes.season), asc(episodes.episode)).all();
  const files = db.select().from(mediaFiles).where(eq(mediaFiles.seriesId, s.id)).all();
  const fileFor = new Map<string, MediaFile>();
  for (const f of files) for (const n of JSON.parse(f.episodes ?? '[]') as number[]) fileFor.set(`${f.season}:${n}`, f);
  const t = today();
  const seasons = new Map<number, SeasonView>();
  for (const e of eps) {
    const f = fileFor.get(`${e.season}:${e.episode}`);
    const view: EpisodeView = { episode: e.episode, title: e.title, airDate: e.airDate, aired: !!(e.airDate && e.airDate <= t), file: f ? fileView(f) : null };
    const sv = seasons.get(e.season) ?? { season: e.season, have: 0, aired: 0, total: 0, episodes: [] };
    sv.episodes.push(view);
    sv.total++;
    if (f) sv.have++;
    if (f || view.aired) sv.aired++;
    seasons.set(e.season, sv);
  }
  const detail: ShowDetail = {
    id: s.id,
    tmdbId: s.tmdbId,
    tvdbId: s.tvdbId,
    title: s.title,
    year: s.year,
    overview: s.overview,
    posterPath: s.posterPath,
    backdropPath: s.backdropPath,
    status: s.status,
    network: s.network,
    certification: s.certification,
    genres: JSON.parse(s.genres),
    path: s.path,
    monitored: s.monitored,
    profile: s.profile,
    profileByHand: s.profileByHand,
    addedAt: s.addedAt,
    sizeBytes: files.reduce((n, f) => n + f.size, 0),
    // Regular seasons first, specials last
    seasons: [...seasons.values()].sort((a, b) => (a.season === 0 ? 1 : b.season === 0 ? -1 : a.season - b.season)),
  };
  return c.json(detail);
});

/** Changes which profile a movie or show uses. Admin only. */
// `profile: null` hands the title back to the profile rules.
const profileBody = z.object({ profile: z.string().min(1).nullable() });
async function setProfile(c: Ctx, kind: 'movie' | 'tv') {
  requireAdmin(c);
  const { profile } = profileBody.parse(await c.req.json());
  const { db, now } = c.get('deps');
  const id = Number(c.req.param('id'));
  if (profile === null) return c.json({ ok: true, profile: useRules(db, kind, id), byHand: false });
  new ProfileService(db, now).assign(kind, id, profile);
  return c.json({ ok: true, profile, byHand: true });
}
movieRoutes.put('/:id{[0-9]+}/profile', (c) => setProfile(c, 'movie'));
showRoutes.put('/:id{[0-9]+}/profile', (c) => setProfile(c, 'tv'));
