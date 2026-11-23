import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { ChoicesCheckView, NameCheckView, OwnRulesView, OwnRuleView, ProfileChangeView, ProfileChoicesView, ProfileDefaultSlot, ProfileDetail, ProfileSummary, ProfilesView, RuleUpdatesView, SizeLimitView } from '@marquee/shared';
import { schema } from '../db/index.js';
import { HttpError, requireAdmin, type Ctx, type Env } from '../http.js';
import { GENRES, LANGUAGES, RATINGS, applyChanges, listChoices, previewChanges, ruleCounts, setChoices, suggestions, tryTitles } from '../releases/choose.js';
import { OWN_LANGUAGES, describeOwn, forgetRules, ownId, ownRuleProblem, type OwnRuleRow } from '../releases/catalog.js';
import { decide } from '../releases/decide.js';
import { parseRelease } from '../releases/parse.js';
import { ProfileService, databaseProfiles, databaseSizes, dictionarryNotice, dismissDictionarryNotice, knownQualities, qualityLabel, sizeLimit, upstreamScore, writeRules, type FullProfile } from '../releases/profiles.js';
import { applyRuleUpdate, checkForRuleUpdates, currentVersion, lastCheck, ruleUpdate } from '../releases/ruleUpdates.js';
import { githubFetch } from '../releases/dictionarry.js';

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
/** Dictionarry's points run to ±999,999 and its "good enough" to 1,000,000. */
const points = z.number().int().min(-10_000_000).max(10_000_000);
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
    minUpgradeScore: z.number().int().min(1).max(10_000_000),
    preferRepacks: z.boolean(),
    sizes: z.record(z.string(), z.object({ min: mbPerMinute, preferred: mbPerMinute, max: mbPerMinute })),
    rules: z.array(z.object({ trashId: z.string(), enabled: z.boolean(), score: points })),
  })
  .partial()
  .strict();

function summary(svc: ProfileService, p: FullProfile): ProfileSummary {
  const defaults = svc.defaults();
  const defaultFor = (Object.keys(defaults) as ProfileDefaultSlot[]).filter((slot) => defaults[slot] === p.key && (slot === 'kids' || slot === p.kind));
  return {
    id: p.id,
    kind: p.kind,
    key: p.key,
    name: p.name,
    description: p.description,
    preset: p.preset,
    database: p.database ?? 'trash',
    base: p.base ?? null,
    cutoff: p.cutoff,
    titles: svc.usage(p.kind, p.key),
    defaultFor,
  };
}

function detail(c: Ctx, svc: ProfileService, p: FullProfile): ProfileDetail {
  const info = p.defs!;
  const db = c.get('deps').db;
  const qualities = knownQualities(p.kind);
  const sizes: SizeLimitView[] = databaseSizes(p.database ?? 'trash', p.kind)
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
    preferRepacks: p.preferRepacks ?? true,
    sizes,
    rules: p.rules.flatMap((r) => {
      const i = info.get(r.trashId);
      return i
        ? [{ trashId: r.trashId, source: i.source, name: i.rule.name, label: i.label, explain: i.explain, group: i.group, enabled: r.enabled, score: r.score, databaseScore: upstreamScore(db, p, r.trashId), conflict: r.upstreamScore ?? null }]
        : [];
    }),
    qualityLabels: Object.fromEntries(qualities.map((q) => [q, qualityLabel(q)])),
  };
}

profileRoutes.get('/', (c) => {
  requireAdmin(c);
  const svc = service(c);
  const db = c.get('deps').db;
  return c.json<ProfilesView>({ profiles: svc.list().map((p) => summary(svc, p)), defaults: svc.defaults(), starters: databaseProfiles(db), notice: dictionarryNotice(db) });
});

profileRoutes.post('/', async (c) => {
  requireAdmin(c);
  const input = z.object({ kind, name, copyFrom: z.number().int().positive().optional(), fromTrash: z.string().optional(), fromDictionarry: z.string().optional() }).parse(await c.req.json());
  const svc = service(c);
  return c.json<ProfileDetail>(detail(c, svc, svc.create(input)), 201);
});

