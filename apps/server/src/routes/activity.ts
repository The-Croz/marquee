import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { ActivityStats, NowPlayingView, PersonSummary, PersonView, PlayView, WatchersView } from '@marquee/shared';
import { HttpError, requireAdmin, type Env } from '../http.js';
import { activityStats, people, person, recentPlays, syncPlays, watchersOf } from '../activity/service.js';
import { MediaServerError } from '../library/mediaServers.js';

/** `/api/activity`: who is watching and what was watched, from Plex and Jellyfin. Admin only. */
export const activityRoutes = new Hono<Env>();

/** What is playing right now. Looks at the servers first, so the answer is fresh. */
activityRoutes.get('/now', async (c) => {
  requireAdmin(c);
  const { activity } = c.get('deps');
  await activity.refresh();
  return c.json<{ sessions: NowPlayingView[]; problems: string[]; live: { server: 'plex' | 'jellyfin'; live: boolean }[] }>({ ...activity.view(), live: activity.status() });
});

/** The same list, pushed the moment it changes (server-sent events). A heartbeat keeps proxies from closing it. */
activityRoutes.get('/live', (c) => {
  requireAdmin(c);
  const { activity } = c.get('deps');
  c.header('X-Accel-Buffering', 'no');
  return streamSSE(c, async (stream) => {
    let open = true;
    const send = (v: object) => stream.writeSSE({ event: 'sessions', data: JSON.stringify({ ...v, live: activity.status() }) }).catch(() => {});
    let sent = false;
    const off = activity.subscribe((v) => {
      sent = true;
      void send(v);
    });
    stream.onAbort(() => {
      open = false;
      off();
    });
    await activity.refresh();
    // A fresh look that changed nothing sends nothing, but a new page still needs the list.
    if (!sent) await send(activity.view());
    while (open) {
      await stream.sleep(20_000);
      if (open) await stream.writeSSE({ event: 'ping', data: '' }).catch(() => {});
    }
  });
});

/** Stops one stream and shows the viewer the message. The server must allow it (Plex needs a Plex Pass for this). */
activityRoutes.post('/stop', async (c) => {
  requireAdmin(c);
  const input = z.object({ server: z.enum(['plex', 'jellyfin']), sessionId: z.string().min(1).max(200), message: z.string().trim().max(200).default('') }).parse(await c.req.json());
  try {
    await c.get('deps').activity.stopStream(input.server, input.sessionId, input.message || 'An admin stopped this stream.');
  } catch (err) {
    if (err instanceof MediaServerError) {
      const plexPass = input.server === 'plex' ? ' Plex only lets a server stop streams with a Plex Pass.' : '';
      throw new HttpError(502, 'stop_failed', `${err.message}${plexPass}`);
    }
    throw err;
  }
  return c.json({ ok: true });
});

activityRoutes.get('/people', (c) => {
  requireAdmin(c);
  return c.json<{ people: PersonSummary[] }>({ people: people(c.get('deps').db) });
});

activityRoutes.get('/people/:name', (c) => {
  requireAdmin(c);
  const v = person(c.get('deps').db, decodeURIComponent(c.req.param('name')));
  if (!v) throw new HttpError(404, 'not_found', 'Nobody by that name has watched anything yet.');
  return c.json<PersonView>(v);
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
