import { and, eq, sql } from 'drizzle-orm';
import { getSetting, setSetting, schema, type Db } from '../db/index.js';
import { HttpError } from '../http.js';
import { DICTIONARRY_SHIPPED, dictionarry, rulesFor, shippedRules, type RuleDatabase, type RuleInfo } from './catalog.js';
import type { DictionarryData } from './dictionarry.js';
import { TRASH, defaultRules, optionalRules, type App, type TrashProfile } from './formats.js';

export type { RuleInfo } from './catalog.js';

/**
 * Profiles: what a title wants. Which qualities it accepts and in what order,
 * which rules add or take away points, size limits, and when a copy is "good
 * enough". Stored in the database and editable. Rules come from Dictionarry
 * (the default) or TRaSH, plus your own; the three presets are built on
 * Dictionarry's space-saving profiles and can be put back to them.
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
  /** The rule's id: TRaSH's hex id, "dict:<name>" or "own:<id>". */
  trashId: string;
  enabled: boolean;
  score: number;
  /** A rule update changed its points while you'd changed them too: their new points (you kept yours). */
  upstreamScore?: number | null;
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
  /** Only the qualities you've changed; the rest use the database's sizes (see `sizeLimit`). */
  sizes: Record<string, SizeLimit>;
  rules: ProfileRuleSetting[];
  /** Where its rules and sizes come from. Missing means TRaSH (profiles saved before Dictionarry). */
  database?: RuleDatabase;
  /** The database's profile it follows for rule updates. */
  base?: string | null;
  /** Rank a proper or repack above others of the same quality, before points (as Radarr's "prefer"). Missing means yes. */
  preferRepacks?: boolean;
  /** Every rule it can score, with your own. Missing means the shipped rules. */
  defs?: Map<string, RuleInfo>;
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

/** The database's sizes for each quality. Dictionarry sets none (its rules judge size), so those are "no limit". */
export function databaseSizes(database: RuleDatabase, kind: Kind): { quality: string; min: number; preferred: number; max: number }[] {
  const app = appFor(kind);
  if (database === 'trash') return TRASH[app].sizes;
  const top = NO_LIMIT[app];
  return DICTIONARRY_SHIPPED[app].sizes.map((s) => ({ quality: s.quality, min: s.min, preferred: Math.min(s.preferred, top), max: s.max > 0 ? Math.min(s.max, top) : top }));
}

/** The size limit for a quality: yours if you changed it, else the database's, else none. */
export function sizeLimit(profile: FullProfile, quality: string): (SizeLimit & { unlimited: boolean }) | null {
  const app = appFor(profile.kind);
  const limit = profile.sizes[quality] ?? databaseSizes(profile.database ?? 'trash', profile.kind).find((s) => s.quality === quality) ?? null;
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
  database: RuleDatabase;
  base: string | null;
  preferRepacks: boolean;
}

interface Preset {
  key: string;
  kind: Kind;
  /** Builds it from the Dictionarry version in use (pass null for the shipped one). */
  build: (db?: Db | null) => PresetValues;
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

export function fromTrash(app: App, base: string, extra: string[], allowed: string[], cutoff: string, text: { name: string; description: string }, sizes: Record<string, SizeLimit> = {}): PresetValues {
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
    database: 'trash',
    base,
    preferRepacks: true,
  };
}

/** Dictionarry's quality list, kept to the qualities Marquee knows, with any it leaves out added (off) at the end. */
function dictTiers(kind: Kind, tiers: Tier[]): Tier[] {
  const known = knownQualities(kind);
  const out = tiers.map((t) => ({ ...t, qualities: t.qualities.filter((q) => known.includes(q)) })).filter((t) => t.qualities.length);
  const placed = new Set(out.flatMap((t) => t.qualities));
  for (const q of known) if (!placed.has(q)) out.push({ name: q, qualities: [q], allowed: false });
  return out;
}

export function dictProfile(data: DictionarryData, name: string) {
  const p = data.profiles.find((x) => x.name === name);
  if (!p) throw new HttpError(400, 'invalid_input', `Dictionarry has no profile called "${name}".`);
  return p;
}

/** A Dictionarry profile as Marquee stores it: its qualities, every rule it scores with its points, and its point limits. */
export function fromDictionarry(data: DictionarryData, kind: Kind, base: string, text: { name: string; description: string }): PresetValues {
  const p = dictProfile(data, base);
  return {
    ...text,
    tiers: dictTiers(kind, p.tiers),
    cutoff: p.cutoff,
    upgrades: p.upgrades,
    minScore: p.minScore,
    cutoffScore: p.cutoffScore,
    minUpgradeScore: p.minUpgradeScore,
    sizes: {},
    rules: Object.entries(p.scores).map(([trashId, score]) => ({ trashId, enabled: true, score })),
    database: 'dictionarry',
    base,
    preferRepacks: data.preferRepacks,
  };
}

