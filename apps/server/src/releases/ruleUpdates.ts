import { and, eq } from 'drizzle-orm';
import { getSetting, schema, setSetting, type Db } from '../db/index.js';
import { HttpError } from '../http.js';
import { DICTIONARRY_SHIPPED, dictionarry, forgetRules, shippedRules } from './catalog.js';
import { downloadDictionarry, type DictionarryData, type DictionarryFetch } from './dictionarry.js';
import { dictExplain } from './dictWords.js';
import type { App } from './formats.js';
import { fromDictionarry, writeRules, type Kind, type ProfileRuleSetting } from './profiles.js';

/**
 * Rule updates (Profilarr's job): once a week Marquee asks whether
 * Dictionarry has changed. A newer version waits until you look at what
 * changed and press Apply. Applying moves every Dictionarry-based profile to
 * the new points, except where you'd changed a value yourself: yours is kept,
 * and if Dictionarry changed that same value too, the rule is flagged so you
 * can pick (the "conflict"). Nothing changes by itself.
 */

const WEEK = 7 * 24 * 3_600_000;
const LAST_CHECK = 'rules.last_check';
const APPS: App[] = ['radarr', 'sonarr'];
const kindOf = (app: App): Kind => (app === 'radarr' ? 'movie' : 'tv');
const appOf = (kind: Kind): App => (kind === 'movie' ? 'radarr' : 'sonarr');

export interface LastCheck {
  at: number;
  ok: boolean;
  message: string;
}

export function lastCheck(db: Db): LastCheck | null {
  const raw = getSetting(db, LAST_CHECK);
  return raw ? (JSON.parse(raw) as LastCheck) : null;
}

export function checkDue(db: Db, now: number): boolean {
  const last = lastCheck(db);
  return !last || now - last.at >= WEEK;
}

function versionRow(db: Db, app: App, state: 'applied' | 'pending') {
  return db
    .select()
    .from(schema.ruleDatabaseVersions)
    .where(and(eq(schema.ruleDatabaseVersions.name, 'dictionarry'), eq(schema.ruleDatabaseVersions.app, app), eq(schema.ruleDatabaseVersions.state, state)))
    .get();
}

function pending(db: Db, app: App): DictionarryData | null {
  const row = versionRow(db, app, 'pending');
  return row ? (JSON.parse(row.data) as DictionarryData) : null;
}

function save(db: Db, app: App, state: 'applied' | 'pending', data: DictionarryData, now: number): void {
  db.delete(schema.ruleDatabaseVersions)
    .where(and(eq(schema.ruleDatabaseVersions.name, 'dictionarry'), eq(schema.ruleDatabaseVersions.app, app), eq(schema.ruleDatabaseVersions.state, state)))
    .run();
  db.insert(schema.ruleDatabaseVersions).values({ name: 'dictionarry', app, state, commitSha: data.commit, fetchedAt: data.fetchedAt, data: JSON.stringify(data), savedAt: now }).run();
}

/** Asks GitHub for Dictionarry's newest version; downloads and keeps it (unapplied) when it's new. */
export async function checkForRuleUpdates(db: Db, fetcher: DictionarryFetch, now: number): Promise<LastCheck> {
  const current = dictionarry(db, 'radarr').commit;
  let result: LastCheck;
  try {
    const latest = await fetcher.latest();
    if (latest === current) {
      for (const app of APPS) db.delete(schema.ruleDatabaseVersions).where(and(eq(schema.ruleDatabaseVersions.app, app), eq(schema.ruleDatabaseVersions.state, 'pending'))).run();
      result = { at: now, ok: true, message: 'Up to date.' };
    } else if (pending(db, 'radarr')?.commit === latest) {
      result = { at: now, ok: true, message: 'An update is waiting for you to apply it.' };
    } else {
      const data = await downloadDictionarry(fetcher, latest, new Date(now));
      for (const app of APPS) save(db, app, 'pending', data[app], now);
      const d = ruleUpdate(db);
      result = { at: now, ok: true, message: d ? `An update is ready: ${d.summary}` : 'Up to date.' };
    }
  } catch (err) {
    result = { at: now, ok: false, message: `Couldn’t check Dictionarry: ${(err as Error).message} Marquee tries again tomorrow.` };
    // Try again in a day rather than a week.
    setSetting(db, LAST_CHECK, JSON.stringify({ ...result, at: now - WEEK + 24 * 3_600_000 }));
    return result;
  }
  setSetting(db, LAST_CHECK, JSON.stringify(result));
  return result;
}

// ---------------------------------------------------------------- what changed

export interface RuleUpdateView {
  from: { commit: string; fetchedAt: string };
  to: { commit: string; fetchedAt: string };
  /** One line, e.g. "4 rules changed, 1 added; 2 profiles get new points". */
  summary: string;
  rules: { kind: Kind; added: string[]; removed: string[]; changed: string[] }[];
  profiles: ProfileImpact[];
}