/** Hides the note about the move to Dictionarry. */
profileRoutes.post('/notice/dismiss', (c) => {
  requireAdmin(c);
  dismissDictionarryNotice(c.get('deps').db);
  return c.json({ ok: true });
});

// ---------------- rule updates (Dictionarry)

const updatesView = (c: Ctx): RuleUpdatesView => {
  const db = c.get('deps').db;
  return { current: currentVersion(db), lastCheck: lastCheck(db), pending: ruleUpdate(db) };
};

profileRoutes.get('/updates', (c) => {
  requireAdmin(c);
  return c.json<RuleUpdatesView>(updatesView(c));
});

profileRoutes.post('/updates/check', async (c) => {
  requireAdmin(c);
  const { db, clients, now } = c.get('deps');
  await checkForRuleUpdates(db, clients.dictionarry ?? githubFetch(), now());
  return c.json<RuleUpdatesView>(updatesView(c));
});

profileRoutes.post('/updates/apply', (c) => {
  requireAdmin(c);
  const { db, now } = c.get('deps');
  applyRuleUpdate(db, now());
  return c.json<RuleUpdatesView>(updatesView(c));
});

// ---------------- your own rules

const ownBody = z.object({
  name: z.string().trim().min(1, 'Give the rule a name.').max(80),
  kind: z.enum(['movie', 'tv', 'both']),
  match: z.enum(['words', 'group', 'language', 'pattern']),
  value: z.string().trim().min(1, 'Say what to look for.').max(2000),
  /** Profile id → points; profiles left out don't count it. */
  points: z.record(z.string(), points).default({}),
});

function ownView(c: Ctx): OwnRulesView {
  const { db } = c.get('deps');
  const rows = db.select().from(schema.ownRules).all();
  const scores = db.select().from(schema.profileRules).all();
  return {
    rules: rows.map(
      (r): OwnRuleView => ({
        id: r.id,
        trashId: ownId(r.id),
        name: r.name,
        kind: r.kind,
        match: r.match,
        value: r.value,
        description: describeOwn(r),
        points: Object.fromEntries(scores.filter((s) => s.trashId === ownId(r.id) && s.enabled).map((s) => [s.profileId, s.score])),
      }),
    ),
    languages: OWN_LANGUAGES,
  };
}

/** Puts an own rule's points into each profile it applies to (0 or left out: listed but off). */
function placeOwn(c: Ctx, rule: OwnRuleRow, points: Record<string, number>): void {
  const { db } = c.get('deps');
  forgetRules(db);
  const svc = service(c);
  for (const p of svc.list()) {
    const fits = rule.kind === 'both' || rule.kind === p.kind;
    const others = p.rules.filter((r) => r.trashId !== ownId(rule.id));
    const score = points[String(p.id)] ?? 0;
    writeRules(db, p.id, fits ? [...others, { trashId: ownId(rule.id), enabled: score !== 0, score }] : others);
  }
}

profileRoutes.get('/own-rules', (c) => {
  requireAdmin(c);
  return c.json<OwnRulesView>(ownView(c));
});

profileRoutes.post('/own-rules', async (c) => {
  requireAdmin(c);
  const input = ownBody.parse(await c.req.json());
  const problem = ownRuleProblem(input.match, input.value);
  if (problem) throw new HttpError(400, 'invalid_input', problem);
  const { db, now } = c.get('deps');
  const row = db.insert(schema.ownRules).values({ name: input.name, kind: input.kind, match: input.match, value: input.value, createdAt: now(), updatedAt: now() }).returning().get();
  db.transaction(() => placeOwn(c, row, input.points));
  return c.json<OwnRulesView>(ownView(c), 201);
});

