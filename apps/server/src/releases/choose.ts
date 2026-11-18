import { and, asc, eq } from 'drizzle-orm';
import { getSetting, schema, setSetting, type Db } from '../db/index.js';
import { HttpError } from '../http.js';
import { defaultProfileKey, type Kind } from './profiles.js';

/**
 * Picks a title's profile from what kind of title it is (TMDB's facts about
 * it), never from who asked for it. Each rule is a list of conditions that
 * must all hold; rules are checked in order and the first match wins; with
 * no match, the library's default ("everything else") is used. A profile
 * you picked by hand is never changed.
 */

export type Field = 'genre' | 'rating' | 'year' | 'company' | 'language' | 'keyword';
export type Op = 'any' | 'all' | 'none' | 'between';

export interface Condition {
  field: Field;
  op: Op;
  /** For list fields. */
  values?: string[];
  /** For year: either end may be left open. */
  min?: number | null;
  max?: number | null;
}

export interface ProfileChoice {
  profile: string;
  conditions: Condition[];
}

/** What a rule can look at. */
export interface TitleFacts {
  genres: string[];
  certification: string | null;
  year: number | null;
  companies: string[];
  /** ISO 639-1, e.g. "en". */
  language: string | null;
  keywords: string[];
}

/** TMDB's genre names. */
export const GENRES: Record<Kind, string[]> = {
  movie: ['Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy', 'History', 'Horror', 'Music', 'Mystery', 'Romance', 'Science Fiction', 'TV Movie', 'Thriller', 'War', 'Western'],
  tv: ['Action & Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Kids', 'Mystery', 'News', 'Reality', 'Sci-Fi & Fantasy', 'Soap', 'Talk', 'War & Politics', 'Western'],
};

/** US age ratings, youngest first. */
export const RATINGS: Record<Kind, string[]> = {
  movie: ['G', 'PG', 'PG-13', 'R', 'NC-17', 'NR'],
  tv: ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA'],
};

/** Plain names for the original languages people most often filter on. */
export const LANGUAGES: Record<string, string> = {
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  cn: 'Cantonese',
  fr: 'French',
  es: 'Spanish',
  de: 'German',
  it: 'Italian',
  hi: 'Hindi',
  pt: 'Portuguese',
  sv: 'Swedish',
  da: 'Danish',
  no: 'Norwegian',
  nl: 'Dutch',
  ru: 'Russian',
  tr: 'Turkish',
  pl: 'Polish',
  th: 'Thai',
};

const LIST_FIELDS: Field[] = ['genre', 'rating', 'company', 'language', 'keyword'];

/** The starting rules. Anything else falls to the library default (4K Quality). */
export const STARTING_CHOICES: Record<Kind, ProfileChoice[]> = {
  movie: [
    { profile: 'everyday-hd', conditions: [{ field: 'genre', op: 'any', values: ['Documentary'] }] },
    {
      profile: 'kids',
      conditions: [
        { field: 'genre', op: 'any', values: ['Animation', 'Family'] },
        { field: 'rating', op: 'any', values: ['G', 'PG'] },
        { field: 'year', op: 'between', min: null, max: 2009 },
      ],
    },
  ],
  tv: [
    { profile: 'kids', conditions: [{ field: 'genre', op: 'any', values: ['Kids'] }] },
    { profile: 'kids', conditions: [{ field: 'rating', op: 'any', values: ['TV-Y', 'TV-Y7', 'TV-G'] }] },
    { profile: 'everyday-hd', conditions: [{ field: 'genre', op: 'any', values: ['Reality', 'Talk', 'News', 'Soap', 'Documentary'] }] },
  ],
};

/** The first starting rules (before conditions). Installs still using them get the new ones. */
const FIRST_MOVIE_RULES: ProfileChoice[] = [
  { profile: 'kids', conditions: [{ field: 'genre', op: 'any', values: ['Animation', 'Family'] }, { field: 'rating', op: 'any', values: ['G', 'PG'] }] },
  { profile: 'everyday-hd', conditions: [{ field: 'genre', op: 'any', values: ['Documentary'] }] },
];

const SEEDED = 'profiles.choices_seeded';
const CONVERTED = 'profiles.choices_conditions';

export function seedChoices(db: Db): void {
  // Rules saved before conditions existed kept genres and ratings in their own columns.
  if (!getSetting(db, CONVERTED)) {
    db.transaction(() => {
      for (const r of db.select().from(schema.profileChoices).all()) {
        if (r.conditions !== '[]') continue;
        const conditions: Condition[] = [];
        const genres = JSON.parse(r.genres) as string[];
        const ratings = JSON.parse(r.ratings) as string[];
        if (genres.length) conditions.push({ field: 'genre', op: 'any', values: genres });
        if (ratings.length) conditions.push({ field: 'rating', op: 'any', values: ratings });
        db.update(schema.profileChoices).set({ conditions: JSON.stringify(conditions) }).where(eq(schema.profileChoices.id, r.id)).run();
      }
      // Still on the first movie rules? Move to the new ones, which keep newer family films in 4K.
      if (getSetting(db, SEEDED) && JSON.stringify(listChoices(db, 'movie')) === JSON.stringify(FIRST_MOVIE_RULES)) write(db, 'movie', STARTING_CHOICES.movie);
      setSetting(db, CONVERTED, '1');
    });
  }
  if (getSetting(db, SEEDED)) return;
  db.transaction(() => {
    for (const kind of ['movie', 'tv'] as Kind[]) {
      // Only rules whose profile still exists.
      const keys = new Set(db.select({ key: schema.profiles.key }).from(schema.profiles).where(eq(schema.profiles.kind, kind)).all().map((r) => r.key));
      write(db, kind, STARTING_CHOICES[kind].filter((c) => keys.has(c.profile)));
    }
    setSetting(db, SEEDED, '1');
  });
}

