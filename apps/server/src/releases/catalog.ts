import { and, eq } from 'drizzle-orm';
import { schema, type Db } from '../db/index.js';
import shippedRadarr from './dictionarry/radarr.json' with { type: 'json' };
import shippedSonarr from './dictionarry/sonarr.json' with { type: 'json' };
import type { DictionarryData } from './dictionarry.js';
import { dictExplain, dictGroup } from './dictWords.js';
import { explain } from './explanations.js';
import { LANGUAGE_ID, TRASH, compile, type App, type Rule, type Spec } from './formats.js';

/**
 * Every rule a profile can score, in one place: TRaSH's (pinned with each
 * Marquee release), Dictionarry's (pinned too, then updated in the app when
 * you apply a rule update) and your own. Keyed by rule id: TRaSH's hex ids,
 * "dict:<name>" for Dictionarry and "own:<id>" for yours.
 */

export type RuleDatabase = 'dictionarry' | 'trash';
export type RuleSource = RuleDatabase | 'own';
type Kind = 'movie' | 'tv';

export interface RuleInfo {
  rule: Rule;
  source: RuleSource;
  label: string;
  explain: string;
  /** Heading on the Quality page, e.g. "Trusted groups"; null for none. */
  group: string | null;
  /** TRaSH's own points for its rules (Dictionarry's depend on the profile; see `upstreamScore`). */
  trashScore: number;
}

export const DICTIONARRY_SHIPPED: Record<App, DictionarryData> = { radarr: shippedRadarr as unknown as DictionarryData, sonarr: shippedSonarr as unknown as DictionarryData };

const appFor = (kind: Kind): App => (kind === 'movie' ? 'radarr' : 'sonarr');

// ---------------------------------------------------------------- caches (one set per database file)

interface Cached {
  dict: Partial<Record<App, DictionarryData>>;
  rules: Partial<Record<Kind, Map<string, RuleInfo>>>;
}
const caches = new WeakMap<Db, Cached>();
const cacheFor = (db: Db): Cached => {
  let c = caches.get(db);
  if (!c) caches.set(db, (c = { dict: {}, rules: {} }));
  return c;
};

/** Call after applying a rule update or changing your own rules. */
export function forgetRules(db: Db): void {
  caches.delete(db);
}

/** The Dictionarry version in use: the last update you applied, or the copy this release ships. */
export function dictionarry(db: Db | null, app: App): DictionarryData {
  if (!db) return DICTIONARRY_SHIPPED[app];
  const c = cacheFor(db);
  const hit = c.dict[app];
  if (hit) return hit;
  const row = db
    .select()
    .from(schema.ruleDatabaseVersions)
    .where(and(eq(schema.ruleDatabaseVersions.name, 'dictionarry'), eq(schema.ruleDatabaseVersions.app, app), eq(schema.ruleDatabaseVersions.state, 'applied')))
    .get();
  const data = row ? (JSON.parse(row.data) as DictionarryData) : DICTIONARRY_SHIPPED[app];
  c.dict[app] = data;
  return data;
}

// ---------------------------------------------------------------- the rules

const staticRules = new Map<App, Map<string, RuleInfo>>();

function databaseRules(app: App, dict: DictionarryData): Map<string, RuleInfo> {
  const map = new Map<string, RuleInfo>();
  const trash = TRASH[app];
  for (const rule of trash.formats) {
    const group = trash.groups.find((g) => g.custom_formats.some((cf) => cf.trash_id === rule.trash_id))?.name ?? null;
    const e = explain(rule.name);
    map.set(rule.trash_id, { rule, source: 'trash', label: e?.label ?? rule.name, explain: e?.explain ?? '', group, trashScore: rule.trash_scores?.default ?? 0 });
  }
  for (const rule of dict.formats) {
    const e = dictExplain(rule.name);
    map.set(rule.trash_id, { rule, source: 'dictionarry', label: e?.label ?? rule.name, explain: e?.explain ?? rule.description, group: dictGroup(rule.tags), trashScore: 0 });
  }
  return map;
}

/** TRaSH's and the shipped Dictionarry rules, with no database to hand (tests and tools). */
export function shippedRules(kind: Kind): Map<string, RuleInfo> {
  const app = appFor(kind);
  let map = staticRules.get(app);
  if (!map) staticRules.set(app, (map = databaseRules(app, DICTIONARRY_SHIPPED[app])));
  return map;
}

