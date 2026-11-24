import Database from 'better-sqlite3';
import { gunzipSync } from 'fflate';
import type { App, Rule, Spec } from './formats.js';

/**
 * Dictionarry (github.com/Dictionarry-Hub/database), the rules and profiles
 * Profilarr uses. Its "v2" database is a list of SQL steps on top of a schema
 * (github.com/Dictionarry-Hub/schema). This replays them into a throwaway
 * SQLite database and turns what comes out into Marquee's rule shape: the same
 * tests Radarr and Sonarr run (see formats.ts), so a rule means the same here.
 *
 * Used by `pnpm dictionarry:update` (the copy pinned in src/releases/dictionarry/)
 * and by the weekly check for updates in the app.
 */

export const DICTIONARRY_REPO = 'Dictionarry-Hub/database';
export const DICTIONARRY_BRANCH = 'v2';
export const SCHEMA_REPO = 'Dictionarry-Hub/schema';

/** Rule ids carry the database, so a Dictionarry rule and a TRaSH one never clash. */
export const dictId = (name: string) => `dict:${name}`;

export interface DictTier {
  name: string;
  /** Quality names in the app's own words ("Bluray-1080p Remux" for Sonarr). */
  qualities: string[];
  allowed: boolean;
}

export interface DictProfile {
  name: string;
  description: string;
  upgrades: boolean;
  minScore: number;
  cutoffScore: number;
  minUpgradeScore: number;
  /** Best first, as Dictionarry orders them. */
  tiers: DictTier[];
  /** The tier upgrades stop at. */
  cutoff: string;
  /** Rule id → points, for every rule the profile scores. */
  scores: Record<string, number>;
}

/** A rule with Dictionarry's own words about it. */
export interface DictRule extends Rule {
  description: string;
  tags: string[];
}

export interface DictionarryData {
  source: string;
  commit: string;
  fetchedAt: string;
  /** Dictionarry sets "don't prefer propers and repacks": its Repack rules give the points instead. */
  preferRepacks: boolean;
  profiles: DictProfile[];
  formats: DictRule[];
  /** MB per minute; max 0 means no limit. */
  sizes: { quality: string; min: number; preferred: number; max: number }[];
  /** Tests Marquee can't check, as "Rule: what" lines. Such a test never counts as a match. */
  unmapped: string[];
}

// ---------------------------------------------------------------- mapping Dictionarry's words to Radarr/Sonarr's numbers

/** Radarr's Source enum and Sonarr's QualitySource enum. */
const SOURCE: Record<App, Record<string, number>> = {
  radarr: { cam: 1, telesync: 2, telecine: 3, workprint: 4, dvd: 5, television: 6, web_dl: 7, webrip: 8, bluray: 9, bluray_raw: 9 },
  sonarr: { television: 1, television_raw: 2, web_dl: 3, webrip: 4, dvd: 5, bluray: 6, bluray_raw: 7 },
};
const MODIFIER: Record<string, number> = { regional: 1, screener: 2, rawhd: 3, brdisk: 4, remux: 5 };
/** Radarr's language ids for the names Dictionarry uses; "Original" is the title's own language. */
const LANGUAGE: Record<string, number> = { Original: -2, English: 1, French: 2, Spanish: 3, German: 4, Italian: 5, Danish: 6, Dutch: 7, Japanese: 8, Chinese: 10, Russian: 11, Polish: 12, Turkish: 17, Portuguese: 18, Korean: 21, Czech: 25, Hindi: 26 };
/** Radarr's IndexerFlags. Marquee only learns "freeleech" from a Source; the others never match. */
const FLAG: Record<string, number> = { freeleech: 1, halfleech: 2, double_upload: 4, ptp_golden: 8, ptp_approved: 16, internal: 32, scene: 128, freeleech_75: 256, freeleech_25: 512, nuked: 2048 };
const RELEASE_TYPE: Record<string, number> = { single_episode: 1, multi_episode: 2, season_pack: 3 };

type Row = Record<string, any>;

/** Replays the schema and database steps, in number order, into a database in memory. */
export function replay(schemaOps: [string, string][], dbOps: [string, string][]): Database.Database {
  const db = new Database(':memory:');
  const byNumber = (a: [string, string], b: [string, string]) => parseInt(a[0], 10) - parseInt(b[0], 10) || a[0].localeCompare(b[0]);
  for (const [file, sql] of [...[...schemaOps].sort(byNumber), ...[...dbOps].sort(byNumber)]) {
    try {
      db.exec(sql);
    } catch (err) {
      db.close();
      throw new Error(`Dictionarry step ${file} didn't apply: ${(err as Error).message}`);
    }
  }
  return db;
}

