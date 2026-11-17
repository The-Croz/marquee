import type { ParsedRelease, Source } from './parse.js';
import radarr from './trash/radarr.json' with { type: 'json' };
import sonarr from './trash/sonarr.json' with { type: 'json' };

/**
 * Rules (TRaSH "custom formats"): named tests on a copy, each worth points in
 * a profile. This checks whether a rule matches a copy, the same way Radarr
 * and Sonarr do, so TRaSH's rules mean here what they mean there.
 */

export type App = 'radarr' | 'sonarr';

export interface Spec {
  name: string;
  implementation: string;
  negate: boolean;
  required: boolean;
  fields: Record<string, unknown>;
}

export interface Rule {
  trash_id: string;
  name: string;
  /** Missing on a few rules TRaSH leaves for you to score. */
  trash_scores?: Record<string, number>;
  specifications: Spec[];
}

export interface RuleGroup {
  trash_id: string;
  name: string;
  trash_description: string;
  /** On by default for the profiles it lists. */
  default: boolean;
  custom_formats: { name: string; trash_id: string; required: boolean; default?: boolean }[];
  profiles: string[];
}

export interface TrashProfile {
  trash_id: string;
  name: string;
  trash_description: string;
  cutoff: string;
  upgradeAllowed: boolean;
  minFormatScore: number;
  cutoffFormatScore: number;
  minUpgradeFormatScore: number;
  items: { name: string; allowed: boolean; items?: string[] }[];
  formatItems: Record<string, string>;
}

export interface TrashData {
  source: string;
  commit: string;
  fetchedAt: string;
  profiles: TrashProfile[];
  groups: RuleGroup[];
  formats: Rule[];
  sizes: { quality: string; min: number; preferred: number; max: number }[];
}

export const TRASH: Record<App, TrashData> = { radarr: radarr as unknown as TrashData, sonarr: sonarr as unknown as TrashData };

/** What a rule looks at. */
export interface RuleInput {
  app: App;
  /** The release name exactly as the Source gave it. */
  title: string;
  parsed: ParsedRelease;
  /** Bytes, if known. */
  size: number | null;
  freeleech: boolean;
  /** The title's original language from TMDB, e.g. "English", "Japanese". */
  originalLanguage?: string;
}

// ---------------------------------------------------------------- enums (Radarr and Sonarr numbering)

/** Radarr's Source enum. */
const RADARR_SOURCE: Partial<Record<Source, number>> = {
  cam: 1,
  telesync: 2,
  telecine: 3,
  workprint: 4,
  dvd: 5,
  dvdr: 5,
  screener: 5,
  regional: 5,
  hdtv: 6,
  rawhd: 6,
  webdl: 7,
  webrip: 8,
  bluray: 9,
  remux: 9,
  brdisk: 9,
};
/** Radarr's quality modifiers: 1 REGIONAL, 2 SCREENER, 3 RAWHD, 4 BRDISK, 5 REMUX. */
const RADARR_MODIFIER: Partial<Record<Source, number>> = { regional: 1, screener: 2, rawhd: 3, brdisk: 4, remux: 5, dvdr: 5 };
/** Sonarr's QualitySource enum: 1 Television, 2 TelevisionRaw, 3 Web, 4 WebRip, 5 DVD, 6 Bluray, 7 BlurayRaw. */
const SONARR_SOURCE: Partial<Record<Source, number>> = { hdtv: 1, rawhd: 2, webdl: 3, webrip: 4, dvd: 5, dvdr: 5, bluray: 6, remux: 7, brdisk: 7 };

/** Radarr/Sonarr language IDs used by TRaSH rules (-2 means the title's original language). */
const LANGUAGE_ID: Record<number, string> = {
  1: 'English',
  2: 'French',
  3: 'Spanish',
  4: 'German',
  5: 'Italian',
  6: 'Danish',
  7: 'Dutch',
  8: 'Japanese',
  10: 'Chinese',
  11: 'Russian',
  12: 'Polish',
  17: 'Turkish',
  18: 'Portuguese',
  21: 'Korean',
  25: 'Czech',
  26: 'Hindi',
};

