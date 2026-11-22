import { describe, expect, it } from 'vitest';
import type { CalendarView, AutomationView, HomeData } from '@marquee/shared';
import { schema } from '../src/db/index.js';
import { catchNewEpisodes, lookForWantedTv, wantedTvTick } from '../src/downloads/wantedTv.js';
import { refreshAiring } from '../src/library/airing.js';
import { LibraryScanner } from '../src/library/scanner.js';
import { FakeQbit, fakeFetchTorrent } from './fakes/qbittorrent.js';
import { FakeRadarr } from './fakes/radarr.js';
import { FakeSites, release } from './fakes/sources.js';
import { FakeTmdb } from './fakes/tmdb.js';
import { call, makeApp, setupAdmin } from './helpers.js';
import type { Release } from '../src/sources/torznab.js';

const GB = 1024 ** 3;
const HOUR = 3_600_000;
const tv = (title: string, extra: Partial<Release> = {}) => release(title, { categories: [5000], size: 4 * GB, ...extra });

const S1_PACK_4K = 'Severance.S01.2160p.ATVP.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX';
const S1E01_4K = 'Severance.S01E01.2160p.ATVP.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX';
const S1E02_4K = 'Severance.S01E02.2160p.ATVP.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX';
const S2E01_4K = 'Severance.S02E01.2160p.ATVP.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX';
const S2E02_4K = 'Severance.S02E02.2160p.ATVP.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX';

/**
 * Severance: season 1 (4 episodes) has aired, season 2 is airing (2 of 3 out),
 * plus a special. Bluey is a show you don't watch. "Today" is 2026-11-18.
 */
async function setup(feed: Release[] = []) {
  const sites = new FakeSites();
  sites.feed('http://tpb.test/api', { releases: feed });
  const qbit = new FakeQbit();
  const sonarr = new FakeRadarr();
  let clock = Date.parse('2026-11-18T12:00:00Z');
  const t = makeApp({
    now: () => clock,
    clients: {
      torznab: sites.torznab,
      qbittorrent: (u, n, p) => qbit.as(u, n, p),
      fetchTorrent: fakeFetchTorrent(),
      arr: () => sonarr,
      tmdb: () => new FakeTmdb(),
    },
  });
  const cookie = await setupAdmin(t.app);
  await call(t.app, 'POST', '/api/settings/sources', { name: 'TPB', url: 'http://tpb.test/api', apiKey: 'good' }, cookie);
  const show = (title: string, tmdbId: number, extra: Partial<typeof schema.series.$inferInsert> = {}) =>
    t.db.insert(schema.series).values({ tmdbId, title, sortTitle: title.toLowerCase(), year: 2022, profile: 'cinema', addedAt: 0, refreshedAt: clock, status: 'Returning Series', ...extra }).returning().get();
  const sev = show('Severance', 95396, { tvdbId: 371980, certification: 'TV-MA' });
  const bluey = show('Bluey', 82728, { monitored: false, certification: 'TV-Y' });
  const ep = (seriesId: number, season: number, episode: number, airDate: string | null) =>
    t.db.insert(schema.episodes).values({ seriesId, season, episode, title: `Episode ${episode}`, airDate }).run();
  for (let e = 1; e <= 4; e++) ep(sev.id, 1, e, '2022-02-18');
  ep(sev.id, 2, 1, '2026-11-10');
  ep(sev.id, 2, 2, '2026-11-17');
  ep(sev.id, 2, 3, '2026-11-24');
  ep(sev.id, 0, 1, '2022-01-01');
  ep(bluey.id, 1, 1, '2026-11-19');
  const file = (season: number, episodes: number[], name: string) =>
    t.db.insert(schema.mediaFiles).values({ path: `/tv/Severance/Season ${season}/${name}.mkv`, seriesId: sev.id, season, episodes: JSON.stringify(episodes), size: GB, mtime: 0, addedAt: 0, seenAt: 0 }).run();
  const deps = () => ({ db: t.db, clients: { qbittorrent: (u: string, n: string, p: string) => qbit.as(u, n, p), fetchTorrent: fakeFetchTorrent() }, sources: t.sources, now: () => clock });
  const connect = () => call(t.app, 'PUT', '/api/settings/downloader', { url: qbit.url, username: 'admin', password: 'adminadmin' }, cookie);
  // Adding the Source checked it once; leave that out.
  const searches = () => sites.feeds.get('http://tpb.test/api')!.searches!.slice(1);
  return { ...t, cookie, qbit, sonarr, sev, bluey, file, deps, connect, searches, later: (ms: number) => (clock += ms), now: () => clock };
}

const sentDownloads = (t: Awaited<ReturnType<typeof setup>>) => t.db.select().from(schema.downloads).all().map((d) => ({ title: d.title, season: d.season, episodes: d.episodes }));

