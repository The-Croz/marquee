import { Hono } from 'hono';
import { z } from 'zod';
import type { ProwlarrSyncResult, SourceCheckResult, SourceView, SourcesView } from '@marquee/shared';
import { HttpError, requireAdmin, type Env } from '../http.js';

/** Settings → Sources: where Marquee searches for copies. Admin only. */
export const sourcesRoutes = new Hono<Env>();

const url = z
  .string()
  .trim()
  .refine((v) => /^https?:\/\/[^\s]+$/i.test(v), 'Addresses start with http:// or https://, e.g. http://192.168.1.100:9696')
  .transform((v) => v.replace(/\/+$/, ''));
const key = z.string().trim().max(500);
const id = (raw: string) => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(404, 'not_found', 'No such Source.');
  return n;
};

sourcesRoutes.get('/', (c) => {
  requireAdmin(c);
  return c.json<SourcesView>(c.get('deps').sources.view());
});

/** Adds a Torznab feed by hand and checks it straight away. */
sourcesRoutes.post('/', async (c) => {
  requireAdmin(c);
  const input = z.object({ name: z.string().trim().min(1, 'Give it a name.').max(100), url, apiKey: key.default('') }).parse(await c.req.json());
  const { sources } = c.get('deps');
  const s = sources.add(input);
  const check = await sources.check(s.id);
  return c.json<{ source: SourceView; check: SourceCheckResult }>({ source: sources.view().sources.find((v) => v.id === s.id)!, check }, 201);
});

// ---------------- Prowlarr ----------------

/** Tries the typed address and key, or the saved ones. */
sourcesRoutes.post('/prowlarr/test', async (c) => {
  requireAdmin(c);
  const { sources } = c.get('deps');
  const input = z.object({ url: url.optional(), apiKey: key.optional() }).parse(await c.req.json());
  const saved = sources.prowlarrSettings();
  const u = input.url || saved.url;
  const k = input.apiKey || saved.apiKey;
  if (!u || !k) return c.json({ ok: false, message: 'Enter the address and API key first.' });
  return c.json(await sources.testProwlarr(u, k));
});

/** Links Prowlarr (or changes its address/key) and syncs its sites. */
sourcesRoutes.put('/prowlarr', async (c) => {
  requireAdmin(c);
  const { sources } = c.get('deps');
  const input = z.object({ url, apiKey: key.optional() }).parse(await c.req.json());
  const apiKey = input.apiKey || sources.prowlarrSettings().apiKey;
  if (!apiKey) throw new HttpError(400, 'invalid_input', 'Paste the API key from Prowlarr → Settings → General.');
  const test = await sources.testProwlarr(input.url, apiKey);
  if (!test.ok) throw new HttpError(400, 'prowlarr_failed', test.message);
  sources.link(input.url, apiKey);
  const result = await sources.syncProwlarr();
  // Check new Sources in the background so the page fills in health without waiting on slow sites.
  void Promise.all(sources.view().sources.filter((s) => s.fromProwlarr && s.state === 'unchecked').map((s) => sources.check(s.id)));
  return c.json<ProwlarrSyncResult>(result);
});

sourcesRoutes.post('/prowlarr/sync', async (c) => {
  requireAdmin(c);
  return c.json<ProwlarrSyncResult>(await c.get('deps').sources.syncProwlarr());
});

sourcesRoutes.post('/prowlarr/unlink', async (c) => {
  requireAdmin(c);
  const { removeSources } = z.object({ removeSources: z.boolean() }).parse(await c.req.json());
  c.get('deps').sources.unlink(removeSources);
  return c.json({ ok: true });
});

// ---------------- one Source ----------------
// (after the Prowlarr routes, so /prowlarr isn't read as an id)

sourcesRoutes.put('/:id', async (c) => {
  requireAdmin(c);
  const { sources } = c.get('deps');
  const s = sources.get(id(c.req.param('id')));
  if (!s) throw new HttpError(404, 'not_found', 'No such Source.');
  const patch = z
    .object({
      name: z.string().trim().min(1, 'Give it a name.').max(100).optional(),
      url: url.optional(),
      apiKey: key.optional(),
      enabled: z.boolean().optional(),
      priority: z.number().int().min(1, 'Priority is 1 to 50.').max(50, 'Priority is 1 to 50.').optional(),
      forMovies: z.boolean().optional(),
      forTv: z.boolean().optional(),
      minSeeders: z.number().int().min(0).max(1000).optional(),
      dailyLimit: z.number().int().min(0).max(100_000).optional(),
      minGapMs: z.number().int().min(0).max(600_000).optional(),
      timeoutSeconds: z.number().int().min(1, 'Give up after is 1 to 300 seconds.').max(300, 'Give up after is 1 to 300 seconds.').optional(),
    })
    .parse(await c.req.json());
  if (s.prowlarrId !== null && (patch.url !== undefined || patch.apiKey !== undefined)) {
    throw new HttpError(409, 'from_prowlarr', 'This Source comes from Prowlarr, so its address and key follow Prowlarr. Change them there, or unlink Prowlarr.');
  }
  if (patch.apiKey === '') delete patch.apiKey; // blank means "keep the saved key"
  sources.update(s.id, patch);
  return c.json({ ok: true });
});

sourcesRoutes.delete('/:id', (c) => {
  requireAdmin(c);
  const { sources } = c.get('deps');
  const s = sources.get(id(c.req.param('id')));
  if (!s) throw new HttpError(404, 'not_found', 'No such Source.');
  if (s.prowlarrId !== null) {
    throw new HttpError(409, 'from_prowlarr', 'This Source comes from Prowlarr and would come back on the next sync. Pause it here, or remove the site in Prowlarr.');
  }
  sources.remove(s.id);
  return c.json({ ok: true });
});

/** "Test" and "Try now": checks the feed and clears any wait. */
sourcesRoutes.post('/:id/check', async (c) => {
  requireAdmin(c);
  const { sources } = c.get('deps');
  const n = id(c.req.param('id'));
  if (!sources.get(n)) throw new HttpError(404, 'not_found', 'No such Source.');
  return c.json<SourceCheckResult>(await sources.check(n));
});
