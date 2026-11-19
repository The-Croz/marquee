import { Hono } from 'hono';
import { z } from 'zod';
import type { ActivityStats, NowPlayingView, PlayView, WatchersView } from '@marquee/shared';
import { HttpError, requireAdmin, type Env } from '../http.js';
import { activityStats, nowPlaying, recentPlays, syncPlays, watchersOf } from '../activity/service.js';

/** `/api/activity`: who is watching and what was watched, from Plex and Jellyfin. Admin only. */
export const activityRoutes = new Hono<Env>();

activityRoutes.get('/now', async (c) => {
  requireAdmin(c);
  const { db, clients, now } = c.get('deps');
  return c.json<{ sessions: NowPlayingView[]; problems: string[] }>(await nowPlaying({ db, clients, now }));
});

activityRoutes.get('/history', (c) => {
  requireAdmin(c);
  const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), offset: z.coerce.number().int().min(0).default(0) }).parse(c.req.query());
  return c.json<{ plays: PlayView[]; total: number }>(recentPlays(c.get('deps').db, q.limit, q.offset));
});

activityRoutes.get('/stats', (c) => {
  requireAdmin(c);
  const { db, now } = c.get('deps');
  return c.json<ActivityStats>(activityStats(db, now()));
});

/** "Update now": copy new watches from the servers straight away. */
activityRoutes.post('/sync', async (c) => {
  requireAdmin(c);
  const { db, clients, now } = c.get('deps');
  return c.json(await syncPlays({ db, clients, now }));
});

activityRoutes.get('/watchers', (c) => {
  requireAdmin(c);
  const q = z.object({ kind: z.enum(['movie', 'tv']), id: z.coerce.number().int() }).parse(c.req.query());
  const v = watchersOf(c.get('deps').db, q.kind, q.id);
  if (!v) throw new HttpError(404, 'not_found', 'No such title.');
  return c.json<WatchersView>(v);
});
