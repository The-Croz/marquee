import { Hono } from 'hono';
import { z } from 'zod';
import type { PersonDetail, DiscoverCard, DiscoverPage, DiscoverPrefs, DiscoverTitle, SeasonPreview, ServiceTop } from '@marquee/shared';
import { discoverPerson, discoverPage, discoverSearch, discoverSeason, discoverTitle, readPrefs, serviceTop, writePrefs, type DiscoverDeps } from '../discover/service.js';
import { SERVICES } from '../library/tmdb.js';
import { requireUser, type Ctx, type Env } from '../http.js';
import { scanSources } from './library.js';
import { readServices } from '../library/services.js';

/** Discover: rows, a title's page, and each person's choices (services to hide, trailers). */
export const discoverRoutes = new Hono<Env>();

export const discoverDeps = (c: Ctx): DiscoverDeps => {
  const { db, config, clients, now } = c.get('deps');
  const s = readServices(db, config);
  return { db, tmdb: scanSources(c).tmdb, now, top: s.streamingTopKey ? clients.streamingTop(s.streamingTopKey) : null, ratings: s.mdblistKey ? clients.mdblist(s.mdblistKey) : null, isAdmin: c.get('user')?.role === 'admin' };
};

const pageQuery = z.object({
  type: z.enum(['all', 'movie', 'series']).default('all'),
  service: z.string().max(30).default('all'),
  genre: z.string().max(40).optional(),
});

discoverRoutes.get('/', async (c) => {
  const user = requireUser(c);
  const q = pageQuery.parse(c.req.query());
  return c.json<DiscoverPage>(await discoverPage(discoverDeps(c), user, { type: q.type, service: q.service, genre: q.genre ?? null }));
});

discoverRoutes.get('/search', async (c) => {
  const user = requireUser(c);
  const q = z.object({ q: z.string().trim().min(1, 'Type something to look for.').max(200), type: z.enum(['all', 'movie', 'series']).default('all') }).parse(c.req.query());
  return c.json<{ results: DiscoverCard[] }>({ results: await discoverSearch(discoverDeps(c), user, q.q, q.type) });
});

discoverRoutes.get('/top', async (c) => {
  const user = requireUser(c);
  const { service } = z.object({ service: z.string().max(30) }).parse(c.req.query());
  return c.json<ServiceTop>(await serviceTop(discoverDeps(c), user, service));
});

discoverRoutes.get('/prefs', (c) => c.json<DiscoverPrefs>({ ...readPrefs(c.get('deps').db, requireUser(c).id), all: SERVICES.map((s) => ({ key: s.key, name: s.name })) }));

discoverRoutes.put('/prefs', async (c) => {
  const user = requireUser(c);
  const body = z.object({ hiddenServices: z.array(z.string().max(30)).max(20), trailers: z.boolean() }).parse(await c.req.json());
  return c.json<DiscoverPrefs>(writePrefs(c.get('deps').db, user.id, body));
});

discoverRoutes.get('/title/:kind{movie|series}/:id{[0-9]+}', async (c) => {
  const user = requireUser(c);
  return c.json<DiscoverTitle>(await discoverTitle(discoverDeps(c), user, c.req.param('kind') as 'movie' | 'series', Number(c.req.param('id'))));
});

discoverRoutes.get('/title/series/:id{[0-9]+}/season/:season{[0-9]+}', async (c) => {
  const user = requireUser(c);
  return c.json<SeasonPreview>(await discoverSeason(discoverDeps(c), user, Number(c.req.param('id')), Number(c.req.param('season'))));
});

discoverRoutes.get('/person/:id{[0-9]+}', async (c) => {
  const user = requireUser(c);
  return c.json<PersonDetail>(await discoverPerson(discoverDeps(c), user, Number(c.req.param('id'))));
});