profileRoutes.put('/own-rules/:id', async (c) => {
  requireAdmin(c);
  const input = ownBody.parse(await c.req.json());
  const problem = ownRuleProblem(input.match, input.value);
  if (problem) throw new HttpError(400, 'invalid_input', problem);
  const { db, now } = c.get('deps');
  const row = db
    .update(schema.ownRules)
    .set({ name: input.name, kind: input.kind, match: input.match, value: input.value, updatedAt: now() })
    .where(eq(schema.ownRules.id, id(c.req.param('id'))))
    .returning()
    .get();
  if (!row) throw new HttpError(404, 'not_found', 'No such rule.');
  db.transaction(() => placeOwn(c, row, input.points));
  return c.json<OwnRulesView>(ownView(c));
});

profileRoutes.delete('/own-rules/:id', (c) => {
  requireAdmin(c);
  const { db } = c.get('deps');
  const ruleId = id(c.req.param('id'));
  db.transaction(() => {
    db.delete(schema.profileRules).where(eq(schema.profileRules.trashId, ownId(ruleId))).run();
    db.delete(schema.ownRules).where(eq(schema.ownRules.id, ruleId)).run();
  });
  forgetRules(db);
  return c.json<OwnRulesView>(ownView(c));
});

profileRoutes.put('/defaults', async (c) => {
  requireAdmin(c);
  const input = z.object({ movie: z.string(), tv: z.string(), kids: z.string() }).partial().parse(await c.req.json());
  return c.json(service(c).setDefaults(input));
});

// ---------------- which profile a title gets

const choiceKind = (raw: string) => kind.parse(raw);
const condition = z.object({
  field: z.enum(['genre', 'rating', 'year', 'company', 'language', 'keyword']),
  op: z.enum(['any', 'all', 'none', 'between']),
  values: z.array(z.string().max(200)).max(100).optional(),
  min: z.number().int().min(1870).max(2200).nullable().optional(),
  max: z.number().int().min(1870).max(2200).nullable().optional(),
});
const rulesBody = z.object({ rules: z.array(z.object({ profile: z.string().min(1), conditions: z.array(condition).max(12) })).max(40) });

profileRoutes.get('/choices', (c) => {
  requireAdmin(c);
  const { db } = c.get('deps');
  return c.json<ProfileChoicesView>({
    rules: { movie: listChoices(db, 'movie'), tv: listChoices(db, 'tv') },
    genres: GENRES,
    ratings: RATINGS,
    languageNames: LANGUAGES,
    suggestions: { movie: suggestions(db, 'movie'), tv: suggestions(db, 'tv') },
  });
});

profileRoutes.put('/choices/:kind', async (c) => {
  requireAdmin(c);
  const { rules } = rulesBody.parse(await c.req.json());
  return c.json({ rules: setChoices(c.get('deps').db, choiceKind(c.req.param('kind')), rules) });
});

/** How rules (saved or a draft being edited) sort the library, and "try a title". Changes nothing. */
profileRoutes.post('/choices/:kind/check', async (c) => {
  requireAdmin(c);
  const { rules, query } = rulesBody.extend({ query: z.string().max(200).default('') }).parse(await c.req.json());
  const { db } = c.get('deps');
  const k = choiceKind(c.req.param('kind'));
  return c.json<ChoicesCheckView>({ counts: ruleCounts(db, k, rules), titles: tryTitles(db, k, query, rules) });
});

/** What sorting the library by the rules would change. Changes nothing. */
profileRoutes.get('/choices/:kind/preview', (c) => {
  requireAdmin(c);
  return c.json<{ changes: ProfileChangeView[] }>({ changes: previewChanges(c.get('deps').db, choiceKind(c.req.param('kind'))) });
});

profileRoutes.post('/choices/:kind/apply', (c) => {
  requireAdmin(c);
  return c.json({ changed: applyChanges(c.get('deps').db, choiceKind(c.req.param('kind'))) });
});

profileRoutes.get('/:id', (c) => {
  requireAdmin(c);
  const svc = service(c);
  return c.json<ProfileDetail>(detail(c, svc, svc.get(id(c.req.param('id')))));
});

