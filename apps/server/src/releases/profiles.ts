import { and, eq, sql } from 'drizzle-orm';
import { getSetting, setSetting, schema, type Db } from '../db/index.js';
import { HttpError } from '../http.js';
import { explain } from './explanations.js';
import { TRASH, defaultRules, optionalRules, type App, type Rule, type TrashProfile } from './formats.js';

/**
 * Profiles: what a title wants. Which qualities it accepts and in what order,
 * which TRaSH rules add or take away points, size limits, and when a copy is
 * "good enough". Stored in the database and editable; the three presets are
 * built from TRaSH's own profiles and can be reset to them.
 */

export type Kind = 'movie' | 'tv';

/** A group of qualities that rank the same, e.g. "WEB 1080p" = WEBDL-1080p + WEBRip-1080p. */
export interface Tier {
  name: string;
  qualities: string[];
  allowed: boolean;
}

/** MB per minute of runtime, as Radarr and Sonarr measure it. */
export interface SizeLimit {
  min: number;
  preferred: number;
  max: number;
}

export interface ProfileRuleSetting {
  trashId: string;
  enabled: boolean;
  score: number;
}

export interface FullProfile {
  id: number;
  kind: Kind;
  key: string;
  name: string;
  description: string;
  preset: string | null;
  tiers: Tier[];
  cutoff: string;
  upgrades: boolean;
  minScore: number;
  cutoffScore: number;
  minUpgradeScore: number;
  /** Only the qualities you've changed; the rest use TRaSH's sizes (see `sizeLimit`). */
  sizes: Record<string, SizeLimit>;
  rules: ProfileRuleSetting[];
}

export const appFor = (kind: Kind): App => (kind === 'movie' ? 'radarr' : 'sonarr');

/** Radarr's slider tops out here; a max at the top means "no limit". Sonarr's tops out at 1000. */
const NO_LIMIT: Record<App, number> = { radarr: 2000, sonarr: 1000 };

/**
 * The parser names qualities the way Radarr does. Sonarr calls remuxes
 * "Bluray-2160p Remux" and has no cinema or disc-image qualities.
 */
export function appQuality(kind: Kind, radarrName: string): string {
  if (kind === 'movie') return radarrName;
  const remux = radarrName.match(/^Remux-(\d+p)$/);
  if (remux) return `Bluray-${remux[1]} Remux`;
  if (radarrName === 'DVD-R') return 'DVD';
  return knownQualities('tv').includes(radarrName) ? radarrName : 'Unknown';
}

/** Every quality name the app knows, from TRaSH's profile (which lists them all). */
export function knownQualities(kind: Kind): string[] {
  const p = TRASH[appFor(kind)].profiles[0]!;
  return p.items.flatMap((i) => i.items ?? [i.name]);
}

/** The size limit for a quality: yours if you changed it, else TRaSH's, else none. */
export function sizeLimit(profile: FullProfile, quality: string): (SizeLimit & { unlimited: boolean }) | null {
  const app = appFor(profile.kind);
  const limit = profile.sizes[quality] ?? TRASH[app].sizes.find((s) => s.quality === quality) ?? null;
  if (!limit) return null;
  return { min: limit.min, preferred: limit.preferred, max: limit.max, unlimited: limit.max >= NO_LIMIT[app] };
}

/** Plain words for a quality name ("WEBDL-1080p" → "1080p web download"). */
export function qualityLabel(quality: string): string {
  const fixed: Record<string, string> = {
    'BR-DISK': 'Full Blu-ray disc',
    'Raw-HD': 'Raw TV recording',
    DVD: 'DVD',
    'DVD-R': 'DVD disc image',
    SDTV: 'TV recording (SD)',
    DVDSCR: 'Screener',
    REGIONAL: 'Regional DVD',
    TELECINE: 'Cinema film scan',
    TELESYNC: 'Cinema recording',
    CAM: 'Filmed in a cinema',
    WORKPRINT: 'Unfinished workprint',
    Unknown: 'Unknown quality',
  };
  if (fixed[quality]) return fixed[quality]!;
  const res = quality.match(/(\d{3,4})p/)?.[1];
  const size = res === '2160' ? '4K' : res ? `${res}p` : '';
  let what = quality;
  if (/Remux/.test(quality)) what = 'Blu-ray remux';
  else if (quality.startsWith('Bluray')) what = 'Blu-ray';
  else if (quality.startsWith('WEBDL')) what = 'web download';
  else if (quality.startsWith('WEBRip')) what = 'web capture';
  else if (quality.startsWith('WEB')) what = 'web';
  else if (quality.startsWith('HDTV')) what = 'TV recording';
  return `${size} ${what}`.trim();
}

