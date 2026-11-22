import { describe, expect, it } from 'vitest';
import type { AutomationView } from '@marquee/shared';
import { schema } from '../src/db/index.js';
import { lookForWanted, wantedTick } from '../src/downloads/wanted.js';
import { FakeMediaServer } from './fakes/mediaServers.js';
import { FakeQbit, fakeFetchTorrent } from './fakes/qbittorrent.js';
import { FakeSites, release } from './fakes/sources.js';
import { call, makeApp, setupAdmin } from './helpers.js';

const GB = 1024 ** 3;
const HOUR = 3_600_000;
const DUNE_4K = 'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX';
const UP_1080 = 'Up.2009.1080p.BluRay.x264-GRP';
const UP_4K = 'Up.2009.2160p.UHD.BluRay.x265.HDR.DDP5.1-GRP';

async function setup() {
  const sites = new FakeSites();
  sites.feed('http://tpb.test/api', { releases: [release(DUNE_4K, { size: 25 * GB }), release(UP_1080, { size: 8 * GB }), release(UP_4K, { size: 18 * GB })] });
  const qbit = new FakeQbit();
  const plex = new FakeMediaServer('plex');
  let clock = Date.parse('2026-11-18T12:00:00Z');
  const t = makeApp({
    now: () => clock,
    clients: {
      torznab: sites.torznab,
      qbittorrent: (u, n, p) => qbit.as(u, n, p),
      fetchTorrent: fakeFetchTorrent(),
      plexServer: (u, k) => plex.as(u, k),
    },
  });
  const cookie = await setupAdmin(t.app);
  await call(t.app, 'POST', '/api/settings/sources', { name: 'TPB', url: 'http://tpb.test/api', apiKey: 'good' }, cookie);
  const movie = (title: string, year: number, tmdbId: number, runtime: number, extra: Partial<typeof schema.movies.$inferInsert> = {}) =>
    t.db.insert(schema.movies).values({ tmdbId, title, sortTitle: title.toLowerCase(), year, runtime, profile: 'cinema', addedAt: tmdbId, refreshedAt: 0, ...extra }).returning().get();
  const dune = movie('Dune: Part Two', 2024, 693134, 166);
  const up = movie('Up', 2009, 14160, 96);
  const view = async () => (await call(t.app, 'GET', '/api/automation', undefined, cookie)).body as AutomationView;
  const deps = () => ({ db: t.db, clients: { qbittorrent: (u: string, n: string, p: string) => qbit.as(u, n, p), fetchTorrent: fakeFetchTorrent() }, sources: t.sources, now: () => clock });
  const connect = () => call(t.app, 'PUT', '/api/settings/downloader', { url: qbit.url, username: 'admin', password: 'adminadmin' }, cookie);
  return { ...t, cookie, qbit, plex, dune, up, view, deps, connect, later: (ms: number) => (clock += ms), now: () => clock };
}