/** Which Dictionarry profile each preset is built on. All three favour small x265 encodes that keep the picture. */
export const PRESET_BASES: Record<string, string> = { cinema: '2160p Efficient', 'everyday-hd': '1080p Efficient', kids: '1080p Compact' };

const CINEMA = {
  name: '4K Quality',
  description: '4K with HDR from streaming services at sensible sizes (about 15–30 GB a movie). Takes a small, high-quality 1080p encode until a 4K copy turns up. Never remuxes or full discs. Built on Dictionarry’s 2160p Efficient.',
};
const EVERYDAY = {
  name: 'Everyday HD',
  description: 'Small 1080p x265 encodes from groups Dictionarry trusts to keep the picture (about 6–12 GB a movie, 2–3 GB an episode). Built on Dictionarry’s 1080p Efficient.',
};
const KIDS = {
  name: 'Kids & Cartoons',
  description: 'Very small 1080p x265 encodes (about 3–6 GB a movie, 1–2 GB an episode); cartoons squeeze well, so they still look sharp. Falls back to 720p and DVD for older ones. Built on Dictionarry’s 1080p Compact.',
};
const TEXT: Record<string, { name: string; description: string }> = { cinema: CINEMA, 'everyday-hd': EVERYDAY, kids: KIDS };

const preset = (key: string, kind: Kind): Preset => ({ key, kind, build: (db) => fromDictionarry(dictionarry(db ?? null, appFor(kind)), kind, PRESET_BASES[key]!, TEXT[key]!) });

export const PRESETS: Preset[] = [preset('cinema', 'movie'), preset('everyday-hd', 'movie'), preset('kids', 'movie'), preset('cinema', 'tv'), preset('everyday-hd', 'tv'), preset('kids', 'tv')];

const SEEDED = 'profiles.seeded';
const RENAMED_4K = 'profiles.renamed_4k';
const KIDS_TV_1080 = 'profiles.kids_tv_1080';
const DICT_REBASED = 'profiles.dictionarry_rebased';
/** What the one-time move to Dictionarry did, shown once on the Quality page. */
export const DICT_NOTICE = 'profiles.dictionarry_notice';
export const DEFAULT_KEYS = { movie: 'profiles.default.movie', tv: 'profiles.default.tv', kids: 'profiles.default.kids' } as const;
export type DefaultSlot = keyof typeof DEFAULT_KEYS;
const FALLBACK: Record<DefaultSlot, string> = { movie: 'cinema', tv: 'cinema', kids: 'kids' };

/** The profile new movies or shows get. */
export function defaultProfileKey(db: Db, kind: Kind): string {
  return getSetting(db, DEFAULT_KEYS[kind]) ?? FALLBACK[kind];
}

export interface DictionarryNotice {
  /** Built-in profiles moved to Dictionarry (you'd never changed them). */
  changed: { kind: Kind; name: string }[];
  /** Built-in profiles you'd changed, left on TRaSH. */
  kept: { kind: Kind; name: string }[];
}

