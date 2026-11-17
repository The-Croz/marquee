import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ArrApi } from '../src/library/arr.js';
import { pickMatch } from '../src/library/scanner.js';
import { ADMIN, call, makeApp, setupAdmin } from './helpers.js';
import { FakeTmdb } from './fakes/tmdb.js';

let root: string;

/** Writes a file of `size` bytes (sparse, so big "movies" cost no disk). */
function file(rel: string, size = 1024, ageDays = 30) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const fd = fs.openSync(p, 'w');
  fs.ftruncateSync(fd, size);
  fs.closeSync(fd);
  const t = new Date(Date.now() - ageDays * 86400_000);
  fs.utimesSync(p, t, t);
}

function snapshot(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((e) => `${path.relative(dir, path.join(e.parentPath, e.name))}:${e.isFile() ? fs.statSync(path.join(e.parentPath, e.name)).size : 'dir'}`)
    .sort();
}

const GB = 1024 ** 3;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-lib-'));
  // Movies: clean names, ID tags, release-style names, extras, samples, an empty folder, an unknown title
  file('movies/The Matrix (1999)/The Matrix (1999) Bluray-1080p.mkv', 8 * GB, 400);
  file('movies/Dune Part Two (2024) {tmdb-693134}/Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.DV.HDR.H.265-FLUX.mkv', 21 * GB, 2);
  file('movies/Dune Part Two (2024) {tmdb-693134}/Featurettes/Making Dune.mkv', 1 * GB);
  file('movies/Inside.Out.2.2024.1080p.WEB-DL.DDP5.1.H.264-GRP/Inside.Out.2.2024.1080p.WEB-DL.DDP5.1.H.264-GRP.mkv', 6 * GB, 3);
  file('movies/Inside.Out.2.2024.1080p.WEB-DL.DDP5.1.H.264-GRP/sample.mkv', 50 * 1024 * 1024);
  file('movies/Blade Runner 2049 (2017)/Blade Runner 2049 (2017) Remux-2160p.mkv', 60 * GB, 100);
  fs.mkdirSync(path.join(root, 'movies/Up (2009)'), { recursive: true });
  file('movies/Some Home Video (2015)/video.mkv', GB);
  file('movies/weird-folder-name/movie.mkv', 4 * GB);
  // TV
  file('tv/Severance (2022)/Season 01/Severance - S01E01 - Good News About Hell [WEBDL-2160p][DV HDR10][h265].mkv', 5 * GB, 5);
  file('tv/Severance (2022)/Season 01/Severance - S01E02 - Half Loop [WEBDL-2160p][DV HDR10][h265].mkv', 5 * GB, 5);
  file('tv/Severance (2022)/Season 02/Severance - S02E01 - Hello, Ms. Cobel [WEBDL-2160p].mkv', 5 * GB, 1);
  file('tv/Bluey (2018) {tvdb-353546}/Season 1/Bluey.S01E01-E03.720p.WEBRip.mkv', GB, 10);
  file('tv/Bluey (2018) {tvdb-353546}/Season 1/Bluey - Behind the scenes.mkv', GB, 10);
  file('tv/Totally Unknown Show/Season 1/Totally Unknown Show S01E01.mkv', GB);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function libraryApp(arr?: Partial<Record<'radarr' | 'sonarr', ArrApi>>) {
  const tmdb = new FakeTmdb();
  const ctx = makeApp({
    clients: {
      tmdb: (key) => (key === 'good-key' ? tmdb : new FakeTmdb(key)),
      arr: (kind) => {
        const api = arr?.[kind];
        if (!api) throw new Error(`no ${kind}`);
        return api;
      },
    },
  });
  return { ...ctx, tmdb };
}

async function scannedApp(arr?: Partial<Record<'radarr' | 'sonarr', ArrApi>>) {
  const ctx = libraryApp(arr);
  const admin = await setupAdmin(ctx.app);
  await call(ctx.app, 'PUT', '/api/settings/services', { tmdbApiKey: 'good-key', moviesRoot: `${root}/movies`, tvRoot: `${root}/tv`, ...(arr?.radarr ? { radarrUrl: 'http://radarr:7878', radarrApiKey: 'r' } : {}) }, admin);
  const start = await call(ctx.app, 'POST', '/api/library/scan', {}, admin);
  expect(start.status).toBe(202);
  await ctx.scanner.wait();
  return { ...ctx, admin };
}