export function listChoices(db: Db, kind: Kind): ProfileChoice[] {
  return db
    .select()
    .from(schema.profileChoices)
    .where(eq(schema.profileChoices.kind, kind))
    .orderBy(asc(schema.profileChoices.position))
    .all()
    .map((r) => ({ profile: r.profile, conditions: JSON.parse(r.conditions) as Condition[] }));
}

export function setChoices(db: Db, kind: Kind, choices: ProfileChoice[]): ProfileChoice[] {
  const keys = new Set(db.select({ key: schema.profiles.key }).from(schema.profiles).where(eq(schema.profiles.kind, kind)).all().map((r) => r.key));
  const bad = (i: number, msg: string) => new HttpError(400, 'invalid_input', `Rule ${i + 1}: ${msg}`);
  const clean = choices.map((c, i) => {
    if (!keys.has(c.profile)) throw bad(i, 'it points at a profile that doesn’t exist.');
    if (!c.conditions.length) throw bad(i, 'it would match everything. Add a condition, or change “everything else” instead.');
    return {
      profile: c.profile,
      conditions: c.conditions.map((x): Condition => {
        if (x.field === 'year') {
          if (x.op !== 'between') throw bad(i, 'a year condition needs a range.');
          if (x.min == null && x.max == null) throw bad(i, 'give the year range a start, an end, or both.');
          if (x.min != null && x.max != null && x.min > x.max) throw bad(i, 'the year range ends before it starts.');
          return { field: 'year', op: 'between', min: x.min ?? null, max: x.max ?? null };
        }
        if (!LIST_FIELDS.includes(x.field)) throw bad(i, 'there’s a condition Marquee doesn’t know.');
        if (!['any', 'all', 'none'].includes(x.op) || (x.op === 'all' && x.field !== 'genre' && x.field !== 'keyword')) throw bad(i, 'a condition has a choice that doesn’t fit it.');
        const values = [...new Set((x.values ?? []).map((v) => v.trim()).filter(Boolean))];
        if (!values.length) throw bad(i, `pick at least one ${label(x.field)}, or remove that condition.`);
        return { field: x.field, op: x.op, values };
      }),
    };
  });
  db.transaction(() => write(db, kind, clean));
  return listChoices(db, kind);
}

function label(field: Field): string {
  return { genre: 'genre', rating: 'age rating', year: 'year', company: 'studio or network', language: 'language', keyword: 'keyword' }[field];
}

function write(db: Db, kind: Kind, choices: ProfileChoice[]): void {
  db.delete(schema.profileChoices).where(eq(schema.profileChoices.kind, kind)).run();
  choices.forEach((c, position) => db.insert(schema.profileChoices).values({ kind, position, profile: c.profile, conditions: JSON.stringify(c.conditions) }).run());
}

// ---------------------------------------------------------------- matching

const lower = (xs: string[]) => xs.map((x) => x.toLowerCase());

function listFor(field: Field, f: TitleFacts): string[] {
  switch (field) {
    case 'genre':
      return f.genres;
    case 'rating':
      return f.certification ? [f.certification] : [];
    case 'company':
      return f.companies;
    case 'language':
      return f.language ? [f.language] : [];
    case 'keyword':
      return f.keywords;
    default:
      return [];
  }
}

/** Whether one condition holds for a title. */
export function holds(c: Condition, f: TitleFacts): boolean {
  if (c.field === 'year') return f.year !== null && (c.min == null || f.year >= c.min) && (c.max == null || f.year <= c.max);
  const have = new Set(lower(listFor(c.field, f)));
  const want = lower(c.values ?? []);
  if (c.op === 'all') return want.every((w) => have.has(w));
  const some = want.some((w) => have.has(w));
  return c.op === 'none' ? !some : some;
}

export interface Choice {
  profile: string;
  /** Rule number that picked it (1-based), or null for "everything else". */
  rule: number | null;
}

export function choose(db: Db, kind: Kind, facts: TitleFacts, choices = listChoices(db, kind)): Choice {
  const i = choices.findIndex((c) => c.conditions.every((x) => holds(x, facts)));
  return i >= 0 ? { profile: choices[i]!.profile, rule: i + 1 } : { profile: defaultProfileKey(db, kind), rule: null };
}

export const chooseProfile = (db: Db, kind: Kind, facts: TitleFacts): string => choose(db, kind, facts).profile;