/** Adds the presets the first time Marquee runs. Deleting one later doesn't bring it back. */
export function seedProfiles(db: Db, now: number): void {
  // The Cinema preset is now called 4K Quality; rename it once unless you've renamed it yourself.
  if (!getSetting(db, RENAMED_4K)) {
    db.update(schema.profiles).set({ name: CINEMA.name }).where(and(eq(schema.profiles.preset, 'cinema'), eq(schema.profiles.name, 'Cinema'))).run();
    setSetting(db, RENAMED_4K, '1');
  }
  // Kids & Cartoons for TV once moved to 1080p on TRaSH; the move to Dictionarry below covers it now.
  if (!getSetting(db, KIDS_TV_1080)) setSetting(db, KIDS_TV_1080, '1');
  if (!getSetting(db, SEEDED)) {
    db.transaction(() => {
      for (const p of PRESETS) {
        const exists = db.select({ id: schema.profiles.id }).from(schema.profiles).where(and(eq(schema.profiles.kind, p.kind), eq(schema.profiles.key, p.key))).get();
        if (!exists) insert(db, p.kind, p.key, p.key, p.build(db), now);
      }
      setSetting(db, SEEDED, '1');
    });
  }
  // Once: built-in profiles still on TRaSH move to Dictionarry, unless you've changed them. The Quality page says which.
  if (!getSetting(db, DICT_REBASED)) {
    const notice: DictionarryNotice = { changed: [], kept: [] };
    db.transaction(() => {
      for (const row of db.select().from(schema.profiles).where(eq(schema.profiles.database, 'trash')).all()) {
        const p = PRESETS.find((x) => x.kind === row.kind && x.key === row.preset);
        if (!p) continue;
        if (row.updatedAt !== row.createdAt) {
          notice.kept.push({ kind: row.kind, name: row.name });
          continue;
        }
        const v = p.build(db);
        db.update(schema.profiles)
          .set({
            name: v.name,
            description: v.description,
            tiers: JSON.stringify(v.tiers),
            cutoff: v.cutoff,
            upgrades: v.upgrades,
            minScore: v.minScore,
            cutoffScore: v.cutoffScore,
            minUpgradeScore: v.minUpgradeScore,
            sizes: JSON.stringify(v.sizes),
            database: v.database,
            base: v.base,
            preferRepacks: v.preferRepacks,
          })
          .where(eq(schema.profiles.id, row.id))
          .run();
        writeRules(db, row.id, v.rules);
        notice.changed.push({ kind: row.kind, name: v.name });
      }
      if (notice.changed.length || notice.kept.length) setSetting(db, DICT_NOTICE, JSON.stringify(notice));
      setSetting(db, DICT_REBASED, '1');
    });
  }
}

export function dictionarryNotice(db: Db): DictionarryNotice | null {
  const raw = getSetting(db, DICT_NOTICE);
  return raw ? (JSON.parse(raw) as DictionarryNotice) : null;
}

export function dismissDictionarryNotice(db: Db): void {
  setSetting(db, DICT_NOTICE, '');
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
      database: v.database,
      base: v.base,
      preferRepacks: v.preferRepacks,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: schema.profiles.id })
    .get();
  writeRules(db, row.id, v.rules);
  return row.id;
}