/** Every rule a profile of this kind can score: TRaSH's, Dictionarry's as applied, and yours. */
export function rulesFor(db: Db | null, kind: Kind): Map<string, RuleInfo> {
  if (!db) return shippedRules(kind);
  const c = cacheFor(db);
  const hit = c.rules[kind];
  if (hit) return hit;
  const map = databaseRules(appFor(kind), dictionarry(db, appFor(kind)));
  for (const own of db.select().from(schema.ownRules).all()) {
    if (own.kind !== 'both' && own.kind !== kind) continue;
    map.set(ownId(own.id), { rule: ownRule(own), source: 'own', label: own.name, explain: describeOwn(own), group: 'Your own rules', trashScore: 0 });
  }
  c.rules[kind] = map;
  return map;
}

// ---------------------------------------------------------------- your own rules

export type OwnMatch = 'words' | 'group' | 'language' | 'pattern';
export interface OwnRuleRow {
  id: number;
  name: string;
  kind: 'movie' | 'tv' | 'both';
  match: OwnMatch;
  value: string;
}

export const ownId = (id: number) => `own:${id}`;

/** "x265, HEVC" or one per line → ["x265", "HEVC"]. */
export const splitList = (value: string): string[] =>
  value
    .split(/[\n,]/)
    .map((w) => w.trim())
    .filter(Boolean);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The pattern a "words" rule uses: any of the words, as whole words; a space also matches a dot, dash or underscore. */
export function wordsPattern(words: string[]): string {
  const alts = words.map((w) => escape(w).replace(/\s+/g, '[ ._-]+'));
  return `(?<![a-z0-9])(?:${alts.join('|')})(?![a-z0-9])`;
}

/** Language names an own rule can use, plus "Original" for the title's own language. */
export const OWN_LANGUAGES = ['Original', ...Object.values(LANGUAGE_ID)];

export function ownRule(own: OwnRuleRow): Rule {
  const spec = (s: Omit<Spec, 'negate' | 'required' | 'name'>): Spec => ({ name: own.name, negate: false, required: false, ...s });
  let specification: Spec;
  switch (own.match) {
    case 'words':
      specification = spec({ implementation: 'ReleaseTitleSpecification', fields: { value: wordsPattern(splitList(own.value)) } });
      break;
    case 'group':
      specification = spec({ implementation: 'ReleaseGroupSpecification', fields: { value: `^(?:${splitList(own.value).map(escape).join('|')})$` } });
      break;
    case 'language': {
      const id = own.value === 'Original' ? -2 : Number(Object.entries(LANGUAGE_ID).find(([, n]) => n === own.value)?.[0] ?? NaN);
      specification = spec({ implementation: 'LanguageSpecification', fields: { value: id, exceptLanguage: false } });
      break;
    }
    case 'pattern':
      specification = spec({ implementation: 'ReleaseTitleSpecification', fields: { value: own.value } });
      break;
  }
  return { trash_id: ownId(own.id), name: own.name, specifications: [specification] };
}

export function describeOwn(own: OwnRuleRow): string {
  const list = splitList(own.value);
  switch (own.match) {
    case 'words':
      return `The name has ${list.length === 1 ? `“${list[0]}”` : `any of: ${list.map((w) => `“${w}”`).join(', ')}`}.`;
    case 'group':
      return `Made by ${list.length === 1 ? list[0] : `any of: ${list.join(', ')}`}.`;
    case 'language':
      return own.value === 'Original' ? 'Has the language the title was made in.' : `Has ${own.value} audio (a copy that names no language counts as English).`;
    case 'pattern':
      return `The name matches the pattern ${own.value}`;
  }
}

/** Why an own rule can't be saved, or null. */
export function ownRuleProblem(match: OwnMatch, value: string): string | null {
  if (match === 'pattern') return compile(value) ? null : 'That pattern doesn’t work. Check the brackets and backslashes.';
  if (match === 'language') return OWN_LANGUAGES.includes(value) ? null : `Pick a language Marquee knows: ${OWN_LANGUAGES.join(', ')}.`;
  if (!splitList(value).length) return match === 'words' ? 'Add at least one word.' : 'Add at least one group.';
  return null;
}