// ---------------------------------------------------------------- regexes

const cache = new Map<string, RegExp | null>();

/**
 * Compiles a rule's pattern for JavaScript. They're written for .NET, where a
 * bare "(?i)" anywhere switches on ignore-case; we always ignore case (as
 * Radarr does), so those are dropped. "(?i:…)" groups work as they are.
 */
export function compile(pattern: string): RegExp | null {
  if (cache.has(pattern)) return cache.get(pattern)!;
  const source = pattern.replace(/\(\?i\)/g, '');
  let re: RegExp | null = null;
  for (const flags of ['i', 'iu']) {
    try {
      re = new RegExp(source, flags);
      break;
    } catch {
      /* try the next flags */
    }
  }
  cache.set(pattern, re);
  return re;
}

// ---------------------------------------------------------------- matching

/**
 * The languages a copy is in, as Radarr reads them: the languages named, or
 * English when none is. "MULTi" alone adds nothing ("MULTi.FRENCH" is French).
 */
function languages(input: RuleInput): Set<string> {
  const named = input.parsed.languages.filter((l) => l !== 'Multi' && l !== 'Nordic');
  return new Set(named.length ? named : ['English']);
}

/**
 * Radarr and Sonarr test the resolution of the *quality*, not the number in the
 * name: a "1080p HDCAM" is CAM quality, which has no resolution.
 */
function qualityResolution(p: ParsedRelease): number {
  const q = p.quality;
  // Telesync and telecine keep the resolution in the name; a cam copy has none (as Radarr reads them).
  if (q === 'TELESYNC' || q === 'TELECINE') return p.resolution === 1440 ? 1080 : (p.resolution ?? 0);
  const m = q.match(/(\d{3,4})p$/);
  if (m?.[1]) return Number(m[1]);
  if (['SDTV', 'DVD', 'DVD-R', 'DVDSCR', 'REGIONAL'].includes(q)) return 480;
  if (q === 'BR-DISK' || q === 'Raw-HD') return 1080;
  return 0;
}

function releaseType(p: ParsedRelease): number {
  if (p.fullSeason) return 3;
  if (p.episodes.length > 1) return 2;
  if (p.episodes.length === 1) return 1;
  return 0;
}

/** Whether one test is satisfied, before `negate`. Returns null for a test type Marquee can't check. */
function satisfied(spec: Spec, input: RuleInput): boolean | null {
  const p = input.parsed;
  const value = spec.fields.value;
  switch (spec.implementation) {
    case 'ReleaseTitleSpecification': {
      const re = compile(String(value));
      return re ? re.test(input.title) : null;
    }
    case 'ReleaseGroupSpecification': {
      const re = compile(String(value));
      if (!re) return null;
      return p.group !== null && re.test(p.group);
    }
    case 'ResolutionSpecification':
      return qualityResolution(p) === Number(value);
    case 'SourceSpecification': {
      const map = input.app === 'radarr' ? RADARR_SOURCE : SONARR_SOURCE;
      return p.source !== null && map[p.source] === Number(value);
    }
    case 'QualityModifierSpecification':
      return p.source !== null && (RADARR_MODIFIER[p.source] ?? 0) === Number(value);
    case 'LanguageSpecification': {
      const id = Number(value);
      const want = id === -2 ? (input.originalLanguage ?? 'English') : LANGUAGE_ID[id];
      if (!want) return null;
      const langs = languages(input);
      // exceptLanguage: matches when the copy has any language other than this one.
      if (spec.fields.exceptLanguage) return [...langs].some((l) => l !== want);
      return langs.has(want);
    }
    case 'IndexerFlagSpecification':
      // 1 is freeleech in both apps. Other flags (internal, scene…) aren't sent by Torznab feeds.
      return Number(value) === 1 ? input.freeleech : false;
    case 'SizeSpecification': {
      if (input.size === null) return false;
      const gb = input.size / 1024 ** 3;
      return gb > Number(spec.fields.min ?? 0) && gb <= Number(spec.fields.max ?? Infinity);
    }
    case 'ReleaseTypeSpecification':
      return releaseType(p) === Number(value);
    default:
      return null;
  }
}