describe('Marquee looks for wanted episodes', () => {
  it('takes a whole-season copy when most of a finished season is missing, and single episodes for an airing season', async () => {
    const t = await setup([tv(S1_PACK_4K, { size: 30 * GB }), tv(S1E01_4K), tv(S2E01_4K), tv(S2E02_4K)]);
    await t.connect();
    const run = await lookForWantedTv(t.deps(), 'missing');
    expect(run.problems).toEqual([]);
    // Season 2 episodes first (newest air dates), then the season 1 pack. Specials, unaired episodes and Bluey (not watched) are left alone.
    expect(run.sent.map((s) => s.title)).toEqual(['Severance · S02E02', 'Severance · S02E01', 'Severance · S01']);
    expect(run.sent[2]).toMatchObject({ href: `/shows/${t.sev.id}`, copy: S1_PACK_4K });
    expect(sentDownloads(t)).toContainEqual({ title: S1_PACK_4K, season: 1, episodes: null });
    expect(run.searched).toBe(3);
    // Everything wanted is now on the way, so the next run searches nothing.
    expect((await lookForWantedTv(t.deps(), 'missing')).searched).toBe(0);
  });

  it('looks for single episodes when no whole-season copy is found', async () => {
    const t = await setup([tv(S1E01_4K), tv(S1E02_4K)]);
    await t.connect();
    t.file(2, [1], 'Severance - S02E01 [WEBDL-2160p]');
    t.file(2, [2], 'Severance - S02E02 [WEBDL-2160p]');
    const run = await lookForWantedTv(t.deps(), 'missing');
    expect(run.searched).toBe(5); // the season, then its 4 episodes
    expect(run.sent.map((s) => s.copy)).toEqual([S1E01_4K, S1E02_4K]);
    expect(t.searches()[0]).toMatchObject({ kind: 'tv', season: 1 });
    expect(t.searches()[0]).toMatchObject({ episode: undefined }); // the whole season
  });

  it('searches single episodes when you have most of a season, and keeps to the limit per run', async () => {
    const t = await setup([tv(S1_PACK_4K), tv(S1E02_4K)]);
    await t.connect();
    t.file(1, [1, 3, 4], 'Severance - S01E01-E03-E04 [WEBDL-2160p]');
    t.file(2, [1], 'Severance - S02E01 [WEBDL-2160p]');
    const run = await lookForWantedTv(t.deps(), 'missing', 1);
    expect(run.searched).toBe(1);
    // S02E02 aired most recently, so it goes first; nothing in the feed fits it.
    expect(run.sent).toEqual([]);
    const next = await lookForWantedTv(t.deps(), 'missing', 1);
    expect(next.sent.map((s) => s.copy)).toEqual([S1E02_4K]);
  });

  it('leaves episodes with a download on the way alone', async () => {
    const t = await setup([tv(S1_PACK_4K), tv(S2E01_4K), tv(S2E02_4K)]);
    await t.connect();
    t.db.insert(schema.downloads).values({ kind: 'tv', seriesId: t.sev.id, season: 1, title: 'x', infoHash: 'busy', addedAt: 0, state: 'downloading' }).run();
    t.db.insert(schema.downloads).values({ kind: 'tv', seriesId: t.sev.id, season: 2, episodes: '[2]', title: 'y', infoHash: 'busy2', addedAt: 0, state: 'downloading' }).run();
    const run = await lookForWantedTv(t.deps(), 'missing');
    expect(run.sent.map((s) => s.title)).toEqual(['Severance · S02E01']);
  });

  it('checks finished seasons you have for a better whole-season copy, skipping ones already good enough', async () => {
    const t = await setup([tv(S1_PACK_4K, { size: 30 * GB })]);
    await t.connect();
    for (let e = 1; e <= 4; e++) t.file(1, [e], `Severance - S01E0${e} [WEBDL-1080p]`);
    const run = await lookForWantedTv(t.deps(), 'better');
    expect(run.sent.map((s) => s.copy)).toEqual([S1_PACK_4K]);
    expect(run.searched).toBe(1); // season 2 is still airing, so it isn't checked yet

    // A profile that doesn't look for better copies: no search at all.
    const t2 = await setup([tv(S1_PACK_4K)]);
    await t2.connect();
    for (let e = 1; e <= 4; e++) t2.file(1, [e], `Severance - S01E0${e} [WEBDL-1080p]`);
    const profile = t2.db.select().from(schema.profiles).all().find((p) => p.kind === 'tv' && p.key === 'cinema')!;
    t2.db.update(schema.profiles).set({ upgrades: false }).where((await import('drizzle-orm')).eq(schema.profiles.id, profile.id)).run();
    const none = await lookForWantedTv(t2.deps(), 'better');
    expect(none.searched).toBe(0);
    expect(t2.searches()).toHaveLength(0);
  });

  it('says why when qBittorrent isn’t connected', async () => {
    const t = await setup([tv(S2E01_4K)]);
    const run = await lookForWantedTv(t.deps(), 'missing');
    expect(run).toMatchObject({ searched: 0, problems: [expect.stringMatching(/qBittorrent isn’t connected/)] });
  });
});

