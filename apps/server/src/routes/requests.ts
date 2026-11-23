import { Hono } from 'hono';
import { z } from 'zod';
import type { RequestView } from '@marquee/shared';
import { notifyDeps } from './notifications.js';
import { requireAdmin, requireUser, type Ctx, type Env } from '../http.js';
import { approveRequest, createRequest, declineRequest, listRequests, pendingCount, removeRequest, reopenRequest, type RequestDeps } from '../requests/service.js';
import { scanSources } from './library.js';

/** Requests: ask, approve, turn down. Everyone can ask; admins decide. */
export const requestRoutes = new Hono<Env>();

const deps = (c: Ctx): RequestDeps => {
  const d = c.get('deps');
  return { db: d.db, scanner: d.scanner, tmdb: scanSources(c).tmdb, clients: d.clients, sources: d.sources, notify: notifyDeps(c), now: d.now };
};

requestRoutes.get('/', (c) => {
  const user = requireUser(c);
  const scope = z.enum(['mine', 'all']).default('mine').parse(c.req.query('scope'));
  const { db, now } = c.get('deps');
  return c.json<{ items: RequestView[] }>({ items: listRequests(db, user, scope, now()) });
});

/** The number on the menu badge: how many wait for an admin (everyone else sees 0). */
requestRoutes.get('/summary', (c) => {
  const user = requireUser(c);
  return c.json({ pending: user.role === 'admin' ? pendingCount(c.get('deps').db) : 0 });
});

requestRoutes.post('/', async (c) => {
  const user = requireUser(c);
  const body = z
    .object({ kind: z.enum(['movie', 'series']), tmdbId: z.number().int().positive(), seasons: z.array(z.number().int().positive()).max(100).optional(), preset: z.enum(['all', 'future', 'latest', 'first', 'none']).optional() })
    .parse(await c.req.json());
  return c.json<RequestView>(await createRequest(deps(c), user, body), 201);
});

requestRoutes.post('/:id{[0-9]+}/approve', async (c) => {
  const admin = requireAdmin(c);
  const body = z
    .object({ profile: z.string().min(1).max(60).optional(), seasons: z.array(z.number().int().positive()).max(100).nullable().optional(), preset: z.enum(['all', 'future', 'latest', 'first']).optional() })
    .parse(await c.req.json());
  return c.json<RequestView>(await approveRequest(deps(c), Number(c.req.param('id')), admin, body));
});

requestRoutes.post('/:id{[0-9]+}/decline', async (c) => {
  const admin = requireAdmin(c);
  const { reason } = z.object({ reason: z.string().max(300).default('') }).parse(await c.req.json());
  return c.json<RequestView>(declineRequest(deps(c), Number(c.req.param('id')), admin, reason));
});

requestRoutes.post('/:id{[0-9]+}/reopen', (c) => {
  requireAdmin(c);
  return c.json<RequestView>(reopenRequest(deps(c), Number(c.req.param('id'))));
});

requestRoutes.delete('/:id{[0-9]+}', (c) => {
  const user = requireUser(c);
  removeRequest(c.get('deps').db, Number(c.req.param('id')), user);
  return c.json({ ok: true });
});