// ---------------------------------------------------------------- presets

interface PresetValues {
  name: string;
  description: string;
  tiers: Tier[];
  cutoff: string;
  upgrades: boolean;
  minScore: number;
  cutoffScore: number;
  minUpgradeScore: number;
  sizes: Record<string, SizeLimit>;
  rules: ProfileRuleSetting[];
}

interface Preset {
  key: string;
  kind: Kind;
  build: () => PresetValues;
}

function trashProfile(app: App, name: string): TrashProfile {
  const p = TRASH[app].profiles.find((x) => x.name === name);
  if (!p) throw new Error(`No TRaSH profile called ${name}`);
  return p;
}

/** TRaSH's quality list, with `allowed` (best first) replaced by ours and the rest kept off below it. */
function tiersFrom(base: TrashProfile, allowed: string[]): Tier[] {
  const all = base.items.map((i) => ({ name: i.name, qualities: i.items ?? [i.name], allowed: false }));
  const on = allowed.map((name) => {
    const t = all.find((x) => x.name === name);
    if (!t) throw new Error(`No quality tier called ${name}`);
    return { ...t, allowed: true };
  });
  return [...on, ...all.filter((t) => !allowed.includes(t.name))];
}

/** On-by-default rules from each TRaSH profile (first wins on overlap), then their opt-in rules switched off. */
function rulesFrom(app: App, profileNames: string[]): ProfileRuleSetting[] {
  const out = new Map<string, ProfileRuleSetting>();
  for (const n of profileNames) for (const r of defaultRules(app, n)) if (!out.has(r.rule.trash_id)) out.set(r.rule.trash_id, { trashId: r.rule.trash_id, enabled: true, score: r.points });
  for (const n of profileNames) for (const r of optionalRules(app, n)) if (!out.has(r.rule.trash_id)) out.set(r.rule.trash_id, { trashId: r.rule.trash_id, enabled: false, score: r.points });
  return [...out.values()];
}

function fromTrash(app: App, base: string, extra: string[], allowed: string[], cutoff: string, text: { name: string; description: string }, sizes: Record<string, SizeLimit> = {}): PresetValues {
  const p = trashProfile(app, base);
  return {
    ...text,
    tiers: tiersFrom(p, allowed),
    cutoff,
    upgrades: p.upgradeAllowed,
    minScore: p.minFormatScore,
    cutoffScore: p.cutoffFormatScore,
    minUpgradeScore: p.minUpgradeFormatScore,
    sizes,
    rules: rulesFrom(app, [base, ...extra]),
  };
}

/**
 * Kids & Cartoons takes a 1080p web copy only when it's small: 40 MB a minute
 * for movies (about 3.6 GB for 90 minutes), 50 for TV episodes.
 */
const KIDS_1080P_MAX = { movie: 40, tv: 50 };
const kidsSizes = (kind: Kind): Record<string, SizeLimit> => {
  const app = appFor(kind);
  const out: Record<string, SizeLimit> = {};
  for (const q of ['WEBDL-1080p', 'WEBRip-1080p']) {
    const t = TRASH[app].sizes.find((s) => s.quality === q)!;
    out[q] = { min: t.min, preferred: KIDS_1080P_MAX[kind] - 1, max: KIDS_1080P_MAX[kind] };
  }
  return out;
};

const CINEMA = { name: 'Cinema', description: '4K with HDR and Dolby Vision at sensible sizes. Takes 1080p until a 4K copy turns up. Skips remuxes and full discs.' };
const EVERYDAY = { name: 'Everyday HD', description: 'Good 1080p copies from Blu-ray or streaming services.' };
const KIDS = { name: 'Kids & Cartoons', description: '720p is plenty for cartoons and saves space. Takes a small 1080p web copy when there’s no 720p.' };

