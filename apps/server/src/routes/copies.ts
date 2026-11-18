import { Hono } from 'hono';
import { z } from 'zod';
import type { CopiesResult } from '@marquee/shared';
import { requireAdmin, type Ctx, type Env } from '../http.js';
import { copyView as view } from '../releases/view.js';
import type { SearchTarget } from '../downloads/cache.js';
import { searchTitle } from '../downloads/search.js';

/**
 * "Copies we found": searches every Source for a title and judges each copy
 * against its profile and against the file you already have. Admin only.
 * The judged copies are kept in memory for an hour so one can be sent to
 * qBittorrent (`POST /api/downloads`).
 */
export const movieCopyRoutes = new Hono<Env>();
export const showCopyRoutes = new Hono<Env>();

async function run(c: Ctx, target: SearchTarget): Promise<CopiesResult> {
  const { sources, db, now, copies } = c.get('deps');
  const started = now();
  const r = await searchTitle({ db, sources, now }, target);
  const searchId = copies.put(r.search);
  return {
    searchId,
    yours: r.yours && { name: r.yours.name, qualityLabel: r.yours.qualityLabel, score: r.yours.score },
    profile: { id: r.profile.id, key: r.profile.key, name: r.profile.name },
    copies: r.search.decisions.map((d, i) => ({ ...view(d), id: String(i), vsYours: r.search.vsYours[i] })),
    sources: r.sources,
    ms: now() - started,
  };
}

movieCopyRoutes.post('/:id{[0-9]+}/search', async (c) => {
  requireAdmin(c);
  return c.json<CopiesResult>(await run(c, { kind: 'movie', movieId: Number(c.req.param('id')) }));
});

const episodeBody = z.object({ season: z.number().int().min(0).max(500), episode: z.number().int().min(0).max(5000).optional() });

showCopyRoutes.post('/:id{[0-9]+}/search', async (c) => {
  requireAdmin(c);
  const { season, episode } = episodeBody.parse(await c.req.json());
  return c.json<CopiesResult>(await run(c, { kind: 'tv', seriesId: Number(c.req.param('id')), season, episode }));
});
