import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, setSetting } from '../src/db/index.js';
import { ImportError, importDownload, videoFiles } from '../src/downloads/importer.js';
import { mapPath } from '../src/downloads/service.js';
import { DEFAULT_MOVIE_PATTERN, DEFAULT_TV_PATTERN, patternProblem, renderName } from '../src/library/naming.js';
import { makeApp } from './helpers.js';

const MB = 1024 ** 2;

describe('clean names', () => {
  it('fills the default movie pattern the way Plex and Jellyfin like', () => {
    expect(renderName(DEFAULT_MOVIE_PATTERN, { Title: 'Dune: Part Two', Year: 2024, TmdbId: 693134, Quality: 'WEBDL-2160p', HDR: 'DV HDR10' })).toBe(
      'Dune - Part Two (2024) {tmdb-693134}/Dune - Part Two (2024) [WEBDL-2160p][DV HDR10]',
    );
    expect(renderName(DEFAULT_MOVIE_PATTERN, { Title: 'Up', Year: null, TmdbId: null, Quality: 'Bluray-1080p', Edition: "Director's Cut" })).toBe("Up/Up Director's Cut [Bluray-1080p]");
  });

  it('fills the TV pattern, including multi-episode files', () => {
    const v = { Show: 'Severance', Year: 2022, TvdbId: 371980, Season: 2, Episodes: [3], 'Episode Title': 'Who Is Alive?', Quality: 'WEBDL-1080p' };
    expect(renderName(DEFAULT_TV_PATTERN, v)).toBe('Severance (2022) {tvdb-371980}/Season 02/Severance - S02E03 - Who Is Alive [WEBDL-1080p]');
    expect(renderName(DEFAULT_TV_PATTERN, { ...v, Episodes: [1, 2], 'Episode Title': null, Quality: null })).toBe('Severance (2022) {tvdb-371980}/Season 02/Severance - S02E01-E02');
  });

  it('never lets a title add folders', () => {
    expect(renderName('{Title}/{Title}', { Title: 'AC/DC: Live' })).toBe('AC DC - Live/AC DC - Live');
    expect(renderName('{Title}', { Title: '../..' })).toBe('');
  });

  it('checks patterns with plain messages', () => {
    expect(patternProblem(DEFAULT_MOVIE_PATTERN, 'movie')).toBeNull();
    expect(patternProblem(DEFAULT_TV_PATTERN, 'tv')).toBeNull();
    expect(patternProblem('{Name} ({Year})', 'movie')).toMatch(/\{Name\} isn’t something/);
    expect(patternProblem('/movies/{Title}', 'movie')).toMatch(/no leading/);
    expect(patternProblem('{Title}/../{Title}', 'movie')).toMatch(/no “\.\.”/);
    expect(patternProblem('{Show}/{Show} - {Episode Title}', 'tv')).toMatch(/\{Season\}/);
  });
});

describe('which files go in the library', () => {
  it('skips samples, extras and tiny files', () => {
    const files = [
      { name: 'Movie/Movie.2024.2160p.mkv', size: 20_000 * MB },
      { name: 'Movie/Sample/movie-sample.mkv', size: 80 * MB },
      { name: 'Movie/movie.sample.mkv', size: 80 * MB },
      { name: 'Movie/Featurettes/Making Of.mkv', size: 900 * MB },
      { name: 'Movie/trailer.mkv', size: 50 * MB },
      { name: 'Movie/Movie.nfo', size: 1 },
    ];
    expect(videoFiles(files).map((f) => f.name)).toEqual(['Movie/Movie.2024.2160p.mkv']);
  });

  it('maps qBittorrent’s folders to Marquee’s', () => {
    const pairs = [
      { from: '/downloads', to: '/data/torrents' },
      { from: '/downloads/tv', to: '/data/tv-downloads' },
    ];
    expect(mapPath('/downloads/marquee/x.mkv', pairs)).toBe('/data/torrents/marquee/x.mkv');
    expect(mapPath('/downloads/tv/x.mkv', pairs)).toBe('/data/tv-downloads/x.mkv');
    expect(mapPath('/downloadsX/x.mkv', pairs)).toBe('/downloadsX/x.mkv');
  });
});

