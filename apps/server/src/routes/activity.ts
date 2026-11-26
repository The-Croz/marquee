import { refreshPlexAvatars } from '../auth/avatars.js';
import { eq } from 'drizzle-orm';
import { devices, liveStreams } from '../db/schema.js';
import { hashToken } from '../auth/sessions.js';
import { unwatched } from '../activity/unwatched.js';
import { importTautulli, realTautulliFetch, tautulliImports, undoTautulli } from '../activity/tautulli.js';
import type { TautulliImportView, UnwatchedView } from '@marquee/shared';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { ActivityStats, NowPlayingView, PersonSummary, PersonView, PlayView, WatchersView } from '@marquee/shared';
import { HttpError, requireAdmin, requireUser, type Env, sessionToken } from '../http.js';
import { activityStats, myHistory, people, person, recentPlays, syncPlays, watchersOf } from '../activity/service.js';
import { MediaServerError } from '../library/mediaServers.js';

/** `/api/activity`: who is watching and what was watched, from Plex and Jellyfin. Admin only, except `/mine`. */
export const activityRoutes = new Hono<Env>();

/** What is playing right now. Looks at the servers first, so the answer is fresh. */
activityRoutes.get('/now', async (c) => {
  requireAdmin(c);
  const { activity } = c.get('deps');
  await activity.refresh();
  return c.json<{ sessions: NowPlayingView[]; problems: string[]; live: { server: 'plex' | 'jellyfin'; live: boolean }[] }>({ ...activity.view(), live: activity.status() });
});

/** How many streams are playing, for the menu. From what's already known, so it is cheap to ask often. */
activityRoutes.get('/count', (c) => {
  requireAdmin(c);
  return c.json<{ playing: number }>({ playing: c.get('deps').activity.view().sessions.length });
});

/** The app got a "who's watching" card (Marquee started it): remember the card's own address, to keep it up to date. */
activityRoutes.post('/live-activity', async (c) => {
  requireAdmin(c);
  const { db, now } = c.get('deps');
  const body = z.object({ ref: z.string().min(3).max(300), token: z.string().regex(/^[0-9a-fA-F]{20,400}$/, 'That isn’t a Live Activity token.'), environment: z.enum(['production', 'sandbox']).default('production') }).parse(await c.req.json());
  const bearer = sessionToken(c);
  const device = bearer ? db.select().from(devices).where(eq(devices.sessionId, hashToken(bearer))).get() : undefined;
  if (!device) throw new HttpError(400, 'bad_request', 'Only the Marquee app on an iPhone can show a Lock Screen card.');
  // Nothing known yet, so the next look sends an update straight away.
  const fields = { token: body.token.toLowerCase(), environment: body.environment, lastPercent: 0, lastState: '' };
  db.insert(liveStreams).values({ streamRef: body.ref, deviceId: device.id, startedAt: now(), ...fields }).onConflictDoUpdate({ target: [liveStreams.streamRef, liveStreams.deviceId], set: fields }).run();
  return c.json({ ok: true });
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

/** Your own history: what you watched on Plex and Jellyfin. Everyone, only their own. */
activityRoutes.get('/mine', (c) => {
  const user = requireUser(c);
  const q = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(50) }).parse(c.req.query());
  return c.json<PersonView & { total: number }>(myHistory(c.get('deps').db, user, q.limit));
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
  // Pictures come along. A Plex problem is already reported by the watches below.
  await refreshPlexAvatars({ db, clients }).catch(() => {});
  return c.json(await syncPlays({ db, clients, now }));
});

activityRoutes.get('/watchers', (c) => {
  requireAdmin(c);
  const q = z.object({ kind: z.enum(['movie', 'tv']), id: z.coerce.number().int() }).parse(c.req.query());
  const v = watchersOf(c.get('deps').db, q.kind, q.id);
  if (!v) throw new HttpError(404, 'not_found', 'No such title.');
  return c.json<WatchersView>(v);
});

// ---------------- never watched, and Tautulli's history

/** W16: library titles nobody has watched, or not in a year. Read-only. */
activityRoutes.get('/unwatched', (c) => {
  requireAdmin(c);
  const q = z.object({ kind: z.enum(['movie', 'series']).default('movie'), since: z.enum(['never', 'year']).default('never') }).parse(c.req.query());
  const { db, now } = c.get('deps');
  return c.json<UnwatchedView>(unwatched(db, q.kind, q.since, now()));
});

activityRoutes.get('/tautulli', (c) => {
  requireAdmin(c);
  return c.json<TautulliImportView>({ imports: tautulliImports(c.get('deps').db) });
});

/** W5: brings Tautulli's history in once. The key is used for this import only and never saved. */
activityRoutes.post('/tautulli/import', async (c) => {
  requireAdmin(c);
  const input = z.object({ url: z.string().trim().min(1, 'Type Tautulli’s address.').max(300), apiKey: z.string().trim().min(1, 'Paste Tautulli’s API key.').max(200) }).parse(await c.req.json());
  const { db, clients, now } = c.get('deps');
  await importTautulli(db, clients.tautulliFetch ?? realTautulliFetch, input, now());
  return c.json<TautulliImportView>({ imports: tautulliImports(db) }, 201);
});

activityRoutes.post('/tautulli/undo', async (c) => {
  requireAdmin(c);
  const { at } = z.object({ at: z.number().int() }).parse(await c.req.json());
  const { db, now } = c.get('deps');
  const removed = undoTautulli(db, at, now());
  return c.json<TautulliImportView & { removed: number }>({ imports: tautulliImports(db), removed });
});
