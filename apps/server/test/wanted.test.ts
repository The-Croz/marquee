import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { AutomationView, LibraryCard, ShowDetail, WantedRunView } from '@marquee/shared';
import { schema } from '../src/db/index.js';
import { lookForWanted } from '../src/downloads/wanted.js';
import { catchNewEpisodes, lookForWantedTv } from '../src/downloads/wantedTv.js';
import { FakeQbit, fakeFetchTorrent } from './fakes/qbittorrent.js';
import { FakeSites, release } from './fakes/sources.js';
import { FakeTmdb } from './fakes/tmdb.js';
import { call, makeApp, setupAdmin } from './helpers.js';

const GB = 1024 ** 3;
const UP_1080 = 'Up.2009.1080p.BluRay.x264-GRP';
const DUNE_4K = 'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX';
const SEV_E1 = 'Severance.S02E01.1080p.WEB-DL.DDP5.1.H.264-GRP';
const SEV_E2 = 'Severance.S02E02.1080p.WEB-DL.DDP5.1.H.264-GRP';

/** Two movies and Severance (season 1: 4 aired episodes, season 2: 2 aired), all Not wanted to begin with. */
async function setup() {
  const sites = new FakeSites();
  sites.feed('http://tpb.test/api', { releases: [release(UP_1080, { size: 8 * GB }), release(DUNE_4K, { size: 25 * GB }), release(SEV_E1, { size: 2 * GB }), release(SEV_E2, { size: 2 * GB })] });
  const qbit = new FakeQbit();
  let clock = Date.parse('2026-11-18T12:00:00Z');
  const t = makeApp({
    now: () => clock,
    clients: { torznab: sites.torznab, qbittorrent: (u, n, p) => qbit.as(u, n, p), fetchTorrent: fakeFetchTorrent(), tmdb: () => new FakeTmdb() },
  });
  const cookie = await setupAdmin(t.app);
  await call(t.app, 'POST', '/api/settings/sources', { name: 'TPB', url: 'http://tpb.test/api', apiKey: 'good' }, cookie);
  await call(t.app, 'PUT', '/api/settings/downloader', { url: qbit.url, username: 'admin', password: 'adminadmin' }, cookie);
  const movie = (title: string, year: number, tmdbId: number, runtime: number) =>
    t.db.insert(schema.movies).values({ tmdbId, title, sortTitle: title.toLowerCase(), year, runtime, profile: 'cinema', addedAt: tmdbId, refreshedAt: 0, monitored: false }).returning().get();
  const up = movie('Up', 2009, 14160, 96);
  const dune = movie('Dune: Part Two', 2024, 693134, 166);
  const sev = t.db.insert(schema.series).values({ tmdbId: 95396, tvdbId: 371980, title: 'Severance', sortTitle: 'severance', year: 2022, profile: 'cinema', addedAt: 0, refreshedAt: 0, monitored: false }).returning().get();
  for (const [season, n, air] of [[1, 4, '2022-02-18'], [2, 2, '2026-11-10']] as const) {
    for (let e = 1; e <= n; e++) t.db.insert(schema.episodes).values({ seriesId: sev.id, season, episode: e, title: `Episode ${e}`, airDate: air }).run();
  }
  const deps = (preview = false) => ({ db: t.db, clients: { qbittorrent: (u: string, n: string, p: string) => qbit.as(u, n, p), fetchTorrent: fakeFetchTorrent() }, sources: t.sources, now: () => clock, preview });
  const put = (path: string, body: unknown) => call(t.app, 'PUT', path, body, cookie);
  const sent = () => t.db.select().from(schema.downloads).all().map((d) => d.title);
  return { ...t, cookie, qbit, up, dune, sev, deps, put, sent, later: (ms: number) => (clock += ms) };
}

