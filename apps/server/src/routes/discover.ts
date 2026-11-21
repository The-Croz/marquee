import { Hono } from 'hono';
import { z } from 'zod';
import type { DiscoverCard, DiscoverPage, DiscoverPrefs, DiscoverTitle, ServiceTop } from '@marquee/shared';
import { discoverPage, discoverSearch, discoverTitle, readPrefs, serviceTop, writePrefs, type DiscoverDeps } from '../discover/service.js';
import { SERVICES } from '../library/tmdb.js';
import { requireUser, type Ctx, type Env } from '../http.js';
import { scanSources } from './library.js';
import { readServices } from '../library/services.js';

/** Discover: rows, a title's page, and each person's choices (services to hide, trailers). */
export const discoverRoutes = new Hono<Env>();

const deps = (c: Ctx): DiscoverDeps => {
  const { db, config, clients, now } = c.get('deps');
  const key = readServices(db, config).streamingTopKey;
  return { db, tmdb: scanSources(c).tmdb, now, top: key ? clients.streamingTop(key) : null, isAdmin: c.get('user')?.role === 'admin' };
};

const pageQuery = z.object({
  type: z.enum(['all', 'movie', 'series']).default('all'),
  service: z.string().max(30).default('all'),
  genre: z.string().max(40).optional(),
});

discoverRoutes.get('/', async (c) => {
  const user = requireUser(c);
  const q = pageQuery.parse(c.req.query());
  return c.json<DiscoverPage>(await discoverPage(deps(c), user, { type: q.type, service: q.service, genre: q.genre ?? null }));
});

discoverRoutes.get('/search', async (c) => {
  const user = requireUser(c);
  const q = z.object({ q: z.string().trim().min(1, 'Type something to look for.').max(200), type: z.enum(['all', 'movie', 'series']).default('all') }).parse(c.req.query());
  return c.json<{ results: DiscoverCard[] }>({ results: await discoverSearch(deps(c), user, q.q, q.type) });
});

discoverRoutes.get('/top', async (c) => {
  const user = requireUser(c);
  const { service } = z.object({ service: z.string().max(30) }).parse(c.req.query());
  return c.json<ServiceTop>(await serviceTop(deps(c), user, service));
});

discoverRoutes.get('/prefs', (c) => c.json<DiscoverPrefs>({ ...readPrefs(c.get('deps').db, requireUser(c).id), all: SERVICES.map((s) => ({ key: s.key, name: s.name })) }));

discoverRoutes.put('/prefs', async (c) => {
  const user = requireUser(c);
  const body = z.object({ hiddenServices: z.array(z.string().max(30)).max(20), trailers: z.boolean() }).parse(await c.req.json());
  return c.json<DiscoverPrefs>(writePrefs(c.get('deps').db, user.id, body));
});

discoverRoutes.get('/title/:kind{movie|series}/:id{[0-9]+}', async (c) => {
  const user = requireUser(c);
  return c.json<DiscoverTitle>(await discoverTitle(deps(c), user, c.req.param('kind') as 'movie' | 'series', Number(c.req.param('id'))));
});
