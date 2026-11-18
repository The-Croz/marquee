import { describe, expect, it } from 'vitest';
import type { ProfileChangeView, ProfileChoicesView } from '@marquee/shared';
import { openDb, schema, setSetting } from '../src/db/index.js';
import { choose } from '../src/releases/choose.js';
import { seedProfiles } from '../src/releases/profiles.js';
import { call, makeApp, setupAdmin } from './helpers.js';

type Db = ReturnType<typeof makeApp>['db'];

function addMovie(db: Db, title: string, genres: string[], certification: string | null, profile = 'cinema', tmdbId = Math.floor(Math.random() * 1e9)) {
  return db.insert(schema.movies).values({ tmdbId, title, sortTitle: title.toLowerCase(), genres: JSON.stringify(genres), certification, profile, addedAt: 0, refreshedAt: 0 }).returning().get();
}
function addShow(db: Db, title: string, genres: string[], certification: string | null, profile = 'cinema') {
  return db.insert(schema.series).values({ tmdbId: Math.floor(Math.random() * 1e9), title, sortTitle: title.toLowerCase(), genres: JSON.stringify(genres), certification, profile, addedAt: 0, refreshedAt: 0 }).returning().get();
}

async function admin() {
  const t = makeApp();
  const cookie = await setupAdmin(t.app);
  return { ...t, cookie, req: (method: string, path: string, body?: unknown) => call(t.app, method, `/api/settings/profiles${path}`, body, cookie) };
}