/** Facts from TMDB's answer, as the scanner has it. */
export function factsFrom(d: { genres: string[]; certification: string | null; year: number | null; companies: string[]; originalLanguage: string | null; keywords: string[] }): TitleFacts {
  return { genres: d.genres, certification: d.certification, year: d.year, companies: d.companies, language: d.originalLanguage, keywords: d.keywords };
}

type TitleRow = { genres: string; certification: string | null; year: number | null; companies: string; originalLanguage: string | null; keywords: string };
const factsOf = (r: TitleRow): TitleFacts => ({
  genres: JSON.parse(r.genres) as string[],
  certification: r.certification,
  year: r.year,
  companies: JSON.parse(r.companies) as string[],
  language: r.originalLanguage,
  keywords: JSON.parse(r.keywords) as string[],
});

function titles(db: Db, kind: Kind) {
  const t = kind === 'movie' ? schema.movies : schema.series;
  return db
    .select({ id: t.id, title: t.title, year: t.year, profile: t.profile, byHand: t.profileByHand, genres: t.genres, certification: t.certification, companies: t.companies, originalLanguage: t.originalLanguage, keywords: t.keywords })
    .from(t)
    .all();
}

// ---------------------------------------------------------------- the library

export interface ProfileChange {
  id: number;
  title: string;
  year: number | null;
  from: string;
  to: string;
  rule: number | null;
}

/** What "sort my library by these rules" would change. Titles you set by hand are left out. */
export function previewChanges(db: Db, kind: Kind): ProfileChange[] {
  const choices = listChoices(db, kind);
  return titles(db, kind)
    .filter((r) => !r.byHand)
    .flatMap((r) => {
      const c = choose(db, kind, factsOf(r), choices);
      return c.profile === r.profile ? [] : [{ id: r.id, title: r.title, year: r.year, from: r.profile, to: c.profile, rule: c.rule }];
    });
}

export function applyChanges(db: Db, kind: Kind): number {
  const table = kind === 'movie' ? schema.movies : schema.series;
  const changes = previewChanges(db, kind);
  db.transaction(() => {
    for (const c of changes) db.update(table).set({ profile: c.to }).where(and(eq(table.id, c.id), eq(table.profileByHand, false))).run();
  });
  return changes.length;
}

/** How many titles in the library each rule picks (first match), and "everything else". Rules can be a draft. */
export function ruleCounts(db: Db, kind: Kind, choices: ProfileChoice[]): { rules: number[]; rest: number } {
  const rules = choices.map(() => 0);
  let rest = 0;
  for (const r of titles(db, kind)) {
    const i = choices.findIndex((c) => c.conditions.length > 0 && c.conditions.every((x) => holds(x, factsOf(r))));
    if (i >= 0) rules[i]!++;
    else rest++;
  }
  return { rules, rest };
}

export interface TitleCheck {
  id: number;
  title: string;
  year: number | null;
  facts: TitleFacts;
  /** For each rule, whether each condition holds. */
  rules: boolean[][];
  /** Rule number that picks it, or null for "everything else". */
  picked: number | null;
  profile: string;
  byHand: boolean;
}

/** "Try a title": which rule picks a library title, and which conditions hold. Rules can be a draft. */
export function tryTitles(db: Db, kind: Kind, query: string, choices: ProfileChoice[]): TitleCheck[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return titles(db, kind)
    .filter((r) => r.title.toLowerCase().includes(q))
    .slice(0, 5)
    .map((r) => {
      const facts = factsOf(r);
      const rules = choices.map((c) => c.conditions.map((x) => holds(x, facts)));
      const i = rules.findIndex((conds) => conds.length > 0 && conds.every(Boolean));
      return { id: r.id, title: r.title, year: r.year, facts, rules, picked: i >= 0 ? i + 1 : null, profile: i >= 0 ? choices[i]!.profile : defaultProfileKey(db, kind), byHand: r.byHand };
    });
}

/** Studios, keywords and languages in your library, most common first, to suggest while editing. */
export function suggestions(db: Db, kind: Kind): { companies: string[]; keywords: string[]; languages: string[] } {
  const count = (lists: string[][]) => {
    const n = new Map<string, number>();
    for (const l of lists) for (const x of l) n.set(x, (n.get(x) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([x]) => x);
  };
  const rows = titles(db, kind).map(factsOf);
  return {
    companies: count(rows.map((r) => r.companies)).slice(0, 300),
    keywords: count(rows.map((r) => r.keywords)).slice(0, 300),
    languages: [...new Set([...count(rows.map((r) => (r.language ? [r.language] : []))), ...Object.keys(LANGUAGES)])],
  };
}

/** Hands a title back to the rules: forgets the hand-picked profile and chooses again. */
export function useRules(db: Db, kind: Kind, titleId: number): string {
  const row = titles(db, kind).find((r) => r.id === titleId);
  if (!row) throw new HttpError(404, 'not_found', kind === 'movie' ? 'No such movie.' : 'No such show.');
  const profile = chooseProfile(db, kind, factsOf(row));
  const table = kind === 'movie' ? schema.movies : schema.series;
  db.update(table).set({ profile, profileByHand: false }).where(eq(table.id, titleId)).run();
  return profile;
}
