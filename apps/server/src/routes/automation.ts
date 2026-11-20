import { Hono } from 'hono';
import { z } from 'zod';
import type { AutomationView, WantedRunView } from '@marquee/shared';
import { requireAdmin, type Ctx, type Env } from '../http.js';
import { automationView } from '../downloads/automation.js';
import { lookForWanted, setLookingForWanted } from '../downloads/wanted.js';
import { setDailyLimit } from '../downloads/wantedLimits.js';
import { catchNewEpisodes, lookForWantedTv, setLookingForWantedTv } from '../downloads/wantedTv.js';

/** `/api/automation`: Marquee looking for Wanted movies and episodes by itself. Admin only. */
export const automationRoutes = new Hono<Env>();

const view = (c: Ctx) => automationView(c.get('deps').db, c.get('deps').now());

automationRoutes.get('/', (c) => {
  requireAdmin(c);
  return c.json<AutomationView>(view(c));
});

/** Turns either kind on or off, and sets the daily limit (0 = no limit). Leave a field out to keep it. */
automationRoutes.put('/', async (c) => {
  requireAdmin(c);
  const body = z
    .object({ movies: z.boolean().optional(), tv: z.boolean().optional(), dailyLimit: z.number().int().min(0).max(1000).optional() })
    .parse(await c.req.json());
  const { db } = c.get('deps');
  if (body.movies !== undefined) setLookingForWanted(db, body.movies);
  if (body.tv !== undefined) setLookingForWantedTv(db, body.tv);
  if (body.dailyLimit !== undefined) setDailyLimit(db, body.dailyLimit);
  return c.json<AutomationView>(view(c));
});

/** "Look now" for movies: missing ones, or better copies of ones you have. `preview` sends nothing. */
automationRoutes.post('/movies/look-now', async (c) => {
  requireAdmin(c);
  const { kind, preview } = z.object({ kind: z.enum(['missing', 'better']), preview: z.boolean().optional() }).parse(await c.req.json());
  const { db, clients, sources, now } = c.get('deps');
  return c.json<WantedRunView>(await lookForWanted({ db, clients, sources, now, preview }, kind));
});

/** "Look now" for TV: new episodes from the Sources' newest copies, missing episodes, or better copies. */
automationRoutes.post('/tv/look-now', async (c) => {
  requireAdmin(c);
  const { kind, preview } = z.object({ kind: z.enum(['new', 'missing', 'better']), preview: z.boolean().optional() }).parse(await c.req.json());
  const { db, clients, sources, now } = c.get('deps');
  const deps = { db, clients, sources, now, preview };
  return c.json<WantedRunView>(kind === 'new' ? await catchNewEpisodes(deps) : await lookForWantedTv(deps, kind));
});
