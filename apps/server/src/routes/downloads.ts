import { Hono } from 'hono';
import { z } from 'zod';
import type { DownloadActionResult, DownloadDetails, DownloadsView, SendResult } from '@marquee/shared';
import { and, inArray, isNull, or, eq } from 'drizzle-orm';
import { downloads } from '../db/schema.js';
import { requireAdmin, requireUser, type Ctx, type Env } from '../http.js';
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

/** The number on the menu: downloads on their way (sent, downloading, or done and waiting to go in the library). */
downloadRoutes.get('/summary', (c) => {
  requireUser(c);
  const active = c
    .get('deps')
    .db.select({ id: downloads.id })
    .from(downloads)
    .where(or(inArray(downloads.state, ['sent', 'downloading']), and(eq(downloads.state, 'done'), isNull(downloads.importedAt))))
    .all().length;
  return c.json({ active });
});

downloadRoutes.post('/', async (c) => {
  const user = requireAdmin(c);
  const input = z.object({ searchId: z.string().min(1).max(100), copyId: z.string().min(1).max(10), anyway: z.boolean().optional() }).parse(await c.req.json());
  const { db, copies, clients, now } = c.get('deps');
  const result = await sendCopy({ db, copies, now, qbittorrent: clients.qbittorrent, fetchTorrent: clients.fetchTorrent }, input, user.id);
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
  requireAdmin(c);
  const { deleteFiles } = z.object({ deleteFiles: z.boolean() }).parse(await c.req.json());
  return c.json<DownloadActionResult>(await monitorFor(c).remove(id(c), deleteFiles));
});

downloadRoutes.post('/:id{[0-9]+}/import', async (c) => {
  requireAdmin(c);
  return c.json<DownloadActionResult>(await monitorFor(c).putInLibrary(id(c)));
});

downloadRoutes.post('/:id{[0-9]+}/try-another', async (c) => {
  const user = requireAdmin(c);
  return c.json<DownloadActionResult>(await monitorFor(c).tryAnother(id(c), 'You asked for another copy.', user.id));
});