export const PRESETS: Preset[] = [
  { key: 'cinema', kind: 'movie', build: () => fromTrash('radarr', 'UHD Bluray + WEB', ['HD Bluray + WEB'], ['Bluray-2160p', 'WEB 2160p', 'Bluray-1080p', 'WEB 1080p'], 'Bluray-2160p', CINEMA) },
  { key: 'everyday-hd', kind: 'movie', build: () => fromTrash('radarr', 'HD Bluray + WEB', [], ['Bluray-1080p', 'WEB 1080p', 'Bluray-720p'], 'Bluray-1080p', EVERYDAY) },
  { key: 'kids', kind: 'movie', build: () => fromTrash('radarr', 'HD Bluray + WEB', [], ['Bluray-720p', 'WEB 720p', 'WEB 1080p'], 'Bluray-720p', KIDS, kidsSizes('movie')) },
  { key: 'cinema', kind: 'tv', build: () => fromTrash('sonarr', 'WEB-2160p', ['WEB-1080p'], ['WEB 2160p', 'WEB 1080p'], 'WEB 2160p', CINEMA) },
  { key: 'everyday-hd', kind: 'tv', build: () => fromTrash('sonarr', 'WEB-1080p', [], ['WEB 1080p', 'Bluray-1080p'], 'WEB 1080p', EVERYDAY) },
  { key: 'kids', kind: 'tv', build: () => fromTrash('sonarr', 'WEB-1080p', [], ['WEB 720p', 'Bluray-720p', 'WEB 1080p'], 'WEB 720p', KIDS, kidsSizes('tv')) },
];

const SEEDED = 'profiles.seeded';
export const DEFAULT_KEYS = { movie: 'profiles.default.movie', tv: 'profiles.default.tv', kids: 'profiles.default.kids' } as const;
export type DefaultSlot = keyof typeof DEFAULT_KEYS;
const FALLBACK: Record<DefaultSlot, string> = { movie: 'cinema', tv: 'cinema', kids: 'kids' };

/** The profile new movies or shows get. */
export function defaultProfileKey(db: Db, kind: Kind): string {
  return getSetting(db, DEFAULT_KEYS[kind]) ?? FALLBACK[kind];
}

/** Adds the presets the first time Marquee runs. Deleting one later doesn't bring it back. */
export function seedProfiles(db: Db, now: number): void {
  if (getSetting(db, SEEDED)) return;
  db.transaction(() => {
    for (const p of PRESETS) {
      const exists = db.select({ id: schema.profiles.id }).from(schema.profiles).where(and(eq(schema.profiles.kind, p.kind), eq(schema.profiles.key, p.key))).get();
      if (!exists) insert(db, p.kind, p.key, p.key, p.build(), now);
    }
    setSetting(db, SEEDED, '1');
  });
}

function insert(db: Db, kind: Kind, key: string, preset: string | null, v: PresetValues, now: number): number {
  const row = db
    .insert(schema.profiles)
    .values({
      kind,
      key,
      name: v.name,
      description: v.description,
      preset,
      tiers: JSON.stringify(v.tiers),
      cutoff: v.cutoff,
      upgrades: v.upgrades,
      minScore: v.minScore,
      cutoffScore: v.cutoffScore,
      minUpgradeScore: v.minUpgradeScore,
      sizes: JSON.stringify(v.sizes),
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: schema.profiles.id })
    .get();
  writeRules(db, row.id, v.rules);
  return row.id;
}

function writeRules(db: Db, profileId: number, rules: ProfileRuleSetting[]): void {
  db.delete(schema.profileRules).where(eq(schema.profileRules.profileId, profileId)).run();
  for (const r of rules) db.insert(schema.profileRules).values({ profileId, trashId: r.trashId, enabled: r.enabled, score: r.score }).run();
}

// ---------------------------------------------------------------- service

export interface ProfilePatch {
  name?: string;
  description?: string;
  tiers?: Tier[];
  cutoff?: string;
  upgrades?: boolean;
  minScore?: number;
  cutoffScore?: number;
  minUpgradeScore?: number;
  sizes?: Record<string, SizeLimit>;
  rules?: ProfileRuleSetting[];
}

const notFound = () => new HttpError(404, 'not_found', 'No such profile.');

