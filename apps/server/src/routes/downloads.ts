import { Hono } from 'hono';
import { z } from 'zod';
import type { DownloadActionResult, DownloadDetails, DownloadsView, SendResult } from '@marquee/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { devices, downloads, liveActivities } from '../db/schema.js';
import { hashToken } from '../auth/sessions.js';
import { HttpError, requireAdmin, requireUser, sessionToken, type Ctx, type Env } from '../http.js';
import { sendCopy } from '../downloads/send.js';
import { sharedMonitor, type DownloadMonitor } from '../downloads/monitor.js';

/** Downloads: send a copy to qBittorrent, follow it, pause, remove or try another copy. Admin only for now. */
export const downloadRoutes = new Hono<Env>();

function monitorFor(c: Ctx): DownloadMonitor {
  const { db, clients, sources, now } = c.get('deps');
  return sharedMonitor({ db, clients, sources, now });
}

const id = (c: Ctx) => Number(c.req.param('id'));

downloadRoutes.get('/', async (c) => {
  requireAdmin(c);
  const q = z.object({ movieId: z.coerce.number().int().optional(), seriesId: z.coerce.number().int().optional() }).parse(c.req.query());
  return c.json<DownloadsView>(await monitorFor(c).view(10_000, q));
});

/** The number on the menu: downloads on their way, counted the same way as the Downloads page's "On the way" (sent or downloading).
 *  Finished ones aren't counted: one another app sent never goes in the library through Marquee, so it would sit in the count forever. */
downloadRoutes.get('/summary', (c) => {
  requireUser(c);
  const active = c
    .get('deps')
    .db.select({ id: downloads.id })
    .from(downloads)
    .where(inArray(downloads.state, ['sent', 'downloading']))
    .all().length;
  return c.json({ active });
});

downloadRoutes.post('/', async (c) => {
  const user = requireAdmin(c);
  const input = z.object({ searchId: z.string().min(1).max(100), copyId: z.string().min(1).max(10), anyway: z.boolean().optional() }).parse(await c.req.json());
  const { db, copies, clients, now } = c.get('deps');
  const result = await sendCopy({ db, copies, now, qbittorrent: clients.qbittorrent, fetchTorrent: clients.fetchTorrent, disk: clients.disk }, input, user.id);
  return c.json<SendResult>(result, 201);
});

downloadRoutes.get('/:id{[0-9]+}', async (c) => {
  requireAdmin(c);
  return c.json<DownloadDetails>(await monitorFor(c).details(id(c)));
});

downloadRoutes.post('/:id{[0-9]+}/pause', async (c) => {
  requireAdmin(c);
  return c.json<DownloadActionResult>(await monitorFor(c).pause(id(c)));
});

downloadRoutes.post('/:id{[0-9]+}/resume', async (c) => {
  requireAdmin(c);
  return c.json<DownloadActionResult>(await monitorFor(c).resume(id(c)));
});

downloadRoutes.post('/:id{[0-9]+}/remove', async (c) => {
  const user = requireAdmin(c);
  const { deleteFiles } = z.object({ deleteFiles: z.boolean() }).parse(await c.req.json());
  return c.json<DownloadActionResult>(await monitorFor(c).remove(id(c), deleteFiles, user.id));
});

/** Try again: puts a finished download in the library (unpacking it first when it came as .rar files). */
downloadRoutes.post('/:id{[0-9]+}/import', async (c) => {
  requireAdmin(c);
  return c.json<DownloadActionResult>(await monitorFor(c).putInLibrary(id(c), true));
});

downloadRoutes.post('/:id{[0-9]+}/try-another', async (c) => {
  const user = requireAdmin(c);
  return c.json<DownloadActionResult>(await monitorFor(c).tryAnother(id(c), 'You asked for another copy.', user.id));
});

/** The app started a Lock Screen card for this download: remember its push token so Marquee can keep it up to date. */
downloadRoutes.post('/:id{[0-9]+}/live-activity', async (c) => {
  requireAdmin(c);
  const { db, now } = c.get('deps');
  const body = z.object({ token: z.string().regex(/^[0-9a-fA-F]{20,400}$/, 'That isn’t a Live Activity token.'), environment: z.enum(['production', 'sandbox']).default('production') }).parse(await c.req.json());
  const bearer = sessionToken(c);
  const device = bearer ? db.select().from(devices).where(eq(devices.sessionId, hashToken(bearer))).get() : undefined;
  if (!device) throw new HttpError(400, 'bad_request', 'Open the Marquee app on your iPhone to follow a download on the Lock Screen.');
  const row = db.select().from(downloads).where(eq(downloads.id, id(c))).get();
  if (!row) throw new HttpError(404, 'not_found', 'That download isn’t there any more.');
  const existing = db.select().from(liveActivities).where(and(eq(liveActivities.downloadId, row.id), eq(liveActivities.deviceId, device.id))).get();
  const fields = { token: body.token.toLowerCase(), environment: body.environment, lastPercent: Math.floor(row.progress * 100), lastState: `${row.state}|${row.importedAt ? 'in' : ''}` };
  if (existing) db.update(liveActivities).set({ ...fields, startedAt: now() }).where(eq(liveActivities.id, existing.id)).run();
  else db.insert(liveActivities).values({ downloadId: row.id, deviceId: device.id, startedAt: now(), ...fields }).run();
  return c.json({ ok: true });
});

downloadRoutes.delete('/:id{[0-9]+}/live-activity', (c) => {
  requireAdmin(c);
  const { db } = c.get('deps');
  const bearer = sessionToken(c);
  const device = bearer ? db.select().from(devices).where(eq(devices.sessionId, hashToken(bearer))).get() : undefined;
  if (device) db.delete(liveActivities).where(and(eq(liveActivities.downloadId, id(c)), eq(liveActivities.deviceId, device.id))).run();
  return c.json({ ok: true });
});
