import { Hono } from 'hono';
import { z } from 'zod';
import type { DownloadView, SendResult } from '@marquee/shared';
import { requireAdmin, type Env } from '../http.js';
import { listDownloads, sendCopy } from '../downloads/send.js';

/** Downloads: send a copy to qBittorrent, and list what Marquee sent. Admin only for now. */
export const downloadRoutes = new Hono<Env>();

downloadRoutes.get('/', (c) => {
  requireAdmin(c);
  return c.json<DownloadView[]>(listDownloads(c.get('deps').db));
});

downloadRoutes.post('/', async (c) => {
  const user = requireAdmin(c);
  const input = z.object({ searchId: z.string().min(1).max(100), copyId: z.string().min(1).max(10), anyway: z.boolean().optional() }).parse(await c.req.json());
  const { db, copies, clients, now } = c.get('deps');
  const result = await sendCopy({ db, copies, now, qbittorrent: clients.qbittorrent, fetchTorrent: clients.fetchTorrent }, input, user.id);
  return c.json<SendResult>(result, 201);
});
