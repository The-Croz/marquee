import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { CollectionView, DiscoverTitle, ListItemView, ListsView, ListView, RequestView } from '@marquee/shared';
import { schema } from '../src/db/index.js';
import { followCollections } from '../src/library/collections.js';
import { parseListUrl, type ListFetch } from '../src/library/lists.js';
import { searchesSettled } from '../src/requests/service.js';
import { COLLECTIONS, FakeTmdb, MOVIES } from './fakes/tmdb.js';
import { call, makeApp, setupAdmin } from './helpers.js';

const NOW = Date.parse('2026-11-23T12:00:00Z');

/** Our own made-up pages for each list site, by address. */
function fakeWeb() {
  const pages = new Map<string, { status: number; text: string }>();
  const asked: { url: string; headers: Record<string, string> }[] = [];
  const fetchPage: ListFetch = async (url, headers = {}) => {
    asked.push({ url, headers });
    return pages.get(url) ?? { status: 404, text: 'not here' };
  };
  const set = (url: string, body: unknown, status = 200) => pages.set(url, { status, text: typeof body === 'string' ? body : JSON.stringify(body) });
  return { fetchPage, set, asked };
}

async function setup() {
  const web = fakeWeb();
  const t = makeApp({ now: () => NOW, clients: { tmdb: () => new FakeTmdb(), listFetch: web.fetchPage } });
  const admin = await setupAdmin(t.app);
  await call(t.app, 'PUT', '/api/settings/services', { tmdbApiKey: 'good-key' }, admin);
  const person = async (username: string, role: 'member' | 'kid') => {
    await call(t.app, 'POST', '/api/users', { username, displayName: username[0]!.toUpperCase() + username.slice(1), role, password: `${username} password` }, admin);
    const cookie = (await call(t.app, 'POST', '/api/auth/login', { username, password: `${username} password` })).cookie!;
    const row = t.db.select().from(schema.users).where(eq(schema.users.username, username)).get()!;
    return { cookie, id: row.id };
  };
  return { ...t, admin, web, person };
}

const episodesOf = (t: Awaited<ReturnType<typeof setup>>, seriesId: number) =>
  t.db.select().from(schema.episodes).where(eq(schema.episodes.seriesId, seriesId)).all().filter((e) => e.monitored).map((e) => `S${e.season}E${e.episode}`).sort();

describe('Which episodes of a show', () => {
  it('adds a show with a choice: only new episodes, the latest season, the first season, or nothing', async () => {
    const t = await setup();
    const add = await call(t.app, 'POST', '/api/library/add', { kind: 'series', tmdbId: 95396, preset: 'future' }, t.admin);
    expect(add.status).toBe(201);
    const id = add.body.id as number;
    // Severance: S1E1–2 aired in 2022, S2E1 in 2025, S2E2 is still to come.
    expect(episodesOf(t, id)).toEqual(['S2E2']);
    const set = (preset: string) => call(t.app, 'PUT', `/api/shows/${id}/episodes-wanted`, { preset }, t.admin);
    expect((await set('latest')).body).toEqual({ wanted: 2 });
    expect(episodesOf(t, id)).toEqual(['S2E1', 'S2E2']);
    await set('first');
    expect(episodesOf(t, id)).toEqual(['S1E1', 'S1E2']);
    expect(t.db.select().from(schema.series).where(eq(schema.series.id, id)).get()).toMatchObject({ monitored: true, wantNew: false });
    await set('none');
    expect(t.db.select().from(schema.series).where(eq(schema.series.id, id)).get()!.monitored).toBe(false);
    await set('all');
    expect(episodesOf(t, id)).toEqual(['S1E1', 'S1E2', 'S2E1', 'S2E2']);
    expect((await set('sometimes')).status).toBe(400);
  });

  it('later seasons follow the choice: "the first season" doesn’t want new ones, the others do', async () => {
    const t = await setup();
    const id = (await call(t.app, 'POST', '/api/library/add', { kind: 'series', tmdbId: 82728, preset: 'first' }, t.admin)).body.id as number;
    const { SHOWS } = await import('./fakes/tmdb.js');
    const bluey = SHOWS.find((s) => s.tmdbId === 82728)!;
    bluey.episodes.push({ season: 2, episode: 1, title: 'Dance Mode', airDate: '2026-12-01', overview: null });
    try {
      await t.scanner.upsertSeries(new FakeTmdb(), 82728, null, NOW);
      expect(episodesOf(t, id)).toEqual(['S1E1', 'S1E2', 'S1E3']);
      await call(t.app, 'PUT', `/api/shows/${id}/episodes-wanted`, { preset: 'latest' }, t.admin);
      expect(episodesOf(t, id)).toEqual(['S2E1']);
    } finally {
      bluey.episodes.pop();
    }
  });

  it('an admin approves a show with a choice instead of seasons', async () => {
    const t = await setup();
    const jessie = await t.person('jessie', 'member');
    const r = (await call(t.app, 'POST', '/api/requests', { kind: 'series', tmdbId: 95396 }, jessie.cookie)).body as RequestView;
    const ok = await call(t.app, 'POST', `/api/requests/${r.id}/approve`, { preset: 'latest' }, t.admin);
    expect(ok.status).toBe(200);
    await searchesSettled();
    const show = t.db.select().from(schema.series).where(eq(schema.series.tmdbId, 95396)).get()!;
    expect(episodesOf(t, show.id)).toEqual(['S2E1', 'S2E2']);
    // An admin's own request can carry the choice too.
    await call(t.app, 'POST', '/api/requests', { kind: 'series', tmdbId: 82728, preset: 'future' }, t.admin);
    await searchesSettled();
    const bluey = t.db.select().from(schema.series).where(eq(schema.series.tmdbId, 82728)).get()!;
    expect(episodesOf(t, bluey.id)).toEqual([]);
    expect(bluey.monitored).toBe(true);
  });
});