describe('Marquee looks for wanted movies', () => {
  it('sends the best copy for movies with no file, leaving unwatched and busy ones alone', async () => {
    const t = await setup();
    await t.connect();
    t.db.insert(schema.movies).values({ tmdbId: 1, title: 'Unwatched', sortTitle: 'unwatched', year: 2020, profile: 'cinema', addedAt: 0, refreshedAt: 0, monitored: false }).run();
    t.db.insert(schema.downloads).values({ kind: 'movie', movieId: t.up.id, title: UP_1080, infoHash: 'busy', addedAt: 0, state: 'downloading' }).run();
    const run = await lookForWanted(t.deps(), 'missing');
    expect(run).toMatchObject({ kind: 'missing', searched: 1, problems: [] });
    expect(run.sent).toEqual([{ href: `/movies/${t.dune.id}`, title: 'Dune: Part Two (2024)', copy: DUNE_4K }]);
    expect(t.qbit.added).toHaveLength(1);
    // Dune now has a download on the way, so the next run skips it.
    expect((await lookForWanted(t.deps(), 'missing')).searched).toBe(0);
  });

  it('sends nothing when the downloads disk would go under the minimum free, and says why', async () => {
    const t = await setup();
    await t.connect();
    const full = async () => ({ free: 30 * GB, total: 4000 * GB });
    const run = await lookForWanted({ ...t.deps(), clients: { ...t.deps().clients, disk: full } }, 'missing');
    expect(t.qbit.added).toHaveLength(0);
    expect(run.sent).toEqual([]);
    expect(run.problems.join(' ')).toMatch(/Not enough room on the downloads disk \(\/data\/torrents\): 30\.0 GB free, this needs 25\.0 GB, and Marquee keeps 20 GB spare/);
    // Lower the minimum (For experts) and it goes.
    await call(t.app, 'PUT', '/api/system/disk', { minFreeGb: 1 }, t.cookie);
    const again = await lookForWanted({ ...t.deps(), clients: { ...t.deps().clients, disk: full } }, 'missing');
    expect(again.sent.map((s) => s.copy).sort()).toEqual([DUNE_4K, UP_4K].sort());
  });

  it('checks movies you have and sends a copy only when it beats your file', async () => {
    const t = await setup();
    await t.connect();
    t.db.insert(schema.mediaFiles).values({ path: '/m/Up (2009)/Up (2009) Bluray-1080p.mkv', movieId: t.up.id, size: GB, mtime: 0, addedAt: 0, seenAt: 0 }).run();
    t.db.insert(schema.mediaFiles).values({ path: `/m/Dune/${DUNE_4K}.mkv`, movieId: t.dune.id, size: GB, mtime: 0, addedAt: 0, seenAt: 0 }).run();
    const run = await lookForWanted(t.deps(), 'better');
    expect(run.searched).toBe(2);
    expect(run.sent.map((s) => s.copy)).toEqual([UP_4K]);
  });

  it('runs missing every 6 hours and better copies daily, only when turned on', async () => {
    const t = await setup();
    await t.connect();
    expect(await wantedTick(t.deps())).toBeNull();
    const put = await call(t.app, 'PUT', '/api/automation', { movies: true }, t.cookie);
    expect(put.body).toMatchObject({ movies: { on: true }, tv: { on: false } });
    expect((await wantedTick(t.deps()))!.kind).toBe('missing');
    expect((await wantedTick(t.deps()))!.kind).toBe('better');
    expect(await wantedTick(t.deps())).toBeNull();
    t.later(6 * HOUR);
    expect((await wantedTick(t.deps()))!.kind).toBe('missing');
    expect(await wantedTick(t.deps())).toBeNull();
    const v = await t.view();
    expect(v.movies.runs.map((r) => r.kind)).toEqual(['missing', 'better', 'missing']);
  });

  it('says why when qBittorrent isn’t connected, and Look now runs at once', async () => {
    const t = await setup();
    const r = await call(t.app, 'POST', '/api/automation/movies/look-now', { kind: 'missing' }, t.cookie);
    expect(r.body).toMatchObject({ searched: 0, problems: [expect.stringMatching(/qBittorrent isn’t connected/)] });
    await t.connect();
    const again = await call(t.app, 'POST', '/api/automation/movies/look-now', { kind: 'missing' }, t.cookie);
    expect(again.body.sent.map((s: { copy: string }) => s.copy)).toContain(DUNE_4K);
  });

  it('searches the longest-waiting movies first, a few at a time', async () => {
    const t = await setup();
    await t.connect();
    const run = await lookForWanted(t.deps(), 'missing', 1);
    expect(run.searched).toBe(1);
    const after = t.db.select().from(schema.movies).all();
    expect(after.filter((m) => m.lastSearchedAt !== null)).toHaveLength(1);
  });
});

describe('Settings → Automatic searching', () => {
  it('says what is on, how many are Wanted, the limit and what went out', async () => {
    const t = await setup();
    expect(await t.view()).toMatchObject({ movies: { on: false, wanted: 2, runs: [] }, tv: { on: false, wanted: 0, runs: [] }, dailyLimit: 10, sentToday: 0 });
    const put = await call(t.app, 'PUT', '/api/automation', { tv: true, dailyLimit: 3 }, t.cookie);
    expect(put.body).toMatchObject({ movies: { on: false }, tv: { on: true }, dailyLimit: 3 });
    expect((await call(t.app, 'PUT', '/api/automation', { dailyLimit: -1 }, t.cookie)).status).toBe(400);
    await t.connect();
    await lookForWanted(t.deps(), 'missing');
    expect(await t.view()).toMatchObject({ sentToday: 2 }); // both movies have no file
  });

  it('is for admins only', async () => {
    const t = await setup();
    await call(t.app, 'POST', '/api/users', { username: 'jessie', displayName: 'Jessie', role: 'member', password: 'jessie password' }, t.cookie);
    const member = (await call(t.app, 'POST', '/api/auth/login', { username: 'jessie', password: 'jessie password' })).cookie;
    expect((await call(t.app, 'GET', '/api/automation', undefined, member)).status).toBe(403);
    expect((await call(t.app, 'PUT', '/api/automation', { movies: true }, member)).status).toBe(403);
    expect((await call(t.app, 'POST', '/api/automation/movies/look-now', { kind: 'missing' }, member)).status).toBe(403);
    expect((await call(t.app, 'GET', '/api/automation')).status).toBe(401);
  });
});
