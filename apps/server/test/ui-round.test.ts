import { beforeEach, describe, expect, it } from 'vitest';
import type { CalendarView, DownloadDetails, DownloadsView, HomeData } from '@marquee/shared';
import { schema } from '../src/db/index.js';
import { StreamingAvailabilityClient, readTop, resetStreamingTop } from '../src/discover/streamingTop.js';
import { trackerHost } from '../src/downloads/monitor.js';
import { SERVICES, TmdbClient } from '../src/library/tmdb.js';
import { comingUp } from '../src/library/airing.js';
import { FakeQbit } from './fakes/qbittorrent.js';
import { FakeTmdb } from './fakes/tmdb.js';
import { call, makeApp, setupAdmin } from './helpers.js';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

describe('TMDB: services and release kinds', () => {
  it('asks for any of a service’s ids, so Paramount+ includes its Essential and Premium plans', async () => {
    const urls: string[] = [];
    const tmdb = new TmdbClient('k', null, (async (u: string) => {
      urls.push(u);
      return new Response(JSON.stringify({ results: [] }));
    }) as typeof fetch);
    await tmdb.discover('movie', { provider: SERVICES.find((s) => s.key === 'paramount')!.ids });
    const q = new URL(urls[0]!).searchParams;
    expect(q.get('with_watch_providers')).toBe('531|2303|2616');
    expect(q.get('watch_region')).toBe('US');
  });

  it('“out to stream or buy” filters on the US digital release date', async () => {
    const urls: string[] = [];
    const tmdb = new TmdbClient('k', null, (async (u: string) => {
      urls.push(u);
      return new Response(JSON.stringify({ results: [] }));
    }) as typeof fetch);
    await tmdb.discover('movie', { releaseType: 'digital', from: '2026-10-20', to: '2026-11-19' });
    const q = new URL(urls[0]!).searchParams;
    expect(q.get('with_release_type')).toBe('4');
    expect(q.get('release_date.gte')).toBe('2026-10-20');
    expect(q.get('primary_release_date.gte')).toBeNull();
  });

  it('reads a movie’s first US cinema, digital and disc dates', async () => {
    const tmdb = new TmdbClient('k', null, (async () =>
      new Response(
        JSON.stringify({
          id: 1, imdb_id: null, title: 'X', original_title: 'X', release_date: '2026-12-18', overview: '', poster_path: null, backdrop_path: null, runtime: 100, genres: [],
          release_dates: { results: [{ iso_3166_1: 'US', release_dates: [
            { certification: 'PG-13', type: 3, release_date: '2026-12-18T00:00:00.000Z' },
            { certification: '', type: 4, release_date: '2027-02-03T00:00:00.000Z' },
            { certification: '', type: 4, release_date: '2027-01-20T00:00:00.000Z' },
            { certification: '', type: 5, release_date: '2027-03-10T00:00:00.000Z' },
          ] }] },
        }),
      )) as typeof fetch);
    expect(await tmdb.movie(1)).toMatchObject({ cinemaRelease: '2026-12-18', digitalRelease: '2027-01-20', physicalRelease: '2027-03-10', certification: 'PG-13' });
  });
});

