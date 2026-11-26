import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { searchesSettled } from '../src/requests/service.js';
import { schema } from '../src/db/index.js';
import { FakeMediaServer } from './fakes/mediaServers.js';
import { FakeQbit, fakeFetchTorrent, qbitTorrent } from './fakes/qbittorrent.js';
import { FakeSites, release } from './fakes/sources.js';
import { FakeTmdb } from './fakes/tmdb.js';
import { call, makeApp, setupAdmin } from './helpers.js';

// Real answers from the server, saved as files. The iPhone app's tests decode
// every one of them, so if the server's shape drifts from the app's models the
// app's tests fail. Run `pnpm --filter @marquee/server fixtures:ios` after a
// change on purpose, and commit the files.

const DIR = path.resolve(import.meta.dirname, '../../ios/Packages/MarqueeKit/Tests/MarqueeKitTests/Fixtures');
const GB = 1024 ** 3;
const DUNE = 'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX';
const UP = 'Up.2009.1080p.BluRay.x265-GRP';
const PHONE = { id: 'phone-aaaa-1111', name: "Josh's iPhone", kind: 'ios' as const };
const STALE = 'The iPhone fixtures are out of date. Run pnpm --filter @marquee/server fixtures:ios and commit them.';

/** Pretty JSON with the token swapped out, since it's different every time. */
function clean(body: unknown, tokens: string[]): string {
  let text = JSON.stringify(body, null, 2);
  for (const t of tokens) text = text.split(t).join('<token>');
  return text + '\n';
}

