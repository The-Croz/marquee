import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '../src/db/schema.js';
import type { SyncItem } from '../src/library/mediaServers.js';
import { PlexServerClient, JellyfinClient } from '../src/library/mediaServers.js';
import { missingTicks } from '../src/watchsync/sync.js';
import { FakeMediaServer } from './fakes/mediaServers.js';
import { call, makeApp, setupAdmin } from './helpers.js';

const movie = (ref: string, tmdb: number, watched: boolean, title = `Movie ${tmdb}`): SyncItem => ({ ref, keys: [`m:tmdb:${tmdb}`], watched, title });
const ep = (ref: string, show: string, s: number, e: number, watched: boolean): SyncItem => ({ ref, keys: [`e:${show}:${s}:${e}`], watched, title: `Show S0${s}E0${e}` });

async function setup() {
  const plex = new FakeMediaServer('plex');
  const jf = new FakeMediaServer('jellyfin');
  let clock = 1_000_000;
  const t = makeApp({ now: () => clock, clients: { plexServer: (u, k) => plex.as(u, k), jellyfin: (u, k) => jf.as(u, k) } });
  const admin = await setupAdmin(t.app);
  await call(t.app, 'PUT', '/api/settings/services', { plexUrl: 'http://plex:32400', plexToken: 'plex-token', jellyfinUrl: 'http://jf:8096', jellyfinApiKey: 'jellyfin-key' }, admin);
  await call(t.app, 'POST', '/api/users', { username: 'ana', displayName: 'Ana', role: 'member', password: 'ana password' }, admin);
  await call(t.app, 'POST', '/api/users', { username: 'sam', displayName: 'Sam', role: 'member', password: 'sam password' }, admin);
  t.db.update(users).set({ plexId: '11', jellyfinId: 'jf-ana' }).where(eq(users.username, 'ana')).run();
  t.db.update(users).set({ plexId: '22' }).where(eq(users.username, 'sam')).run();
  plex.people = [{ id: '11', username: 'ana', name: 'Ana' }, { id: '22', username: 'sam', name: 'Sam' }];
  jf.people = [{ id: 'jf-ana', username: 'ana', name: 'Ana' }];
  return { ...t, plex, jf, admin, tick: () => (clock += 1000) };
}

describe('watched sync', () => {
  it('matches by id, only adds ticks, and lists each missing one once', () => {
    const plex = [movie('p1', 603, true), ep('p2', 'tvdb:1', 1, 2, true), movie('p3', 604, false)];
    const jf = [{ ...movie('j1', 603, false), keys: ['m:tmdb:603', 'm:imdb:tt1'] }, ep('j2', 'tvdb:1', 1, 2, false), ep('j3', 'tvdb:1', 1, 3, false), movie('j4', 604, true)];
    expect(missingTicks(plex, jf).map((i) => i.ref)).toEqual(['j1', 'j2']);
    expect(missingTicks(jf, plex).map((i) => i.ref)).toEqual(['p3']);
  });

  it('previews, then ticks both ways for people linked to both servers, logs it, and can undo a run', async () => {
    const t = await setup();
    t.plex.watched.set('11', [movie('p1', 603, true, 'The Matrix (1999)'), ep('p2', 'tvdb:9', 1, 1, false)]);
    t.jf.watched.set('jf-ana', [movie('j1', 603, false, 'The Matrix (1999)'), ep('j2', 'tvdb:9', 1, 1, true)]);

    const plan = (await call(t.app, 'GET', '/api/watch-sync/plan', undefined, t.admin)).body;
    expect(plan).toMatchObject({ ready: true, total: 2 });
    expect(plan.people.find((p: { name: string }) => p.name === 'Ana')).toMatchObject({ state: 'linked', toPlex: 1, toJellyfin: 1 });
    expect(plan.people.find((p: { name: string }) => p.name === 'Sam')).toMatchObject({ state: 'not_linked' });
    expect(plan.people.find((p: { name: string }) => p.name === 'Sam').note).toMatch(/Jellyfin/);
    expect(t.plex.ticks).toEqual([]); // the preview changes nothing

    const run = (await call(t.app, 'POST', '/api/watch-sync/run', {}, t.admin)).body;
    expect(run).toMatchObject({ ticked: 2, failed: 0 });
    expect(t.jf.ticks).toEqual([{ user: 'jf-ana', ref: 'j1', watched: true }]);
    expect(t.plex.ticks).toEqual([{ user: '11', ref: 'p2', watched: true }]);
    // Nothing left to do: a second run adds nothing.
    t.tick();
    expect((await call(t.app, 'POST', '/api/watch-sync/run', {}, t.admin)).body.ticked).toBe(0);

    const status = (await call(t.app, 'GET', '/api/watch-sync', undefined, t.admin)).body;
    expect(status.runs).toHaveLength(1);
    expect(status.runs[0]).toMatchObject({ ticks: 2, undone: 0 });
    expect(status.runs[0].items.map((i: { title: string }) => i.title)).toContain('The Matrix (1999)');

    const undo = (await call(t.app, 'POST', '/api/watch-sync/undo', { at: run.at }, t.admin)).body;
    expect(undo).toEqual({ undone: 2, failed: 0 });
    expect(t.jf.ticks.at(-1)).toEqual({ user: 'jf-ana', ref: 'j1', watched: false });
    expect((await call(t.app, 'GET', '/api/watch-sync', undefined, t.admin)).body.runs[0].undone).toBe(2);
  });

  it('a tick that fails is counted and the rest still happen; needs both servers; admin only', async () => {
    const t = await setup();
    t.plex.watched.set('11', [movie('p1', 1, true), movie('p2', 2, true)]);
    t.jf.watched.set('jf-ana', [movie('j1', 1, false), movie('j2', 2, false)]);
    t.jf.failTick = 'j1';
    expect((await call(t.app, 'POST', '/api/watch-sync/run', {}, t.admin)).body).toMatchObject({ ticked: 1, failed: 1 });

    await call(t.app, 'PUT', '/api/watch-sync/enabled', { enabled: true }, t.admin);
    expect((await call(t.app, 'GET', '/api/watch-sync', undefined, t.admin)).body.enabled).toBe(true);
    const ana = (await call(t.app, 'POST', '/api/auth/login', { username: 'ana', password: 'ana password' })).cookie!;
    expect((await call(t.app, 'GET', '/api/watch-sync/plan', undefined, ana)).status).toBe(403);

    const bare = makeApp();
    const admin = await setupAdmin(bare.app);
    expect((await call(bare.app, 'GET', '/api/watch-sync/plan', undefined, admin)).body).toMatchObject({ ready: false, problem: expect.stringMatching(/both Plex and Jellyfin/) });
  });
});