describe('which profile a title gets', () => {
  it('starts with rules by kind of title, falling back to 4K Quality', async () => {
    const { db } = await admin();
    const cases: [string, 'movie' | 'tv', string[], string | null, string][] = [
      ['Up', 'movie', ['Animation', 'Family', 'Adventure'], 'PG', 'kids'],
      ['Spider-Verse', 'movie', ['Animation', 'Action'], 'PG-13', 'cinema'],
      ['Free Solo', 'movie', ['Documentary'], 'PG-13', 'everyday-hd'],
      ['Dune: Part Two', 'movie', ['Science Fiction', 'Adventure'], 'PG-13', 'cinema'],
      ['Bluey', 'tv', ['Animation', 'Kids', 'Family'], 'TV-Y', 'kids'],
      ['Sesame Street', 'tv', ['Family'], 'TV-Y', 'kids'],
      ['Survivor', 'tv', ['Reality'], 'TV-PG', 'everyday-hd'],
      ['Severance', 'tv', ['Drama', 'Mystery', 'Sci-Fi & Fantasy'], 'TV-MA', 'cinema'],
      ['No rating', 'tv', ['Comedy'], null, 'cinema'],
    ];
    for (const [title, kind, genres, certification, want] of cases) expect(choose(db, kind, { genres, certification }).profile, title).toBe(want);
  });

  it('calls the Cinema preset 4K Quality, renaming it once unless you renamed it', () => {
    const db = openDb(':memory:');
    seedProfiles(db, 0);
    expect(db.select().from(schema.profiles).all().filter((p) => p.preset === 'cinema').map((p) => p.name)).toEqual(['4K Quality', '4K Quality']);
    // A database from before the rename.
    const old = openDb(':memory:');
    setSetting(old, 'profiles.seeded', '1');
    old.insert(schema.profiles).values({ kind: 'movie', key: 'cinema', name: 'Cinema', preset: 'cinema', tiers: '[]', cutoff: 'x', createdAt: 0, updatedAt: 0 }).run();
    old.insert(schema.profiles).values({ kind: 'tv', key: 'cinema', name: 'Big Screen', preset: 'cinema', tiers: '[]', cutoff: 'x', createdAt: 0, updatedAt: 0 }).run();
    seedProfiles(old, 0);
    expect(old.select().from(schema.profiles).all().map((p) => p.name)).toEqual(['4K Quality', 'Big Screen']);
    old.update(schema.profiles).set({ name: 'Cinema' }).run();
    seedProfiles(old, 0);
    expect(old.select().from(schema.profiles).all().map((p) => p.name)).toEqual(['Cinema', 'Cinema']);
  });

  it('lists, edits and checks the rules', async () => {
    const t = await admin();
    const view = (await t.req('GET', '/choices')).body as ProfileChoicesView;
    expect(view.rules.movie).toHaveLength(2);
    expect(view.rules.tv[2]).toEqual({ profile: 'everyday-hd', genres: ['Reality', 'Talk', 'News', 'Soap', 'Documentary'], ratings: [] });
    expect(view.genres.tv).toContain('Kids');
    expect(view.ratings.movie).toEqual(['G', 'PG', 'PG-13', 'R', 'NC-17', 'NR']);

    const res = await t.req('PUT', '/choices/tv', { rules: [{ profile: 'everyday-hd', genres: ['Drama'], ratings: [] }] });
    expect(res.body.rules).toEqual([{ profile: 'everyday-hd', genres: ['Drama'], ratings: [] }]);
    expect(choose(t.db, 'tv', { genres: ['Drama'], certification: 'TV-MA' })).toEqual({ profile: 'everyday-hd', rule: 1 });
    expect((await t.req('PUT', '/choices/tv', { rules: [{ profile: 'nope', genres: ['Drama'], ratings: [] }] })).body.message).toMatch(/Rule 1 points at a profile that doesn't exist/);
    expect((await t.req('PUT', '/choices/tv', { rules: [{ profile: 'kids', genres: [], ratings: [] }] })).body.message).toMatch(/would match everything/);
    expect((await t.req('PUT', '/choices/books', { rules: [] })).status).toBe(400);
    expect((await call(t.app, 'GET', '/api/settings/profiles/choices')).status).toBe(401);
  });

  it('previews and applies the rules to the library, leaving hand-picked profiles alone', async () => {
    const t = await admin();
    const up = addMovie(t.db, 'Up', ['Animation', 'Family'], 'G');
    const doc = addMovie(t.db, 'Free Solo', ['Documentary'], 'PG-13');
    addMovie(t.db, 'Dune: Part Two', ['Science Fiction'], 'PG-13');
    const mine = addMovie(t.db, 'Coco', ['Animation', 'Family'], 'PG');
    expect((await call(t.app, 'PUT', `/api/movies/${mine.id}/profile`, { profile: 'cinema' }, t.cookie)).body).toMatchObject({ byHand: true });

    const preview = (await t.req('GET', '/choices/movie/preview')).body.changes as ProfileChangeView[];
    expect(preview.map((c) => [c.title, c.from, c.to, c.rule])).toEqual([
      ['Up', 'cinema', 'kids', 1],
      ['Free Solo', 'cinema', 'everyday-hd', 2],
    ]);
    // Previewing changes nothing.
    expect(t.db.select().from(schema.movies).all().every((m) => m.profile === 'cinema')).toBe(true);

    expect((await t.req('POST', '/choices/movie/apply', {})).body).toEqual({ changed: 2 });
    const profile = (id: number) => t.db.select().from(schema.movies).all().find((m) => m.id === id)!.profile;
    expect([profile(up.id), profile(doc.id), profile(mine.id)]).toEqual(['kids', 'everyday-hd', 'cinema']);
    expect(((await t.req('GET', '/choices/movie/preview')).body.changes as unknown[]).length).toBe(0);

    // Handing Coco back to the rules picks Kids & Cartoons.
    const back = await call(t.app, 'PUT', `/api/movies/${mine.id}/profile`, { profile: null }, t.cookie);
    expect(back.body).toEqual({ ok: true, profile: 'kids', byHand: false });
    expect((await call(t.app, 'GET', `/api/movies/${mine.id}`, undefined, t.cookie)).body).toMatchObject({ profile: 'kids', profileByHand: false });
  });

  it('works for shows too', async () => {
    const t = await admin();
    addShow(t.db, 'Bluey', ['Animation', 'Kids'], 'TV-Y');
    addShow(t.db, 'Severance', ['Drama'], 'TV-MA');
    const preview = (await t.req('GET', '/choices/tv/preview')).body.changes as ProfileChangeView[];
    expect(preview.map((c) => [c.title, c.to])).toEqual([['Bluey', 'kids']]);
  });
});