describe('Wanted and not wanted', () => {
  it('nothing is wanted to begin with, so the jobs do nothing', async () => {
    const t = await setup();
    expect((await lookForWanted(t.deps(), 'missing')).searched).toBe(0);
    expect((await lookForWantedTv(t.deps(), 'missing')).searched).toBe(0);
    expect(t.sent()).toEqual([]);
  });

  it('existing titles become Not wanted when the update runs, and new episodes of a wanted show stay wanted', async () => {
    const t = await setup();
    expect(t.db.select().from(schema.movies).all().every((m) => !m.monitored)).toBe(true);
    expect(t.db.select().from(schema.episodes).all().every((e) => e.monitored)).toBe(true);
  });

  it('marking a movie Wanted makes the job look for just that one', async () => {
    const t = await setup();
    expect((await t.put(`/api/movies/${t.up.id}/wanted`, { wanted: true })).status).toBe(200);
    const run = await lookForWanted(t.deps(), 'missing');
    expect(run.searched).toBe(1);
    expect(run.sent.map((s) => s.title)).toEqual(['Up (2009)']);
    expect(t.sent()).toEqual([UP_1080]);
  });

  it('lists show who is wanted, and can filter on it', async () => {
    const t = await setup();
    await t.put(`/api/movies/${t.dune.id}/wanted`, { wanted: true });
    const all = (await call(t.app, 'GET', '/api/movies', undefined, t.cookie)).body.items as LibraryCard[];
    expect(Object.fromEntries(all.map((m) => [m.title, m.wanted]))).toEqual({ Up: false, 'Dune: Part Two': true });
    const yes = (await call(t.app, 'GET', '/api/movies?wanted=yes', undefined, t.cookie)).body.items as LibraryCard[];
    expect(yes.map((m) => m.title)).toEqual(['Dune: Part Two']);
    const no = (await call(t.app, 'GET', '/api/movies?wanted=no', undefined, t.cookie)).body.items as LibraryCard[];
    expect(no.map((m) => m.title)).toEqual(['Up']);
  });

  it('changes many at once, and wanting a whole show wants every episode', async () => {
    const t = await setup();
    const bulk = await call(t.app, 'POST', '/api/movies/wanted', { ids: [t.up.id, t.dune.id], wanted: true }, t.cookie);
    expect(bulk.body).toEqual({ ok: true, changed: 2 });
    await t.put(`/api/shows/${t.sev.id}/seasons/1/episodes/2/wanted`, { wanted: false });
    await t.put(`/api/shows/${t.sev.id}/wanted`, { wanted: true });
    const show = (await call(t.app, 'GET', `/api/shows/${t.sev.id}`, undefined, t.cookie)).body as ShowDetail;
    expect(show.monitored).toBe(true);
    expect(show.seasons.flatMap((s) => s.episodes).every((e) => e.wanted)).toBe(true);
  });

  it('leaving out an episode turns the show on only if you want one, and shows it', async () => {
    const t = await setup();
    await t.put(`/api/shows/${t.sev.id}/seasons/2/wanted`, { wanted: true });
    let show = (await call(t.app, 'GET', `/api/shows/${t.sev.id}`, undefined, t.cookie)).body as ShowDetail;
    expect(show.monitored).toBe(true);
    expect(show.seasons.map((s) => s.episodes.every((e) => e.wanted))).toEqual([true, true]); // season 1 episodes default on, the show gate is what counts
    await t.put(`/api/shows/${t.sev.id}/seasons/2/episodes/1/wanted`, { wanted: false });
    show = (await call(t.app, 'GET', `/api/shows/${t.sev.id}`, undefined, t.cookie)).body as ShowDetail;
    expect(show.seasons[1]!.episodes.map((e) => e.wanted)).toEqual([false, true]);
    expect((await t.put(`/api/shows/${t.sev.id}/seasons/9/wanted`, { wanted: true })).status).toBe(404);
  });

  it('the TV job skips episodes you left out, and never takes a whole season that includes one', async () => {
    const t = await setup();
    await t.put(`/api/shows/${t.sev.id}/wanted`, { wanted: true });
    await t.put(`/api/shows/${t.sev.id}/seasons/1/episodes/4/wanted`, { wanted: false });
    const run = await lookForWantedTv(t.deps(), 'missing');
    const searched = run.sent.map((s) => s.title);
    expect(searched.join(' ')).not.toMatch(/S01E04/);
    expect(searched.join(' ')).not.toMatch(/S01(?!E)/); // no whole-season search for season 1
    const nope = await catchNewEpisodes(t.deps());
    expect(nope.problems).toEqual([]);
  });

  it('only admins can change it', async () => {
    const t = await setup();
    await call(t.app, 'POST', '/api/users', { username: 'jessie', displayName: 'Jessie', role: 'member', password: 'jessie password' }, t.cookie);
    const member = (await call(t.app, 'POST', '/api/auth/login', { username: 'jessie', password: 'jessie password' })).cookie;
    expect((await call(t.app, 'PUT', `/api/movies/${t.up.id}/wanted`, { wanted: true }, member)).status).toBe(403);
    expect((await call(t.app, 'POST', '/api/shows/wanted', { ids: [t.sev.id], wanted: true }, member)).status).toBe(403);
    expect((await call(t.app, 'PUT', '/api/automation', { dailyLimit: 5 }, member)).status).toBe(403);
  });

  it('adding a title is Not wanted unless you say "look for it"', async () => {
    const t = await setup();
    await call(t.app, 'PUT', '/api/settings/services', { tmdbApiKey: 'good-key' }, t.cookie);
    const plain = await call(t.app, 'POST', '/api/library/add', { kind: 'movie', tmdbId: 603 }, t.cookie);
    const wanted = await call(t.app, 'POST', '/api/library/add', { kind: 'movie', tmdbId: 604, wanted: true }, t.cookie);
    expect([plain.status, wanted.status]).toEqual([201, 201]);
    const rows = t.db.select().from(schema.movies).all();
    expect(rows.find((m) => m.id === plain.body.id)!.monitored).toBe(false);
    expect(rows.find((m) => m.id === wanted.body.id)!.monitored).toBe(true);
  });
});

