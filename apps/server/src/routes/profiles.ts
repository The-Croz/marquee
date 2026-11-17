import { Hono } from 'hono';
import { z } from 'zod';
import type { ProfileDefaultSlot, ProfileDetail, ProfileSummary, ProfilesView, SizeLimitView } from '@marquee/shared';
import { HttpError, requireAdmin, type Ctx, type Env } from '../http.js';
import { TRASH } from '../releases/formats.js';
import { ProfileService, appFor, knownQualities, qualityLabel, ruleInfo, sizeLimit, type FullProfile } from '../releases/profiles.js';

/** Settings → Quality: profiles. Admin only. */
export const profileRoutes = new Hono<Env>();

const service = (c: Ctx) => new ProfileService(c.get('deps').db, c.get('deps').now);
const id = (raw: string) => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(404, 'not_found', 'No such profile.');
  return n;
};

const kind = z.enum(['movie', 'tv']);
const name = z.string().trim().min(1, 'Give it a name.').max(60, 'Keep the name under 60 characters.');
const points = z.number().int().min(-100000).max(100000);
const mbPerMinute = z.number().min(0).max(2000);
const patch = z
  .object({
    name,
    description: z.string().trim().max(300),
    tiers: z.array(z.object({ name: z.string().trim().min(1).max(60), qualities: z.array(z.string()).min(1), allowed: z.boolean() })).min(1),
    cutoff: z.string(),
    upgrades: z.boolean(),
    minScore: points,
    cutoffScore: points,
    minUpgradeScore: z.number().int().min(1).max(100000),
    sizes: z.record(z.string(), z.object({ min: mbPerMinute, preferred: mbPerMinute, max: mbPerMinute })),
    rules: z.array(z.object({ trashId: z.string(), enabled: z.boolean(), score: points })),
  })
  .partial()
  .strict();

function summary(svc: ProfileService, p: FullProfile): ProfileSummary {
  const defaults = svc.defaults();
  const defaultFor = (Object.keys(defaults) as ProfileDefaultSlot[]).filter((slot) => defaults[slot] === p.key && (slot === 'kids' || slot === p.kind));
  return { id: p.id, kind: p.kind, key: p.key, name: p.name, description: p.description, preset: p.preset, cutoff: p.cutoff, titles: svc.usage(p.kind, p.key), defaultFor };
}

function detail(svc: ProfileService, p: FullProfile): ProfileDetail {
  const info = ruleInfo(p.kind);
  const qualities = knownQualities(p.kind);
  const sizes: SizeLimitView[] = TRASH[appFor(p.kind)].sizes
    .map((s) => s.quality)
    .filter((q) => qualities.includes(q))
    .map((q) => {
      const l = sizeLimit(p, q)!;
      return { quality: q, label: qualityLabel(q), min: l.min, preferred: l.preferred, max: l.max, unlimited: l.unlimited, changed: q in p.sizes };
    });
  return {
    ...summary(svc, p),
    tiers: p.tiers,
    upgrades: p.upgrades,
    minScore: p.minScore,
    cutoffScore: p.cutoffScore,
    minUpgradeScore: p.minUpgradeScore,
    sizes,
    rules: p.rules.flatMap((r) => {
      const i = info.get(r.trashId);
      return i ? [{ trashId: r.trashId, name: i.rule.name, label: i.label, explain: i.explain, group: i.group, enabled: r.enabled, score: r.score, trashScore: i.trashScore }] : [];
    }),
    qualityLabels: Object.fromEntries(qualities.map((q) => [q, qualityLabel(q)])),
  };
}

profileRoutes.get('/', (c) => {
  requireAdmin(c);
  const svc = service(c);
  return c.json<ProfilesView>({ profiles: svc.list().map((p) => summary(svc, p)), defaults: svc.defaults() });
});

profileRoutes.post('/', async (c) => {
  requireAdmin(c);
  const input = z.object({ kind, name, copyFrom: z.number().int().positive().optional() }).parse(await c.req.json());
  const svc = service(c);
  return c.json<ProfileDetail>(detail(svc, svc.create(input)), 201);
});

profileRoutes.put('/defaults', async (c) => {
  requireAdmin(c);
  const input = z.object({ movie: z.string(), tv: z.string(), kids: z.string() }).partial().parse(await c.req.json());
  return c.json(service(c).setDefaults(input));
});

profileRoutes.get('/:id', (c) => {
  requireAdmin(c);
  const svc = service(c);
  return c.json<ProfileDetail>(detail(svc, svc.get(id(c.req.param('id')))));
});

profileRoutes.patch('/:id', async (c) => {
  requireAdmin(c);
  const input = patch.parse(await c.req.json());
  const svc = service(c);
  return c.json<ProfileDetail>(detail(svc, svc.update(id(c.req.param('id')), input)));
});

/** Puts a built-in profile back to TRaSH's values. */
profileRoutes.post('/:id/reset', (c) => {
  requireAdmin(c);
  const svc = service(c);
  return c.json<ProfileDetail>(detail(svc, svc.reset(id(c.req.param('id')))));
});

profileRoutes.delete('/:id', (c) => {
  requireAdmin(c);
  service(c).remove(id(c.req.param('id')));
  return c.json({ ok: true });
});
