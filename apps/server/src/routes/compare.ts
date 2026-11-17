import { Hono } from 'hono';
import { z } from 'zod';
import type { CompareView, ComparisonView } from '@marquee/shared';
import { HttpError, requireAdmin, type Ctx, type Env } from '../http.js';
import { ComparisonService } from '../compare/service.js';

/** Comparison mode against Radarr. Admin only; only reads from Radarr. */
export const compareRoutes = new Hono<Env>();

export const comparisons = (c: Ctx) => {
  const d = c.get('deps');
  return new ComparisonService(d.db, d.config, d.clients, d.sources, d.now);
};
const id = (raw: string) => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(404, 'not_found', 'No such comparison.');
  return n;
};

compareRoutes.get('/', (c) => {
  requireAdmin(c);
  return c.json<CompareView>(comparisons(c).overview());
});

/** Turns the background comparison on or off. */
compareRoutes.put('/settings', async (c) => {
  requireAdmin(c);
  const { enabled } = z.object({ enabled: z.boolean() }).parse(await c.req.json());
  comparisons(c).setEnabled(enabled);
  return c.json<CompareView>(comparisons(c).overview());
});

/** Brings in Radarr's new downloads and compares a few now. */
compareRoutes.post('/run', async (c) => {
  requireAdmin(c);
  const svc = comparisons(c);
  const result = await svc.run();
  return c.json({ ...result, view: svc.overview() });
});

compareRoutes.delete('/', (c) => {
  requireAdmin(c);
  comparisons(c).clear();
  return c.json({ ok: true });
});

compareRoutes.get('/:id{[0-9]+}', (c) => {
  requireAdmin(c);
  return c.json<ComparisonView>(comparisons(c).view(id(c.req.param('id'))));
});

/** Judges the exact copies Radarr saw for this movie, so both engines look at the same list. */
compareRoutes.post('/:id{[0-9]+}/explain', async (c) => {
  requireAdmin(c);
  return c.json<ComparisonView>(await comparisons(c).compare(id(c.req.param('id')), 'same_list'));
});

/** Compares this one again with a fresh search of Marquee's Sources. */
compareRoutes.post('/:id{[0-9]+}/again', async (c) => {
  requireAdmin(c);
  return c.json<ComparisonView>(await comparisons(c).compare(id(c.req.param('id')), 'own_search'));
});
