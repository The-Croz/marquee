import { describe, expect, it } from 'vitest';
import type { HomeData } from '@marquee/shared';
import { schema } from '../src/db/index.js';
import { call, makeApp, setupAdmin } from './helpers.js';

const NOW = Date.parse('2026-11-19T12:00:00Z');

async function setup() {
  const t = makeApp({ now: () => NOW });
  const cookie = await setupAdmin(t.app);
  const movie = (title: string, tmdbId: number) =>
    t.db.insert(schema.movies).values({ tmdbId, title, sortTitle: title.toLowerCase(), year: 2024, profile: 'cinema', addedAt: 0, refreshedAt: 0, posterPath: `/${tmdbId}.jpg` }).returning().get();
  const home = async (c = cookie) => (await call(t.app, 'GET', '/api/home', undefined, c)).body as HomeData;
  return { ...t, cookie, movie, home };
}

describe('Home', () => {
  it('is empty and calm on a new install', async () => {
    const t = await setup();
    const h = await t.home();
    expect(h).toMatchObject({ needsYou: [], watching: [], onItsWay: [], myRequests: [], recent: [], upcoming: [] });
    expect(h.stats.slice(0, 2)).toEqual([
      { label: 'movies', value: '0', to: '/library/movies' },
      { label: 'shows', value: '0', to: '/library/shows' },
    ]);
    expect(h.stats.find((s) => s.label === 'Automatic searching')).toMatchObject({ value: 'off', to: '/settings/automation' });
  });

  it('puts downloads on their way, and broken ones under Needs you', async () => {
    const t = await setup();
    const dune = t.movie('Dune: Part Two', 693134);
    const up = t.movie('Up', 14160);
    t.db.insert(schema.downloads).values({ kind: 'movie', movieId: dune.id, title: 'Dune.Part.Two.2160p', infoHash: 'a', addedAt: NOW, state: 'downloading', progress: 0.4 }).run();
    t.db.insert(schema.downloads).values({ kind: 'movie', movieId: up.id, title: 'Up.1080p', infoHash: 'b', addedAt: NOW, state: 'done', progress: 1, importError: 'Marquee isn’t allowed to write there.' }).run();
    t.db.insert(schema.downloads).values({ kind: 'movie', movieId: up.id, title: 'Up.720p', infoHash: 'c', addedAt: NOW, state: 'removed' }).run();
    const h = await t.home();
    expect(h.onItsWay).toMatchObject([{ title: 'Dune: Part Two (2024)', href: `/movies/${dune.id}`, posterPath: '/693134.jpg', percent: 40 }]);
    expect(h.needsYou).toMatchObject([{ tone: 'problem', title: 'Up (2024) · Couldn’t put it in your library', posterPath: '/14160.jpg', to: '/downloads' }]);
  });

  it('lists failing Sources and folders that need a match, problems first', async () => {
    const t = await setup();
    t.db.insert(schema.scanItems).values({ kind: 'movie', path: '/m/Odd.Folder', seenAt: 0 }).run();
    t.db.insert(schema.sources).values({ name: 'TPB', url: 'http://tpb.test/api', state: 'unreachable', retryAt: NOW + 3_600_000, createdAt: 0 }).run();
    t.db.insert(schema.sources).values({ name: 'Paused', url: 'http://p.test/api', state: 'key_refused', enabled: false, createdAt: 0 }).run();
    const h = await t.home();
    expect(h.needsYou.map((n) => [n.key, n.tone, n.to])).toEqual([
      [expect.stringMatching(/^source-/), 'problem', '/settings/sources'],
      ['unmatched', 'attention', '/library/unmatched'],
    ]);
    expect(h.needsYou[0]!.title).toMatch(/^TPB: /);
    expect(h.needsYou[0]!.detail).toMatch(/^Tries again by itself at /);
    expect(h.needsYou[1]!.title).toBe('1 folder needs a match');
  });

  it('shows members their own requests and nothing of the household', async () => {
    const t = await setup();
    await call(t.app, 'POST', '/api/users', { username: 'ana', displayName: 'Ana', role: 'member', password: 'ana password!' }, t.cookie);
    const ana = (await call(t.app, 'POST', '/api/auth/login', { username: 'ana', password: 'ana password!' })).cookie;
    const anaId = t.db.select().from(schema.users).all().find((u) => u.username === 'ana')!.id;
    t.db.insert(schema.requests).values({ kind: 'movie', tmdbId: 1, title: 'Wicked', year: 2024, requestedBy: anaId, createdAt: NOW }).run();
    t.db.insert(schema.scanItems).values({ kind: 'movie', path: '/m/Odd.Folder', seenAt: 0 }).run();
    const h = await t.home(ana);
    expect(h.myRequests).toMatchObject([{ title: 'Wicked', state: 'pending' }]);
    expect(h.needsYou).toEqual([]);
    expect(h.stats.map((s) => s.label)).toEqual(['movies', 'shows', 'episode files', 'added this week']);
    // The admin sees Ana's request as something to approve.
    expect((await t.home()).needsYou.map((n) => n.title)).toContain('Ana asked for Wicked');
  });

  it('leads the banner with what was added, with its backdrop', async () => {
    const t = await setup();
    const dune = t.movie('Dune: Part Two', 693134);
    t.db.update(schema.movies).set({ backdropPath: '/dune-bg.jpg' }).run();
    t.db.insert(schema.mediaFiles).values({ path: '/m/Dune/Dune.mkv', movieId: dune.id, size: 1, mtime: 0, addedAt: NOW - 2 * 3_600_000, seenAt: 0, resolution: '2160p' }).run();
    const h = await t.home();
    expect(h.hero).toMatchObject({ kind: 'arrived', eyebrow: 'Recently added · today', title: 'Dune: Part Two', href: `/movies/${dune.id}`, backdropPath: '/dune-bg.jpg', posterPath: '/693134.jpg' });
    expect(h.heroes[0]).toEqual(h.hero);
    t.db.update(schema.mediaFiles).set({ addedAt: NOW - 4 * 86_400_000 }).run();
    expect((await t.home()).hero?.eyebrow).toBe('Recently added · 4 days ago');
  });

  it('rotates through what was added, aired, coming and unwatched, never the same title twice, and never who is watching', async () => {
    const t = await setup();
    const file = (v: Partial<typeof schema.mediaFiles.$inferInsert>, age: number) =>
      t.db.insert(schema.mediaFiles).values({ path: `/m/${Math.random()}.mkv`, size: 1, mtime: 0, addedAt: NOW - age, seenAt: 0, ...v }).run();
    const titles = ['Alpha', 'Bravo', 'Charlie', 'Delta'].map((n, i) => t.movie(n, 100 + i));
    titles.forEach((m, i) => file({ movieId: m.id }, (i + 1) * 3_600_000));
    const show = t.db.insert(schema.series).values({ tmdbId: 7, title: 'Severance', sortTitle: 'severance', profile: 'cinema', addedAt: 0, refreshedAt: 0 }).returning().get();
    t.db.insert(schema.episodes).values({ seriesId: show.id, season: 2, episode: 4, title: 'Four', airDate: '2026-11-18' } as never).run();
    file({ seriesId: show.id, season: 2, episodes: '[4]' }, 30 * 86_400_000);
    t.db.insert(schema.plays).values({ server: 'plex', serverUserId: '1', userName: 'josh', itemKey: 'a', kind: 'movie', title: 'Alpha', playedAt: NOW }).run();
    const h = await t.home();
    expect(h.heroes.map((s) => s.kind)).toEqual(['arrived', 'arrived', 'aired', 'unwatched', 'random']);
    expect(h.heroes[2]).toMatchObject({ title: 'Severance', eyebrow: 'Recently aired · Nov 18', note: 'Season 2, episode 4' });
    expect(h.heroes[3]!.title).not.toBe('Alpha');
    expect(new Set(h.heroes.map((s) => s.href)).size).toBe(h.heroes.length);
    // The same picks for the rest of the hour.
    expect((await t.home()).heroes).toEqual(h.heroes);
  });

  it('puts something you asked for first once it arrives', async () => {
    const t = await setup();
    const m = t.movie('Wicked', 402431);
    t.db.insert(schema.mediaFiles).values({ path: '/m/w.mkv', movieId: m.id, size: 1, mtime: 0, addedAt: NOW, seenAt: 0 }).run();
    const me = t.db.select().from(schema.users).all()[0]!.id;
    t.db.insert(schema.requests).values({ kind: 'movie', tmdbId: 402431, title: 'Wicked', requestedBy: me, status: 'approved', titleId: m.id, readyAt: NOW - 3_600_000, createdAt: 0 }).run();
    const h = await t.home();
    expect(h.heroes.map((s) => [s.kind, s.title])).toEqual([['ready', 'Wicked']]);
  });

  it('keeps grown-up titles off a kid’s banner', async () => {
    const t = await setup();
    await call(t.app, 'POST', '/api/users', { username: 'kiddo', displayName: 'Kiddo', role: 'kid', password: 'kiddo password!' }, t.cookie);
    const kid = (await call(t.app, 'POST', '/api/auth/login', { username: 'kiddo', password: 'kiddo password!' })).cookie;
    const m = t.movie('Heat', 949);
    t.db.update(schema.movies).set({ certification: 'R' }).run();
    t.db.insert(schema.mediaFiles).values({ path: '/m/heat.mkv', movieId: m.id, size: 1, mtime: 0, addedAt: NOW, seenAt: 0 }).run();
    expect((await t.home(kid)).heroes).toEqual([]);
  });

  it('walks a new admin through getting set up, and goes away once the musts are done', async () => {
    const t = await setup();
    const steps = (h: HomeData) => h.setup?.map((s) => [s.key, s.done, !!s.optional]);
    expect(steps(await t.home())).toEqual([
      ['tmdb', false, false],
      ['scan', false, false],
      ['downloader', false, false],
      ['sources', false, false],
      ['mediaServer', false, true],
      ['people', false, true],
    ]);
    expect((await t.home()).setup![0]).toMatchObject({ title: 'Add your TMDB key', to: '/settings/services' });

    t.db.insert(schema.settings).values({ key: 'services.tmdb_api_key', value: 'k' }).run();
    t.movie('Up', 14160);
    t.db.insert(schema.settings).values({ key: 'downloader.url', value: 'http://qbit.test' }).run();
    expect(steps(await t.home())!.slice(0, 4).map((s) => s[1])).toEqual([true, true, true, false]);

    t.db.insert(schema.sources).values({ name: 'TPB', url: 'http://tpb.test/api', state: 'working', createdAt: 0 }).run();
    // The optional steps alone don't keep the checklist on Home.
    expect((await t.home()).setup).toBeNull();
  });

  it('never shows the checklist to members', async () => {
    const t = await setup();
    await call(t.app, 'POST', '/api/users', { username: 'ana', displayName: 'Ana', role: 'member', password: 'ana password!' }, t.cookie);
    const ana = (await call(t.app, 'POST', '/api/auth/login', { username: 'ana', password: 'ana password!' })).cookie;
    expect((await t.home(ana)).setup).toBeNull();
  });
});