export interface ProfileImpact {
  id: number;
  kind: Kind;
  name: string;
  /** Rules whose points change. */
  newPoints: { label: string; from: number; to: number }[];
  added: string[];
  removed: string[];
  /** Settings Dictionarry changed, e.g. "Turn down copies under: 200,000 → 250,000". */
  settings: string[];
  /** You'd changed these and so had Dictionarry: yours are kept and flagged. */
  conflicts: { label: string; yours: string; theirs: string }[];
}

const label = (id: string, name: string) => dictExplain(name)?.label ?? name ?? id;
const num = (n: number) => n.toLocaleString('en-US');

/** What applying the waiting update would do, or null when there's none. */
export function ruleUpdate(db: Db): RuleUpdateView | null {
  const next = { radarr: pending(db, 'radarr'), sonarr: pending(db, 'sonarr') };
  if (!next.radarr || !next.sonarr) return null;
  const rules: RuleUpdateView['rules'] = [];
  for (const app of APPS) {
    const before = new Map(dictionarry(db, app).formats.map((f) => [f.trash_id, f]));
    const after = new Map(next[app]!.formats.map((f) => [f.trash_id, f]));
    rules.push({
      kind: kindOf(app),
      added: [...after.values()].filter((f) => !before.has(f.trash_id)).map((f) => label(f.trash_id, f.name)),
      removed: [...before.values()].filter((f) => !after.has(f.trash_id)).map((f) => label(f.trash_id, f.name)),
      changed: [...after.values()].filter((f) => before.has(f.trash_id) && JSON.stringify(before.get(f.trash_id)!.specifications) !== JSON.stringify(f.specifications)).map((f) => label(f.trash_id, f.name)),
    });
  }
  const profiles = db
    .select()
    .from(schema.profiles)
    .where(eq(schema.profiles.database, 'dictionarry'))
    .all()
    .flatMap((p) => {
      const m = merge(db, p, next[appOf(p.kind)]!);
      return m ? [m.impact] : [];
    })
    .filter((i) => i.newPoints.length || i.added.length || i.removed.length || i.settings.length || i.conflicts.length);
  const ruleCount = rules.reduce((n, r) => n + r.added.length + r.removed.length + r.changed.length, 0);
  const parts = [ruleCount ? `${ruleCount} ${ruleCount === 1 ? 'rule' : 'rules'} changed` : null, profiles.length ? `${profiles.length} ${profiles.length === 1 ? 'profile gets' : 'profiles get'} new points` : null].filter(Boolean);
  const from = dictionarry(db, 'radarr');
  return {
    from: { commit: from.commit, fetchedAt: from.fetchedAt },
    to: { commit: next.radarr.commit, fetchedAt: next.radarr.fetchedAt },
    summary: parts.length ? parts.join('; ') : 'nothing that affects your profiles',
    rules,
    profiles,
  };
}

type ProfileRow = typeof schema.profiles.$inferSelect;

