import { describe, expect, it } from 'vitest';
import { JellyfinClient, PlexServerClient, type PlayRecord } from '../src/library/mediaServers.js';
import { movies, series } from '../src/db/schema.js';
import { FakeMediaServer } from './fakes/mediaServers.js';
import { call, makeApp, setupAdmin } from './helpers.js';

const NOW = Date.parse('2026-11-18T12:00:00Z');
const play = (o: Partial<PlayRecord>): PlayRecord => ({ kind: 'movie', title: 'Dune', show: null, season: null, episode: null, year: 2021, tmdbId: 438631, userId: 'u1', user: 'josh', key: 'k1', playedAt: NOW - 3600_000, ...o });

async function setup() {
  const plex = new FakeMediaServer('plex');
  const jf = new FakeMediaServer('jellyfin');
  const t = makeApp({ now: () => NOW, clients: { plexServer: (u, k) => plex.as(u, k), jellyfin: (u, k) => jf.as(u, k) } });
  const admin = await setupAdmin(t.app);
  await call(t.app, 'PUT', '/api/settings/services', { plexUrl: 'http://plex:32400', plexToken: 'plex-token', jellyfinUrl: 'http://jellyfin:8096', jellyfinApiKey: 'jellyfin-key' }, admin);
  return { ...t, plex, jf, admin };
}

describe('activity', () => {
  it('copies watches from both servers once, and counts them', async () => {
    const { app, plex, jf, admin } = await setup();
    plex.plays = [play({}), play({ kind: 'episode', title: 'Pilot', show: 'Severance', season: 1, episode: 1, tmdbId: null, key: 'k2', playedAt: NOW - 7200_000 })];
    jf.plays = [play({ user: 'sam', userId: 'jf1', key: 'j1', playedAt: NOW - 86_400_000 * 3 })];
    const first = await call(app, 'POST', '/api/activity/sync', {}, admin);
    expect(first.body).toEqual({ added: 3, problems: [] });
    expect((await call(app, 'POST', '/api/activity/sync', {}, admin)).body.added).toBe(0);
    const stats = (await call(app, 'GET', '/api/activity/stats', undefined, admin)).body;
    expect(stats).toMatchObject({ total: 3, last24h: 2, servers: { plex: 2, jellyfin: 1 } });
    expect(stats.perDay).toHaveLength(30);
    expect(stats.users[0]).toEqual({ name: 'Josh', plays: 2 });
    expect(stats.shows).toEqual([{ name: 'Severance', plays: 1 }]);
    const hist = (await call(app, 'GET', '/api/activity/history?limit=2', undefined, admin)).body;
    expect(hist.total).toBe(3);
    expect(hist.plays[0]).toMatchObject({ title: 'Dune', server: 'plex', subtitle: '2021' });
    expect(hist.plays[1].subtitle).toBe('S01E01 · Pilot');
  });

  it('says which server is down and still copies from the other', async () => {
    const { app, plex, jf, admin } = await setup();
    plex.fail = "Couldn't reach Plex.";
    jf.plays = [play({ key: 'j1' })];
    const r = await call(app, 'POST', '/api/activity/sync', {}, admin);
    expect(r.body.added).toBe(1);
    expect(r.body.problems).toEqual(["Plex: Couldn't reach Plex."]);
  });

  it('shows who is watching now, linked to the library title', async () => {
    const { app, db, plex, admin } = await setup();
    db.insert(movies).values({ tmdbId: 438631, title: 'Dune', sortTitle: 'dune', year: 2021, path: '/m/dune', addedAt: 1, refreshedAt: 1 } as never).run();
    plex.playing = [{ sessionId: 's1', platform: 'Roku', resolution: '1080', kind: 'movie', title: 'Dune', show: null, season: null, episode: null, year: 2021, tmdbId: 438631, user: 'ana', device: 'Living room TV', state: 'paused', progress: 0.4, transcoding: false }];
    const r = (await call(app, 'GET', '/api/activity/now', undefined, admin)).body;
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0]).toMatchObject({ server: 'plex', user: 'ana', title: 'Dune', state: 'paused', href: expect.stringMatching(/^\/movies\/\d+$/) });
  });

  it('lists who has watched a movie or show, using Marquee names', async () => {
    const { app, db, plex, jf, admin } = await setup();
    await call(app, 'POST', '/api/users', { username: 'sam', displayName: 'Sam', role: 'member', password: 'a lovely password' }, admin);
    const m = db.insert(movies).values({ tmdbId: 438631, title: 'Dune', sortTitle: 'dune', year: 2021, path: '/m/dune', addedAt: 1, refreshedAt: 1 } as never).returning().get();
    const s = db.insert(series).values({ tmdbId: 5, title: 'Severance', sortTitle: 'severance', addedAt: 1, refreshedAt: 1, path: '/tv/s' } as never).returning().get();
    plex.plays = [play({}), play({ kind: 'episode', title: 'Pilot', show: 'Severance', season: 1, episode: 1, tmdbId: null, key: 'e1' }), play({ kind: 'episode', title: 'Two', show: 'Severance', season: 1, episode: 2, tmdbId: null, key: 'e2', playedAt: NOW - 1000 })];
    jf.plays = [play({ user: 'Sam', userId: 'jf1', key: 'j1', playedAt: NOW - 5000 })];
    await call(app, 'POST', '/api/activity/sync', {}, admin);
    const movie = (await call(app, 'GET', `/api/activity/watchers?kind=movie&id=${m.id}`, undefined, admin)).body.watchers;
    expect(movie.map((w: { user: string }) => w.user)).toEqual(['Sam', 'Josh']);
    const show = (await call(app, 'GET', `/api/activity/watchers?kind=tv&id=${s.id}`, undefined, admin)).body.watchers;
    expect(show).toEqual([{ user: 'Josh', plays: 2, last: NOW - 1000, episodes: 2 }]);
    expect((await call(app, 'GET', '/api/activity/watchers?kind=movie&id=999', undefined, admin)).status).toBe(404);
  });

  it('is for admins only', async () => {
    const { app, admin } = await setup();
    await call(app, 'POST', '/api/users', { username: 'partner', displayName: 'P', role: 'member', password: 'a lovely password' }, admin);
    const member = (await call(app, 'POST', '/api/auth/login', { username: 'partner', password: 'a lovely password' })).cookie!;
    for (const p of ['now', 'history', 'stats']) expect((await call(app, 'GET', `/api/activity/${p}`, undefined, member)).status).toBe(403);
    expect((await call(app, 'POST', '/api/activity/sync', {}, member)).status).toBe(403);
  });
});

