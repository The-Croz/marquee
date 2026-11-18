import { and, asc, eq } from 'drizzle-orm';
import { getSetting, schema, setSetting, type Db } from '../db/index.js';
import { HttpError } from '../http.js';
import { defaultProfileKey, type Kind } from './profiles.js';

/**
 * Picks a title's profile from what kind of title it is (TMDB genres and the
 * US age rating), not from who asked for it. Rules are checked in order and
 * the first match wins; with no match, the library's default is used.
 * A profile you picked by hand is never changed.
 */

export interface ProfileChoice {
  profile: string;
  /** Matches a title with any of these genres; empty means any genre. */
  genres: string[];
  /** Matches a title with any of these ratings; empty means any rating. */
  ratings: string[];
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

/** The starting rules, added once. Anything else falls to the library default (4K Quality). */
export const STARTING_CHOICES: Record<Kind, ProfileChoice[]> = {
  movie: [
    { profile: 'kids', genres: ['Animation', 'Family'], ratings: ['G', 'PG'] },
    { profile: 'everyday-hd', genres: ['Documentary'], ratings: [] },
  ],
  tv: [
    { profile: 'kids', genres: ['Kids'], ratings: [] },
    { profile: 'kids', genres: [], ratings: ['TV-Y', 'TV-Y7', 'TV-G'] },
    { profile: 'everyday-hd', genres: ['Reality', 'Talk', 'News', 'Soap', 'Documentary'], ratings: [] },
  ],
};

const SEEDED = 'profiles.choices_seeded';

export function seedChoices(db: Db): void {
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
    .map((r) => ({ profile: r.profile, genres: JSON.parse(r.genres) as string[], ratings: JSON.parse(r.ratings) as string[] }));
}

export function setChoices(db: Db, kind: Kind, choices: ProfileChoice[]): ProfileChoice[] {
  const keys = new Set(db.select({ key: schema.profiles.key }).from(schema.profiles).where(eq(schema.profiles.kind, kind)).all().map((r) => r.key));
  choices.forEach((c, i) => {
    if (!keys.has(c.profile)) throw new HttpError(400, 'invalid_input', `Rule ${i + 1} points at a profile that doesn't exist.`);
    if (!c.genres.length && !c.ratings.length) throw new HttpError(400, 'invalid_input', `Rule ${i + 1} would match everything. Pick at least one genre or rating, or change the default instead.`);
  });
  db.transaction(() => write(db, kind, choices));
  return listChoices(db, kind);
}

function write(db: Db, kind: Kind, choices: ProfileChoice[]): void {
  db.delete(schema.profileChoices).where(eq(schema.profileChoices.kind, kind)).run();
  choices.forEach((c, position) =>
    db.insert(schema.profileChoices).values({ kind, position, profile: c.profile, genres: JSON.stringify(c.genres), ratings: JSON.stringify(c.ratings) }).run(),
  );
}

export interface TitleFacts {
  genres: string[];
  certification: string | null;
}

/** Which rule picks a profile for these facts, and its number (1-based), or the default. */
export function choose(db: Db, kind: Kind, facts: TitleFacts): { profile: string; rule: number | null } {
  const choices = listChoices(db, kind);
  const i = choices.findIndex(
    (c) => (!c.genres.length || c.genres.some((g) => facts.genres.includes(g))) && (!c.ratings.length || (facts.certification !== null && c.ratings.includes(facts.certification))),
  );
  return i >= 0 ? { profile: choices[i]!.profile, rule: i + 1 } : { profile: defaultProfileKey(db, kind), rule: null };
}

export const chooseProfile = (db: Db, kind: Kind, facts: TitleFacts): string => choose(db, kind, facts).profile;

export interface ProfileChange {
  id: number;
  title: string;
  year: number | null;
  from: string;
  to: string;
  /** Rule number that picked it, or null for the default. */
  rule: number | null;
}

/** What "sort my library by these rules" would change. Titles you set by hand are left out. */
export function previewChanges(db: Db, kind: Kind): ProfileChange[] {
  const table = kind === 'movie' ? schema.movies : schema.series;
  const rows = db.select({ id: table.id, title: table.title, year: table.year, profile: table.profile, genres: table.genres, certification: table.certification }).from(table).where(eq(table.profileByHand, false)).all();
  return rows.flatMap((r) => {
    const c = choose(db, kind, { genres: JSON.parse(r.genres) as string[], certification: r.certification });
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

/** Hands a title back to the rules: forgets the hand-picked profile and chooses again. */
export function useRules(db: Db, kind: Kind, titleId: number): string {
  const table = kind === 'movie' ? schema.movies : schema.series;
  const row = db.select({ genres: table.genres, certification: table.certification }).from(table).where(eq(table.id, titleId)).get();
  if (!row) throw new HttpError(404, 'not_found', kind === 'movie' ? 'No such movie.' : 'No such show.');
  const profile = chooseProfile(db, kind, { genres: JSON.parse(row.genres) as string[], certification: row.certification });
  db.update(table).set({ profile, profileByHand: false }).where(eq(table.id, titleId)).run();
  return profile;
}