/** Three-way merge of one profile: Dictionarry before, Dictionarry after, and yours. */
function merge(db: Db, row: ProfileRow, next: DictionarryData) {
  if (!row.base) return null;
  const app = appOf(row.kind);
  const prev = dictionarry(db, app);
  const oldBase = prev.profiles.find((p) => p.name === row.base);
  const newBase = next.profiles.find((p) => p.name === row.base);
  if (!oldBase || !newBase) return null;
  const was = fromDictionarry(prev, row.kind, row.base, { name: '', description: '' });
  const will = fromDictionarry(next, row.kind, row.base, { name: '', description: '' });
  const names = new Map([...prev.formats, ...next.formats].map((f) => [f.trash_id, f.name]));
  const info = shippedRules(row.kind);
  const nameOf = (id: string) => label(id, names.get(id) ?? info.get(id)?.rule.name ?? id);
  const impact: ProfileImpact = { id: row.id, kind: row.kind, name: row.name, newPoints: [], added: [], removed: [], settings: [], conflicts: [] };

  const stillThere = new Set(next.formats.map((f) => f.trash_id));
  const mine = db.select().from(schema.profileRules).where(eq(schema.profileRules.profileId, row.id)).all();
  const rules: ProfileRuleSetting[] = [];
  const seen = new Set<string>();
  for (const r of mine) {
    seen.add(r.trashId);
    if (!r.trashId.startsWith('dict:')) {
      rules.push({ trashId: r.trashId, enabled: r.enabled, score: r.score, upstreamScore: r.upstreamScore });
      continue;
    }
    const o = oldBase.scores[r.trashId];
    const n = newBase.scores[r.trashId];
    const edited = o === undefined || r.score !== o;
    if (n === undefined) {
      // Gone from the profile; kept only if you'd changed it and the rule still exists.
      if (!edited || !stillThere.has(r.trashId)) {
        impact.removed.push(nameOf(r.trashId));
        continue;
      }
      rules.push({ trashId: r.trashId, enabled: r.enabled, score: r.score, upstreamScore: r.upstreamScore });
    } else if (n !== o && !edited) {
      impact.newPoints.push({ label: nameOf(r.trashId), from: r.score, to: n });
      rules.push({ trashId: r.trashId, enabled: r.enabled, score: n, upstreamScore: null });
    } else if (n !== o && edited && n !== r.score) {
      impact.conflicts.push({ label: nameOf(r.trashId), yours: num(r.score), theirs: num(n) });
      rules.push({ trashId: r.trashId, enabled: r.enabled, score: r.score, upstreamScore: n });
    } else {
      rules.push({ trashId: r.trashId, enabled: r.enabled, score: r.score, upstreamScore: n === r.score ? null : r.upstreamScore });
    }
  }
  for (const [id, n] of Object.entries(newBase.scores)) {
    if (seen.has(id) || oldBase.scores[id] !== undefined) continue;
    impact.added.push(nameOf(id));
    rules.push({ trashId: id, enabled: true, score: n });
  }

  // Profile settings: take Dictionarry's new value only where yours still matches its old one.
  const set: Partial<ProfileRow> = {};
  const field = <K extends 'minScore' | 'cutoffScore' | 'minUpgradeScore' | 'upgrades' | 'cutoff' | 'preferRepacks'>(key: K, what: string, show: (v: ProfileRow[K]) => string) => {
    const o = was[key] as unknown as ProfileRow[K];
    const n = will[key] as unknown as ProfileRow[K];
    if (o === n) return;
    if (row[key] === o) {
      (set as Record<string, unknown>)[key] = n;
      impact.settings.push(`${what}: ${show(o)} → ${show(n)}`);
    } else if (row[key] !== n) impact.conflicts.push({ label: what, yours: show(row[key]), theirs: show(n) });
  };
  field('minScore', 'Turn down copies under', (v) => `${num(v as number)} points`);
  field('cutoffScore', 'Good enough at', (v) => `${num(v as number)} points`);
  field('minUpgradeScore', 'Smallest gain worth an upgrade', (v) => `${num(v as number)} points`);
  field('upgrades', 'Keep looking for better copies', (v) => (v ? 'yes' : 'no'));
  field('cutoff', 'Good enough quality', (v) => String(v));
  field('preferRepacks', 'Fixed copies rank first', (v) => (v ? 'yes' : 'no'));
  const tiersOld = JSON.stringify(was.tiers);
  const tiersNew = JSON.stringify(will.tiers);
  if (tiersOld !== tiersNew) {
    if (row.tiers === tiersOld) {
      set.tiers = tiersNew;
      impact.settings.push('Which qualities it takes, and their order');
    } else if (row.tiers !== tiersNew) impact.conflicts.push({ label: 'Which qualities it takes', yours: 'your order', theirs: 'Dictionarry’s new order' });
  }
  return { impact, rules, set };
}

/** Applies the waiting update. Returns what changed, or 409 when there's nothing waiting. */
export function applyRuleUpdate(db: Db, now: number): RuleUpdateView {
  const view = ruleUpdate(db);
  const next = { radarr: pending(db, 'radarr'), sonarr: pending(db, 'sonarr') };
  if (!view || !next.radarr || !next.sonarr) throw new HttpError(409, 'nothing_to_apply', 'There’s no rule update waiting. Check for one first.');
  db.transaction(() => {
    for (const row of db.select().from(schema.profiles).where(eq(schema.profiles.database, 'dictionarry')).all()) {
      const m = merge(db, row, next[appOf(row.kind)]!);
      if (!m) continue;
      if (Object.keys(m.set).length) db.update(schema.profiles).set(m.set).where(eq(schema.profiles.id, row.id)).run();
      writeRules(db, row.id, m.rules);
    }
    for (const app of APPS) {
      save(db, app, 'applied', next[app]!, now);
      db.delete(schema.ruleDatabaseVersions).where(and(eq(schema.ruleDatabaseVersions.app, app), eq(schema.ruleDatabaseVersions.state, 'pending'))).run();
    }
  });
  forgetRules(db);
  setSetting(db, LAST_CHECK, JSON.stringify({ at: now, ok: true, message: `Applied: ${view.summary}.` }));
  return view;
}

/** Which Dictionarry version is in use. */
export function currentVersion(db: Db): { commit: string; fetchedAt: string; shipped: boolean } {
  const d = dictionarry(db, 'radarr');
  return { commit: d.commit, fetchedAt: d.fetchedAt, shipped: d.commit === DICTIONARRY_SHIPPED.radarr.commit && !versionRow(db, 'radarr', 'applied') };
}

