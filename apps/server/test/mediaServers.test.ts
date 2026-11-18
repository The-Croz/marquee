import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DownloadsView } from '@marquee/shared';
import { schema, setSetting } from '../src/db/index.js';
import { JellyfinClient, MediaServerError, PlexServerClient, pickLibrary, serverPath, tellMediaServers } from '../src/library/mediaServers.js';
import { FakeMediaServer } from './fakes/mediaServers.js';
import { FakeQbit, qbitTorrent } from './fakes/qbittorrent.js';
import { call, makeApp, setupAdmin } from './helpers.js';

const LIBS = new FakeMediaServer('plex').libs;

describe('which library, and what path the server sees', () => {
  it('picks the library of the right kind, or the one you chose', () => {
    expect(pickLibrary(LIBS, 'movie', null, '/data/media/movies')?.name).toBe('Movies');
    expect(pickLibrary(LIBS, 'tv', null, '/data/media/tv')?.name).toBe('TV Shows');
    const two = [...LIBS, { id: '9', name: '4K Movies', kind: 'movie' as const, locations: ['/media/4k'] }];
    expect(pickLibrary(two, 'movie', null, '/data/media/movies')?.id).toBe('1');
    expect(pickLibrary(two, 'movie', '9', '/data/media/movies')?.id).toBe('9');
    expect(pickLibrary(two, 'movie', 'gone', '/data/media/movies')).toBeNull();
    expect(pickLibrary([], 'tv', null, '/x')).toBeNull();
  });

  it('turns Marquee’s folder into the server’s', () => {
    const plexMovies = LIBS[0]!;
    expect(serverPath('/data/media/movies/Up (2009)', '/data/media/movies', plexMovies)).toBe('/media/movies/Up (2009)');
    const same = { ...plexMovies, locations: ['/data/media/movies'] };
    expect(serverPath('/data/media/movies/Up (2009)', '/data/media/movies', same)).toBe('/data/media/movies/Up (2009)');
    expect(serverPath('/elsewhere/Up', '/data/media/movies', plexMovies)).toBe('/elsewhere/Up');
  });
});

