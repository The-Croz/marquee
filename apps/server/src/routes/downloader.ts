import { Hono } from 'hono';
import { z } from 'zod';
import type { DownloaderHealth } from '@marquee/shared';
import { requireAdmin, type Env } from '../http.js';
import { DOWNLOADER_TEXT, checkDownloader, downloaderView, readDownloader, writeDownloader } from '../downloads/service.js';

/** Settings → Downloader: qBittorrent's address, sign-in, category and health. Admin only. */
export const downloaderRoutes = new Hono<Env>();

const url = z
  .string()
  .trim()
  .refine((v) => v === '' || /^https?:\/\/[^\s]+$/i.test(v), "Addresses start with http:// or https://, e.g. http://192.168.1.100:8080")
  .transform((v) => v.replace(/\/+$/, ''));
const category = z
  .string()
  .trim()
  .max(100)
  .refine((v) => !/[\\]|^\/|\/$|\/\//.test(v), 'A category is a plain name like marquee, without slashes at either end.');

downloaderRoutes.get('/', (c) => {
  requireAdmin(c);
  return c.json(downloaderView(c.get('deps').db));
});

downloaderRoutes.put('/', async (c) => {
  requireAdmin(c);
  const input = z
    .object({
      url: url.nullable().optional(),
      username: z.string().max(200).optional(),
      password: z.string().max(500).nullable().optional(),
      category: category.optional(),
      stuckHours: z.number().int().min(1, 'Stuck after is at least 1 hour.').max(168, 'Stuck after is at most a week (168 hours).').optional(),
      giveUpHours: z.number().int().min(1).max(720, 'Try another copy after is at most 30 days (720 hours).').optional(),
      tryAnother: z.boolean().optional(),
    })
    .refine((v) => v.stuckHours === undefined || v.giveUpHours === undefined || v.giveUpHours >= v.stuckHours, 'Try another copy after has to be at least as long as Stuck after.')
    .parse(await c.req.json());
  writeDownloader(c.get('deps').db, input);
  return c.json(downloaderView(c.get('deps').db));
});

/** Checks the saved connection. */
downloaderRoutes.get('/health', async (c) => {
  requireAdmin(c);
  const { db, clients, now } = c.get('deps');
  const s = readDownloader(db);
  const client = s.url ? clients.qbittorrent(s.url, s.username, s.password ?? '') : null;
  return c.json(await checkDownloader(client, s.category, now()));
});

/** Tries the typed values, falling back to the saved ones for anything left blank. */
downloaderRoutes.post('/test', async (c) => {
  requireAdmin(c);
  const { db, clients, now } = c.get('deps');
  const input = z
    .object({ url: url.optional(), username: z.string().max(200).optional(), password: z.string().max(500).optional(), category: category.optional() })
    .parse(await c.req.json());
  const saved = readDownloader(db);
  const target = input.url || saved.url;
  const cat = input.category || saved.category;
  if (!target) return c.json(await checkDownloader(null, cat, now()));
  let password = input.password;
  if (!password) {
    // A saved password only ever goes to the address it was saved with.
    if (saved.password && target !== saved.url) {
      const t = DOWNLOADER_TEXT.needs_password;
      return c.json<DownloaderHealth>({ state: 'needs_password', ok: false, label: t.label, fix: t.fix, detail: null, checkedAt: now() });
    }
    password = saved.password ?? '';
  }
  const username = input.username ?? saved.username;
  return c.json(await checkDownloader(clients.qbittorrent(target, username, password), cat, now()));
});