describe('Settings → Services', () => {
  it('stores keys but never sends them back', async () => {
    const { app } = libraryApp();
    const admin = await setupAdmin(app);
    await call(app, 'PUT', '/api/settings/services', { tmdbApiKey: 'good-key', radarrUrl: 'http://192.168.1.100:7878/', radarrApiKey: 'secret' }, admin);
    const view = await call(app, 'GET', '/api/settings/services', undefined, admin);
    expect(view.body).toEqual({
      tmdb: { configured: true, fromEnvironment: false },
      radarr: { url: 'http://192.168.1.100:7878', configured: true },
      sonarr: { url: null, configured: false },
      moviesRoot: '/data/media/movies',
      tvRoot: '/data/media/tv',
    });
    expect(JSON.stringify(view.body)).not.toContain('secret');
    expect(JSON.stringify(view.body)).not.toContain('good-key');
  });

  it('uses the TMDB key from the container settings until one is saved', async () => {
    const ctx = makeApp({ config: { tmdbApiKey: 'from-env' } });
    const admin = await setupAdmin(ctx.app);
    expect((await call(ctx.app, 'GET', '/api/settings/services', undefined, admin)).body.tmdb).toEqual({ configured: true, fromEnvironment: true });
  });

  it('tests connections and explains failures', async () => {
    const radarr: ArrApi = { ping: async () => ({ app: 'Radarr', version: '5.20' }), titles: async () => [] };
    const { app } = libraryApp({ radarr });
    const admin = await setupAdmin(app);
    expect((await call(app, 'POST', '/api/settings/services/test', { service: 'tmdb', apiKey: 'good-key' }, admin)).body).toEqual({ ok: true, message: 'Connected to TMDB.' });
    expect((await call(app, 'POST', '/api/settings/services/test', { service: 'tmdb', apiKey: 'bad' }, admin)).body).toEqual({ ok: false, message: 'TMDB rejected the API key.' });
    const r = await call(app, 'POST', '/api/settings/services/test', { service: 'radarr', url: 'http://radarr:7878', apiKey: 'k' }, admin);
    expect(r.body).toEqual({ ok: true, message: 'Connected to Radarr 5.20: 0 movies.' });
  });

  it('rejects bad addresses and folders in plain English', async () => {
    const { app } = libraryApp();
    const admin = await setupAdmin(app);
    const bad = await call(app, 'PUT', '/api/settings/services', { radarrUrl: '192.168.1.100:7878' }, admin);
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/http:\/\//);
    expect((await call(app, 'PUT', '/api/settings/services', { moviesRoot: 'movies' }, admin)).status).toBe(400);
  });

  it('is admin only', async () => {
    const { app } = libraryApp();
    const admin = await setupAdmin(app);
    await call(app, 'POST', '/api/users', { username: 'jessie', displayName: 'Jessie', role: 'member', password: 'jessie password' }, admin);
    const member = (await call(app, 'POST', '/api/auth/login', { username: 'jessie', password: 'jessie password' })).cookie;
    expect((await call(app, 'GET', '/api/settings/services', undefined, member)).status).toBe(403);
    expect((await call(app, 'POST', '/api/library/scan', {}, member)).status).toBe(403);
  });
});