// ---------------------------------------------------------------- importing for real, in a temp folder

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-import-'));
  dirs.push(root);
  const t = makeApp();
  setSetting(t.db, 'library.movies_root', path.join(root, 'media/movies'));
  setSetting(t.db, 'library.tv_root', path.join(root, 'media/tv'));
  const write = (rel: string, bytes = 1000) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(bytes, 7));
    return p;
  };
  const movie = t.db
    .insert(schema.movies)
    .values({ tmdbId: 693134, title: 'Dune: Part Two', sortTitle: 'dune part two', year: 2024, profile: 'cinema', addedAt: 0, refreshedAt: 0 })
    .returning()
    .get();
  const show = t.db.insert(schema.series).values({ tmdbId: 95396, tvdbId: 371980, title: 'Severance', sortTitle: 'severance', year: 2022, profile: 'cinema', addedAt: 0, refreshedAt: 0 }).returning().get();
  t.db.insert(schema.episodes).values([
    { seriesId: show.id, season: 2, episode: 1, title: 'Hello, Ms. Cobel' },
    { seriesId: show.id, season: 2, episode: 2, title: 'Goodbye, Mrs. Selvig' },
  ]).run();
  const download = (extra: Partial<typeof schema.downloads.$inferInsert> = {}) =>
    t.db
      .insert(schema.downloads)
      .values({ kind: 'movie', movieId: movie.id, title: 'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX', infoHash: 'h1', addedAt: 0, state: 'done', savePath: path.join(root, 'torrents/marquee'), ...extra })
      .returning()
      .get();
  return { ...t, root, write, movie, show, download };
}

