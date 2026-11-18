import { describe, expect, it } from 'vitest';
import type { CutoverView } from '@marquee/shared';
import { schema } from '../src/db/index.js';
import { lookForWanted, wantedTick } from '../src/downloads/wanted.js';
import { FakeMediaServer } from './fakes/mediaServers.js';
import { FakeQbit, fakeFetchTorrent } from './fakes/qbittorrent.js';
import { FakeRadarr } from './fakes/radarr.js';
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
  const radarr = new FakeRadarr();
  const plex = new FakeMediaServer('plex');
  let clock = Date.parse('2026-11-18T12:00:00Z');
  const t = makeApp({
    now: () => clock,
    clients: {
      torznab: sites.torznab,
      qbittorrent: (u, n, p) => qbit.as(u, n, p),
      fetchTorrent: fakeFetchTorrent(),
      arr: () => radarr,
      radarrHistory: () => radarr,
      plexServer: (u, k) => plex.as(u, k),
    },
  });
  const cookie = await setupAdmin(t.app);
  await call(t.app, 'POST', '/api/settings/sources', { name: 'TPB', url: 'http://tpb.test/api', apiKey: 'good' }, cookie);
  const movie = (title: string, year: number, tmdbId: number, runtime: number, extra: Partial<typeof schema.movies.$inferInsert> = {}) =>
    t.db.insert(schema.movies).values({ tmdbId, title, sortTitle: title.toLowerCase(), year, runtime, profile: 'cinema', addedAt: tmdbId, refreshedAt: 0, ...extra }).returning().get();
  const dune = movie('Dune: Part Two', 2024, 693134, 166);
  const up = movie('Up', 2009, 14160, 96);
  const view = async () => (await call(t.app, 'GET', '/api/cutover', undefined, cookie)).body as CutoverView;
  const deps = () => ({ db: t.db, clients: { qbittorrent: (u: string, n: string, p: string) => qbit.as(u, n, p), fetchTorrent: fakeFetchTorrent() }, sources: t.sources, now: () => clock });
  const connect = () => call(t.app, 'PUT', '/api/settings/downloader', { url: qbit.url, username: 'admin', password: 'adminadmin' }, cookie);
  return { ...t, cookie, qbit, radarr, plex, dune, up, view, deps, connect, later: (ms: number) => (clock += ms), now: () => clock };
}

const state = (v: CutoverView) => Object.fromEntries(v.steps.map((s) => [s.key, s.state]));