describe('library scan', () => {
  it('needs a TMDB key first', async () => {
    const { app } = libraryApp();
    const admin = await setupAdmin(app);
    const res = await call(app, 'POST', '/api/library/scan', {}, admin);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/TMDB API key/);
  });

  it('matches movies by ID tag, clean name and release name, and skips extras and samples', async () => {
    const { app, admin, scanner } = await scannedApp();
    expect(scanner.status).toMatchObject({ phase: 'done', error: null });
    const list = await call(app, 'GET', '/api/movies?sort=title', undefined, admin);
    const byTitle = Object.fromEntries(list.body.items.map((m: { title: string }) => [m.title, m]));
    expect(Object.keys(byTitle)).toEqual(['Blade Runner 2049', 'Dune: Part Two', 'Inside Out 2', 'The Matrix']);
    expect(byTitle['Dune: Part Two']).toMatchObject({ badge: '4K DV', complete: true, sizeBytes: 21 * GB });
    expect(byTitle['Inside Out 2']).toMatchObject({ badge: '1080p', sizeBytes: 6 * GB });
    expect(byTitle['The Matrix'].badge).toBe('1080p');
    expect(byTitle['Blade Runner 2049'].badge).toBe('4K');
  });

  it('dates "added" from the files, not from the scan', async () => {
    const { app, admin } = await scannedApp();
    const list = await call(app, 'GET', '/api/movies', undefined, admin);
    expect(list.body.items[0].title).toBe('Dune: Part Two'); // newest file (2 days old)
    expect(list.body.items.at(-1).title).toBe('The Matrix'); // 400 days old
  });

  it('matches shows by folder name and TVDB tag, with episode progress', async () => {
    const { app, admin } = await scannedApp();
    const shows = await call(app, 'GET', '/api/shows?sort=title', undefined, admin);
    expect(shows.body.items.map((s: { title: string; badge: string }) => [s.title, s.badge])).toEqual([
      ['Bluey', 'All 3 episodes'],
      ['Severance', 'All 3 episodes'],
    ]);
    const sev = await call(app, 'GET', `/api/shows/${shows.body.items[1].id}`, undefined, admin);
    expect(sev.body.seasons.map((s: { season: number; have: number; aired: number; total: number }) => [s.season, s.have, s.aired, s.total])).toEqual([
      [1, 2, 2, 2],
      [2, 1, 1, 2],
    ]);
    expect(sev.body.seasons[0].episodes[0]).toMatchObject({ episode: 1, title: 'Good News About Hell', file: { quality: { label: '4K DV', source: 'WEB-DL' } } });
    expect(sev.body.seasons[1].episodes[1]).toMatchObject({ episode: 2, aired: false, file: null });
  });

  it('lists what it could not match, with suggestions, and lets you fix it', async () => {
    const { app, admin } = await scannedApp();
    const un = await call(app, 'GET', '/api/library/unmatched', undefined, admin);
    expect(un.body.items.map((i: { folder: string }) => i.folder)).toEqual(['Some Home Video (2015)', 'weird-folder-name', 'Totally Unknown Show']);

    const weird = un.body.items.find((i: { folder: string }) => i.folder === 'weird-folder-name');
    expect((await call(app, 'POST', `/api/library/unmatched/${weird.id}/match`, { tmdbId: 604 }, admin)).status).toBe(200);
    const after = await call(app, 'GET', '/api/movies?q=reloaded', undefined, admin);
    expect(after.body.items).toMatchObject([{ title: 'The Matrix Reloaded', badge: 'Unknown quality', sizeBytes: 4 * GB }]);

    const home = un.body.items.find((i: { folder: string }) => i.folder === 'Some Home Video (2015)');
    await call(app, 'POST', `/api/library/unmatched/${home.id}/ignore`, {}, admin);
    expect((await call(app, 'GET', '/api/library/unmatched', undefined, admin)).body.items.map((i: { folder: string }) => i.folder)).toEqual(['Totally Unknown Show']);
  });

  it('never changes anything on disk', async () => {
    const before = snapshot(root);
    await scannedApp();
    expect(snapshot(root)).toEqual(before);
  });

  it('rescans quickly and forgets files that were deleted', async () => {
    const { app, admin, scanner, tmdb } = await scannedApp();
    const firstCalls = tmdb.calls.length;
    fs.rmSync(path.join(root, 'tv/Severance (2022)/Season 02'), { recursive: true });
    await call(app, 'POST', '/api/library/scan', {}, admin);
    await scanner.wait();
    // Already-matched folders aren't searched again
    expect(tmdb.calls.slice(firstCalls).filter((c) => c.startsWith('search'))).toEqual([
      'searchMovie:Some Home Video:2015',
      'searchMovie:Some Home Video:',
      'searchMovie:weird-folder-name:',
      'searchShow:Totally Unknown Show:',
    ]);
    const shows = await call(app, 'GET', '/api/shows?q=sev', undefined, admin);
    expect(shows.body.items[0].badge).toBe('2 of 3 episodes');
  });

  it("uses Radarr's IDs when connected, and keeps going if Radarr is down", async () => {
    const radarr: ArrApi = {
      ping: async () => ({ app: 'Radarr', version: '5' }),
      titles: async () => [{ title: 'The Matrix Reloaded', year: 2003, path: '/data/movies/weird-folder-name', tmdbId: 604, tvdbId: null, imdbId: null, monitored: true }],
    };
    const { app, admin } = await scannedApp({ radarr });
    expect((await call(app, 'GET', '/api/movies?q=reloaded', undefined, admin)).body.items).toHaveLength(1);

    const down: ArrApi = { ping: async () => ({ app: 'Radarr', version: '5' }), titles: async () => Promise.reject(new Error('Couldn\'t reach Radarr at http://radarr:7878 (ECONNREFUSED).')) };
    const second = await scannedApp({ radarr: down });
    expect(second.scanner.status.phase).toBe('done');
    expect(second.scanner.status.warnings.join('\n')).toMatch(/Couldn't read Radarr, matching without it/);
  });

  it('falls back to other ways of matching when a TMDB ID no longer exists', async () => {
    // Sonarr remembers a TMDB id that TMDB has since deleted (like The Scooby-Doo Show's 205755)
    const sonarr: ArrApi = {
      ping: async () => ({ app: 'Sonarr', version: '4' }),
      titles: async () => [{ title: 'Severance', year: 2022, path: '/data/media/tv/Severance (2022)', tmdbId: 205755, tvdbId: 371980, imdbId: null, monitored: true }],
    };
    file('movies/Up (2009) {tmdb-999999}/Up (2009) WEBDL-720p.mkv', 2 * GB);
    file('tv/Old Cartoon {tmdb-888888}/Season 1/Old Cartoon S01E01.mkv', GB);
    const ctx = libraryApp({ sonarr });
    const admin = await setupAdmin(ctx.app);
    await call(ctx.app, 'PUT', '/api/settings/services', { tmdbApiKey: 'good-key', moviesRoot: `${root}/movies`, tvRoot: `${root}/tv`, sonarrUrl: 'http://sonarr:8989', sonarrApiKey: 's' }, admin);
    await call(ctx.app, 'POST', '/api/library/scan', {}, admin);
    await ctx.scanner.wait();
    const warnings = ctx.scanner.status.warnings.join('\n');

    // Severance: Sonarr's dead TMDB id → matched by its TVDB id instead
    expect((await call(ctx.app, 'GET', '/api/shows?q=severance', undefined, admin)).body.items).toHaveLength(1);
    expect(warnings).toMatch(/Severance \(2022\): TMDB no longer has Sonarr's TMDB ID 205755; matched another way instead/);
    // Up: dead id in the folder name → matched by title search
    expect((await call(ctx.app, 'GET', '/api/movies?q=up', undefined, admin)).body.items.map((m: { title: string }) => m.title)).toEqual(['Up']);
    // Nothing else works → it goes to "Needs a match" with an explanation, not a warning
    const un = await call(ctx.app, 'GET', '/api/library/unmatched', undefined, admin);
    const cartoon = un.body.items.find((i: { folder: string }) => i.folder.startsWith('Old Cartoon'));
    expect(cartoon.reason).toBe('TMDB no longer has the TMDB ID in the folder name 888888, and no other match was certain.');
    expect(ctx.scanner.status.phase).toBe('done');
  });

  it('warns clearly when a library folder is missing', async () => {
    const ctx = libraryApp();
    const admin = await setupAdmin(ctx.app);
    await call(ctx.app, 'PUT', '/api/settings/services', { tmdbApiKey: 'good-key', moviesRoot: '/nope/movies', tvRoot: `${root}/tv` }, admin);
    await call(ctx.app, 'POST', '/api/library/scan', {}, admin);
    await ctx.scanner.wait();
    expect(ctx.scanner.status.warnings[0]).toMatch(/Can't open the Movies folder \/nope\/movies/);
  });
});

describe('kid profiles', () => {
  it('only see kid-rated titles', async () => {
    const { app, admin } = await scannedApp();
    await call(app, 'POST', '/api/users', { username: 'kids', displayName: 'Kids', role: 'kid', password: 'bluey bluey bluey' }, admin);
    const kid = (await call(app, 'POST', '/api/auth/login', { username: 'kids', password: 'bluey bluey bluey' })).cookie;
    expect((await call(app, 'GET', '/api/movies', undefined, kid)).body.items.map((m: { title: string }) => m.title)).toEqual(['Inside Out 2']);
    expect((await call(app, 'GET', '/api/shows', undefined, kid)).body.items.map((m: { title: string }) => m.title)).toEqual(['Bluey']);
    const matrix = (await call(app, 'GET', '/api/movies?q=matrix', undefined, admin)).body.items[0];
    expect((await call(app, 'GET', `/api/movies/${matrix.id}`, undefined, kid)).status).toBe(404);
    expect((await call(app, 'GET', '/api/library/search?q=up', undefined, kid)).status).toBe(403);
    const home = await call(app, 'GET', '/api/home', undefined, kid);
    expect(home.body.recent.map((r: { title: string }) => r.title).sort()).toEqual(['Bluey', 'Inside Out 2']);
  });
});

describe('search and add', () => {
  it('searches TMDB, marks what you already have, and adds missing titles', async () => {
    const { app, admin } = await scannedApp();
    const res = await call(app, 'GET', '/api/library/search?q=matrix', undefined, admin);
    expect(res.body.results.map((r: { title: string; libraryId: number | null }) => [r.title, r.libraryId !== null])).toEqual([
      ['The Matrix', true],
      ['The Matrix Reloaded', false],
    ]);
    const add = await call(app, 'POST', '/api/library/add', { kind: 'movie', tmdbId: 604 }, admin);
    expect(add.status).toBe(201);
    const missing = await call(app, 'GET', '/api/movies?filter=missing', undefined, admin);
    expect(missing.body.items).toMatchObject([{ title: 'The Matrix Reloaded', badge: 'Missing', complete: false }]);
    expect((await call(app, 'POST', '/api/library/add', { kind: 'movie', tmdbId: 604 }, admin)).status).toBe(200);
  });
});

describe('home', () => {
  it('shows real recently added titles once the library is scanned', async () => {
    const { app, admin } = await scannedApp();
    const home = await call(app, 'GET', '/api/home', undefined, admin);
    expect(home.body.libraryReady).toBe(true);
    expect(home.body.recent[0]).toMatchObject({ title: 'Severance', sub: 'S2 E1 · 4K', posterPath: '/sev.jpg' });
    expect(home.body.recent.map((r: { title: string }) => r.title)).toContain('Dune: Part Two');
    expect(home.body.stats[0]).toMatchObject({ label: 'In your library', value: '6', note: '4 movies · 2 shows' });
  });

  it('falls back to sample data before the first scan', async () => {
    const { app } = libraryApp();
    const admin = await setupAdmin(app);
    expect((await call(app, 'GET', '/api/home', undefined, admin)).body.libraryReady).toBe(false);
  });
});

describe('pickMatch', () => {
  const r = (tmdbId: number, title: string, year: number | null, popularity = 1) => ({ tmdbId, title, year, posterPath: null, overview: '', popularity });
  it('requires the same title and a year within one', () => {
    expect(pickMatch([r(1, 'Up', 2009)], 'Up', 2009)?.tmdbId).toBe(1);
    expect(pickMatch([r(1, 'Up', 2009)], 'Up', 2010)?.tmdbId).toBe(1);
    expect(pickMatch([r(1, 'Up', 2009)], 'Up', 2015)).toBeNull();
    expect(pickMatch([r(1, 'Upgrade', 2018)], 'Up', 2018)).toBeNull();
  });
  it('prefers the exact year, then popularity', () => {
    expect(pickMatch([r(1, 'Dune', 1984, 50), r(2, 'Dune', 2021, 300)], 'Dune', 2021)?.tmdbId).toBe(2);
    expect(pickMatch([r(1, 'Dune', 1984, 50), r(2, 'Dune', 2021, 300)], 'Dune', null)?.tmdbId).toBe(2);
  });
});

void ADMIN;