describe('catching new episodes from the Sources’ newest copies', () => {
  it('sends missing episodes of shows you watch, preferring a whole season, and skips the rest', async () => {
    const t = await setup([
      tv(S2E02_4K),
      tv('Severance.S02E09.2160p.ATVP.WEB-DL.DDP5.1.DV.H.265-FLUX'), // TMDB doesn't know this episode
      tv('Bluey.S01E01.1080p.WEB-DL.AAC2.0.H.264-GRP'), // not watched
      tv('Some.Other.Show.S01E01.1080p.WEB-DL-GRP'), // not in your library
      tv(S1_PACK_4K),
      tv(S1E01_4K), // the pack already covers it
      tv('Severance.S00E01.Special.1080p.WEB-DL-GRP'), // specials only by hand
    ]);
    await t.connect();
    t.file(2, [1], 'Severance - S02E01 [WEBDL-2160p]');
    const run = await catchNewEpisodes(t.deps());
    expect(run).toMatchObject({ kind: 'new', searched: 7, problems: [] });
    expect(run.sent.map((s) => s.title)).toEqual(['Severance · S01', 'Severance · S02E02']);
    // A Source's newest copies are asked for TV, with no title.
    expect(t.searches().at(-1)).toEqual({ kind: 'recent', for: 'tv' });
  });

  it('skips a whole-season copy of a season still airing, taking the episode instead', async () => {
    const t = await setup([tv('Severance.S02.2160p.ATVP.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX'), tv(S2E02_4K)]);
    await t.connect();
    t.file(2, [1], 'Severance - S02E01 [WEBDL-2160p]');
    expect((await catchNewEpisodes(t.deps())).sent.map((s) => s.title)).toEqual(['Severance · S02E02']);
  });

  it('sends a better copy of an episode you have, and nothing when yours is as good', async () => {
    const t = await setup([tv(S2E01_4K)]);
    await t.connect();
    t.file(2, [1], 'Severance - S02E01 [WEBDL-1080p]');
    expect((await catchNewEpisodes(t.deps())).sent.map((s) => s.copy)).toEqual([S2E01_4K]);

    const same = await setup([tv(S2E01_4K)]);
    await same.connect();
    same.file(2, [1], S2E01_4K);
    expect((await catchNewEpisodes(same.deps())).sent).toEqual([]);
  });

  it('matches by TVDB ID when the name differs', async () => {
    const t = await setup([tv('Severance.US.S02E02.2160p.WEB-DL.DV.H.265-FLUX', { tvdbId: 371980 })]);
    await t.connect();
    expect((await catchNewEpisodes(t.deps())).sent.map((s) => s.title)).toEqual(['Severance · S02E02']);
  });

  it('keeps half of a limited Source’s daily searches for searching titles', async () => {
    const t = await setup([tv(S2E02_4K)]);
    await t.connect();
    const src = t.db.select().from(schema.sources).get()!;
    t.db.update(schema.sources).set({ dailyLimit: 4 }).run();
    for (let i = 0; i < 2; i++) t.db.insert(schema.sourceCalls).values({ sourceId: src.id, at: t.now() - HOUR, kind: 'search', ok: true, ms: 1, results: 0 }).run();
    const r = await t.sources.recent('tv');
    expect(r.sources[0]).toMatchObject({ status: 'skipped', message: expect.stringMatching(/Used 2 of its 4 searches today/) });
    // A title search may still use the rest.
    expect((await t.sources.search({ kind: 'tv', title: 'Severance', season: 2, episode: 2 })).sources[0]!.status).toBe('searched');
  });
});

describe('the TV schedule', () => {
  it('reads new copies every 30 minutes, missing every 6 hours, better daily, only when turned on', async () => {
    const t = await setup([]);
    await t.connect();
    expect(await wantedTvTick(t.deps())).toBeNull();
    const put = await call(t.app, 'PUT', '/api/automation', { tv: true }, t.cookie);
    expect(put.body).toMatchObject({ tv: { on: true } });
    expect((await wantedTvTick(t.deps()))!.kind).toBe('new');
    expect((await wantedTvTick(t.deps()))!.kind).toBe('missing');
    expect((await wantedTvTick(t.deps()))!.kind).toBe('better');
    expect(await wantedTvTick(t.deps())).toBeNull();
    t.later(30 * 60_000);
    expect((await wantedTvTick(t.deps()))!.kind).toBe('new');
    expect(await wantedTvTick(t.deps())).toBeNull();
    // Movies are a separate switch.
    expect((await call(t.app, 'GET', '/api/automation', undefined, t.cookie)).body.movies.on).toBe(false);
  });
});