describe('Preview and the daily limit', () => {
  it('a preview says what it would send and sends nothing', async () => {
    const t = await setup();
    await call(t.app, 'POST', '/api/movies/wanted', { ids: [t.up.id], wanted: true }, t.cookie);
    const r = await call(t.app, 'POST', '/api/automation/movies/look-now', { kind: 'missing', preview: true }, t.cookie);
    const run = r.body as WantedRunView;
    expect(run.preview).toBe(true);
    expect(run.sent).toHaveLength(1);
    expect(t.sent()).toEqual([]);
    const view = (await call(t.app, 'GET', '/api/automation', undefined, t.cookie)).body as AutomationView;
    expect(view.movies.runs).toEqual([]); // not remembered
    // and it didn't use up the movie's turn
    expect((await lookForWanted(t.deps(), 'missing')).sent).toHaveLength(1);
  });

  it('stops at the daily limit, says so, and carries on after a day', async () => {
    const t = await setup();
    await call(t.app, 'POST', '/api/movies/wanted', { ids: [t.up.id, t.dune.id], wanted: true }, t.cookie);
    await call(t.app, 'PUT', '/api/automation', { dailyLimit: 1 }, t.cookie);
    const first = await lookForWanted(t.deps(), 'missing');
    expect(first.sent).toHaveLength(1);
    expect(first.capped).toBe(true);
    expect(first.problems.join(' ')).toMatch(/today’s limit of 1 copy/);
    t.later(25 * 3_600_000);
    const next = await lookForWanted(t.deps(), 'missing');
    expect(next.sent).toHaveLength(1);
    expect(t.sent()).toHaveLength(2);
  });

  it('a preview respects the limit too, and 0 means no limit', async () => {
    const t = await setup();
    await call(t.app, 'POST', '/api/movies/wanted', { ids: [t.up.id, t.dune.id], wanted: true }, t.cookie);
    await call(t.app, 'PUT', '/api/automation', { dailyLimit: 1 }, t.cookie);
    expect((await lookForWanted(t.deps(true), 'missing')).sent).toHaveLength(1);
    await call(t.app, 'PUT', '/api/automation', { dailyLimit: 0 }, t.cookie);
    expect((await lookForWanted(t.deps(true), 'missing')).sent).toHaveLength(2);
  });
});

describe('Movies that aren’t out yet', () => {
  it('are left alone until their release date, and requests say so', async () => {
    const t = await setup();
    t.db.update(schema.movies).set({ releaseDate: '2026-12-20', monitored: true }).where(eq(schema.movies.id, t.up.id)).run();
    expect((await lookForWanted(t.deps(), 'missing')).searched).toBe(0);
    t.later(40 * 86_400_000);
    expect((await lookForWanted(t.deps(), 'missing')).searched).toBe(1);
  });
});