export class ProfileService {
  constructor(
    private db: Db,
    private now: () => number,
  ) {}

  list(kind?: Kind): (FullProfile & { titles: number })[] {
    const rows = this.db.select().from(schema.profiles).all().filter((r) => !kind || r.kind === kind);
    return rows
      .map((r) => ({ ...this.full(r), titles: this.usage(r.kind, r.key) }))
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.id - b.id);
  }

  get(id: number): FullProfile {
    const row = this.db.select().from(schema.profiles).where(eq(schema.profiles.id, id)).get();
    if (!row) throw notFound();
    return this.full(row);
  }

  /** The profile a title points at, or the library default if that one is gone. */
  forTitle(kind: Kind, key: string): FullProfile {
    const row =
      this.db.select().from(schema.profiles).where(and(eq(schema.profiles.kind, kind), eq(schema.profiles.key, key))).get() ??
      this.db.select().from(schema.profiles).where(and(eq(schema.profiles.kind, kind), eq(schema.profiles.key, this.defaults()[kind]))).get() ??
      this.db.select().from(schema.profiles).where(eq(schema.profiles.kind, kind)).get();
    if (!row) throw new HttpError(409, 'no_profiles', `There are no ${kind === 'movie' ? 'movie' : 'TV'} profiles. Add one in Settings → Quality.`);
    return this.full(row);
  }

  /** How many titles use a profile. */
  usage(kind: Kind, key: string): number {
    const table = kind === 'movie' ? schema.movies : schema.series;
    return this.db.select({ n: sql<number>`count(*)` }).from(table).where(eq(table.profile, key)).get()?.n ?? 0;
  }

  /** A new profile: a copy of `copyFrom`, TRaSH's profile `fromTrash` as TRaSH sets it up, or else a copy of the Everyday HD preset. */
  create(input: { kind: Kind; name: string; copyFrom?: number; fromTrash?: string }): FullProfile {
    let values: PresetValues;
    if (input.fromTrash !== undefined) {
      const app = appFor(input.kind);
      const tp = TRASH[app].profiles.find((x) => x.name === input.fromTrash);
      if (!tp) throw new HttpError(400, 'invalid_input', `TRaSH has no ${input.kind === 'movie' ? 'movie' : 'TV'} profile called "${input.fromTrash}".`);
      values = fromTrash(app, tp.name, [], tp.items.filter((i) => i.allowed).map((i) => i.name), tp.cutoff, { name: input.name, description: `Starts as TRaSH's ${tp.name}.` });
    } else if (input.copyFrom !== undefined) {
      const src = this.get(input.copyFrom);
      if (src.kind !== input.kind) throw new HttpError(400, 'invalid_input', `That profile is for ${src.kind === 'movie' ? 'movies' : 'TV'}; copy one made for ${input.kind === 'movie' ? 'movies' : 'TV'}.`);
      values = { ...src, name: input.name };
    } else {
      values = { ...PRESETS.find((p) => p.kind === input.kind && p.key === 'everyday-hd')!.build(), name: input.name, description: '' };
    }
    this.checkName(input.kind, input.name, null);
    const id = this.db.transaction(() => insert(this.db, input.kind, this.newKey(input.kind, input.name), null, values, this.now()));
    return this.get(id);
  }

  update(id: number, patch: ProfilePatch): FullProfile {
    const current = this.get(id);
    const next = { ...current, ...patch };
    if (patch.name !== undefined) this.checkName(current.kind, patch.name, id);
    this.validate(next);
    this.db.transaction(() => {
      this.db
        .update(schema.profiles)
        .set({
          name: next.name,
          description: next.description,
          tiers: JSON.stringify(next.tiers),
          cutoff: next.cutoff,
          upgrades: next.upgrades,
          minScore: next.minScore,
          cutoffScore: next.cutoffScore,
          minUpgradeScore: next.minUpgradeScore,
          sizes: JSON.stringify(next.sizes),
          updatedAt: this.now(),
        })
        .where(eq(schema.profiles.id, id))
        .run();
      if (patch.rules) writeRules(this.db, id, patch.rules);
    });
    return this.get(id);
  }

  /** Puts a preset back to TRaSH's values. Its name stays as you set it. */
  reset(id: number): FullProfile {
    const current = this.get(id);
    const preset = PRESETS.find((p) => p.kind === current.kind && p.key === current.preset);
    if (!preset) throw new HttpError(400, 'not_a_preset', 'Only the built-in profiles can be reset. This one started as a copy.');
    const v = preset.build();
    return this.update(id, { ...v, name: current.name });
  }

  remove(id: number): void {
    const p = this.get(id);
    const n = this.usage(p.kind, p.key);
    if (n > 0) throw new HttpError(409, 'in_use', `${n} ${n === 1 ? 'title uses' : 'titles use'} this profile. Move ${n === 1 ? 'it' : 'them'} to another profile first.`);
    const slots = (Object.keys(DEFAULT_KEYS) as DefaultSlot[]).filter((s) => slotKind(s) === p.kind && this.defaults()[s] === p.key);
    if (slots.length) throw new HttpError(409, 'is_default', `It's the default for ${slots.map(slotLabel).join(' and ')}. Pick another default first.`);
    this.db.delete(schema.profiles).where(eq(schema.profiles.id, id)).run();
  }

  /** The profile key new titles get, per library, and for kids' requests. */
  defaults(): Record<DefaultSlot, string> {
    return {
      movie: getSetting(this.db, DEFAULT_KEYS.movie) ?? FALLBACK.movie,
      tv: getSetting(this.db, DEFAULT_KEYS.tv) ?? FALLBACK.tv,
      kids: getSetting(this.db, DEFAULT_KEYS.kids) ?? FALLBACK.kids,
    };
  }

  setDefaults(input: Partial<Record<DefaultSlot, string>>): Record<DefaultSlot, string> {
    for (const [slot, key] of Object.entries(input) as [DefaultSlot, string][]) {
      const kinds: Kind[] = slot === 'kids' ? ['movie', 'tv'] : [slotKind(slot)];
      for (const kind of kinds) {
        const found = this.db.select({ id: schema.profiles.id }).from(schema.profiles).where(and(eq(schema.profiles.kind, kind), eq(schema.profiles.key, key))).get();
        if (!found) throw new HttpError(400, 'invalid_input', `There's no ${kind === 'movie' ? 'movie' : 'TV'} profile called "${key}".`);
      }
    }
    for (const [slot, key] of Object.entries(input) as [DefaultSlot, string][]) setSetting(this.db, DEFAULT_KEYS[slot], key);
    return this.defaults();
  }

  /** Assigns a profile to a movie or show. */
  assign(kind: Kind, titleId: number, key: string): void {
    const found = this.db.select({ id: schema.profiles.id }).from(schema.profiles).where(and(eq(schema.profiles.kind, kind), eq(schema.profiles.key, key))).get();
    if (!found) throw new HttpError(400, 'invalid_input', 'No such profile.');
    const table = kind === 'movie' ? schema.movies : schema.series;
    const res = this.db.update(table).set({ profile: key }).where(eq(table.id, titleId)).run();
    if (res.changes === 0) throw new HttpError(404, 'not_found', kind === 'movie' ? 'No such movie.' : 'No such show.');
  }

  // ---------------- helpers

  private full(row: typeof schema.profiles.$inferSelect): FullProfile {
    const rules = this.db.select().from(schema.profileRules).where(eq(schema.profileRules.profileId, row.id)).all();
    return {
      id: row.id,
      kind: row.kind,
      key: row.key,
      name: row.name,
      description: row.description,
      preset: row.preset,
      tiers: JSON.parse(row.tiers) as Tier[],
      cutoff: row.cutoff,
      upgrades: row.upgrades,
      minScore: row.minScore,
      cutoffScore: row.cutoffScore,
      minUpgradeScore: row.minUpgradeScore,
      sizes: JSON.parse(row.sizes) as Record<string, SizeLimit>,
      rules: rules.map((r) => ({ trashId: r.trashId, enabled: r.enabled, score: r.score })),
    };
  }

  private checkName(kind: Kind, name: string, exceptId: number | null): void {
    const clash = this.db.select().from(schema.profiles).all().find((p) => p.kind === kind && p.id !== exceptId && p.name.toLowerCase() === name.trim().toLowerCase());
    if (clash) throw new HttpError(409, 'name_taken', `There's already a ${kind === 'movie' ? 'movie' : 'TV'} profile called "${clash.name}".`);
  }

  private newKey(kind: Kind, name: string): string {
    const base = name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'profile';
    const taken = new Set(this.db.select({ key: schema.profiles.key }).from(schema.profiles).where(eq(schema.profiles.kind, kind)).all().map((r) => r.key));
    let key = base;
    for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
    return key;
  }

  private validate(p: FullProfile): void {
    const bad = (message: string) => new HttpError(400, 'invalid_input', message);
    const known = new Set(knownQualities(p.kind));
    const seen = new Set<string>();
    const names = new Set<string>();
    for (const t of p.tiers) {
      if (!t.name.trim()) throw bad('Every quality group needs a name.');
      if (names.has(t.name)) throw bad(`Two quality groups are called "${t.name}".`);
      names.add(t.name);
      if (!t.qualities.length) throw bad(`The group "${t.name}" has no qualities in it.`);
      for (const q of t.qualities) {
        if (!known.has(q)) throw bad(`"${q}" isn't a quality Marquee knows.`);
        if (seen.has(q)) throw bad(`"${q}" is in more than one group.`);
        seen.add(q);
      }
    }
    const missing = [...known].filter((q) => !seen.has(q));
    if (missing.length) throw bad(`Every quality needs a place in the list. Missing: ${missing.join(', ')}.`);
    if (!p.tiers.some((t) => t.allowed)) throw bad('Turn on at least one quality, or nothing will ever be picked.');
    const cutoff = p.tiers.find((t) => t.name === p.cutoff);
    if (!cutoff) throw bad('Pick which quality is good enough.');
    if (!cutoff.allowed) throw bad(`"Good enough" is set to ${cutoff.name}, which is turned off. Turn it on or pick another.`);
    for (const [q, s] of Object.entries(p.sizes)) {
      if (!known.has(q)) throw bad(`"${q}" isn't a quality Marquee knows.`);
      if (!(s.min >= 0 && s.min <= s.preferred && s.preferred <= s.max)) throw bad(`Sizes for ${qualityLabel(q)} must go smallest ≤ preferred ≤ largest.`);
    }
    const rules = new Set(TRASH[appFor(p.kind)].formats.map((f) => f.trash_id));
    const ruleSeen = new Set<string>();
    for (const r of p.rules) {
      if (!rules.has(r.trashId)) throw bad(`Rule ${r.trashId} isn't one Marquee knows.`);
      if (ruleSeen.has(r.trashId)) throw bad('A rule is listed twice.');
      ruleSeen.add(r.trashId);
    }
  }
}