describe('switch-over checklist', () => {
  it('starts with what to do for each step', async () => {
    const t = await setup();
    const v = await t.view();
    expect(state(v)).toEqual({ agree: 'todo', downloader: 'todo', import: 'todo', media: 'todo', radarr_queue: 'unknown', radarr_off: 'unknown', take_over: 'todo' });
    expect(v.ready).toBe(false);
    expect(v.steps.find((s) => s.key === 'radarr_queue')!.detail).toMatch(/Connect Radarr \(read-only\)/);
    for (const s of v.steps) expect(s.detail.length).toBeGreaterThan(10);
    expect(v.steps.find((s) => s.key === 'import')!.action).toEqual({ label: 'Find a movie to add', to: '/search?kind=movie' });
  });

  it('is ready when Marquee agrees, downloads, imports, tells Plex and Radarr has stopped', async () => {
    const t = await setup();
    await t.connect();
    for (let i = 0; i < 10; i++) {
      t.db.insert(schema.comparisons).values({ radarrHistoryId: i, radarrMovieId: 1, title: 'x', grabbedAt: t.now() - i * HOUR, status: 'done', verdict: i < 9 ? 'same' : 'higher', radarr: '{}' }).run();
    }
    t.db.insert(schema.downloads).values({ kind: 'movie', movieId: t.up.id, title: UP_1080, infoHash: 'h', addedAt: 0, state: 'done', importedAt: 1 }).run();
    await call(t.app, 'PUT', '/api/settings/services', { plexUrl: 'http://plex:32400', plexToken: 'plex-token', radarrUrl: 'http://radarr:7878', radarrApiKey: 'k' }, t.cookie);
    t.radarr.movies = [{ title: 'Up', monitored: false }];
    const v = await t.view();
    expect(state(v)).toMatchObject({ agree: 'done', downloader: 'done', import: 'done', media: 'done', radarr_queue: 'done', radarr_off: 'done', take_over: 'todo' });
    expect(v.ready).toBe(true);
    expect(v.steps[0]!.detail).toBe('Agreed on 9 of 10 downloads in the last two weeks (90%).');
  });

  it('says what still needs doing in Radarr', async () => {
    const t = await setup();
    await call(t.app, 'PUT', '/api/settings/services', { radarrUrl: 'http://radarr:7878', radarrApiKey: 'k' }, t.cookie);
    t.radarr.queue = 2;
    t.radarr.movies = [{ title: 'Up', monitored: true }, { title: 'Dune', monitored: true }, { title: 'Old', monitored: false }];
    t.db.insert(schema.comparisons).values({ radarrHistoryId: 1, radarrMovieId: 1, title: 'x', grabbedAt: t.now(), status: 'done', verdict: 'lower', radarr: '{}' }).run();
    const v = await t.view();
    const step = (k: string) => v.steps.find((s) => s.key === k)!;
    expect(step('agree')).toMatchObject({ state: 'warn', detail: 'Agreed on 0 of 1 downloads in the last two weeks (0%). Wait for at least 10.' });
    expect(step('radarr_queue')).toMatchObject({ state: 'warn', detail: expect.stringMatching(/still has 2 downloads on the way/) });
    expect(step('radarr_off')).toMatchObject({ state: 'todo', detail: expect.stringMatching(/still watches 2 movies\. In Radarr: Movies → Select Movies/) });
    t.radarr.fail = 'Radarr rejected the API key.';
    expect((await t.view()).steps.find((s) => s.key === 'radarr_queue')).toMatchObject({ state: 'unknown', detail: 'Radarr rejected the API key.' });
  });
});

describe('Marquee looks for wanted movies', () => {
  it('sends the best copy for movies with no file, leaving unwatched and busy ones alone', async () => {
    const t = await setup();
    await t.connect();
    t.db.insert(schema.movies).values({ tmdbId: 1, title: 'Unwatched', sortTitle: 'unwatched', year: 2020, profile: 'cinema', addedAt: 0, refreshedAt: 0, monitored: false }).run();
    t.db.insert(schema.downloads).values({ kind: 'movie', movieId: t.up.id, title: UP_1080, infoHash: 'busy', addedAt: 0, state: 'downloading' }).run();
    const run = await lookForWanted(t.deps(), 'missing');
    expect(run).toMatchObject({ kind: 'missing', searched: 1, problems: [] });
    expect(run.sent).toEqual([{ movieId: t.dune.id, title: 'Dune: Part Two (2024)', copy: DUNE_4K }]);
    expect(t.qbit.added).toHaveLength(1);
    // Dune now has a download on the way, so the next run skips it.
    expect((await lookForWanted(t.deps(), 'missing')).searched).toBe(0);
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
    const put = await call(t.app, 'PUT', '/api/cutover', { lookForWanted: true }, t.cookie);
    expect(put.body).toMatchObject({ lookingForWanted: true });
    expect((await wantedTick(t.deps()))!.kind).toBe('missing');
    expect((await wantedTick(t.deps()))!.kind).toBe('better');
    expect(await wantedTick(t.deps())).toBeNull();
    t.later(6 * HOUR);
    expect((await wantedTick(t.deps()))!.kind).toBe('missing');
    expect(await wantedTick(t.deps())).toBeNull();
    const v = await t.view();
    expect(v.runs.map((r) => r.kind)).toEqual(['missing', 'better', 'missing']);
    expect(v.steps.at(-1)).toMatchObject({ key: 'take_over', state: 'done' });
  });

  it('says why when qBittorrent isn’t connected, and Look now runs at once', async () => {
    const t = await setup();
    const r = await call(t.app, 'POST', '/api/cutover/look-now', { kind: 'missing' }, t.cookie);
    expect(r.body).toMatchObject({ searched: 0, problems: [expect.stringMatching(/qBittorrent isn’t connected/)] });
    await t.connect();
    const again = await call(t.app, 'POST', '/api/cutover/look-now', { kind: 'missing' }, t.cookie);
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
