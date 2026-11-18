import { Hono } from 'hono';
import { z } from 'zod';
import type { BringOverResult, ProwlarrSyncResult, SiteForm, SitesView, SolverView, SourceCheckResult, SourceView, SourcesView } from '@marquee/shared';
import { HttpError, requireAdmin, type Ctx, type Env } from '../http.js';
import { listSites, refreshCatalogue, siteForm } from '../sources/sites/catalogue.js';
import { readSolver, saveSolver, solverView } from '../sources/sites/solver.js';

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

/** Brought-over sites can need a password or cookie; check them in the background so the page fills in. */
const checkInBackground = (c: Ctx, ids: number[]) => void Promise.all(ids.map((n) => c.get('deps').sources.check(n)));

/** "Bring over from Prowlarr": Prowlarr's sites become sites Marquee searches itself. */
sourcesRoutes.post('/prowlarr/bring-over', async (c) => {
  requireAdmin(c);
  const { sources } = c.get('deps');
  let result: BringOverResult;
  try {
    result = await sources.bringOver();
  } catch (err) {
    throw new HttpError(502, 'prowlarr_failed', (err as Error).message);
  }
  checkInBackground(c, sources.view().sources.filter((s) => s.kind === 'site' && s.state === 'unchecked').map((s) => s.id));
  return c.json(result);
});

// ---------------- sites Marquee searches itself ----------------

const settingsValues = z.record(z.string(), z.union([z.string().max(10_000), z.boolean(), z.array(z.string().max(200)).max(200), z.null()]));

/** The sites Marquee can run, built-in ones first. */
sourcesRoutes.get('/sites', (c) => {
  requireAdmin(c);
  const { db, config } = c.get('deps');
  return c.json<SitesView>(listSites(db, config.dataDir, c.req.query('q')));
});

/** Downloads the catalogue again and reads the sites folder. */
sourcesRoutes.post('/sites/refresh', async (c) => {
  requireAdmin(c);
  const { db, config, clients, now } = c.get('deps');
  const r = await refreshCatalogue({ db, dataDir: config.dataDir, fetchCatalogue: clients.fetchCatalogue, now });
  return c.json({ ...r, view: listSites(db, config.dataDir) });
});

/** What to fill in to add a site. */
sourcesRoutes.get('/sites/:siteId', (c) => {
  requireAdmin(c);
  const form = siteForm(c.get('deps').db, c.req.param('siteId').toLowerCase());
  if (!form) throw new HttpError(404, 'not_found', 'Marquee doesn’t know that site. Update the list of sites and try again.');
  return c.json<SiteForm>(form);
});

/** Adds a site and checks it straight away. */
sourcesRoutes.post('/sites', async (c) => {
  requireAdmin(c);
  const input = z
    .object({ siteId: z.string().trim().min(1).max(100), name: z.string().trim().max(100).optional(), url: z.string().trim().max(500).optional(), settings: settingsValues.default({}) })
    .parse(await c.req.json());
  const { sources, db } = c.get('deps');
  const form = siteForm(db, input.siteId.toLowerCase());
  if (!form) throw new HttpError(404, 'not_found', 'Marquee doesn’t know that site. Update the list of sites and try again.');
  if (form.unsupported) throw new HttpError(409, 'not_supported', `Marquee can’t run ${form.name} yet: ${form.unsupported}`);
  const s = sources.addSite({ ...input, siteId: form.id });
  const check = await sources.check(s.id);
  return c.json<{ source: SourceView; check: SourceCheckResult }>({ source: sources.view().sources.find((v) => v.id === s.id)!, check }, 201);
});

// ---------------- bot-check solving ----------------

sourcesRoutes.get('/solver', (c) => {
  requireAdmin(c);
  const { db, sources } = c.get('deps');
  return c.json<SolverView>(solverView(db, sources.bundledSolver));
});

sourcesRoutes.put('/solver', async (c) => {
  requireAdmin(c);
  const input = z.object({ enabled: z.boolean(), url: z.union([url, z.literal('')]).nullable().optional() }).parse(await c.req.json());
  const { db, sources } = c.get('deps');
  const current = readSolver(db);
  saveSolver(db, { enabled: input.enabled, url: input.url === undefined ? current.url : input.url || null });
  if (!input.enabled) sources.bundledSolver?.stop();
  return c.json<SolverView>(solverView(db, sources.bundledSolver));
});

/** Starts the solver if needed and asks it to answer. */
sourcesRoutes.post('/solver/test', async (c) => {
  requireAdmin(c);
  const { db, sources, clients } = c.get('deps');
  const s = readSolver(db);
  try {
    const address = s.url ?? (sources.bundledSolver ? await sources.bundledSolver.start() : null);
    if (!address) return c.json({ ok: false, message: 'This install has no solver inside it. Give a solver’s address under For experts.' });
    const version = await clients.solver(address).ping();
    return c.json({ ok: true, message: `The solver answered${version ? ` (version ${version})` : ''}.`, view: solverView(db, sources.bundledSolver) });
  } catch (err) {
    return c.json({ ok: false, message: (err as Error).message, view: solverView(db, sources.bundledSolver) });
  }
});

// ---------------- one Source ----------------
// (after the Prowlarr, site and solver routes, so those words aren't read as an id)

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
      seedRatio: z.number().min(0, 'Ratio is 0 (no limit) or more.').max(100).nullable().optional(),
      seedDays: z.number().min(0, 'Days are 0 (no limit) or more.').max(3650).nullable().optional(),
    })
    .parse(await c.req.json());
  if (s.prowlarrId !== null && (patch.url !== undefined || patch.apiKey !== undefined)) {
    throw new HttpError(409, 'from_prowlarr', 'This Source comes from Prowlarr, so its address and key follow Prowlarr. Change them there, or unlink Prowlarr.');
  }
  if (s.kind === 'site' && (patch.url !== undefined || patch.apiKey !== undefined)) {
    throw new HttpError(409, 'is_site', 'Change a site’s address and sign-in in its own settings.');
  }
  if (patch.apiKey === '') delete patch.apiKey; // blank means "keep the saved key"
  sources.update(s.id, patch);
  return c.json({ ok: true });
});

/** A site's address and settings. Secrets left blank keep what was saved. Checks it again. */
sourcesRoutes.put('/:id/site', async (c) => {
  requireAdmin(c);
  const { sources } = c.get('deps');
  const s = sources.get(id(c.req.param('id')));
  if (!s || s.kind !== 'site') throw new HttpError(404, 'not_found', 'No such site.');
  const input = z.object({ url: z.string().trim().max(500).optional(), settings: settingsValues.optional() }).parse(await c.req.json());
  sources.updateSite(s.id, input);
  return c.json<SourceCheckResult>(await sources.check(s.id));
});

/** Undoes "Bring over": the site is searched through Prowlarr again. */
sourcesRoutes.post('/:id/put-back', async (c) => {
  requireAdmin(c);
  const { sources } = c.get('deps');
  const n = id(c.req.param('id'));
  if (!sources.putBack(n)) throw new HttpError(409, 'cant_put_back', 'This site wasn’t brought over from Prowlarr, so there’s nothing to put back.');
  return c.json<SourceCheckResult>(await sources.check(n));
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