const slotKind = (s: DefaultSlot): Kind => (s === 'tv' ? 'tv' : 'movie');
const slotLabel = (s: DefaultSlot): string => (s === 'movie' ? 'new movies' : s === 'tv' ? 'new shows' : "kids' requests");

// ---------------------------------------------------------------- rule lookup for screens

export interface RuleInfo {
  rule: Rule;
  label: string;
  explain: string;
  /** TRaSH's group, e.g. "[Unwanted] Unwanted Formats". */
  group: string | null;
  trashScore: number;
}

const ruleIndex = new Map<App, Map<string, RuleInfo>>();

/** Every TRaSH rule for an app, with its plain-English text and group. */
export function ruleInfo(kind: Kind): Map<string, RuleInfo> {
  const app = appFor(kind);
  let map = ruleIndex.get(app);
  if (map) return map;
  map = new Map();
  const data = TRASH[app];
  for (const rule of data.formats) {
    const group = data.groups.find((g) => g.custom_formats.some((cf) => cf.trash_id === rule.trash_id))?.name ?? null;
    const e = explain(rule.name);
    map.set(rule.trash_id, { rule, label: e?.label ?? rule.name, explain: e?.explain ?? '', group, trashScore: rule.trash_scores?.default ?? 0 });
  }
  ruleIndex.set(app, map);
  return map;
}

/** TRaSH's own profiles a new one can start from. */
export function trashProfiles(): { kind: Kind; name: string; description: string }[] {
  return (['movie', 'tv'] as Kind[]).flatMap((kind) => TRASH[appFor(kind)].profiles.map((p) => ({ kind, name: p.name, description: p.trash_description.replace(/<[^>]+>/g, '').trim() })));
}