describe('Look now for TV', () => {
  it('Look now runs each TV job at once', async () => {
    const t = await setup([tv(S2E02_4K)]);
    await t.connect();
    const r = await call(t.app, 'POST', '/api/automation/tv/look-now', { kind: 'new' }, t.cookie);
    expect(r.body).toMatchObject({ kind: 'new', sent: [{ title: 'Severance · S02E02' }] });
    const m = await call(t.app, 'POST', '/api/automation/tv/look-now', { kind: 'missing' }, t.cookie);
    expect(m.body.kind).toBe('missing');
    const runs = ((await call(t.app, 'GET', '/api/automation', undefined, t.cookie)).body as AutomationView).tv.runs;
    expect(runs.map((x) => x.kind)).toEqual(['missing', 'new']);
  });
});

describe('airing calendar', () => {
  it('lists episodes by day with what happens next', async () => {
    const t = await setup();
    t.file(2, [1], 'Severance - S02E01 [WEBDL-2160p]');
    const v = (await call(t.app, 'GET', '/api/calendar?from=2026-11-10&days=15', undefined, t.cookie)).body as CalendarView;
    expect(v).toMatchObject({ from: '2026-11-10', to: '2026-11-24', today: '2026-11-18' });
    expect(v.items.map((i) => [i.show, i.season, i.episode, i.state])).toEqual([
      ['Severance', 2, 1, 'have'],
      ['Severance', 2, 2, 'missing'],
      ['Bluey', 1, 1, 'not_watched'],
      ['Severance', 2, 3, 'coming'],
    ]);
    expect(v.items[3]!.note).toBe('4K Quality');
    await call(t.app, 'PUT', '/api/automation', { tv: true }, t.cookie);
    const on = (await call(t.app, 'GET', '/api/calendar?from=2026-11-24&days=1', undefined, t.cookie)).body as CalendarView;
    expect(on.items[0]!.note).toBe('Marquee will download it in 4K Quality');
    expect((await call(t.app, 'GET', '/api/calendar?from=nope', undefined, t.cookie)).status).toBe(400);
  });

  it('shows kids only kids’ shows', async () => {
    const t = await setup();
    await call(t.app, 'POST', '/api/users', { username: 'kid', password: 'kid password 1', displayName: 'Kid', role: 'kid' }, t.cookie);
    const kid = (await call(t.app, 'POST', '/api/auth/login', { username: 'kid', password: 'kid password 1' })).cookie;
    const v = (await call(t.app, 'GET', '/api/calendar?from=2026-11-10&days=15', undefined, kid)).body as CalendarView;
    expect(v.items.map((i) => i.show)).toEqual(['Bluey']);
  });

  it('fills “Coming up this week” on Home', async () => {
    const t = await setup();
    const home = (await call(t.app, 'GET', '/api/home', undefined, t.cookie)).body as HomeData;
    expect(home.upcoming).toEqual([
      { day: 'Thu', title: 'Bluey · S1 E1', note: 'This show isn’t Wanted, so it won’t be downloaded', href: `/shows/${t.bluey.id}`, posterPath: null, backdropPath: null },
      { day: 'Tue', title: 'Severance · S2 E3', note: '4K Quality', href: `/shows/${t.sev.id}`, posterPath: null, backdropPath: null },
    ]);
  });

  it('re-reads shows still on the air from TMDB twice a day', async () => {
    const t = await setup();
    await call(t.app, 'PUT', '/api/settings/services', { tmdbApiKey: 'good-key' }, t.cookie);
    t.db.update(schema.series).set({ status: 'Ended' }).where((await import('drizzle-orm')).eq(schema.series.id, t.bluey.id)).run();
    const deps = { db: t.db, config: t.config, clients: { tmdb: () => new FakeTmdb() }, scanner: new LibraryScanner(t.db, t.now), now: t.now };
    expect((await refreshAiring(deps)).refreshed).toBe(0); // refreshed just now
    t.later(13 * HOUR);
    expect(await refreshAiring(deps)).toEqual({ refreshed: 1, problems: [] });
    // TMDB's "Not Yet Aired" episode (S02E02 in 2099) replaced the date we had.
    const e = t.db.select().from(schema.episodes).all().find((x) => x.seriesId === t.sev.id && x.season === 2 && x.episode === 2)!;
    expect(e.airDate).toBe('2099-01-01');
    expect((await refreshAiring(deps)).refreshed).toBe(0);
  });
});
