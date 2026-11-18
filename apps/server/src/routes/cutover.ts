import { Hono } from 'hono';
import { z } from 'zod';
import type { CutoverView, WantedRunView } from '@marquee/shared';
import { requireAdmin, type Env } from '../http.js';
import { cutoverChecklist } from '../compare/cutover.js';
import { lookForWanted, setLookingForWanted } from '../downloads/wanted.js';

/** Switching movies over from Radarr: the checklist, and "Marquee looks for wanted movies". Admin only. */
export const cutoverRoutes = new Hono<Env>();

cutoverRoutes.get('/', async (c) => {
  requireAdmin(c);
  const { db, config, clients, now } = c.get('deps');
  return c.json<CutoverView>(await cutoverChecklist({ db, config, clients, now }));
});

cutoverRoutes.put('/', async (c) => {
  requireAdmin(c);
  const { lookForWanted: on } = z.object({ lookForWanted: z.boolean() }).parse(await c.req.json());
  const { db, config, clients, now } = c.get('deps');
  setLookingForWanted(db, on);
  return c.json<CutoverView>(await cutoverChecklist({ db, config, clients, now }));
});

/** "Look now": runs a search for missing movies (or better copies) at once. */
cutoverRoutes.post('/look-now', async (c) => {
  requireAdmin(c);
  const { kind } = z.object({ kind: z.enum(['missing', 'better']) }).parse(await c.req.json());
  const { db, clients, sources, now } = c.get('deps');
  return c.json<WantedRunView>(await lookForWanted({ db, clients, sources, now }, kind));
});