describe('Streaming Availability client', () => {
  beforeEach(() => resetStreamingTop());
  const quick = { gapMs: 0, sleep: async () => {} };
  it('reads TMDB ids from a top list, keeping its order and only the asked-for kind', () => {
    const body = [{ tmdbId: 'tv/1399', title: 'A' }, { tmdbId: 'movie/550', title: 'B' }, { tmdbId: 'movie/551', title: 'C' }, { tmdbId: 'movie/550', title: 'B again' }, { tmdbId: 'odd' }];
    expect(readTop(body, 'movie').map((t) => t.tmdbId)).toEqual([550, 551]);
    expect(readTop({ shows: body }, 'series').map((t) => t.tmdbId)).toEqual([1399]);
    expect(readTop('nonsense', 'movie')).toEqual([]);
  });

  it('tries RapidAPI first, then Movie of the Night’s own address, keeps the answer 12 hours and an old one while it’s down', async () => {
    const t = makeApp();
    let now = NOW;
    let down = false;
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (u: string, init: RequestInit) => {
      seen.push({ url: u, headers: init.headers as Record<string, string> });
      if (down) throw new Error('ECONNREFUSED');
      if (u.startsWith('https://streaming-availability.p.rapidapi.com')) return new Response('{}', { status: 403 });
      return new Response(JSON.stringify([{ tmdbId: 'movie/550' }, { tmdbId: 'movie/603' }]));
    }) as typeof fetch;
    const c = new StreamingAvailabilityClient('secret-key', t.db, () => now, fetchImpl, quick);
    expect((await c.top('netflix', 'movie')).map((x) => x.tmdbId)).toEqual([550, 603]);
    expect(seen.map((s) => new URL(s.url).host)).toEqual(['streaming-availability.p.rapidapi.com', 'api.movieofthenight.com']);
    expect(seen[1]!.headers['X-API-Key']).toBe('secret-key');
    expect(new URL(seen[1]!.url).searchParams.get('service')).toBe('netflix');
    expect(new URL(seen[1]!.url).searchParams.get('show_type')).toBe('movie');
    await c.top('netflix', 'movie');
    expect(seen).toHaveLength(2);
    now += 13 * 3_600_000;
    down = true;
    expect((await c.top('netflix', 'movie')).map((x) => x.tmdbId)).toEqual([550, 603]);
  });

  it('says plainly when the key is turned down', async () => {
    const t = makeApp();
    const c = new StreamingAvailabilityClient('bad', t.db, () => NOW, (async () => new Response('{}', { status: 401 })) as typeof fetch, quick);
    await expect(c.top('netflix', 'series')).rejects.toThrow(/turned the key down/);
  });

  it('asks one call at a time with a gap, since free keys allow about one a second', async () => {
    const t = makeApp();
    let now = NOW;
    const at: number[] = [];
    const waits: number[] = [];
    const fetchImpl = (async (u: string) => {
      at.push(now);
      if (u.includes('rapidapi')) return new Response('{}', { status: 403 });
      return new Response(JSON.stringify([{ tmdbId: 'movie/1' }, { tmdbId: 'tv/2' }]));
    }) as typeof fetch;
    const sleep = async (ms: number) => void (waits.push(ms), (now += ms));
    const c = new StreamingAvailabilityClient('k', t.db, () => now, fetchImpl, { gapMs: 1100, sleep });
    await Promise.all([c.top('netflix', 'movie'), c.top('netflix', 'series')]);
    // RapidAPI turned it down, then Movie of the Night answered; never two at once.
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(1100);
    // A new client (Marquee makes one per request) remembers which address the key works on.
    at.length = 0;
    const again = new StreamingAvailabilityClient('k', t.db, () => now, fetchImpl, { gapMs: 1100, sleep });
    await again.top('hbo', 'movie');
    expect(at).toHaveLength(1);
  });

  it('a 429 is waited out and tried once more; two in a row pause it for a few minutes with a plain reason', async () => {
    const t = makeApp();
    const now = NOW;
    let busy = 1;
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (busy-- > 0) return new Response('{}', { status: 429, headers: { 'retry-after': '1' } });
      return new Response(JSON.stringify([{ tmdbId: 'movie/7' }]));
    }) as typeof fetch;
    const c = new StreamingAvailabilityClient('k2', t.db, () => now, fetchImpl, quick);
    expect((await c.top('disney', 'movie')).map((x) => x.tmdbId)).toEqual([7]);
    expect(calls).toBe(2);

    busy = 99;
    calls = 0;
    await expect(c.top('disney', 'series')).rejects.toThrow(/asked Marquee to slow down/);
    const before = calls;
    await expect(c.top('hulu', 'series')).rejects.toThrow(/slow down/);
    expect(calls).toBe(before);
  });
});

