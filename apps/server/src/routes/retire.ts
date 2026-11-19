import { Hono } from 'hono';
import type { RetireView } from '@marquee/shared';
import { requireAdmin, type Env } from '../http.js';
import { retireSeerrChecklist } from '../retire/seerr.js';
import { retireTautulliChecklist } from '../retire/tautulli.js';

/** `/api/retire-seerr`: the checklist for turning Seerr off. Admin only, read-only. */
export const retireRoutes = new Hono<Env>();

retireRoutes.get('/', (c) => {
  requireAdmin(c);
  const { db, config } = c.get('deps');
  return c.json<RetireView>(retireSeerrChecklist({ db, config }));
});

/** `/api/retire-tautulli`: the same for Tautulli. */
export const retireTautulliRoutes = new Hono<Env>();

retireTautulliRoutes.get('/', (c) => {
  requireAdmin(c);
  const { db, activity } = c.get('deps');
  return c.json<RetireView>(retireTautulliChecklist({ db, activity }));
});
