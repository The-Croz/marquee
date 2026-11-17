import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { CopiesResult, CopyView } from '@marquee/shared';
import { episodes, movies, series } from '../db/schema.js';
import { HttpError, requireAdmin, type Ctx, type Env } from '../http.js';
import { decide, type Decision, type Wanted } from '../releases/decide.js';
import { ProfileService } from '../releases/profiles.js';
import type { SearchQuery } from '../sources/torznab.js';

/**
 * "Copies we found": searches every Source for a title and judges each copy
 * against its profile. Admin only. Nothing is stored or downloaded.
 */
export const movieCopyRoutes = new Hono<Env>();
export const showCopyRoutes = new Hono<Env>();

function view(d: Decision): CopyView {
  const p = d.parsed;
  return {
    title: d.copy.title,
    sizeBytes: d.copy.size,
    seeders: d.seeders,
    leechers: d.leechers,
    publishedAt: d.copy.publishedAt,
    infoUrl: d.copy.infoUrl,
    sources: d.sources,
    quality: d.quality,
    qualityLabel: d.qualityLabel,
    tier: d.tier,
    score: d.score,
    rules: d.rules,
    rejections: d.rejections,
    accepted: d.accepted,
    details: { resolution: p.resolution, hdr: p.hdr, codec: p.codec, audio: p.audio, atmos: p.atmos, service: p.service, group: p.group, editions: p.editions, repack: p.repack > 0 || p.proper },
  };
}

async function run(c: Ctx, wanted: Wanted, query: Exclude<SearchQuery, { kind: 'recent' }>, profileKey: string): Promise<CopiesResult> {
  const { sources, db, now } = c.get('deps');
  const profile = new ProfileService(db, now).forTitle(wanted.kind, profileKey);
  if (!sources.view().sources.some((s) => s.enabled)) throw new HttpError(409, 'no_sources', 'There are no Sources to search yet. Add some in Settings → Sources.');
  const started = now();
  const outcome = await sources.search(query);
  return {
    profile: { id: profile.id, key: profile.key, name: profile.name },
    copies: decide(wanted, outcome.releases, profile).map(view),
    sources: outcome.sources,
    ms: now() - started,
  };
}

movieCopyRoutes.post('/:id{[0-9]+}/search', async (c) => {
  requireAdmin(c);
  const m = c.get('deps').db.select().from(movies).where(eq(movies.id, Number(c.req.param('id')))).get();
  if (!m) throw new HttpError(404, 'not_found', 'No such movie.');
  const wanted: Wanted = { kind: 'movie', title: m.title, year: m.year, tmdbId: m.tmdbId, imdbId: m.imdbId, runtime: m.runtime };
  return c.json<CopiesResult>(await run(c, wanted, { kind: 'movie', title: m.title, year: m.year, tmdbId: m.tmdbId, imdbId: m.imdbId }, m.profile));
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
  return c.json<CopiesResult>(await run(c, wanted, { kind: 'tv', title: s.title, tvdbId: s.tvdbId, tmdbId: s.tmdbId, imdbId: s.imdbId, season, episode }, s.profile));
});