describe('Calendar: Wanted movies', () => {
  it('shows a Wanted movie’s cinema, digital and disc dates with what happens next, and leaves unwanted ones out', async () => {
    const t = makeApp({ now: () => NOW });
    const cookie = await setupAdmin(t.app);
    const m = t.db
      .insert(schema.movies)
      .values({ tmdbId: 1, title: 'Coming Soon', sortTitle: 'coming soon', year: 2026, profile: 'cinema', monitored: true, addedAt: 0, refreshedAt: 0, releaseDate: iso(NOW + 2 * DAY), cinemaRelease: iso(NOW + 2 * DAY), digitalRelease: iso(NOW + 5 * DAY), physicalRelease: iso(NOW + 40 * DAY) })
      .returning()
      .get();
    t.db.insert(schema.movies).values({ tmdbId: 2, title: 'Not Wanted', sortTitle: 'not wanted', profile: 'cinema', monitored: false, addedAt: 0, refreshedAt: 0, digitalRelease: iso(NOW + 3 * DAY) }).run();
    t.db.insert(schema.movies).values({ tmdbId: 3, title: 'Out Today', sortTitle: 'out today', profile: 'cinema', monitored: true, addedAt: 0, refreshedAt: 0, releaseDate: iso(NOW - 60 * DAY), digitalRelease: iso(NOW) }).run();
    const v = (await call(t.app, 'GET', `/api/calendar?from=${iso(NOW)}&days=14`, undefined, cookie)).body as CalendarView;
    expect(v.items.map((i) => [i.kind, i.show, i.title, i.state])).toEqual([
      ['movie', 'Out Today', 'Out to stream or buy', 'missing'],
      ['movie', 'Coming Soon', 'In cinemas', 'coming'],
      ['movie', 'Coming Soon', 'Out to stream or buy', 'coming'],
    ]);
    expect(v.items[1]).toMatchObject({ movieId: m.id, seriesId: null, note: expect.stringMatching(/once it’s out to stream or buy/) });

    const week = comingUp(t.db, NOW);
    expect(week.map((w) => w.title)).toEqual(['Out Today · Out to stream or buy', 'Coming Soon · In cinemas', 'Coming Soon · Out to stream or buy']);
    expect(week[0]).toMatchObject({ day: 'Today', href: expect.stringMatching(/^\/movies\/\d+$/) });

    // A movie already in the library just says so.
    t.db.insert(schema.mediaFiles).values({ path: '/m/x.mkv', movieId: m.id, size: 1, mtime: 0, addedAt: NOW, seenAt: 0 }).run();
    const again = (await call(t.app, 'GET', `/api/calendar?from=${iso(NOW)}&days=14`, undefined, cookie)).body as CalendarView;
    expect(again.items.filter((i) => i.movieId === m.id).every((i) => i.state === 'have')).toBe(true);
  });
});

describe('Home: recent requests and the banner’s facts', () => {
  it('lists the newest requests in every state, and the banner carries year, rating, length, genres, description and score', async () => {
    const t = makeApp({ now: () => NOW, clients: { tmdb: () => new FakeTmdb() } });
    const admin = await setupAdmin(t.app);
    await call(t.app, 'PUT', '/api/settings/services', { tmdbApiKey: 'good-key' }, admin);
    const dune = t.db
      .insert(schema.movies)
      .values({ tmdbId: 693134, title: 'Dune: Part Two', sortTitle: 'dune', year: 2024, certification: 'PG-13', runtime: 166, genres: JSON.stringify(['Science Fiction', 'Adventure']), overview: 'Paul joins the Fremen.', profile: 'cinema', addedAt: 0, refreshedAt: 0 })
      .returning()
      .get();
    t.db.insert(schema.mediaFiles).values({ path: '/m/Dune.mkv', movieId: dune.id, size: 1, mtime: 0, addedAt: NOW - 3_600_000, seenAt: 0, resolution: '2160p' }).run();
    const ask = (title: string, tmdbId: number, status: 'pending' | 'approved' | 'declined', at: number) =>
      t.db.insert(schema.requests).values({ kind: 'movie', tmdbId, title, status, requestedBy: 1, createdAt: at }).run();
    ask('Up', 14160, 'pending', NOW - 1000);
    ask('The Matrix', 603, 'declined', NOW - 2000);
    ask('Inside Out 2', 1022789, 'approved', NOW - 3000);
    const h = (await call(t.app, 'GET', '/api/home', undefined, admin)).body as HomeData;
    expect(h.recentRequests.map((r) => [r.title, r.state])).toEqual([
      ['Up', 'pending'],
      ['The Matrix', 'declined'],
      ['Inside Out 2', expect.stringMatching(/looking|unreleased|downloading/)],
    ]);
    expect(h.hero).toMatchObject({ kind: 'arrived', year: 2024, rating: 'PG-13', runtime: 166, genres: ['Science Fiction', 'Adventure'], overview: 'Paul joins the Fremen.', score: 8.1, kindLabel: 'Movie' });
  });
});

