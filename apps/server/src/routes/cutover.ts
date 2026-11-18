import { Hono } from 'hono';
import { z } from 'zod';
import type { CutoverView, WantedRunView } from '@marquee/shared';
import { requireAdmin, type Ctx, type Env } from '../http.js';
import { cutoverChecklist } from '../compare/cutover.js';
import { lookForWanted, setLookingForWanted } from '../downloads/wanted.js';
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
  const { kind } = z.object({ kind: z.enum(['missing', 'better']) }).parse(await c.req.json());
  const { db, clients, sources, now } = c.get('deps');
  return c.json<WantedRunView>(await lookForWanted({ db, clients, sources, now }, kind));
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
  const { kind } = z.object({ kind: z.enum(['new', 'missing', 'better']) }).parse(await c.req.json());
  const { db, clients, sources, now } = c.get('deps');
  const deps = { db, clients, sources, now };
  return c.json<WantedRunView>(kind === 'new' ? await catchNewEpisodes(deps) : await lookForWantedTv(deps, kind));
});