describe('putting a download in the library', () => {
  it('hardlinks the movie under a clean name and records it', async () => {
    const w = world();
    const src = w.write('torrents/marquee/Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX/Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX.mkv', 5000);
    w.write('torrents/marquee/Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX/sample.mkv', 100);
    const files = [
      { name: 'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX/Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX.mkv', size: 5000 },
      { name: 'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX/sample.mkv', size: 100 },
    ];
    const r = await importDownload(w.db, w.download(), files, 1);
    const dest = path.join(w.root, 'media/movies/Dune - Part Two (2024) {tmdb-693134}/Dune - Part Two (2024) [WEBDL-2160p][DV HDR].mkv');
    expect(r).toEqual({ paths: [dest], copied: false, replaced: [] });
    expect(fs.statSync(dest).ino).toBe(fs.statSync(src).ino);
    expect(fs.existsSync(src)).toBe(true); // still there for qBittorrent to share
    const rec = w.db.select().from(schema.mediaFiles).all();
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ path: dest, movieId: w.movie.id, size: 5000, resolution: '2160p' });
    expect(w.db.select().from(schema.movies).where(eq(schema.movies.id, w.movie.id)).get()!.path).toBe(path.dirname(dest));
    // Doing it again is fine: already linked.
    expect((await importDownload(w.db, w.download(), files, 2)).paths).toEqual([dest]);
  });

  it('keeps an existing folder, and sets the replaced file aside instead of deleting it', async () => {
    const w = world();
    const oldFile = w.write('media/movies/Dune Part Two (2024)/Dune Part Two (2024) WEBDL-1080p.mkv', 300);
    w.db.update(schema.movies).set({ path: path.dirname(oldFile) }).run();
    w.db.insert(schema.mediaFiles).values({ path: oldFile, movieId: w.movie.id, size: 300, mtime: 0, addedAt: 0, seenAt: 0 }).run();
    w.write('torrents/marquee/dune.mkv', 5000);
    const r = await importDownload(w.db, w.download(), [{ name: 'dune.mkv', size: 5000 }], 1);
    expect(r.paths[0]).toBe(path.join(w.root, 'media/movies/Dune Part Two (2024)/Dune - Part Two (2024) [WEBDL-2160p][DV HDR].mkv'));
    expect(r.replaced).toEqual([oldFile]);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(path.join(w.root, 'media/movies/.marquee-replaced/Dune Part Two (2024)/Dune Part Two (2024) WEBDL-1080p.mkv'))).toBe(true);
    expect(w.db.select().from(schema.mediaFiles).all().map((f) => f.path)).toEqual(r.paths);
  });

  it('copies when the download and the library are on different disks, and says so', async () => {
    const w = world();
    w.write('torrents/marquee/dune.mkv', 5000);
    const exdev = Object.assign(new Error('cross-device'), { code: 'EXDEV' });
    const r = await importDownload(w.db, w.download(), [{ name: 'dune.mkv', size: 5000 }], 1, {
      link: async () => Promise.reject(exdev),
      copy: (a, b) => fs.promises.copyFile(a, b),
    });
    expect(r.copied).toBe(true);
    expect(fs.statSync(r.paths[0]!).size).toBe(5000);
  });

  it('waits to copy when it would leave the library disk under the minimum, but hardlinks anyway', async () => {
    const w = world();
    w.write('torrents/marquee/dune.mkv', 5000);
    const tight = async () => ({ free: 15 * 1024 ** 3, total: 1000 * 1024 ** 3 }); // under the 20 GB default
    let copied = false;
    const copyOps = { link: async () => {}, copy: async () => void (copied = true), sameDisk: async () => false };
    const err = await importDownload(w.db, w.download(), [{ name: 'dune.mkv', size: 5000 }], 1, copyOps, tight).catch((e) => e);
    expect(err).toBeInstanceOf(ImportError);
    expect(err.message).toMatch(/^Not enough room on the Movies disk .*15\.0 GB free.*keeps 20 GB spare.*tries again by itself\.$/);
    expect(copied).toBe(false);
    expect(w.db.select().from(schema.mediaFiles).all()).toEqual([]);

    // A hardlink takes no space, so the same import goes ahead on one disk.
    const r = await importDownload(w.db, w.download(), [{ name: 'dune.mkv', size: 5000 }], 1, undefined, tight);
    expect(r.copied).toBe(false);
    expect(r.paths).toHaveLength(1);
  });

  it('puts each episode of a season pack in its place, skipping the rest', async () => {
    const w = world();
    for (const n of ['Severance.S02E01.1080p.WEB-DL.mkv', 'Severance.S02E02.1080p.WEB-DL.mkv']) w.write(`torrents/marquee/Severance.S02/${n}`, 2000);
    const files = [
      { name: 'Severance.S02/Severance.S02E01.1080p.WEB-DL.mkv', size: 2000 },
      { name: 'Severance.S02/Severance.S02E02.1080p.WEB-DL.mkv', size: 2000 },
    ];
    const pack = w.download({ kind: 'tv', movieId: null, seriesId: w.show.id, season: 2, episodes: null, title: 'Severance.S02.1080p.WEB-DL-GRP' });
    const r = await importDownload(w.db, pack, files, 1);
    expect(r.paths.map((p) => path.relative(path.join(w.root, 'media/tv'), p))).toEqual([
      'Severance (2022) {tvdb-371980}/Season 02/Severance - S02E01 - Hello, Ms. Cobel [WEBDL-1080p].mkv',
      'Severance (2022) {tvdb-371980}/Season 02/Severance - S02E02 - Goodbye, Mrs. Selvig [WEBDL-1080p].mkv',
    ]);
    expect(w.db.select().from(schema.mediaFiles).all().map((f) => f.episodes)).toEqual(['[1]', '[2]']);
    // One episode from a pack: only that one.
    const one = w.download({ kind: 'tv', movieId: null, seriesId: w.show.id, season: 2, episodes: '[2]', title: 'Severance.S02.1080p.WEB-DL-GRP', infoHash: 'h2' });
    expect((await importDownload(w.db, one, files, 2)).paths).toHaveLength(1);
    const wrong = w.download({ kind: 'tv', movieId: null, seriesId: w.show.id, season: 2, episodes: '[5]', infoHash: 'h3' });
    await expect(importDownload(w.db, wrong, files, 3)).rejects.toThrow(/None of the files in this download are S02E05/);
  });

  it('explains when Marquee can’t see the download, and follows folder pairs', async () => {
    const w = world();
    w.write('torrents/marquee/dune.mkv', 5000);
    const d = w.download({ savePath: '/downloads/marquee' });
    const err = await importDownload(w.db, d, [{ name: 'dune.mkv', size: 5000 }], 1).catch((e) => e);
    expect(err).toBeInstanceOf(ImportError);
    expect(err.message).toMatch(/can't see the downloaded file at \/downloads\/marquee\/dune\.mkv\. .*add a folder pair .*qBittorrent's folder: \/downloads\/marquee/);
    setSetting(w.db, 'downloader.folder_pairs', JSON.stringify([{ from: '/downloads', to: path.join(w.root, 'torrents') }]));
    expect((await importDownload(w.db, d, [{ name: 'dune.mkv', size: 5000 }], 2)).paths).toHaveLength(1);
  });

  it('says what to do when it can’t write in the library', async () => {
    const w = world();
    w.write('torrents/marquee/dune.mkv', 5000);
    const denied = Object.assign(new Error('nope'), { code: 'EACCES' });
    const err = await importDownload(w.db, w.download(), [{ name: 'dune.mkv', size: 5000 }], 1, { link: async () => Promise.reject(denied), copy: async () => {} }).catch((e) => e);
    expect(err.message).toMatch(/isn't allowed to write .*PUID and PGID/);
  });

  it('leaves downloads from other apps to them, and needs a video', async () => {
    const w = world();
    await expect(importDownload(w.db, w.download({ adopted: true }), [], 1)).rejects.toThrow(/Another app sent this download/);
    await expect(importDownload(w.db, w.download(), [{ name: 'readme.txt', size: 1 }], 1)).rejects.toThrow(/no video file/);
  });
});