describe('Collections', () => {
  it('shows a collection with where each film stands, and the title page links to it', async () => {
    const t = await setup();
    await call(t.app, 'POST', '/api/library/add', { kind: 'movie', tmdbId: 603, wanted: true }, t.admin);
    const v = (await call(t.app, 'GET', '/api/collections/2344', undefined, t.admin)).body as CollectionView;
    expect(v).toMatchObject({ name: 'The Matrix Collection', wanted: false });
    expect(v.parts.map((p) => [p.title, p.libraryId !== null, p.wanted, p.released])).toEqual([
      ['The Matrix', true, true, true],
      ['The Matrix Reloaded', false, false, true],
      ['The Matrix Revolutions', false, false, true],
    ]);
    const title = (await call(t.app, 'GET', '/api/discover/title/movie/603', undefined, t.admin)).body as DiscoverTitle;
    expect(title.collection).toEqual({ tmdbId: 2344, name: 'The Matrix Collection' });
    expect((await call(t.app, 'GET', '/api/collections/999', undefined, t.admin)).status).toBe(404);
  });

  it('wants the whole collection, and adds new films in it as they’re announced', async () => {
    const t = await setup();
    const res = await call(t.app, 'POST', '/api/collections/2344/want', { followNew: true }, t.admin);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ wanted: true, added: 3, nowWanted: 3 });
    expect(t.db.select().from(schema.movies).all().map((m) => [m.title, m.monitored, m.collectionTmdbId])).toEqual([
      ['The Matrix', true, 2344],
      ['The Matrix Reloaded', true, 2344],
      ['The Matrix Revolutions', true, 2344],
    ]);
    // A film you remove later isn't brought back; a new one TMDB lists is added.
    t.db.delete(schema.movies).where(eq(schema.movies.tmdbId, 604)).run();
    MOVIES.push({ tmdbId: 624860, imdbId: 'tt10838180', title: 'The Matrix Resurrections', year: 2021, certification: 'R', posterPath: '/res.jpg', popularity: 50, collection: 2344 });
    try {
      const deps = { db: t.db, tmdb: new FakeTmdb(), scanner: t.scanner, now: () => NOW };
      expect(await followCollections(deps)).toEqual({ checked: 1, added: 1, problems: [] });
      expect(t.db.select().from(schema.movies).all().map((m) => m.title).sort()).toEqual(['The Matrix', 'The Matrix Resurrections', 'The Matrix Revolutions']);
      await call(t.app, 'POST', '/api/collections/2344/stop', {}, t.admin);
      expect(await followCollections(deps)).toEqual({ checked: 0, added: 0, problems: [] });
    } finally {
      MOVIES.pop();
    }
  });

  it('kids see only films in the library that are for them; only admins want collections', async () => {
    const t = await setup();
    const kid = await t.person('kiddo', 'kid');
    await call(t.app, 'POST', '/api/library/add', { kind: 'movie', tmdbId: 603 }, t.admin);
    expect(((await call(t.app, 'GET', '/api/collections/2344', undefined, kid.cookie)).body as CollectionView).parts).toEqual([]);
    expect((await call(t.app, 'POST', '/api/collections/2344/want', { followNew: true }, kid.cookie)).status).toBe(403);
    expect(COLLECTIONS.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- lists

const PLEX = 'https://discover.provider.plex.tv/library/sections/watchlist/all?includeGuids=1&X-Plex-Container-Start=0&X-Plex-Container-Size=100';
const watchlist = (items: object[]) => ({ MediaContainer: { totalSize: items.length, Metadata: items } });

describe('Plex watchlists', () => {
  it('what each person adds to their Plex watchlist becomes their request, approved by role as usual', async () => {
    const t = await setup();
    const jessie = await t.person('jessie', 'member');
    const kiddo = await t.person('kiddo', 'kid');
    t.db.update(schema.users).set({ plexId: 'p1', plexToken: 'jessie-token' }).where(eq(schema.users.id, jessie.id)).run();
    t.db.update(schema.users).set({ plexId: 'p2', plexToken: 'kid-token' }).where(eq(schema.users.id, kiddo.id)).run();
    t.web.set(PLEX, watchlist([{ type: 'movie', title: 'Dune: Part Two', year: 2024, Guid: [{ id: 'tmdb://693134' }] }, { type: 'show', title: 'Bluey', year: 2018, ratingKey: 'abc' }, { type: 'episode', title: 'skip me' }]));
    t.web.set('https://discover.provider.plex.tv/library/metadata/abc', watchlist([{ type: 'show', Guid: [{ id: 'tvdb://353546' }, { id: 'imdb://tt7678620' }] }]));
    const res = await call(t.app, 'PUT', `/api/lists/watchlists/${jessie.id}`, { on: true }, t.admin);
    const me = (res.body as ListsView).people.find((p) => p.userId === jessie.id)!;
    expect(me).toMatchObject({ plexLinked: true, canRead: true, watchlist: { kind: 'plex_watchlist', lastOk: true, lastMessage: '2 on the list, 2 new, 2 asked for.' } });
    expect(t.web.asked[0]!.headers['X-Plex-Token']).toBe('jessie-token');
    const mine = (await call(t.app, 'GET', '/api/requests', undefined, jessie.cookie)).body.items as RequestView[];
    expect(mine.map((r) => [r.title, r.state])).toEqual(expect.arrayContaining([['Dune: Part Two', 'pending'], ['Bluey', 'pending']]));
    // Read again: nothing new happens.
    const again = (await call(t.app, 'POST', `/api/lists/${me.watchlist!.id}/sync`, {}, t.admin)).body as ListView;
    expect(again.lastMessage).toBe('2 on the list, nothing new.');
    // A kid's watchlist: titles not for kids are left out and say so.
    t.web.set(PLEX, watchlist([{ type: 'movie', title: 'The Matrix', Guid: [{ id: 'tmdb://603' }] }]));
    const kidList = ((await call(t.app, 'PUT', `/api/lists/watchlists/${kiddo.id}`, { on: true }, t.admin)).body as ListsView).people.find((p) => p.userId === kiddo.id)!.watchlist!;
    const items = (await call(t.app, 'GET', `/api/lists/${kidList.id}/items`, undefined, t.admin)).body.items as ListItemView[];
    expect(items.map((i) => [i.title, i.outcomeText])).toEqual([['The Matrix', 'Not for kid profiles']]);
  });

  it('an admin’s watchlist goes straight through; a person who never signed in with Plex is told how', async () => {
    const t = await setup();
    const sam = await t.person('sam', 'member');
    t.db.update(schema.users).set({ plexId: 'p3' }).where(eq(schema.users.id, sam.id)).run();
    const v = (await call(t.app, 'PUT', `/api/lists/watchlists/${sam.id}`, { on: true }, t.admin)).body as ListsView;
    expect(v.people.find((p) => p.userId === sam.id)!.watchlist!.lastMessage).toMatch(/Sam needs to sign in to Marquee with Plex once/);
    const josh = t.db.select().from(schema.users).where(eq(schema.users.username, 'josh')).get()!;
    expect((await call(t.app, 'PUT', `/api/lists/watchlists/${josh.id}`, { on: true }, t.admin)).body.message).toMatch(/hasn’t linked Plex/);
    t.db.update(schema.users).set({ plexId: 'p0', plexToken: 'josh-token' }).where(eq(schema.users.id, josh.id)).run();
    t.web.set(PLEX, watchlist([{ type: 'movie', title: 'Up', Guid: [{ id: 'tmdb://14160' }] }]));
    await call(t.app, 'PUT', `/api/lists/watchlists/${josh.id}`, { on: true }, t.admin);
    await searchesSettled();
    expect(t.db.select().from(schema.movies).where(eq(schema.movies.tmdbId, 14160)).get()).toMatchObject({ monitored: true });
    // Plex turning the token down says what to do.
    t.web.set(PLEX, 'no', 401);
    const list = (await call(t.app, 'GET', '/api/lists', undefined, t.admin)).body.people.find((p: { userId: number }) => p.userId === josh.id).watchlist as ListView;
    expect(((await call(t.app, 'POST', `/api/lists/${list.id}/sync`, {}, t.admin)).body as ListView).lastMessage).toMatch(/Plex turned down their sign-in/);
  });
});

describe('Trakt, IMDb and Letterboxd lists', () => {
  it('checks list addresses and says what a good one looks like', () => {
    expect(parseListUrl('trakt', 'https://trakt.tv/users/josh/lists/family-night/')).toEqual({ url: 'https://trakt.tv/users/josh/lists/family-night', name: 'Trakt: family night' });
    expect(parseListUrl('imdb', 'https://www.imdb.com/list/ls012345678/?ref_=x').url).toBe('https://www.imdb.com/list/ls012345678/');
    expect(parseListUrl('letterboxd', 'https://letterboxd.com/josh/watchlist/').name).toBe('josh’s Letterboxd watchlist');
    expect(() => parseListUrl('imdb', 'https://www.imdb.com/title/tt0133093/')).toThrow(/IMDb list address/);
    expect(() => parseListUrl('trakt', 'not a link')).toThrow(/isn’t a web address/);
  });

  it('Trakt: needs an app key, then adds new titles as Wanted with the list’s profile and episodes choice', async () => {
    const t = await setup();
    t.web.set('https://api.trakt.tv/users/josh/lists/favs/items', [
      { type: 'movie', movie: { title: 'Blade Runner', year: 1982, ids: { tmdb: 78 } } },
      { type: 'show', show: { title: 'Severance', year: 2022, ids: { tmdb: null, imdb: 'tt11280740', tvdb: 371980 } } },
      { type: 'person', person: {} },
    ]);
    const made = await call(t.app, 'POST', '/api/lists', { kind: 'trakt', url: 'https://trakt.tv/users/josh/lists/favs', profile: 'everyday-hd', showPreset: 'future' }, t.admin);
    expect(made.status).toBe(201);
    expect((made.body as ListView).lastMessage).toMatch(/Add a Trakt app key/);
    await call(t.app, 'PUT', '/api/lists/trakt-key', { clientId: 'trakt-client' }, t.admin);
    const synced = (await call(t.app, 'POST', `/api/lists/${made.body.id}/sync`, {}, t.admin)).body as ListView;
    expect(synced).toMatchObject({ lastOk: true, lastMessage: '2 on the list, 2 new, 2 added.', added: 2 });
    expect(t.web.asked.at(-1)!.headers['trakt-api-key']).toBe('trakt-client');
    expect(t.db.select().from(schema.movies).where(eq(schema.movies.tmdbId, 78)).get()).toMatchObject({ monitored: true, profile: 'everyday-hd' });
    const sev = t.db.select().from(schema.series).where(eq(schema.series.tmdbId, 95396)).get()!;
    expect(episodesOf(t, sev.id)).toEqual(['S2E2']);
    expect((await call(t.app, 'POST', '/api/lists', { kind: 'trakt', url: 'https://trakt.tv/users/josh/lists/favs' }, t.admin)).status).toBe(409);
  });

  it('IMDb: reads the titles on a public list; unknown ones are counted, excluded ones are skipped', async () => {
    const t = await setup();
    await call(t.app, 'POST', '/api/lists/exclusions', { kind: 'movie', tmdbId: 604, title: 'The Matrix Reloaded', year: 2003 }, t.admin);
    t.web.set('https://www.imdb.com/list/ls000000001/', '<a href="/title/tt0133093/">The Matrix</a> <a href="/title/tt0234215/?ref=1">Reloaded</a> <a href="/title/tt0133093/">again</a> <a href="/title/tt9999999/">?</a> <a href="/title/tt7678620/">Bluey</a>');
    const list = (await call(t.app, 'POST', '/api/lists', { kind: 'imdb', url: 'https://www.imdb.com/list/ls000000001' }, t.admin)).body as ListView;
    expect(list.lastMessage).toBe('4 on the list, 3 new, 2 added, 1 not found on TMDB.');
    const items = (await call(t.app, 'GET', `/api/lists/${list.id}/items`, undefined, t.admin)).body.items as ListItemView[];
    expect(Object.fromEntries(items.map((i) => [i.title, i.outcomeText]))).toEqual({ Bluey: 'Added and Wanted', 'The Matrix': 'Added and Wanted', 'The Matrix Reloaded': 'On the exclusions list' });
    const view = (await call(t.app, 'DELETE', '/api/lists/exclusions/movie/604', undefined, t.admin)).body as ListsView;
    expect(view.exclusions).toEqual([]);
    // Stopping a list removes nothing from the library.
    await call(t.app, 'DELETE', `/api/lists/${list.id}`, undefined, t.admin);
    expect(t.db.select().from(schema.movies).all().map((m) => m.title)).toEqual(['The Matrix']);
  });

  it('Letterboxd: reads every page, looks each film up once, and says when the list isn’t there', async () => {
    const t = await setup();
    t.web.set('https://letterboxd.com/josh/list/pixar/', '<div data-film-slug="up"></div><div data-target-link="/film/inside-out-2/"></div>');
    t.web.set('https://letterboxd.com/josh/list/pixar/page/2/', '<div data-film-slug="the-matrix"></div>');
    t.web.set('https://letterboxd.com/film/up/', '<body data-tmdb-id="14160" data-tmdb-type="movie">');
    t.web.set('https://letterboxd.com/film/inside-out-2/', '<body data-tmdb-id="1022789" data-tmdb-type="movie">');
    t.web.set('https://letterboxd.com/film/the-matrix/', '<body data-tmdb-id="603" data-tmdb-type="movie">');
    const list = (await call(t.app, 'POST', '/api/lists', { kind: 'letterboxd', url: 'https://letterboxd.com/josh/list/pixar/' }, t.admin)).body as ListView;
    expect(list.lastMessage).toBe('3 on the list, 3 new, 3 added.');
    const filmPages = () => t.web.asked.filter((a) => a.url.includes('/film/')).length;
    expect(filmPages()).toBe(3);
    await call(t.app, 'POST', `/api/lists/${list.id}/sync`, {}, t.admin);
    expect(filmPages()).toBe(3);
    const gone = (await call(t.app, 'POST', '/api/lists', { kind: 'letterboxd', url: 'https://letterboxd.com/josh/list/nope/' }, t.admin)).body as ListView;
    expect(gone).toMatchObject({ lastOk: false, lastMessage: 'Letterboxd says there’s no such list. Check the address, and that it’s public. Marquee tries again by itself.' });
  });

  it('is for admins only', async () => {
    const t = await setup();
    const jessie = await t.person('jessie', 'member');
    expect((await call(t.app, 'GET', '/api/lists', undefined, jessie.cookie)).status).toBe(403);
    expect((await call(t.app, 'PUT', '/api/shows/1/episodes-wanted', { preset: 'all' }, jessie.cookie)).status).toBe(403);
  });
});