describe('server clients: watching', () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body));

  it('Plex: sessions and history, with names from /accounts', async () => {
    const f = (async (url: string) => {
      if (url.includes('/status/sessions/history')) return ok({ MediaContainer: { Metadata: [{ type: 'episode', title: 'Pilot', grandparentTitle: 'Severance', parentIndex: 1, index: 1, ratingKey: '77', viewedAt: 1_700_000_000, accountID: 2 }, { type: 'track', title: 'Song', viewedAt: 1 }] } });
      if (url.endsWith('/accounts')) return ok({ MediaContainer: { Account: [{ id: 2, name: 'ana' }] } });
      return ok({ MediaContainer: { Metadata: [{ type: 'movie', title: 'Dune', year: 2021, viewOffset: 500, duration: 1000, User: { title: 'josh' }, Player: { title: 'TV', state: 'playing' }, Guid: [{ id: 'tmdb://438631' }], TranscodeSession: { videoDecision: 'transcode' } }] } });
    }) as unknown as typeof fetch;
    const px = new PlexServerClient('http://plex:32400', 'T', f);
    const now = await px.nowPlaying();
    expect(now[0]).toMatchObject({ title: 'Dune', tmdbId: 438631, user: 'josh', progress: 0.5, transcoding: true, state: 'playing' });
    const hist = await px.history(0);
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ show: 'Severance', season: 1, episode: 1, user: 'ana', userId: '2', key: '77', playedAt: 1_700_000_000_000 });
  });

  it('Jellyfin: sessions and each person\'s played items', async () => {
    const f = (async (url: string) => {
      if (url.endsWith('/Sessions')) return ok([{ UserName: 'sam', DeviceName: 'Phone', NowPlayingItem: { Type: 'Episode', Name: 'Pilot', SeriesName: 'Severance', ParentIndexNumber: 1, IndexNumber: 1, RunTimeTicks: 100 }, PlayState: { PositionTicks: 25, IsPaused: true, PlayMethod: 'DirectPlay' } }, { UserName: 'idle' }]);
      if (url.endsWith('/Users')) return ok([{ Id: 'a', Name: 'Sam' }]);
      return ok({ Items: [{ Id: 'i1', Type: 'Movie', Name: 'Dune', ProductionYear: 2021, ProviderIds: { Tmdb: '438631' }, UserData: { LastPlayedDate: '2026-11-17T20:00:00Z' } }, { Id: 'i0', Type: 'Movie', Name: 'Old', UserData: { LastPlayedDate: '2020-01-01T00:00:00Z' } }] });
    }) as unknown as typeof fetch;
    const jf = new JellyfinClient('http://jf:8096', 'K', f);
    const now = await jf.nowPlaying();
    expect(now).toHaveLength(1);
    expect(now[0]).toMatchObject({ show: 'Severance', state: 'paused', progress: 0.25, transcoding: false });
    const hist = await jf.history(Date.parse('2026-01-01'));
    expect(hist.map((h) => h.title)).toEqual(['Dune']);
    expect(hist[0]).toMatchObject({ tmdbId: 438631, user: 'Sam', userId: 'a', key: 'i1' });
  });
});
