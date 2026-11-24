import { describe, expect, it } from 'vitest';
import type { ChoicesCheckView, ProfileChangeView, ProfileChoicesView } from '@marquee/shared';
import { openDb, schema, setSetting } from '../src/db/index.js';
import { choose, holds, listChoices, seedChoices, type TitleFacts } from '../src/releases/choose.js';
import { PRESETS, seedProfiles } from '../src/releases/profiles.js';
import { call, makeApp, setupAdmin } from './helpers.js';

type Db = ReturnType<typeof makeApp>['db'];
const facts = (f: Partial<TitleFacts>): TitleFacts => ({ genres: [], certification: null, year: null, companies: [], language: 'en', keywords: [], ...f });

let next = 1;
function addMovie(db: Db, title: string, f: Partial<TitleFacts>, profile = 'cinema') {
  const x = facts(f);
  return db
    .insert(schema.movies)
    .values({ tmdbId: next++, title, sortTitle: title.toLowerCase(), year: x.year, genres: JSON.stringify(x.genres), certification: x.certification, companies: JSON.stringify(x.companies), originalLanguage: x.language, keywords: JSON.stringify(x.keywords), profile, addedAt: 0, refreshedAt: 0 })
    .returning()
    .get();
}
function addShow(db: Db, title: string, f: Partial<TitleFacts>, profile = 'cinema') {
  const x = facts(f);
  return db
    .insert(schema.series)
    .values({ tmdbId: next++, title, sortTitle: title.toLowerCase(), year: x.year, genres: JSON.stringify(x.genres), certification: x.certification, companies: JSON.stringify(x.companies), originalLanguage: x.language, keywords: JSON.stringify(x.keywords), profile, addedAt: 0, refreshedAt: 0 })
    .returning()
    .get();
}

async function admin() {
  const t = makeApp();
  const cookie = await setupAdmin(t.app);
  return { ...t, cookie, req: (method: string, path: string, body?: unknown) => call(t.app, method, `/api/settings/profiles${path}`, body, cookie) };
}

describe('conditions', () => {
  const up = facts({ genres: ['Animation', 'Family'], certification: 'PG', year: 2009, companies: ['Pixar'], keywords: ['Balloon'] });
  it.each([
    [{ field: 'genre', op: 'any', values: ['Animation', 'Documentary'] }, true],
    [{ field: 'genre', op: 'all', values: ['Animation', 'Documentary'] }, false],
    [{ field: 'genre', op: 'none', values: ['Horror'] }, true],
    [{ field: 'rating', op: 'any', values: ['G', 'PG'] }, true],
    [{ field: 'rating', op: 'none', values: ['PG'] }, false],
    [{ field: 'year', op: 'between', min: 2010, max: null }, false],
    [{ field: 'year', op: 'between', min: null, max: 2009 }, true],
    [{ field: 'company', op: 'any', values: ['pixar'] }, true],
    [{ field: 'language', op: 'any', values: ['ja'] }, false],
    [{ field: 'keyword', op: 'any', values: ['balloon'] }, true],
  ] as const)('%j → %s', (c, want) => expect(holds(c as never, up)).toBe(want));

  it('a title with no year or rating never matches a year range or a rating list', () => {
    expect(holds({ field: 'year', op: 'between', min: 2000, max: null }, facts({}))).toBe(false);
    expect(holds({ field: 'rating', op: 'any', values: ['G'] }, facts({}))).toBe(false);
    expect(holds({ field: 'rating', op: 'none', values: ['R'] }, facts({}))).toBe(true);
  });
});

