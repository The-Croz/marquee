import { Hono } from 'hono';
import type { RetireView } from '@marquee/shared';
import { requireAdmin, type Env } from '../http.js';
import { retireSeerrChecklist } from '../retire/seerr.js';

/** `/api/retire-seerr`: the checklist for turning Seerr off. Admin only, read-only. */
export const retireRoutes = new Hono<Env>();

retireRoutes.get('/', (c) => {
  requireAdmin(c);
  const { db, config } = c.get('deps');
  return c.json<RetireView>(retireSeerrChecklist({ db, config }));
});
