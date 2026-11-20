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
    expect(h.stats.map((s) => s.label)).toEqual(['movies', 'shows']);
    // The admin sees Ana's request as something to approve.
    expect((await t.home()).needsYou.map((n) => n.title)).toContain('Ana asked for Wicked');
  });

  it('leads with what just arrived, with its backdrop, for three days', async () => {
    const t = await setup();
    const dune = t.movie('Dune: Part Two', 693134);
    t.db.update(schema.movies).set({ backdropPath: '/dune-bg.jpg' }).run();
    t.db.insert(schema.mediaFiles).values({ path: '/m/Dune/Dune.mkv', movieId: dune.id, size: 1, mtime: 0, addedAt: NOW - 2 * 3_600_000, seenAt: 0, resolution: '2160p' }).run();
    const h = await t.home();
    expect(h.hero).toMatchObject({ kind: 'arrived', eyebrow: 'Just arrived · 2 hours ago', title: 'Dune: Part Two', href: `/movies/${dune.id}`, backdropPath: '/dune-bg.jpg', posterPath: '/693134.jpg' });
    t.db.update(schema.mediaFiles).set({ addedAt: NOW - 4 * 86_400_000 }).run();
    expect((await t.home()).hero).toBeNull();
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