/** Saves a profile's rules. A rule-update conflict note stays until you change that rule's points. */
export function writeRules(db: Db, profileId: number, rules: ProfileRuleSetting[]): void {
  const before = new Map(db.select().from(schema.profileRules).where(eq(schema.profileRules.profileId, profileId)).all().map((r) => [r.trashId, r]));
  db.delete(schema.profileRules).where(eq(schema.profileRules.profileId, profileId)).run();
  for (const r of rules) {
    const old = before.get(r.trashId);
    const upstreamScore = r.upstreamScore !== undefined ? r.upstreamScore : old && old.score === r.score ? old.upstreamScore : null;
    db.insert(schema.profileRules).values({ profileId, trashId: r.trashId, enabled: r.enabled, score: r.score, upstreamScore }).run();
  }
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
  preferRepacks?: boolean;
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

  /**
   * A new profile: a copy of `copyFrom`, Dictionarry's profile `fromDictionarry`
   * or TRaSH's profile `fromTrash` as they set it up, or else a copy of the Everyday HD preset.
   */
  create(input: { kind: Kind; name: string; copyFrom?: number; fromTrash?: string; fromDictionarry?: string }): FullProfile {
    let values: PresetValues;
    if (input.fromDictionarry !== undefined) {
      const data = dictionarry(this.db, appFor(input.kind));
      values = fromDictionarry(data, input.kind, input.fromDictionarry, { name: input.name, description: `Starts as Dictionarry’s ${input.fromDictionarry}.` });
    } else if (input.fromTrash !== undefined) {
      const app = appFor(input.kind);
      const tp = TRASH[app].profiles.find((x) => x.name === input.fromTrash);
      if (!tp) throw new HttpError(400, 'invalid_input', `TRaSH has no ${input.kind === 'movie' ? 'movie' : 'TV'} profile called "${input.fromTrash}".`);
      values = fromTrash(app, tp.name, [], tp.items.filter((i) => i.allowed).map((i) => i.name), tp.cutoff, { name: input.name, description: `Starts as TRaSH's ${tp.name}.` });
    } else if (input.copyFrom !== undefined) {
      const src = this.get(input.copyFrom);
      if (src.kind !== input.kind) throw new HttpError(400, 'invalid_input', `That profile is for ${src.kind === 'movie' ? 'movies' : 'TV'}; copy one made for ${input.kind === 'movie' ? 'movies' : 'TV'}.`);
      values = { ...src, name: input.name, database: src.database ?? 'trash', base: src.base ?? null, preferRepacks: src.preferRepacks ?? true };
    } else {
      values = { ...PRESETS.find((p) => p.kind === input.kind && p.key === 'everyday-hd')!.build(this.db), name: input.name, description: '' };
    }
    this.checkName(input.kind, input.name, null);
    const id = this.db.transaction(() => insert(this.db, input.kind, this.newKey(input.kind, input.name), null, values, this.now()));
    return this.get(id);
  }

  update(id: number, patch: ProfilePatch): FullProfile {
    const current = this.get(id);
    // A rule its database no longer has (a rule update dropped it) is quietly left out rather than refused.
    const known = rulesFor(this.db, current.kind);
    const had = new Set(current.rules.map((r) => r.trashId));
    const rules = (patch.rules ?? current.rules).filter((r) => known.has(r.trashId) || !had.has(r.trashId));
    if (patch.rules || rules.length !== current.rules.length) patch = { ...patch, rules };
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
          preferRepacks: next.preferRepacks ?? true,
          updatedAt: this.now(),
        })
        .where(eq(schema.profiles.id, id))
        .run();
      if (patch.rules) writeRules(this.db, id, patch.rules);
    });
    return this.get(id);
  }

  /** Puts a preset back to its database's values (Dictionarry's now, even if it was on TRaSH). Its name stays as you set it. */
  reset(id: number): FullProfile {
    const current = this.get(id);
    const preset = PRESETS.find((p) => p.kind === current.kind && p.key === current.preset);
    if (!preset) throw new HttpError(400, 'not_a_preset', 'Only the built-in profiles can be reset. This one started as a copy.');
    const v = preset.build(this.db);
    this.db.update(schema.profiles).set({ database: v.database, base: v.base }).where(eq(schema.profiles.id, id)).run();
    return this.update(id, { ...v, rules: v.rules.map((r) => ({ ...r, upstreamScore: null })), name: current.name });
  }

  /** Settles a rule-update conflict on one rule: take the database's new points, or keep yours. */
  settle(id: number, trashId: string, use: 'theirs' | 'mine'): FullProfile {
    const p = this.get(id);
    const rule = p.rules.find((r) => r.trashId === trashId);
    if (!rule || rule.upstreamScore === null || rule.upstreamScore === undefined) throw new HttpError(404, 'not_found', 'That rule has nothing to settle.');
    return this.update(id, { rules: p.rules.map((r) => (r.trashId === trashId ? { ...r, score: use === 'theirs' ? rule.upstreamScore! : r.score, upstreamScore: null } : r)) });
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
    // Picked by hand: the profile rules never change it after this.
    const res = this.db.update(table).set({ profile: key, profileByHand: true }).where(eq(table.id, titleId)).run();
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
      rules: rules.map((r) => ({ trashId: r.trashId, enabled: r.enabled, score: r.score, upstreamScore: r.upstreamScore })),
      database: row.database,
      base: row.base,
      preferRepacks: row.preferRepacks,
      defs: rulesFor(this.db, row.kind),
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
    const rules = rulesFor(this.db, p.kind);
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

/** The shipped rules (TRaSH's and Dictionarry's), for when there's no database to hand. */
export function ruleInfo(kind: Kind): Map<string, RuleInfo> {
  return shippedRules(kind);
}

/** The database's own points for a rule in this profile: what "put back" would give it. Null for your own rules. */
export function upstreamScore(db: Db | null, profile: FullProfile, trashId: string): number | null {
  if (trashId.startsWith('own:')) return null;
  if ((profile.database ?? 'trash') === 'dictionarry') {
    const base = profile.base ? dictionarry(db, appFor(profile.kind)).profiles.find((p) => p.name === profile.base) : undefined;
    return base?.scores[trashId] ?? 0;
  }
  return (profile.defs ?? shippedRules(profile.kind)).get(trashId)?.trashScore ?? 0;
}

/** The databases' own profiles a new one can start from. */
export function databaseProfiles(db: Db | null): { database: RuleDatabase; kind: Kind; name: string; description: string }[] {
  const out: { database: RuleDatabase; kind: Kind; name: string; description: string }[] = [];
  for (const kind of ['movie', 'tv'] as Kind[]) {
    for (const p of dictionarry(db, appFor(kind)).profiles) out.push({ database: 'dictionarry', kind, name: p.name, description: plain(p.description) });
    for (const p of TRASH[appFor(kind)].profiles) out.push({ database: 'trash', kind, name: p.name, description: plain(p.trash_description) });
  }
  return out;
}

/** Dictionarry's and TRaSH's descriptions carry HTML and Markdown; screens want plain text. */
const plain = (s: string) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s*\n\s*-\s*/g, ' · ')
    .replace(/\s+/g, ' ')
    .trim();