/**
 * Radarr's rule: tests are grouped by type; a group passes unless a required
 * test fails or every test in it fails; the rule matches when every group passes.
 */
export function matches(rule: Rule, input: RuleInput): boolean {
  const byType = new Map<string, boolean[][]>();
  for (const spec of rule.specifications) {
    const raw = satisfied(spec, input);
    if (raw === null) return false; // a test we can't check: never claim a match
    const ok = raw !== spec.negate;
    const list = byType.get(spec.implementation) ?? [];
    list.push([ok, spec.required]);
    byType.set(spec.implementation, list);
  }
  for (const tests of byType.values()) {
    if (tests.some(([ok, required]) => required && !ok)) return false;
    if (tests.every(([ok]) => !ok)) return false;
  }
  return true;
}

/** Why Marquee can't check a rule, or null when it can. */
export function unsupported(rule: Rule): string | null {
  for (const spec of rule.specifications) {
    if (/Title|Group/.test(spec.implementation) && !compile(String(spec.fields.value))) return `The pattern in "${spec.name}" doesn't work in JavaScript.`;
    if (spec.implementation === 'LanguageSpecification' && Number(spec.fields.value) !== -2 && !LANGUAGE_ID[Number(spec.fields.value)]) return `Language ${String(spec.fields.value)} isn't known.`;
    if (!['ReleaseTitleSpecification', 'ReleaseGroupSpecification', 'ResolutionSpecification', 'SourceSpecification', 'QualityModifierSpecification', 'LanguageSpecification', 'IndexerFlagSpecification', 'SizeSpecification', 'ReleaseTypeSpecification'].includes(spec.implementation)) {
      return `Tests of type ${spec.implementation} aren't supported yet.`;
    }
  }
  return null;
}

/** Every rule in a TRaSH profile's default set (always-on rules plus default-on groups), with TRaSH's points. */
export function defaultRules(app: App, profileName: string): { rule: Rule; points: number; group: string | null }[] {
  const data = TRASH[app];
  const profile = data.profiles.find((p) => p.name === profileName);
  if (!profile) throw new Error(`No TRaSH profile called ${profileName}`);
  const byId = new Map(data.formats.map((f) => [f.trash_id, f]));
  const out = new Map<string, { rule: Rule; points: number; group: string | null }>();
  const add = (id: string, group: string | null) => {
    const rule = byId.get(id);
    if (rule && !out.has(id)) out.set(id, { rule, points: rule.trash_scores?.default ?? 0, group });
  };
  for (const id of Object.values(profile.formatItems)) add(id, null);
  for (const g of data.groups) {
    if (!g.default || !g.profiles.includes(profileName)) continue;
    for (const cf of g.custom_formats) if (cf.required || cf.default) add(cf.trash_id, g.name);
  }
  return [...out.values()];
}

/** Opt-in rules for a profile: in its groups but off by default. */
export function optionalRules(app: App, profileName: string): { rule: Rule; points: number; group: string }[] {
  const data = TRASH[app];
  const on = new Set(defaultRules(app, profileName).map((r) => r.rule.trash_id));
  const byId = new Map(data.formats.map((f) => [f.trash_id, f]));
  const out: { rule: Rule; points: number; group: string }[] = [];
  for (const g of data.groups) {
    if (!g.profiles.includes(profileName)) continue;
    for (const cf of g.custom_formats) {
      const rule = byId.get(cf.trash_id);
      if (rule && !on.has(cf.trash_id) && !out.some((o) => o.rule.trash_id === cf.trash_id)) out.push({ rule, points: rule.trash_scores?.default ?? 0, group: g.name });
    }
  }
  return out;
}