profileRoutes.patch('/:id', async (c) => {
  requireAdmin(c);
  const input = patch.parse(await c.req.json());
  const svc = service(c);
  return c.json<ProfileDetail>(detail(c, svc, svc.update(id(c.req.param('id')), input)));
});

/** Puts a built-in profile back to its database's values. */
profileRoutes.post('/:id/reset', (c) => {
  requireAdmin(c);
  const svc = service(c);
  return c.json<ProfileDetail>(detail(c, svc, svc.reset(id(c.req.param('id')))));
});

/** After a rule update: take Dictionarry's new points for a rule you'd changed, or keep yours. */
profileRoutes.post('/:id/settle', async (c) => {
  requireAdmin(c);
  const input = z.object({ trashId: z.string().min(1), use: z.enum(['theirs', 'mine']) }).parse(await c.req.json());
  const svc = service(c);
  return c.json<ProfileDetail>(detail(c, svc, svc.settle(id(c.req.param('id')), input.trashId, input.use)));
});

/**
 * Try a name: how this profile judges one copy name (each rule's points and
 * whether it'd be taken). Changes nothing. Size and runtime are optional; with
 * both, the size limits are checked too.
 */
profileRoutes.post('/:id/try', async (c) => {
  requireAdmin(c);
  const input = z
    .object({ name: z.string().trim().min(1, 'Paste a copy’s name.').max(500), sizeGb: z.number().positive().max(1000).optional(), minutes: z.number().int().positive().max(1000).optional() })
    .parse(await c.req.json());
  const p = service(c).get(id(c.req.param('id')));
  const parsed = parseRelease(input.name);
  const d = decide(
    { kind: p.kind, title: parsed.title || input.name, year: parsed.year, runtime: input.minutes ?? null, season: parsed.season ?? parsed.seasons[0], episode: parsed.fullSeason ? undefined : parsed.episodes[0] },
    [
      {
        title: input.name,
        size: input.sizeGb ? Math.round(input.sizeGb * 1024 ** 3) : null,
        seeders: null,
        leechers: null,
        grabs: null,
        publishedAt: null,
        downloadUrl: '',
        infoUrl: null,
        guid: 'try',
        infoHash: null,
        categories: [],
        imdbId: null,
        tmdbId: null,
        tvdbId: null,
        freeleech: false,
        sourceId: 0,
        sourceName: '',
        sourcePriority: 0,
      },
    ],
    p,
  )[0]!;
  // Only what the profile says counts here; the name is the title by definition.
  const own = new Set(['quality', 'too_small', 'too_big', 'never', 'low_score', 'sample']);
  const reasons = d.rejections.filter((r) => own.has(r.code)).map((r) => r.message);
  if (p.kind === 'movie' && (parsed.season !== null || parsed.episodes.length)) reasons.unshift('That’s a TV episode or season; try it against a TV profile.');
  if (p.kind === 'tv' && parsed.season === null && !parsed.seasons.length) reasons.unshift('The name doesn’t say which season or episode it is, so Marquee would never take it for a show.');
  const tier = d.tier ? p.tiers.find((t) => t.name === d.tier) : undefined;
  return c.json<NameCheckView>({
    name: input.name,
    quality: d.quality,
    qualityLabel: d.qualityLabel,
    tier: d.tier,
    tierAllowed: !!tier?.allowed,
    score: d.score,
    minScore: p.minScore,
    rules: d.rules,
    taken: reasons.length === 0,
    reasons,
    details: {
      title: parsed.title,
      year: parsed.year,
      source: parsed.source,
      resolution: parsed.resolution,
      hdr: parsed.hdr,
      codec: parsed.codec,
      audio: parsed.audio,
      atmos: parsed.atmos,
      service: parsed.service,
      group: parsed.group,
      editions: parsed.editions,
      repack: parsed.repack > 0 || parsed.proper,
    },
  });
});

profileRoutes.delete('/:id', (c) => {
  requireAdmin(c);
  service(c).remove(id(c.req.param('id')));
  return c.json({ ok: true });
});