describe('Plex and Jellyfin clients', () => {
  it('reads Plex sections and asks for a folder scan with the token', async () => {
    const asked: { url: string; token: string | null }[] = [];
    const f = (async (u: string | URL, init: RequestInit = {}) => {
      asked.push({ url: String(u), token: new Headers(init.headers).get('x-plex-token') });
      const p = new URL(String(u)).pathname;
      if (p === '/') return Response.json({ MediaContainer: { friendlyName: 'Tower', version: '1.41.3' } });
      if (p === '/library/sections') return Response.json({ MediaContainer: { Directory: [{ key: '1', title: 'Movies', type: 'movie', Location: [{ path: '/media/movies' }] }, { key: '2', title: 'TV', type: 'show', Location: [{ path: '/media/tv' }] }] } });
      return new Response('');
    }) as typeof fetch;
    const plex = new PlexServerClient('http://plex:32400/', 'TOKEN', f);
    expect(await plex.ping()).toEqual({ name: 'Tower', version: '1.41.3' });
    const libs = await plex.libraries();
    expect(libs.map((l) => [l.id, l.kind, l.locations[0]])).toEqual([
      ['1', 'movie', '/media/movies'],
      ['2', 'tv', '/media/tv'],
    ]);
    await plex.scan(libs[0]!, '/media/movies/Up (2009)');
    expect(asked.at(-1)).toEqual({ url: 'http://plex:32400/library/sections/1/refresh?path=%2Fmedia%2Fmovies%2FUp%20(2009)', token: 'TOKEN' });
  });

  it('reads Jellyfin libraries and reports a new folder', async () => {
    const asked: { url: string; auth: string | null; body: string | null; method: string }[] = [];
    const f = (async (u: string | URL, init: RequestInit = {}) => {
      asked.push({ url: String(u), auth: new Headers(init.headers).get('authorization'), body: init.body ? String(init.body) : null, method: init.method ?? 'GET' });
      const p = new URL(String(u)).pathname;
      if (p === '/System/Info') return Response.json({ ServerName: 'Tower', Version: '10.10.3' });
      if (p === '/Library/VirtualFolders') return Response.json([{ Name: 'Movies', ItemId: 'abc', CollectionType: 'movies', Locations: ['/data/media/movies'] }]);
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const jf = new JellyfinClient('http://jellyfin:8096', 'KEY', f);
    expect(await jf.ping()).toEqual({ name: 'Tower', version: '10.10.3' });
    const [lib] = await jf.libraries();
    expect(lib).toEqual({ id: 'abc', name: 'Movies', kind: 'movie', locations: ['/data/media/movies'] });
    await jf.scan(lib!, '/data/media/movies/Up (2009)');
    expect(asked.at(-1)).toEqual({
      url: 'http://jellyfin:8096/Library/Media/Updated',
      auth: 'MediaBrowser Token="KEY"',
      method: 'POST',
      body: JSON.stringify({ Updates: [{ Path: '/data/media/movies/Up (2009)', UpdateType: 'Created' }] }),
    });
  });

  it('says plainly when a server can’t be reached or turns the key down, without the key', async () => {
    const down = (async () => Promise.reject(Object.assign(new TypeError('x'), { cause: { code: 'ECONNREFUSED' } }))) as unknown as typeof fetch;
    const e1 = await new PlexServerClient('http://plex:32400', 'SECRET', down).ping().catch((e) => e);
    expect(e1).toBeInstanceOf(MediaServerError);
    expect(e1.message).toBe("Couldn't reach Plex at http://plex:32400 (ECONNREFUSED).");
    const refused = (async () => new Response('', { status: 401 })) as unknown as typeof fetch;
    const e2 = await new JellyfinClient('http://jf', 'SECRET', refused).libraries().catch((e) => e);
    expect(e2.message).toBe('Jellyfin turned down the API key.');
  });
});

// ---------------------------------------------------------------- settings and scans after an import

function setup() {
  const plex = new FakeMediaServer('plex');
  const jellyfin = new FakeMediaServer('jellyfin');
  const qbit = new FakeQbit();
  let clock = Date.parse('2026-11-18T12:00:00Z');
  const t = makeApp({ now: () => clock, clients: { plexServer: (u, k) => plex.as(u, k), jellyfin: (u, k) => jellyfin.as(u, k), qbittorrent: (u, n, p) => qbit.as(u, n, p) } });
  return { ...t, plex, jellyfin, qbit, later: (ms: number) => (clock += ms) };
}

describe('Settings → Services: Plex and Jellyfin', () => {
  it('connects, tests, lists libraries and never sends the token back', async () => {
    const t = setup();
    const admin = await setupAdmin(t.app);
    await call(t.app, 'PUT', '/api/settings/services', { plexUrl: 'http://plex:32400/', plexToken: 'plex-token', jellyfinUrl: 'http://jellyfin:8096', jellyfinApiKey: 'jellyfin-key' }, admin);
    const v = await call(t.app, 'GET', '/api/settings/services', undefined, admin);
    expect(v.body.plex).toEqual({ url: 'http://plex:32400', configured: true, movieLibrary: null, tvLibrary: null });
    expect(JSON.stringify(v.body)).not.toMatch(/plex-token|jellyfin-key/);
    const test = await call(t.app, 'POST', '/api/settings/services/test', { service: 'plex' }, admin);
    expect(test.body).toEqual({ ok: true, message: "Connected to Josh's Plex (Plex 1.41.3): 1 movie library and 1 TV library." });
    const libs = await call(t.app, 'POST', '/api/settings/services/media-libraries', { server: 'jellyfin' }, admin);
    expect(libs.body.picked).toEqual({ movie: 'a1', tv: 'b2' });
    await call(t.app, 'PUT', '/api/settings/services', { plexTvLibrary: '3' }, admin);
    expect((await call(t.app, 'POST', '/api/settings/services/media-libraries', { server: 'plex' }, admin)).body.picked.tv).toBe('3');
    expect((await call(t.app, 'PUT', '/api/settings/services', { plexTvLibrary: '' }, admin)).status).toBe(200);
    expect((await call(t.app, 'GET', '/api/settings/services', undefined, admin)).body.plex.tvLibrary).toBeNull();
  });

  it('never sends a saved token to a new address, and says what’s wrong', async () => {
    const t = setup();
    const admin = await setupAdmin(t.app);
    await call(t.app, 'PUT', '/api/settings/services', { plexUrl: 'http://plex:32400', plexToken: 'plex-token' }, admin);
    const moved = await call(t.app, 'POST', '/api/settings/services/test', { service: 'plex', url: 'http://elsewhere:32400' }, admin);
    expect(moved.body).toEqual({ ok: false, message: 'The address changed. For safety, type the token again.' });
    const wrong = await call(t.app, 'POST', '/api/settings/services/test', { service: 'jellyfin', url: 'http://jellyfin:8096', apiKey: 'nope' }, admin);
    expect(wrong.body).toEqual({ ok: false, message: 'Jellyfin turned down the API key.' });
    // A new address without a token forgets the old one.
    await call(t.app, 'PUT', '/api/settings/services', { plexUrl: 'http://new:32400' }, admin);
    expect((await call(t.app, 'GET', '/api/settings/services', undefined, admin)).body.plex.configured).toBe(false);
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('after an import', () => {
  it('tells both servers to scan just that folder, each in its own path', async () => {
    const t = setup();
    setSetting(t.db, 'services.plex_url', 'http://plex:32400');
    setSetting(t.db, 'services.plex_token', 'plex-token');
    setSetting(t.db, 'services.jellyfin_url', 'http://jellyfin:8096');
    setSetting(t.db, 'services.jellyfin_api_key', 'jellyfin-key');
    const r = await tellMediaServers(t.db, { plexServer: (u, k) => t.plex.as(u, k), jellyfin: (u, k) => t.jellyfin.as(u, k) }, 'tv', ['/data/media/tv/Severance (2022)/Season 02', '/data/media/tv/Severance (2022)/Season 02']);
    expect(r).toEqual({ told: ['Plex', 'Jellyfin'], failed: [] });
    expect(t.plex.scans).toEqual([{ library: '2', folder: '/media/tv/Severance (2022)/Season 02' }]);
    expect(t.jellyfin.scans).toEqual([{ library: 'b2', folder: '/data/media/tv/Severance (2022)/Season 02' }]);
  });

  it('does it right after putting a download in the library, and retries a server that didn’t answer', async () => {
    const t = setup();
    const admin = await setupAdmin(t.app);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-scan-'));
    dirs.push(root);
    setSetting(t.db, 'library.movies_root', path.join(root, 'movies'));
    await call(t.app, 'PUT', '/api/settings/downloader', { url: t.qbit.url, username: 'admin', password: 'adminadmin' }, admin);
    await call(t.app, 'PUT', '/api/settings/services', { plexUrl: 'http://plex:32400', plexToken: 'plex-token', jellyfinUrl: 'http://jellyfin:8096', jellyfinApiKey: 'jellyfin-key' }, admin);
    t.jellyfin.fail = "Couldn't reach Jellyfin at http://jellyfin:8096 (ECONNREFUSED).";
    const movie = t.db.insert(schema.movies).values({ tmdbId: 14160, title: 'Up', sortTitle: 'up', year: 2009, profile: 'cinema', addedAt: 0, refreshedAt: 0 }).returning().get();
    fs.mkdirSync(path.join(root, 'torrents/Up.2009'), { recursive: true });
    fs.writeFileSync(path.join(root, 'torrents/Up.2009/Up.2009.1080p.BluRay.x264.mkv'), Buffer.alloc(3000));
    t.db.insert(schema.downloads).values({ kind: 'movie', movieId: movie.id, title: 'Up.2009.1080p.BluRay.x264-GRP', infoHash: 'h1', addedAt: 0, state: 'downloading' }).run();
    t.qbit.list.push(qbitTorrent('h1', { name: 'Up.2009', state: 'stalledUP', progress: 1, size: 3000, savePath: path.join(root, 'torrents') }));
    t.qbit.fileLists.set('h1', [{ name: 'Up.2009/Up.2009.1080p.BluRay.x264.mkv', size: 3000 }]);

    const view = async () => {
      t.later(11_000);
      return ((await call(t.app, 'GET', '/api/downloads', undefined, admin)).body as DownloadsView).items[0]!;
    };
    let d = await view();
    expect(d.status.label).toBe('In your library · sharing');
    expect(d.status.detail).toMatch(/Told Plex to scan it\. Couldn't reach Jellyfin/);
    // Plex sees /media/movies here, so it's asked about its own path.
    expect(t.plex.scans).toEqual([{ library: '1', folder: '/media/movies/Up (2009) {tmdb-14160}' }]);
    t.jellyfin.fail = null;
    t.later(16 * 60_000);
    d = await view();
    expect(t.jellyfin.scans).toEqual([{ library: 'a1', folder: path.join(root, 'movies/Up (2009) {tmdb-14160}').replace(path.join(root, 'movies'), '/data/media/movies') }]);
    expect(d.status.detail).toMatch(/Told Plex and Jellyfin to scan it\.$/);
  });

  it('skips servers that aren’t set up, quietly', async () => {
    const t = setup();
    expect(await tellMediaServers(t.db, { plexServer: (u, k) => t.plex.as(u, k), jellyfin: (u, k) => t.jellyfin.as(u, k) }, 'movie', ['/x'])).toEqual({ told: [], failed: [] });
  });
});
