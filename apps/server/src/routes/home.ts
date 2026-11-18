import fs from 'node:fs/promises';
import { Hono } from 'hono';
import { count, desc, inArray, isNotNull, sql } from 'drizzle-orm';
import type { HomeData } from '@marquee/shared';
import { mediaFiles, movies, series } from '../db/schema.js';
import { comingUp } from '../library/airing.js';
import { readServices } from '../library/services.js';
import { KID_MOVIE_RATINGS, KID_TV_RATINGS, qualityLabel } from './library.js';
import { requireUser, type Ctx, type Env } from '../http.js';

const DAY = 24 * 60 * 60 * 1000;

function fmtBytes(n: number): string {
  const tb = n / 1e12;
  return tb >= 1 ? `${tb.toFixed(1)} TB` : `${Math.round(n / 1e9)} GB`;
}

/** Real "Recently added" and library numbers, once a scan has found something. */
async function realLibrary(c: Ctx, kid: boolean): Promise<Pick<HomeData, 'recent' | 'stats'> | null> {
  const { db, config, now } = c.get('deps');
  const hasFiles = (db.select({ n: count() }).from(mediaFiles).get()?.n ?? 0) > 0;
  if (!hasFiles) return null;

  // Latest file per title, newest first
  const latest = db
    .select({ movieId: mediaFiles.movieId, seriesId: mediaFiles.seriesId, addedAt: sql<number>`max(${mediaFiles.addedAt})`, resolution: mediaFiles.resolution, hdr: mediaFiles.hdr, season: mediaFiles.season, episodes: mediaFiles.episodes })
    .from(mediaFiles)
    .groupBy(sql`coalesce(${mediaFiles.movieId}, -${mediaFiles.seriesId})`)
    .orderBy(desc(sql`max(${mediaFiles.addedAt})`))
    .limit(40)
    .all();
  const movieRows = new Map(db.select().from(movies).where(inArray(movies.id, latest.filter((l) => l.movieId).map((l) => l.movieId!))).all().map((m) => [m.id, m]));
  const showRows = new Map(db.select().from(series).where(inArray(series.id, latest.filter((l) => l.seriesId).map((l) => l.seriesId!))).all().map((s) => [s.id, s]));

  const recent: HomeData['recent'] = [];
  for (const l of latest) {
    if (recent.length >= 14) break;
    if (l.movieId) {
      const m = movieRows.get(l.movieId);
      if (!m || (kid && !KID_MOVIE_RATINGS.includes(m.certification ?? ''))) continue;
      recent.push({ title: m.title, sub: `Movie · ${qualityLabel(l)}`, color: '#1A1F29', posterPath: m.posterPath, href: `/movies/${m.id}` });
    } else if (l.seriesId) {
      const s = showRows.get(l.seriesId);
      if (!s || (kid && !KID_TV_RATINGS.includes(s.certification ?? ''))) continue;
      const ep = (JSON.parse(l.episodes ?? '[]') as number[])[0];
      recent.push({ title: s.title, sub: `S${l.season} E${ep ?? '?'} · ${qualityLabel(l)}`, color: '#1A1F29', posterPath: s.posterPath, href: `/shows/${s.id}` });
    }
  }

  const weekAgo = now() - 7 * DAY;
  const addedMovies = db.select({ n: sql<number>`count(distinct ${mediaFiles.movieId})` }).from(mediaFiles).where(sql`${mediaFiles.movieId} is not null and ${mediaFiles.addedAt} >= ${weekAgo}`).get()?.n ?? 0;
  const addedEpisodes = db.select({ n: count() }).from(mediaFiles).where(sql`${mediaFiles.seriesId} is not null and ${mediaFiles.addedAt} >= ${weekAgo}`).get()?.n ?? 0;
  const movieCount = db.select({ n: sql<number>`count(distinct ${mediaFiles.movieId})` }).from(mediaFiles).where(isNotNull(mediaFiles.movieId)).get()?.n ?? 0;
  const showCount = db.select({ n: sql<number>`count(distinct ${mediaFiles.seriesId})` }).from(mediaFiles).where(isNotNull(mediaFiles.seriesId)).get()?.n ?? 0;

  const stats: HomeData['stats'] = [
    { label: 'In your library', value: `${movieCount + showCount}`, note: `${movieCount} movies · ${showCount} shows` },
    { label: 'Added this week', value: `${addedMovies + addedEpisodes}`, note: `${addedMovies} movies · ${addedEpisodes} episodes` },
  ];
  if (!kid) {
    try {
      const root = readServices(db, config).moviesRoot;
      const st = await fs.statfs(root);
      const free = st.bavail * st.bsize;
      const total = st.blocks * st.bsize;
      stats.push({ label: 'Free space', value: fmtBytes(free), note: `of ${fmtBytes(total)}` });
    } catch {
      /* folder not mounted: leave it out */
    }
  }
  return { recent, stats };
}