describe('which profile a title gets', () => {
  it('starts with rules that keep newer family films in 4K', async () => {
    const { db } = await admin();
    const cases: [string, 'movie' | 'tv', Partial<TitleFacts>, string][] = [
      ['Up', 'movie', { genres: ['Animation', 'Family'], certification: 'PG', year: 2009 }, 'kids'],
      ['Inside Out 2', 'movie', { genres: ['Animation', 'Family'], certification: 'PG', year: 2024 }, 'cinema'],
      ['Wonka', 'movie', { genres: ['Family', 'Fantasy'], certification: 'PG', year: 2023 }, 'cinema'],
      ['Free Solo', 'movie', { genres: ['Documentary'], certification: 'PG-13', year: 2018 }, 'everyday-hd'],
      ['Dune: Part Two', 'movie', { genres: ['Science Fiction'], certification: 'PG-13', year: 2024 }, 'cinema'],
      ['Bluey', 'tv', { genres: ['Animation', 'Kids'], certification: 'TV-Y' }, 'kids'],
      ['Sesame Street', 'tv', { genres: ['Family'], certification: 'TV-Y' }, 'kids'],
      ['Survivor', 'tv', { genres: ['Reality'], certification: 'TV-PG' }, 'everyday-hd'],
      ['Severance', 'tv', { genres: ['Drama'], certification: 'TV-MA' }, 'cinema'],
    ];
    for (const [title, kind, f, want] of cases) expect(choose(db, kind, facts(f)).profile, title).toBe(want);
  });

  it('turns older genre/rating rules into conditions, and moves untouched first rules to the new ones', () => {
    const db = openDb(':memory:');
    seedProfiles(db, 0);
    setSetting(db, 'profiles.choices_seeded', '1');
    const old = (kind: 'movie' | 'tv', position: number, profile: string, genres: string[], ratings: string[]) =>
      db.insert(schema.profileChoices).values({ kind, position, profile, genres: JSON.stringify(genres), ratings: JSON.stringify(ratings) }).run();
    old('movie', 0, 'kids', ['Animation', 'Family'], ['G', 'PG']);
    old('movie', 1, 'everyday-hd', ['Documentary'], []);
    old('tv', 0, 'everyday-hd', ['Reality'], ['TV-PG']);
    seedChoices(db);
    expect(listChoices(db, 'movie')[1]!.conditions).toContainEqual({ field: 'year', op: 'between', min: null, max: 2009 });
    expect(listChoices(db, 'tv')).toEqual([
      { profile: 'everyday-hd', conditions: [{ field: 'genre', op: 'any', values: ['Reality'] }, { field: 'rating', op: 'any', values: ['TV-PG'] }] },
    ]);
  });

  it('keeps rules you changed when converting', () => {
    const db = openDb(':memory:');
    seedProfiles(db, 0);
    setSetting(db, 'profiles.choices_seeded', '1');
    db.insert(schema.profileChoices).values({ kind: 'movie', position: 0, profile: 'kids', genres: '["Animation"]', ratings: '[]' }).run();
    seedChoices(db);
    expect(listChoices(db, 'movie')).toEqual([{ profile: 'kids', conditions: [{ field: 'genre', op: 'any', values: ['Animation'] }] }]);
  });

  it('lists, edits and checks the rules, with plain messages', async () => {
    const t = await admin();
    addMovie(t.db, 'Up', { genres: ['Animation'], companies: ['Pixar'], keywords: ['balloon'] });
    addMovie(t.db, 'Coco', { genres: ['Animation'], companies: ['Pixar'], language: 'es' });
    const view = (await t.req('GET', '/choices')).body as ProfileChoicesView;
    expect(view.rules.movie).toHaveLength(2);
    expect(view.genres.tv).toContain('Kids');
    expect(view.suggestions.movie.companies[0]).toBe('Pixar');
    expect(view.suggestions.movie.languages.slice(0, 2)).toEqual(['en', 'es']);
    expect(view.languageNames.ja).toBe('Japanese');

    const rules = [{ profile: 'cinema', conditions: [{ field: 'company', op: 'any', values: ['Pixar', ' '] }, { field: 'year', op: 'between', min: 2000, max: null }] }];
    const res = await t.req('PUT', '/choices/movie', { rules });
    expect(res.status).toBe(200);
    expect(res.body.rules[0].conditions).toEqual([{ field: 'company', op: 'any', values: ['Pixar'] }, { field: 'year', op: 'between', min: 2000, max: null }]);

    const bad: [unknown, RegExp][] = [
      [{ profile: 'nope', conditions: [{ field: 'genre', op: 'any', values: ['Drama'] }] }, /Rule 1: it points at a profile that doesn’t exist/],
      [{ profile: 'kids', conditions: [] }, /would match everything/],
      [{ profile: 'kids', conditions: [{ field: 'genre', op: 'any', values: [] }] }, /pick at least one genre/],
      [{ profile: 'kids', conditions: [{ field: 'year', op: 'between', min: 2010, max: 2000 }] }, /ends before it starts/],
      [{ profile: 'kids', conditions: [{ field: 'year', op: 'between' }] }, /a start, an end, or both/],
      [{ profile: 'kids', conditions: [{ field: 'rating', op: 'all', values: ['G'] }] }, /doesn’t fit/],
    ];
    for (const [rule, msg] of bad) expect((await t.req('PUT', '/choices/movie', { rules: [rule] })).body.message, JSON.stringify(rule)).toMatch(msg);
    expect((await t.req('PUT', '/choices/books', { rules: [] })).status).toBe(400);
    expect((await call(t.app, 'GET', '/api/settings/profiles/choices')).status).toBe(401);
  });

  it('checks a draft: how many titles each rule picks, and why for a title', async () => {
    const t = await admin();
    addMovie(t.db, 'Up', { genres: ['Animation', 'Family'], certification: 'PG', year: 2009 });
    addMovie(t.db, 'Inside Out 2', { genres: ['Animation', 'Family'], certification: 'PG', year: 2024 });
    addMovie(t.db, 'Dune: Part Two', { genres: ['Science Fiction'], year: 2024 });
    const rules = [
      { profile: 'cinema', conditions: [{ field: 'genre', op: 'any', values: ['Animation'] }, { field: 'year', op: 'between', min: 2010, max: null }] },
      { profile: 'kids', conditions: [{ field: 'genre', op: 'any', values: ['Animation', 'Family'] }] },
    ];
    const res = (await t.req('POST', '/choices/movie/check', { rules, query: 'in' })).body as ChoicesCheckView;
    expect(res.counts).toEqual({ rules: [1, 1], rest: 1 });
    expect(res.titles.map((x) => [x.title, x.picked, x.profile, x.rules])).toEqual([['Inside Out 2', 1, 'cinema', [[true, true], [true]]]]);
    // Nothing was saved.
    expect(listChoices(t.db, 'movie')).toHaveLength(2);
    expect(listChoices(t.db, 'movie')[0]!.profile).toBe('everyday-hd');
  });

  it('previews and applies the rules to the library, leaving hand-picked profiles alone', async () => {
    const t = await admin();
    const up = addMovie(t.db, 'Up', { genres: ['Animation', 'Family'], certification: 'G', year: 2009 });
    const doc = addMovie(t.db, 'Free Solo', { genres: ['Documentary'], certification: 'PG-13', year: 2018 });
    addMovie(t.db, 'Dune: Part Two', { genres: ['Science Fiction'], certification: 'PG-13', year: 2024 });
    const mine = addMovie(t.db, 'Toy Story', { genres: ['Animation', 'Family'], certification: 'G', year: 1995 });
    expect((await call(t.app, 'PUT', `/api/movies/${mine.id}/profile`, { profile: 'cinema' }, t.cookie)).body).toMatchObject({ byHand: true });

    const preview = (await t.req('GET', '/choices/movie/preview')).body.changes as ProfileChangeView[];
    expect(preview.map((c) => [c.title, c.from, c.to, c.rule])).toEqual([
      ['Up', 'cinema', 'kids', 2],
      ['Free Solo', 'cinema', 'everyday-hd', 1],
    ]);
    expect(t.db.select().from(schema.movies).all().every((m) => m.profile === 'cinema')).toBe(true);

    expect((await t.req('POST', '/choices/movie/apply', {})).body).toEqual({ changed: 2 });
    const profile = (id: number) => t.db.select().from(schema.movies).all().find((m) => m.id === id)!.profile;
    expect([profile(up.id), profile(doc.id), profile(mine.id)]).toEqual(['kids', 'everyday-hd', 'cinema']);

    const back = await call(t.app, 'PUT', `/api/movies/${mine.id}/profile`, { profile: null }, t.cookie);
    expect(back.body).toEqual({ ok: true, profile: 'kids', byHand: false });
    expect((await call(t.app, 'GET', `/api/movies/${mine.id}`, undefined, t.cookie)).body).toMatchObject({ profile: 'kids', profileByHand: false });
  });

  it('works for shows too', async () => {
    const t = await admin();
    addShow(t.db, 'Bluey', { genres: ['Animation', 'Kids'], certification: 'TV-Y' });
    addShow(t.db, 'Severance', { genres: ['Drama'], certification: 'TV-MA' });
    const preview = (await t.req('GET', '/choices/tv/preview')).body.changes as ProfileChangeView[];
    expect(preview.map((c) => [c.title, c.to])).toEqual([['Bluey', 'kids']]);
  });
});

describe('Kids & Cartoons for TV', () => {
  it('takes small 1080p encodes and goes down to SD, so older cartoons still turn up', () => {
    const v = PRESETS.find((p) => p.kind === 'tv' && p.key === 'kids')!.build();
    expect(v.tiers.filter((t) => t.allowed).map((t) => t.name)).toEqual(['1080p Compact']);
    expect(v.tiers[0]!.qualities).toEqual(expect.arrayContaining(['WEBDL-1080p', 'Bluray-720p', 'WEBDL-480p', 'DVD', 'SDTV']));
    expect(v.cutoff).toBe('1080p Compact');
    expect(v.sizes).toEqual({});
  });
});