describe('reading and ticking on the real servers', () => {
  const recorder = (answers: Record<string, unknown>) => {
    const calls: { url: string; method: string; token?: string }[] = [];
    const f = (async (url: string, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push({ url, method: init.method ?? 'GET', token: headers['X-Plex-Token'] });
      const hit = Object.keys(answers).find((k) => url.includes(k));
      const body = hit ? answers[hit] : {};
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    return { calls, f };
  };

  it('Plex: finds each person’s own key from the sharing list, reads with it and ticks with it', async () => {
    const { calls, f } = recorder({
      'plex.tv/api/v2/user': { id: 1, username: 'josh', title: 'Josh' },
      'shared_servers': '<MediaContainer><SharedServer id="9" userID="11" username="ana" accessToken="ANA-TOKEN"/></MediaContainer>',
      '/library/sections/1/all': { MediaContainer: { Metadata: [{ type: 'movie', ratingKey: 5, title: 'The Matrix', year: 1999, viewCount: 1, Guid: [{ id: 'tmdb://603' }, { id: 'imdb://tt0133093' }] }] } },
      '/library/sections/2/all?type=2': { MediaContainer: { Metadata: [{ type: 'show', ratingKey: 70, title: 'Severance', Guid: [{ id: 'tvdb://371980' }] }] } },
      '/library/sections/2/all?type=4': { MediaContainer: { Metadata: [{ type: 'episode', ratingKey: 71, title: 'Pilot', grandparentTitle: 'Severance', grandparentRatingKey: 70, parentIndex: 1, index: 1 }] } },
      '/library/sections': { MediaContainer: { Directory: [{ key: '1', title: 'Movies', type: 'movie' }, { key: '2', title: 'TV', type: 'show' }] } },
      'plex:32400/': { MediaContainer: { machineIdentifier: 'abc', version: '1' } },
    });
    const plex = new PlexServerClient('http://plex:32400', 'OWNER', f);
    expect((await plex.watchedUsers()).map((p) => p.id)).toEqual(['1', '11']);
    const lib = await plex.watchedLibrary('11');
    expect(lib).toEqual([
      { ref: '5', keys: ['m:tmdb:603', 'm:imdb:tt0133093'], watched: true, title: 'The Matrix (1999)', position: 0, lastPlayed: 0 },
      { ref: '71', keys: ['e:tvdb:371980:1:1'], watched: false, title: 'Severance S01E01', position: 0, lastPlayed: 0 },
    ]);
    await plex.setWatched('11', '71', true);
    const tick = calls.at(-1)!;
    expect(tick.url).toBe('http://plex:32400/:/scrobble?identifier=com.plexapp.plugins.library&key=71');
    expect(tick.token).toBe('ANA-TOKEN');
    expect(calls.filter((c) => c.url.includes('/library/sections/1/all')).every((c) => c.token === 'ANA-TOKEN')).toBe(true);
  });

  it('Jellyfin: reads with ids and ticks or unticks for the person', async () => {
    const { calls, f } = recorder({
      'IncludeItemTypes=Series': { Items: [{ Id: 's1', Type: 'Series', Name: 'Severance', ProviderIds: { Tvdb: '371980', Tmdb: '95396' } }] },
      'IncludeItemTypes=Movie,Episode': { Items: [{ Id: 'e1', Type: 'Episode', Name: 'Pilot', SeriesName: 'Severance', SeriesId: 's1', ParentIndexNumber: 1, IndexNumber: 1, UserData: { Played: true, PlaybackPositionTicks: 25_000_000_000, LastPlayedDate: '2026-11-20T10:00:00Z' } }] },
    });
    const jf = new JellyfinClient('http://jf:8096', 'KEY', f);
    expect(await jf.watchedLibrary('u1')).toEqual([{ ref: 'e1', keys: ['e:tvdb:371980:1:1', 'e:tmdb:95396:1:1'], watched: true, title: 'Severance S01E01', position: 2_500_000, lastPlayed: Date.parse('2026-11-20T10:00:00Z') }]);
    await jf.setPosition('u1', 'e1', 60_000);
    expect(calls.at(-1)!.url).toBe('http://jf:8096/Users/u1/Items/e1/UserData');
    await jf.setWatched('u1', 'e1', false);
    expect(calls.at(-1)).toMatchObject({ url: 'http://jf:8096/Users/u1/PlayedItems/e1', method: 'DELETE' });
  });
});