describe('naming settings API', async () => {
  const { call, setupAdmin } = await import('./helpers.js');
  it('saves patterns, previews them and refuses broken ones', async () => {
    const t = makeApp();
    const admin = await setupAdmin(t.app);
    const view = await call(t.app, 'GET', '/api/settings/services', undefined, admin);
    expect(view.body.naming).toMatchObject({ movie: DEFAULT_MOVIE_PATTERN, tv: DEFAULT_TV_PATTERN });
    const ex = await call(t.app, 'POST', '/api/settings/services/name-example', { kind: 'movie', pattern: '{Title} ({Year})/{Title} - {Quality}' }, admin);
    expect(ex.body).toEqual({ example: 'Dune - Part Two (2024)/Dune - Part Two - WEBDL-2160p.mkv', problem: null });
    expect((await call(t.app, 'POST', '/api/settings/services/name-example', { kind: 'tv', pattern: '{Show}' }, admin)).body.problem).toMatch(/\{Season\}/);
    const bad = await call(t.app, 'PUT', '/api/settings/services', { tvPattern: '{Show}/{Nope}' }, admin);
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/\{Nope\} isn’t something/);
    await call(t.app, 'PUT', '/api/settings/services', { moviePattern: '{Title} ({Year})/{Title}' }, admin);
    expect((await call(t.app, 'GET', '/api/settings/services', undefined, admin)).body.naming.movie).toBe('{Title} ({Year})/{Title}');
    await call(t.app, 'PUT', '/api/settings/services', { moviePattern: '' }, admin);
    expect((await call(t.app, 'GET', '/api/settings/services', undefined, admin)).body.naming.movie).toBe(DEFAULT_MOVIE_PATTERN);
    // Folder pairs on Settings → Downloader.
    const pairs = await call(t.app, 'PUT', '/api/settings/downloader', { folderPairs: [{ from: '/downloads/', to: '/data/torrents' }] }, admin);
    expect(pairs.body.folderPairs).toEqual([{ from: '/downloads', to: '/data/torrents' }]);
    expect((await call(t.app, 'PUT', '/api/settings/downloader', { folderPairs: [{ from: 'downloads', to: '/x' }] }, admin)).status).toBe(400);
  });
});