/** Turns a replayed Dictionarry database into Marquee's rules and profiles for one app. */
export function convert(db: Database.Database, app: App, meta: { source: string; commit: string; fetchedAt: string }): DictionarryData {
  const all = (sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as Row[];
  const forApp = (arrType: string) => arrType === 'all' || arrType === app;
  const unmapped: string[] = [];

  const pattern = new Map(all('SELECT name, pattern FROM regular_expressions').map((r) => [r.name as string, r.pattern as string]));
  const keyed = (table: string) => new Map(all(`SELECT * FROM ${table}`).map((r) => [`${r.custom_format_name}\u0000${r.condition_name}`, r]));
  const patterns = keyed('condition_patterns');
  const languages = keyed('condition_languages');
  const flags = keyed('condition_indexer_flags');
  const sources = keyed('condition_sources');
  const resolutions = keyed('condition_resolutions');
  const modifiers = keyed('condition_quality_modifiers');
  const sizes = keyed('condition_sizes');
  const types = keyed('condition_release_types');
  const years = keyed('condition_years');
  const tags = new Map<string, string[]>();
  for (const r of all('SELECT custom_format_name, tag_name FROM custom_format_tags ORDER BY tag_name')) tags.set(r.custom_format_name, [...(tags.get(r.custom_format_name) ?? []), r.tag_name]);

  const conditions = new Map<string, Row[]>();
  for (const c of all('SELECT * FROM custom_format_conditions ORDER BY custom_format_name, id')) {
    if (!forApp(c.arr_type)) continue;
    conditions.set(c.custom_format_name, [...(conditions.get(c.custom_format_name) ?? []), c]);
  }

  const spec = (cf: string, c: Row): Spec => {
    const key = `${cf}\u0000${c.name}`;
    const base = { name: c.name as string, negate: c.negate === 1, required: c.required === 1 };
    const unknown = (what: string): Spec => {
      unmapped.push(`${cf}: ${what}`);
      return { ...base, implementation: `Unsupported:${c.type}`, fields: {} };
    };
    switch (c.type) {
      case 'release_title':
      case 'release_group': {
        const p = pattern.get(patterns.get(key)?.regular_expression_name);
        if (p === undefined) return unknown(`"${c.name}" points at a pattern that isn't there`);
        return { ...base, implementation: c.type === 'release_title' ? 'ReleaseTitleSpecification' : 'ReleaseGroupSpecification', fields: { value: p } };
      }
      case 'resolution': {
        const r = Number.parseInt(String(resolutions.get(key)?.resolution ?? ''), 10);
        return Number.isFinite(r) ? { ...base, implementation: 'ResolutionSpecification', fields: { value: r } } : unknown(`resolution "${c.name}"`);
      }
      case 'source': {
        const s = sources.get(key)?.source as string | undefined;
        const v = s ? SOURCE[app][s] : undefined;
        return v !== undefined ? { ...base, implementation: 'SourceSpecification', fields: { value: v } } : unknown(`source "${s}" (${app})`);
      }
      case 'quality_modifier': {
        const m = modifiers.get(key)?.quality_modifier as string | undefined;
        // Sonarr has no quality modifiers; Dictionarry only sets these for Radarr.
        return m && MODIFIER[m] !== undefined ? { ...base, implementation: 'QualityModifierSpecification', fields: { value: MODIFIER[m] } } : unknown(`quality modifier "${m}"`);
      }
      case 'language': {
        const l = languages.get(key);
        const v = l ? LANGUAGE[l.language_name as string] : undefined;
        return v !== undefined ? { ...base, implementation: 'LanguageSpecification', fields: { value: v, exceptLanguage: l!.except_language === 1 } } : unknown(`language "${l?.language_name}"`);
      }
      case 'indexer_flag': {
        const f = flags.get(key)?.flag as string | undefined;
        return f && FLAG[f] !== undefined ? { ...base, implementation: 'IndexerFlagSpecification', fields: { value: FLAG[f] } } : unknown(`site flag "${f}"`);
      }
      case 'size': {
        const s = sizes.get(key);
        const gb = (b: number | null) => (b === null || b === undefined ? undefined : b / 1024 ** 3);
        return s ? { ...base, implementation: 'SizeSpecification', fields: { min: gb(s.min_bytes) ?? 0, max: gb(s.max_bytes) ?? Number.MAX_SAFE_INTEGER } } : unknown('size');
      }
      case 'release_type': {
        const t = types.get(key)?.release_type as string | undefined;
        return t && RELEASE_TYPE[t] !== undefined ? { ...base, implementation: 'ReleaseTypeSpecification', fields: { value: RELEASE_TYPE[t] } } : unknown(`release type "${t}"`);
      }
      case 'year': {
        const y = years.get(key);
        return y ? { ...base, implementation: 'YearSpecification', fields: { min: y.min_year ?? 0, max: y.max_year ?? 9999 } } : unknown('year');
      }
      default:
        return unknown(`a "${c.type}" test`);
    }
  };

  const formats: DictRule[] = [];
  for (const cf of all('SELECT name, description FROM custom_formats ORDER BY name')) {
    const conds = conditions.get(cf.name);
    // A rule with no tests for this app (e.g. Radarr-only) doesn't exist here.
    if (!conds?.length) continue;
    formats.push({ trash_id: dictId(cf.name), name: cf.name, description: String(cf.description ?? '').trim(), tags: tags.get(cf.name) ?? [], specifications: conds.map((c) => spec(cf.name, c)) });
  }
  const known = new Set(formats.map((f) => f.trash_id));

  // Quality names in this app's words; a quality the app doesn't have is left out.
  const apiName = new Map(all('SELECT quality_name, api_name FROM quality_api_mappings WHERE arr_type = ?', app).map((r) => [r.quality_name as string, r.api_name as string]));
  const members = new Map<string, string[]>();
  for (const m of all('SELECT quality_profile_name, quality_group_name, quality_name FROM quality_group_members')) {
    const k = `${m.quality_profile_name}\u0000${m.quality_group_name}`;
    const n = apiName.get(m.quality_name);
    if (n) members.set(k, [...(members.get(k) ?? []), n]);
  }

  const profiles: DictProfile[] = all('SELECT * FROM quality_profiles ORDER BY name').map((p) => {
    const tiers: DictTier[] = [];
    let cutoff = '';
    for (const q of all('SELECT * FROM quality_profile_qualities WHERE quality_profile_name = ? ORDER BY position', p.name)) {
      const name: string = q.quality_group_name ?? apiName.get(q.quality_name) ?? '';
      const qualities = q.quality_group_name ? (members.get(`${p.name}\u0000${q.quality_group_name}`) ?? []) : apiName.has(q.quality_name) ? [apiName.get(q.quality_name)!] : [];
      if (!name || !qualities.length) continue;
      tiers.push({ name, qualities: sortQualities(qualities), allowed: q.enabled === 1 });
      if (q.upgrade_until === 1) cutoff = name;
    }
    const scores: Record<string, number> = {};
    // App-specific points win over "all".
    for (const s of all("SELECT * FROM quality_profile_custom_formats WHERE quality_profile_name = ? ORDER BY arr_type = 'all' DESC", p.name)) {
      if (!forApp(s.arr_type)) continue;
      const id = dictId(s.custom_format_name);
      if (known.has(id)) scores[id] = s.score;
    }
    return {
      name: p.name,
      description: String(p.description ?? '').trim(),
      upgrades: p.upgrades_allowed === 1,
      minScore: p.minimum_custom_format_score,
      cutoffScore: p.upgrade_until_score,
      minUpgradeScore: p.upgrade_score_increment,
      tiers,
      cutoff: cutoff || tiers.find((t) => t.allowed)?.name || '',
      scores,
    };
  });

  const defs = all(`SELECT quality_name, min_size, preferred_size, max_size FROM ${app}_quality_definitions ORDER BY quality_name`);
  const media = all(`SELECT propers_repacks FROM ${app}_media_settings LIMIT 1`)[0];
  return {
    ...meta,
    preferRepacks: media ? media.propers_repacks !== 'doNotPrefer' : false,
    profiles,
    formats,
    sizes: defs.flatMap((d) => (apiName.has(d.quality_name) ? [{ quality: apiName.get(d.quality_name)!, min: d.min_size, preferred: d.preferred_size, max: d.max_size }] : [])),
    unmapped: [...new Set(unmapped)].sort(),
  };
}

/** Best quality first, so a group reads "Bluray-2160p, WEBDL-2160p, … DVD". */
function sortQualities(qs: string[]): string[] {
  const res = (q: string) => Number(q.match(/(\d{3,4})p/)?.[1] ?? (/DVD|SDTV/.test(q) ? 480 : 0));
  const src = (q: string) => ['Remux', 'Bluray', 'WEBDL', 'WEBRip', 'HDTV', 'DVD', 'SDTV'].findIndex((s) => q.includes(s));
  return [...qs].sort((a, b) => res(b) - res(a) || src(a) - src(b) || a.localeCompare(b));
}

// ---------------------------------------------------------------- downloading

/** Reads a .tar.gz into { path → text }, keeping only files under `prefix` ending in `.sql` or `.json`. */
export function untar(gz: Uint8Array): Map<string, string> {
  const tar = gunzipSync(gz);
  const out = new Map<string, string>();
  const text = (from: number, len: number) => new TextDecoder().decode(tar.subarray(from, from + len)).replace(/\0.*$/s, '');
  let longName: string | null = null;
  for (let at = 0; at + 512 <= tar.length; ) {
    const name = text(at, 100);
    if (!name) break;
    const size = Number.parseInt(text(at + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(tar[at + 156] ?? 48);
    const prefix = text(at + 345, 155);
    const body = at + 512;
    if (type === 'L') longName = text(body, size);
    else if (type === '0' || type === '\0') {
      const full = longName ?? (prefix ? `${prefix}/${name}` : name);
      // GitHub's tarballs put everything under "<owner>-<repo>-<sha>/".
      const path = full.split('/').slice(1).join('/');
      if (/\.(sql|json)$/.test(path)) out.set(path, new TextDecoder().decode(tar.subarray(body, body + size)));
      longName = null;
    } else if (type !== 'g' && type !== 'x') longName = null;
    at = body + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** The SQL steps in a folder of an unpacked repository, as [file, sql]. */
export function opsIn(files: Map<string, string>, folder = 'ops'): [string, string][] {
  return [...files].filter(([p]) => p.startsWith(`${folder}/`) && p.endsWith('.sql')).map(([p, sql]) => [p.slice(folder.length + 1), sql]);
}

export interface DictionarryFetch {
  /** The newest commit on Dictionarry's v2 branch. */
  latest(): Promise<string>;
  /** The repository at a commit, as a .tar.gz. */
  tarball(repo: string, ref: string): Promise<Uint8Array>;
}

/** Talks to GitHub. Two small requests and two downloads; no account needed. */
export function githubFetch(fetchImpl: typeof fetch = fetch): DictionarryFetch {
  const headers = { 'User-Agent': 'marquee', Accept: 'application/vnd.github+json' };
  return {
    async latest() {
      const res = await fetchImpl(`https://api.github.com/repos/${DICTIONARRY_REPO}/commits/${DICTIONARRY_BRANCH}`, { headers, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`GitHub answered ${res.status} when asked for Dictionarry's newest version.`);
      return String(((await res.json()) as { sha: string }).sha);
    },
    async tarball(repo, ref) {
      const res = await fetchImpl(`https://codeload.github.com/${repo}/tar.gz/${ref}`, { headers: { 'User-Agent': 'marquee' }, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`GitHub answered ${res.status} when downloading ${repo}.`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

/** Downloads Dictionarry at a commit (and the schema version it asks for) and builds Marquee's copy of it. */
export async function downloadDictionarry(fetcher: DictionarryFetch, commit?: string, now = new Date()): Promise<Record<App, DictionarryData>> {
  const sha = commit ?? (await fetcher.latest());
  const db = untar(await fetcher.tarball(DICTIONARRY_REPO, sha));
  const manifest = JSON.parse(db.get('pcd.json') ?? '{}') as { dependencies?: Record<string, string> };
  const schemaVersion = Object.entries(manifest.dependencies ?? {}).find(([k]) => k.toLowerCase().includes('dictionarry-hub/schema'))?.[1] ?? 'main';
  const schema = untar(await fetcher.tarball(SCHEMA_REPO, schemaVersion));
  return buildDictionarry(opsIn(schema), opsIn(db), { commit: sha, fetchedAt: now.toISOString().slice(0, 10) });
}

export function buildDictionarry(schemaOps: [string, string][], dbOps: [string, string][], meta: { commit: string; fetchedAt: string }): Record<App, DictionarryData> {
  const db = replay(schemaOps, dbOps);
  try {
    const source = `https://github.com/${DICTIONARRY_REPO}/tree/${meta.commit}`;
    return { radarr: convert(db, 'radarr', { source, ...meta }), sonarr: convert(db, 'sonarr', { source, ...meta }) };
  } finally {
    db.close();
  }
}