describe('fixtures for the iPhone app', () => {
  it('match what the server sends', async () => {
    const sites = new FakeSites();
    sites.feed('http://tpb.test/api', { releases: [release(DUNE, { size: 25 * GB }), release(UP, { size: 4 * GB })] });
    const qbit = new FakeQbit();
    const clock = Date.parse('2026-11-25T12:00:00Z');
    const t = makeApp({
      now: () => clock,
      clients: { torznab: sites.torznab, qbittorrent: (u, n, p) => qbit.as(u, n, p), fetchTorrent: fakeFetchTorrent(), tmdb: () => new FakeTmdb() },
    });
    const admin = await setupAdmin(t.app);
    await call(t.app, 'PUT', '/api/settings/services', { tmdbApiKey: 'good-key' }, admin);
    await call(t.app, 'POST', '/api/settings/sources', { name: 'TPB', url: 'http://tpb.test/api', apiKey: 'good' }, admin);
    await call(t.app, 'PUT', '/api/settings/downloader', { url: qbit.url, username: 'admin', password: 'adminadmin' }, admin);
    const person = async (username: string, role: 'member' | 'kid') => {
      await call(t.app, 'POST', '/api/users', { username, displayName: username[0]!.toUpperCase() + username.slice(1), role, password: `${username} password` }, admin);
      return (await call(t.app, 'POST', '/api/auth/login', { username, password: `${username} password` })).cookie!;
    };
    const jessie = await person('jessie', 'member');
    const kiddo = await person('kiddo', 'kid');

    // Dune: a member asks, an admin approves, it downloads. Up: an admin asks and it gets stuck.
    const ask = await call(t.app, 'POST', '/api/requests', { kind: 'movie', tmdbId: 693134 }, jessie);
    const approved = await call(t.app, 'POST', `/api/requests/${ask.body.id}/approve`, {}, admin);
    await call(t.app, 'POST', '/api/requests', { kind: 'movie', tmdbId: 14160 }, admin);
    await searchesSettled();
    // Something just arrived in the library, so Home has artwork to lead with.
    const wicked = t.db
      .insert(schema.movies)
      .values({ tmdbId: 402431, imdbId: 'tt10638522', title: 'Wicked', sortTitle: 'wicked', year: 2024, certification: 'PG', profile: 'cinema', addedAt: 0, refreshedAt: 0, posterPath: '/wicked.jpg', backdropPath: '/wicked-bg.jpg', posterColor: '#2e4a3a' })
      .returning()
      .get();
    t.db.insert(schema.mediaFiles).values({ path: '/data/media/movies/Wicked/Wicked.mkv', movieId: wicked.id, size: 1, mtime: 0, addedAt: clock - 2 * 3_600_000, seenAt: 0, resolution: '2160p' }).run();
    // A kid is waiting on one, and a member's was turned down.
    await call(t.app, 'POST', '/api/requests', { kind: 'movie', tmdbId: 1022789 }, kiddo);
    const anora = await call(t.app, 'POST', '/api/requests', { kind: 'movie', tmdbId: 1064213 }, jessie);
    const declined = await call(t.app, 'POST', `/api/requests/${anora.body.id}/decline`, { reason: 'We have it on disc.' }, admin);
    // Up's copy was sent a while ago and has gone quiet.
    t.db.insert(schema.downloads).values({ kind: 'movie', movieId: 2, title: UP, infoHash: 'b'.repeat(40), addedAt: clock - 5 * 3_600_000, state: 'downloading', progress: 0.1 }).run();
    qbit.list.push(qbitTorrent('b'.repeat(40), { name: UP, state: 'stalledDL', progress: 0.1 }));
    qbit.list[0]!.progress = 0.42;
    qbit.list[0]!.state = 'downloading';
    qbit.list[0]!.downloadSpeed = 4.2 * 1024 ** 2;
    qbit.list[0]!.eta = 720;

    const login = await call(t.app, 'POST', '/api/auth/login', { username: 'josh', password: 'correct horse battery', device: PHONE });
    const bearer = { authorization: `Bearer ${login.body.token}` };
    const tokens = [login.body.token as string];
    const get = (p: string, who: string | undefined = admin) => call(t.app, 'GET', p, undefined, who);
    const asPhone = (p: string) => call(t.app, 'GET', p, undefined, undefined, bearer);
    const bad = await call(t.app, 'POST', '/api/auth/login', { username: 'josh', password: 'wrong password', device: PHONE });
    // Asked last, on a phone with notifications on, so the answers above stay as they were.
    const pushEvents = async () => {
      const id = ((await asPhone('/api/me/devices')).body as { devices: { id: string }[] }).devices[0]!.id;
      await call(t.app, 'POST', `/api/me/devices/${id}/push`, { token: 'a'.repeat(64) }, undefined, bearer);
      return asPhone(`/api/me/devices/${id}/push/events`);
    };
    const signedOut = await call(t.app, 'GET', '/api/auth/status');

    const answers: [string, { status: number; body: unknown }, number?][] = [
      ['health', await get('/api/health')],
      ['auth-status', await asPhone('/api/auth/status')],
      ['auth-status-signed-out', signedOut],
      ['app-sign-in', login],
      ['error-bad-credentials', bad, 401],
      ['me', await asPhone('/api/me')],
      ['devices', await asPhone('/api/me/devices')],
      ['push-events', await pushEvents()],
      ['home-admin', await get('/api/home')],
      ['home-member', await get('/api/home', jessie)],
      ['home-kid', await get('/api/home', kiddo)],
      ['downloads', await get('/api/downloads')],
      ['downloads-summary', await get('/api/downloads/summary')],
      ['requests-admin', await get('/api/requests?scope=all')],
      ['requests-member', await get('/api/requests', jessie)],
      ['requests-summary', await get('/api/requests/summary')],
      ['request-approved', approved],
      ['request-declined', declined],
    ];

    fs.mkdirSync(DIR, { recursive: true });
    for (const [name, res, status = 200] of answers) {
      expect(res.status, `${name} answered ${res.status}`).toBe(status);
      const text = clean(res.body, tokens);
      const file = path.join(DIR, `${name}.json`);
      if (process.env.WRITE_FIXTURES) fs.writeFileSync(file, text);
      else {
        expect(fs.existsSync(file), `${name}.json is missing. ${STALE}`).toBe(true);
        expect(JSON.parse(text), `${name}.json. ${STALE}`).toEqual(JSON.parse(fs.readFileSync(file, 'utf8')));
      }
    }
  });

  it('browse: library, titles, Discover, Calendar and copies', async () => {
    const sites = new FakeSites();
    sites.feed('http://tpb.test/api', { releases: [release(DUNE, { size: 25 * GB })] });
    const qbit = new FakeQbit();
    const clock = Date.parse('2026-11-25T12:00:00Z');
    const t = makeApp({
      now: () => clock,
      clients: { torznab: sites.torznab, qbittorrent: (u, n, p) => qbit.as(u, n, p), fetchTorrent: fakeFetchTorrent(), tmdb: () => new FakeTmdb() },
    });
    const admin = await setupAdmin(t.app);
    await call(t.app, 'PUT', '/api/settings/services', { tmdbApiKey: 'good-key' }, admin);
    await call(t.app, 'POST', '/api/settings/sources', { name: 'TPB', url: 'http://tpb.test/api', apiKey: 'good' }, admin);
    await call(t.app, 'PUT', '/api/settings/downloader', { url: qbit.url, username: 'admin', password: 'adminadmin' }, admin);
    await call(t.app, 'POST', '/api/users', { username: 'kiddo', displayName: 'Kiddo', role: 'kid', password: 'kiddo password' }, admin);
    const kiddo = (await call(t.app, 'POST', '/api/auth/login', { username: 'kiddo', password: 'kiddo password' })).cookie!;

    const movie = (tmdbId: number, title: string, extra: object = {}) =>
      t.db.insert(schema.movies).values({ tmdbId, title, sortTitle: title.toLowerCase(), year: 2024, certification: 'PG-13', profile: 'cinema', addedAt: clock - 86_400_000, refreshedAt: 0, posterPath: `/${tmdbId}.jpg`, backdropPath: `/${tmdbId}-bg.jpg`, overview: 'A story.', genres: '["Science Fiction","Adventure"]', runtime: 166, ...extra }).returning().get();
    const dune = movie(693134, 'Dune: Part Two', { monitored: true });
    const up = movie(14160, 'Up', { certification: 'PG', year: 2009, monitored: true });
    t.db.insert(schema.mediaFiles).values({ path: '/data/media/movies/Dune/Dune.mkv', movieId: dune.id, size: 25 * GB, mtime: 0, addedAt: clock - 3_600_000, seenAt: 0, resolution: '2160p', hdr: 'HDR', source: 'WEBDL', codec: 'x265', releaseGroup: 'FLUX' }).run();

    const show = t.db.insert(schema.series).values({ tmdbId: 95396, tvdbId: 371980, title: 'Severance', sortTitle: 'severance', year: 2022, certification: 'TV-MA', profile: 'cinema', addedAt: clock - 5 * 86_400_000, refreshedAt: 0, posterPath: '/sev.jpg', backdropPath: '/sev-bg.jpg', overview: 'Work and life, split.', genres: '["Drama","Mystery"]', status: 'Returning Series', network: 'Apple TV+', monitored: true }).returning().get();
    const eps = [
      [1, 1, 'Good News About Hell', '2022-02-18'],
      [1, 2, 'Half Loop', '2022-02-18'],
      [2, 1, 'Hello, Ms. Cobel', '2025-01-17'],
      [2, 2, 'Not Yet Aired', '2099-01-01'],
      [2, 3, 'Coming This Week', '2026-11-27'],
    ] as const;
    for (const [season, episode, title, airDate] of eps) t.db.insert(schema.episodes).values({ seriesId: show.id, season, episode, title, airDate, monitored: true }).run();
    t.db.insert(schema.mediaFiles).values({ path: '/data/media/tv/Severance/S01E01.mkv', seriesId: show.id, season: 1, episodes: '[1]', size: 3 * GB, mtime: 0, addedAt: clock - 86_400_000, seenAt: 0, resolution: '1080p', source: 'WEBDL', codec: 'x264', releaseGroup: 'NTb' }).run();
    t.db.insert(schema.history).values({ at: clock - 3_600_000, event: 'in_library', kind: 'movie', movieId: dune.id, title: 'Dune: Part Two (2024)', source: 'TPB', quality: 'WEBDL-2160p', size: 25 * GB }).run();

    const get = (p: string, who: string | undefined = admin) => call(t.app, 'GET', p, undefined, who);
    await call(t.app, 'POST', '/api/issues', { kind: 'movie', id: dune.id, problem: 'sound', message: 'Dialogue is quiet.' }, admin);
    const copies = await call(t.app, 'POST', `/api/movies/${dune.id}/search`, {}, admin);
    const answers: [string, { status: number; body: unknown }][] = [
      ['movies', await get('/api/movies')],
      ['shows', await get('/api/shows')],
      ['movies-kid', await get('/api/movies', kiddo)],
      ['movie-detail', await get(`/api/movies/${dune.id}`)],
      ['show-detail', await get(`/api/shows/${show.id}`)],
      ['movie-watch', await get(`/api/movies/${dune.id}/watch`)],
      ['episode-detail', await get(`/api/shows/${show.id}/seasons/1/episodes/1`)],
      ['discover', await get('/api/discover')],
      ['discover-kids', await get('/api/discover', kiddo)],
      ['discover-title-movie', await get('/api/discover/title/movie/402431')],
      ['discover-title-series', await get('/api/discover/title/series/95396')],
      ['discover-season', await get('/api/discover/title/series/95396/season/2')],
      ['discover-search', await get('/api/discover/search?q=dune')],
      ['library-search', await get('/api/library/search?q=dune')],
      ['calendar', await get('/api/calendar?from=2026-11-18&days=14')],
      ['copies', { status: copies.status, body: { ...(copies.body as object), searchId: '<id>' } }],
      ['history-title', await get(`/api/history?movieId=${dune.id}`)],
      ['profiles', await get('/api/settings/profiles')],
      ['issues-title', await get(`/api/issues/title/movie/${dune.id}`)],
    ];
    fs.mkdirSync(DIR, { recursive: true });
    for (const [name, res] of answers) {
      expect(res.status, `${name} answered ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`).toBeLessThan(300);
      const text = clean(res.body, []);
      const file = path.join(DIR, `${name}.json`);
      if (process.env.WRITE_FIXTURES) fs.writeFileSync(file, text);
      else {
        expect(fs.existsSync(file), `${name}.json is missing. ${STALE}`).toBe(true);
        expect(JSON.parse(text), `${name}.json. ${STALE}`).toEqual(JSON.parse(fs.readFileSync(file, 'utf8')));
      }
    }
  });

  it('admin: watching and the things Josh looks after', async () => {
    const plex = new FakeMediaServer('plex');
    const sites = new FakeSites();
    sites.feed('http://tpb.test/api', { releases: [release(DUNE, { size: 25 * GB })] });
    const qbit = new FakeQbit();
    const clock = Date.parse('2026-11-25T12:00:00Z');
    const t = makeApp({ now: () => clock, clients: { torznab: sites.torznab, qbittorrent: (u, n, p) => qbit.as(u, n, p), tmdb: () => new FakeTmdb(), plexServer: (u, k) => plex.as(u, k) } });
    const admin = await setupAdmin(t.app);
    await call(t.app, 'PUT', '/api/settings/services', { tmdbApiKey: 'good-key', plexUrl: 'http://plex:32400', plexToken: 'plex-token' }, admin);
    await call(t.app, 'POST', '/api/settings/sources', { name: 'TPB', url: 'http://tpb.test/api', apiKey: 'good' }, admin);
    await call(t.app, 'PUT', '/api/settings/downloader', { url: qbit.url, username: 'admin', password: 'adminadmin' }, admin);
    for (const [username, role] of [['mia', 'member'], ['kiddo', 'kid']] as const) {
      await call(t.app, 'POST', '/api/users', { username, displayName: username[0]!.toUpperCase() + username.slice(1), role, password: `${username} password` }, admin);
    }
    plex.playing = [{ sessionId: 's1', platform: 'Roku', resolution: '1080', kind: 'movie', title: 'Dune: Part Two', show: null, season: null, episode: null, year: 2024, tmdbId: 693134, user: 'mia', device: 'Living room TV', state: 'playing', progress: 0.4, transcoding: true }];
    plex.plays = [
      { kind: 'movie', title: 'Dune: Part Two', show: null, season: null, episode: null, year: 2024, tmdbId: 693134, userId: 'u1', user: 'mia', key: 'k1', playedAt: clock - 3_600_000 },
      { kind: 'episode', title: 'Pilot', show: 'Severance', season: 1, episode: 1, year: 2022, tmdbId: null, userId: 'u1', user: 'mia', key: 'k2', playedAt: clock - 86_400_000 },
    ];
    await call(t.app, 'POST', '/api/activity/sync', {}, admin);
    t.db.insert(schema.scanItems).values({ kind: 'movie', path: '/data/media/movies/Odd.Folder.2019', seenAt: clock, parsedTitle: 'Odd Folder', parsedYear: 2019, candidates: '[{"tmdbId":14160,"title":"Up","year":2009,"posterPath":"/up.jpg"}]' }).run();
    const get = (p: string) => call(t.app, 'GET', p, undefined, admin);
    const answers: [string, { status: number; body: unknown }][] = [
      ['activity-now', await get('/api/activity/now')],
      ['activity-stats', await get('/api/activity/stats')],
      ['activity-people', await get('/api/activity/people')],
      ['system-health', await get('/api/system/health')],
      ['sources', await get('/api/settings/sources')],
      ['users', await get('/api/users').then((r) => ({ ...r, body: { users: (r.body as any).users.map((u: any) => ({ ...u, createdAt: 0, lastLoginAt: null })) } }))],
      ['unmatched', await get('/api/library/unmatched')],
      ['left-out', await get('/api/library/left-out')],
    ];
    fs.mkdirSync(DIR, { recursive: true });
    for (const [name, res] of answers) {
      expect(res.status, `${name} answered ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`).toBeLessThan(300);
      const text = clean(res.body, []);
      const file = path.join(DIR, `${name}.json`);
      if (process.env.WRITE_FIXTURES) fs.writeFileSync(file, text);
      else {
        expect(fs.existsSync(file), `${name}.json is missing. ${STALE}`).toBe(true);
        expect(JSON.parse(text), `${name}.json. ${STALE}`).toEqual(JSON.parse(fs.readFileSync(file, 'utf8')));
      }
    }
  });
});
