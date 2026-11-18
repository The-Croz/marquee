import { Hono } from 'hono';
import { z } from 'zod';
import type { DownloadActionResult, DownloadsView, SendResult } from '@marquee/shared';
import { requireAdmin, type Ctx, type Env } from '../http.js';
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

downloadRoutes.post('/', async (c) => {
  const user = requireAdmin(c);
  const input = z.object({ searchId: z.string().min(1).max(100), copyId: z.string().min(1).max(10), anyway: z.boolean().optional() }).parse(await c.req.json());
  const { db, copies, clients, now } = c.get('deps');
  const result = await sendCopy({ db, copies, now, qbittorrent: clients.qbittorrent, fetchTorrent: clients.fetchTorrent }, input, user.id);
  return c.json<SendResult>(result, 201);
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
