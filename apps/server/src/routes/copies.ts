import { Hono } from 'hono';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { CopiesResult } from '@marquee/shared';
import { episodes, mediaFiles, movies, series } from '../db/schema.js';
import { HttpError, requireAdmin, type Ctx, type Env } from '../http.js';
import { decide, type Wanted } from '../releases/decide.js';
import { copyView as view } from '../releases/view.js';
import { ProfileService } from '../releases/profiles.js';
import type { SearchQuery } from '../sources/torznab.js';
import { compareToYours, judgeFile, worstFile } from '../releases/upgrade.js';
import type { SearchTarget } from '../downloads/cache.js';

/**
 * "Copies we found": searches every Source for a title and judges each copy
 * against its profile and against the file you already have. Admin only.
 * The judged copies are kept in memory for an hour so one can be sent to
 * qBittorrent (`POST /api/downloads`).
 */
export const movieCopyRoutes = new Hono<Env>();
export const showCopyRoutes = new Hono<Env>();

async function run(c: Ctx, wanted: Wanted, query: Exclude<SearchQuery, { kind: 'recent' }>, profileKey: string, target: SearchTarget, files: string[]): Promise<CopiesResult> {
  const { sources, db, now, copies } = c.get('deps');
  const profile = new ProfileService(db, now).forTitle(wanted.kind, profileKey);
  if (!sources.view().sources.some((s) => s.enabled)) throw new HttpError(409, 'no_sources', 'There are no Sources to search yet. Add some in Settings → Sources.');
  const started = now();
  const outcome = await sources.search(query);
  const decisions = decide(wanted, outcome.releases, profile);
  const yours = worstFile(files.map((f) => judgeFile(wanted, f, profile)));
  // Only copies Marquee would take are compared with your file; the rest already say why not.
  const vsYours = decisions.map((d) => (d.accepted ? compareToYours(d, yours, profile) : null));
  const searchId = copies.put({ wanted, target, profileKey: profile.key, decisions, vsYours });
  return {
    searchId,
    yours: yours && { name: yours.name, qualityLabel: yours.qualityLabel, score: yours.score },
    profile: { id: profile.id, key: profile.key, name: profile.name },
    copies: decisions.map((d, i) => ({ ...view(d), id: String(i), vsYours: vsYours[i] })),
    sources: outcome.sources,
    ms: now() - started,
  };
}

movieCopyRoutes.post('/:id{[0-9]+}/search', async (c) => {
  requireAdmin(c);
  const m = c.get('deps').db.select().from(movies).where(eq(movies.id, Number(c.req.param('id')))).get();
  if (!m) throw new HttpError(404, 'not_found', 'No such movie.');
  const wanted: Wanted = { kind: 'movie', title: m.title, year: m.year, tmdbId: m.tmdbId, imdbId: m.imdbId, runtime: m.runtime };
  const files = c.get('deps').db.select({ path: mediaFiles.path }).from(mediaFiles).where(eq(mediaFiles.movieId, m.id)).all().map((f) => f.path);
  return c.json<CopiesResult>(await run(c, wanted, { kind: 'movie', title: m.title, year: m.year, tmdbId: m.tmdbId, imdbId: m.imdbId }, m.profile, { kind: 'movie', movieId: m.id }, files));
});

const episodeBody = z.object({ season: z.number().int().min(0).max(500), episode: z.number().int().min(0).max(5000).optional() });

showCopyRoutes.post('/:id{[0-9]+}/search', async (c) => {
  requireAdmin(c);
  const { season, episode } = episodeBody.parse(await c.req.json());
  const { db } = c.get('deps');
  const s = db.select().from(series).where(eq(series.id, Number(c.req.param('id')))).get();
  if (!s) throw new HttpError(404, 'not_found', 'No such show.');
  const count = db.select({ n: sql<number>`count(*)` }).from(episodes).where(and(eq(episodes.seriesId, s.id), eq(episodes.season, season))).get()?.n ?? 0;
  // Shows don't store an episode length yet, so size limits are skipped for TV searches.
  const wanted: Wanted = { kind: 'tv', title: s.title, year: s.year, tmdbId: s.tmdbId, imdbId: s.imdbId, tvdbId: s.tvdbId, season, episode, runtime: null, seasonEpisodes: count || undefined };
  // Your files for that episode, or for the whole season (judged by its worst episode).
  const files = db
    .select({ path: mediaFiles.path, episodes: mediaFiles.episodes })
    .from(mediaFiles)
    .where(and(inArray(mediaFiles.seriesId, [s.id]), eq(mediaFiles.season, season)))
    .all()
    .filter((f) => episode === undefined || (JSON.parse(f.episodes ?? '[]') as number[]).includes(episode))
    .map((f) => f.path);
  return c.json<CopiesResult>(
    await run(c, wanted, { kind: 'tv', title: s.title, tvdbId: s.tvdbId, tmdbId: s.tmdbId, imdbId: s.imdbId, season, episode }, s.profile, { kind: 'tv', seriesId: s.id, season, episode }, files),
  );
});
