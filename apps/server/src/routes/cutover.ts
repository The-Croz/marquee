import { Hono } from 'hono';
import { z } from 'zod';
import type { CutoverView, WantedRunView } from '@marquee/shared';
import { requireAdmin, type Ctx, type Env } from '../http.js';
import { cutoverChecklist } from '../compare/cutover.js';
import { lookForWanted, setLookingForWanted } from '../downloads/wanted.js';
import { dailyLimit, setDailyLimit } from '../downloads/wantedLimits.js';
import { catchNewEpisodes, lookForWantedTv, setLookingForWantedTv } from '../downloads/wantedTv.js';

/**
 * Switching over from Radarr (`/api/cutover`) and Sonarr (`/api/cutover/tv`):
 * the checklist, and "Marquee looks for wanted movies / episodes". Admin only.
 */
export const cutoverRoutes = new Hono<Env>();

const checklist = (c: Ctx, kind: 'movie' | 'tv') => {
  const { db, config, clients, now } = c.get('deps');
  return cutoverChecklist({ db, config, clients, now }, kind);
};

cutoverRoutes.get('/', async (c) => {
  requireAdmin(c);
  return c.json<CutoverView>(await checklist(c, 'movie'));
});

cutoverRoutes.put('/', async (c) => {
  requireAdmin(c);
  const { lookForWanted: on } = z.object({ lookForWanted: z.boolean() }).parse(await c.req.json());
  setLookingForWanted(c.get('deps').db, on);
  return c.json<CutoverView>(await checklist(c, 'movie'));
});

/** "Look now": runs a search for missing movies (or better copies) at once. */
cutoverRoutes.post('/look-now', async (c) => {
  requireAdmin(c);
  const { kind, preview } = z.object({ kind: z.enum(['missing', 'better']), preview: z.boolean().optional() }).parse(await c.req.json());
  const { db, clients, sources, now } = c.get('deps');
  return c.json<WantedRunView>(await lookForWanted({ db, clients, sources, now, preview }, kind));
});

cutoverRoutes.get('/tv', async (c) => {
  requireAdmin(c);
  return c.json<CutoverView>(await checklist(c, 'tv'));
});

cutoverRoutes.put('/tv', async (c) => {
  requireAdmin(c);
  const { lookForWanted: on } = z.object({ lookForWanted: z.boolean() }).parse(await c.req.json());
  setLookingForWantedTv(c.get('deps').db, on);
  return c.json<CutoverView>(await checklist(c, 'tv'));
});

/** "Look now" for TV: new episodes from the Sources' newest copies, missing episodes, or better copies. */
cutoverRoutes.post('/tv/look-now', async (c) => {
  requireAdmin(c);
  const { kind, preview } = z.object({ kind: z.enum(['new', 'missing', 'better']), preview: z.boolean().optional() }).parse(await c.req.json());
  const { db, clients, sources, now } = c.get('deps');
  const deps = { db, clients, sources, now, preview };
  return c.json<WantedRunView>(kind === 'new' ? await catchNewEpisodes(deps) : await lookForWantedTv(deps, kind));
});

/** The most copies Marquee sends by itself in 24 hours, for movies and TV together (0 = no limit). */
cutoverRoutes.get('/limit', (c) => {
  requireAdmin(c);
  return c.json({ dailyLimit: dailyLimit(c.get('deps').db) });
});

cutoverRoutes.put('/limit', async (c) => {
  requireAdmin(c);
  const { dailyLimit: n } = z.object({ dailyLimit: z.number().int().min(0).max(1000) }).parse(await c.req.json());
  setDailyLimit(c.get('deps').db, n);
  return c.json({ dailyLimit: n });
});