describe('Downloads: more from qBittorrent', () => {
  async function setup() {
    const qbit = new FakeQbit();
    const t = makeApp({ now: () => NOW, clients: { qbittorrent: (u, n, p) => qbit.as(u, n, p) } });
    const admin = await setupAdmin(t.app);
    await call(t.app, 'PUT', '/api/settings/downloader', { url: qbit.url, username: 'admin', password: 'adminadmin' }, admin);
    const d = t.db.insert(schema.downloads).values({ kind: 'movie', title: 'Up.2009.1080p', infoHash: 'aa', addedAt: NOW - DAY, state: 'downloading', progress: 0.2 }).returning().get();
    qbit.list.push({
      hash: 'aa', name: 'Up.2009.1080p', category: 'marquee', state: 'downloading', progress: 0.5, size: 4e9, savePath: '/data/torrents', downloadSpeed: 2e6, eta: 600,
      seedsConnected: 12, seedsKnown: 40, contentPath: '/data/torrents/Up.2009.1080p', ratio: 0.3, seedingSeconds: 0,
      uploadSpeed: 1e5, peersConnected: 3, peersKnown: 9, downloaded: 2e9, uploaded: 6e8, addedOn: NOW - DAY, completedOn: null, tracker: 'https://tracker.example/abc123secret/announce', tags: ['marquee'], activeSeconds: 3600,
    });
    qbit.fileLists.set('aa', [{ name: 'Up.2009.1080p/Up.mkv', size: 4e9, progress: 0.5 }]);
    return { t, admin, d, qbit };
  }

  it('the list carries speeds, people, ratio and what was shared', async () => {
    const { t, admin } = await setup();
    const v = (await call(t.app, 'GET', '/api/downloads', undefined, admin)).body as DownloadsView;
    expect(v.items[0]).toMatchObject({ speed: 2e6, uploadSpeed: 1e5, eta: 600, seeds: 40, peers: 9, ratio: 0.3, uploaded: 6e8 });
  });

  it('a download’s details come live from qBittorrent, with only the tracker’s host', async () => {
    const { t, admin, d, qbit } = await setup();
    const r = (await call(t.app, 'GET', `/api/downloads/${d.id}`, undefined, admin)).body as DownloadDetails;
    expect(r.note).toBeNull();
    expect(r.live).toMatchObject({ savePath: '/data/torrents', category: 'marquee', tracker: 'tracker.example', seedsConnected: 12, peersKnown: 9, files: [{ name: 'Up.2009.1080p/Up.mkv', progress: 0.5 }] });
    expect(JSON.stringify(r)).not.toContain('abc123secret');
    qbit.list = [];
    const gone = (await call(t.app, 'GET', `/api/downloads/${d.id}`, undefined, admin)).body as DownloadDetails;
    expect(gone).toMatchObject({ live: null, note: expect.stringMatching(/doesn’t have this one any more/) });
    expect((await call(t.app, 'GET', '/api/downloads/999', undefined, admin)).status).toBe(404);
  });

  it('keeps tracker keys out', () => {
    expect(trackerHost('udp://open.tracker.test:1337/announce')).toBe('open.tracker.test');
    expect(trackerHost('')).toBeNull();
    expect(trackerHost('not a url')).toBeNull();
  });
});