/**
 * Home screen data. Until the library (M1), downloads (M3), requests (M5) and
 * stats (M6) exist, this returns the sample data from the design mockups so the
 * UI can be built and reviewed. `sample: true` tells the web app to say so.
 */
export const homeRoutes = new Hono<Env>();

homeRoutes.get('/', async (c) => {
  const user = requireUser(c);
  const isAdmin = user.role === 'admin';
  const isKid = user.role === 'kid';

  const data: HomeData = {
    sample: true,
    libraryReady: false,
    nowDownloading: isKid
      ? null
      : {
          title: 'Dune: Part Two',
          requestedBy: 'Partner',
          quality: '4K HDR',
          profile: 'Cinema · efficient',
          size: '21.4 GB',
          percent: 62,
          speed: '48 MB/s',
          eta: 'About 8 min left',
        },
    stats: [
      { label: 'Watching now', value: '2', note: 'Plex 1 · Jellyfin 1' },
      { label: 'Added this week', value: '11', note: '3 movies · 8 episodes' },
      ...(isAdmin ? [{ label: 'Waiting for your OK', value: '2', note: 'From the Kids profile' }] : []),
      { label: 'Free space', value: '18.4 TB', note: 'of 60 TB' },
    ],
    approvals: isAdmin
      ? [
          { id: 1, title: 'Paw Patrol: The Mighty Movie', who: 'Kids · asked 2 hours ago', plan: 'Will use Kids & Cartoons · 720p', color: '#1F4E8C' },
          { id: 2, title: 'Bluey — Season 3', who: 'Kids · asked yesterday', plan: 'Kids & Cartoons · 720p · 3 episodes missing', color: '#3B8FB8' },
        ]
      : [],
    watching: isKid
      ? []
      : [
          { title: 'The Bear · S3 E4', who: 'Josh · Living Room TV · Plex', mode: 'Direct play · 4K', percent: 64 },
          { title: 'Bluey · S2 E19', who: 'Kids · iPad · Jellyfin', mode: 'Converting · 720p', percent: 30 },
        ],
    recent: (isKid
      ? [
          { title: 'Bluey', sub: 'S3 E41 · 720p', color: '#3B8FB8' },
          { title: 'Inside Out 2', sub: 'Movie · 4K HDR', color: '#7A3B6E' },
        ]
      : [
          { title: 'Dune: Part Two', sub: 'Movie · 4K HDR', color: '#6B3E1E' },
          { title: 'Severance', sub: 'S2 E7 · 4K HDR', color: '#22364A' },
          { title: 'The Bear', sub: 'S3 E5 · 1080p', color: '#5A2A22' },
          { title: 'Bluey', sub: 'S3 E41 · 720p', color: '#3B8FB8' },
          { title: 'Andor', sub: 'S2 E3 · 4K HDR', color: '#3C3A34' },
          { title: 'Inside Out 2', sub: 'Movie · 4K HDR', color: '#7A3B6E' },
          { title: 'Shōgun', sub: 'S1 E10 · 4K HDR', color: '#4A1F1A' },
        ]),
    upcoming: isKid
      ? [{ day: 'Sun', title: 'Bluey · new episodes', note: 'Kids & Cartoons · 720p' }]
      : [
          { day: 'Tue', title: 'Severance · next episode', note: 'Will grab 4K HDR automatically' },
          { day: 'Thu', title: 'The Bear · next episode', note: 'No 4K expected · 1080p' },
          { day: 'Fri', title: 'Andor · next episode', note: 'Will grab 4K HDR automatically' },
          { day: 'Sun', title: 'Bluey · new episodes', note: 'Kids & Cartoons · 720p' },
        ],
  };
  const real = await realLibrary(c, isKid);
  if (real) {
    data.libraryReady = true;
    data.recent = real.recent;
    // Keep the sample "Watching now" and approvals tiles until Milestones 5 and 6.
    data.stats = [...real.stats, ...data.stats.filter((s) => s.label === 'Watching now' || s.label === 'Waiting for your OK')];
  }
  // Real airing dates once there are shows in the library.
  const { db, now } = c.get('deps');
  if (db.select({ id: series.id }).from(series).limit(1).get()) data.upcoming = comingUp(db, now(), isKid ? KID_TV_RATINGS : undefined);
  return c.json(data);
});
