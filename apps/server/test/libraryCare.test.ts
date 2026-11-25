import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ImportScanView, RemovalPreview, RenamePlanView, ReplacedView } from '@marquee/shared';
import { openDb, schema } from '../src/db/index.js';
import { importDownload } from '../src/downloads/importer.js';
import { extrasNames, subtitleTags, subtitlesInList } from '../src/library/extras.js';
import { lookNowDone } from '../src/library/lookNow.js';
import { FakeMediaServer } from './fakes/mediaServers.js';
import { FakeQbit, fakeFetchTorrent, qbitTorrent } from './fakes/qbittorrent.js';
import { FakeSites, release } from './fakes/sources.js';
import { FakeTmdb } from './fakes/tmdb.js';
import { call, makeApp, setupAdmin } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A library on disk in a temp folder, Plex watching it, a fake qBittorrent, TMDB and one Source. */
async function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-care-'));
  dirs.push(root);
  const tmdb = new FakeTmdb();
  const qbit = new FakeQbit();
  const sites = new FakeSites();
  sites.feed('http://tpb.test/api', { releases: [release('Up.2009.2160p.UHD.BluRay.x265.HDR.DDP5.1-GRP', { size: 18 * 1024 ** 3 }), release('The.Matrix.1999.2160p.UHD.BluRay.x265.HDR.DDP5.1-GRP', { size: 20 * 1024 ** 3 })] });
  const plex = new FakeMediaServer('plex', [
    { id: '1', name: 'Movies', kind: 'movie', locations: [`${root}/media/movies`] },
    { id: '2', name: 'TV Shows', kind: 'tv', locations: [`${root}/media/tv`] },
  ]);
  const t = makeApp({ trashPresets: true, clients: { tmdb: () => tmdb, qbittorrent: (u, n, p) => qbit.as(u, n, p), fetchTorrent: fakeFetchTorrent(), plexServer: (u, k) => plex.as(u, k), torznab: sites.torznab } });
  const admin = await setupAdmin(t.app);
  await call(t.app, 'PUT', '/api/settings/services', { tmdbApiKey: 'good-key', moviesRoot: `${root}/media/movies`, tvRoot: `${root}/media/tv`, plexUrl: 'http://plex:32400', plexToken: 'plex-token' }, admin);
  await call(t.app, 'PUT', '/api/system/disk', { downloadsFolder: `${root}/torrents` }, admin);
  const write = (rel: string, bytes = 1000) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(bytes, 7));
    return p;
  };
  const scan = async () => {
    await call(t.app, 'POST', '/api/library/scan', {}, admin);
    await t.scanner.wait();
  };
  const movieId = (tmdbId: number) => t.db.select().from(schema.movies).where(eq(schema.movies.tmdbId, tmdbId)).get()?.id;
  const showId = (tmdbId: number) => t.db.select().from(schema.series).where(eq(schema.series.tmdbId, tmdbId)).get()?.id;
  const ls = (rel: string) =>
    fs
      .readdirSync(path.join(root, rel), { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => path.relative(path.join(root, rel), path.join(e.parentPath, e.name)))
      .sort();
  const api = (method: string, url: string, body?: unknown) => call(t.app, method, url, body, admin);
  return { ...t, root, admin, tmdb, qbit, plex, sites, write, scan, movieId, showId, ls, api };
}

// ---------------------------------------------------------------- subtitles (L16)

describe('subtitles that come along with a video', () => {
  it('keeps language and forced tags from many naming styles', () => {
    expect(subtitleTags('Movie.2024.English.Forced.srt', 'Movie.2024')).toEqual(['en', 'forced']);
    expect(subtitleTags('2_English.srt', null)).toEqual(['en']);
    expect(subtitleTags('Movie.2024.eng.SDH.srt', 'Movie.2024')).toEqual(['en', 'sdh']);
    expect(subtitleTags('Movie.2024.srt', 'Movie.2024')).toEqual([]);
    expect(subtitleTags('Movie.2024.fr.ass', 'Movie.2024')).toEqual(['fr']);
  });

  it('names them after the video, numbering two of the same kind, and keeps .sub and .idx together', () => {
    const names = extrasNames(['/d/Movie.en.srt', '/d/Movie.en.sdh.srt', '/d/Subs/English.srt', '/d/Movie.idx', '/d/Movie.sub'], 'Movie', 'New Name [WEBDL-1080p]').map((x) => x.name);
    expect(names).toEqual(['New Name [WEBDL-1080p].en.srt', 'New Name [WEBDL-1080p].en.sdh.srt', 'New Name [WEBDL-1080p].en.2.srt', 'New Name [WEBDL-1080p].idx', 'New Name [WEBDL-1080p].sub']);
  });

  it('finds each episode’s subtitles in a whole-season copy', () => {
    const files = [
      { name: 'Show.S01/Show.S01E01.mkv' },
      { name: 'Show.S01/Show.S01E02.mkv' },
      { name: 'Show.S01/Show.S01E01.en.srt' },
      { name: 'Show.S01/Subs/Show.S01E02/2_English.srt' },
      { name: 'Show.S01/Subs/Show.S01E01/3_French.srt' },
      { name: 'Show.S01/other.srt' },
    ];
    expect(subtitlesInList('Show.S01/Show.S01E01.mkv', files, 2)).toEqual(['Show.S01/Show.S01E01.en.srt', 'Show.S01/Subs/Show.S01E01/3_French.srt']);
    expect(subtitlesInList('Show.S01/Show.S01E02.mkv', files, 2)).toEqual(['Show.S01/Subs/Show.S01E02/2_English.srt']);
    // With one video, every subtitle beside it is its own.
    expect(subtitlesInList('M/M.mkv', [{ name: 'M/M.mkv' }, { name: 'M/English.srt' }, { name: 'M/Subs/2_Spanish.srt' }], 1)).toEqual(['M/English.srt', 'M/Subs/2_Spanish.srt']);
  });

  it('links them into the library with the download, and sets them aside with the video on an upgrade', async () => {
    const w = await world();
    const movie = w.db.insert(schema.movies).values({ tmdbId: 693134, title: 'Dune: Part Two', sortTitle: 'dune part two', year: 2024, profile: 'cinema', addedAt: 0, refreshedAt: 0 }).returning().get();
    const name = 'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX';
    w.write(`torrents/${name}/${name}.mkv`, 5000);
    const srt = w.write(`torrents/${name}/Subs/English.srt`, 10);
    w.write(`torrents/${name}/${name}.en.forced.srt`, 10);
    const row = w.db.insert(schema.downloads).values({ kind: 'movie', movieId: movie.id, title: name, infoHash: 'h1', addedAt: 0, state: 'done', savePath: path.join(w.root, 'torrents') }).returning().get();
    const files = [`${name}/${name}.mkv`, `${name}/Subs/English.srt`, `${name}/${name}.en.forced.srt`].map((n) => ({ name: n, size: 10 }));
    files[0]!.size = 5000;
    const r = await importDownload(w.db, row, files, 1);
    const folder = 'media/movies/Dune - Part Two (2024) {tmdb-693134}';
    expect(w.ls(folder)).toEqual(['Dune - Part Two (2024) [WEBDL-2160p][DV HDR].en.forced.srt', 'Dune - Part Two (2024) [WEBDL-2160p][DV HDR].en.srt', 'Dune - Part Two (2024) [WEBDL-2160p][DV HDR].mkv']);
    expect(r.extras).toHaveLength(2);
    expect(fs.statSync(path.join(w.root, folder, 'Dune - Part Two (2024) [WEBDL-2160p][DV HDR].en.srt')).ino).toBe(fs.statSync(srt).ino);

    // An upgrade: the old video's subtitles go into .marquee-replaced with it.
    const better = 'Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.DV.HDR.HEVC.TrueHD.7.1.Atmos-FGT';
    w.write(`torrents/${better}.mkv`, 9000);
    const row2 = w.db.insert(schema.downloads).values({ kind: 'movie', movieId: movie.id, title: better, infoHash: 'h2', addedAt: 0, state: 'done', savePath: path.join(w.root, 'torrents') }).returning().get();
    await importDownload(w.db, row2, [{ name: `${better}.mkv`, size: 9000 }], 2);
    expect(w.ls(folder)).toEqual(['Dune - Part Two (2024) [Remux-2160p][DV HDR].mkv']);
    expect(w.ls('media/movies/.marquee-replaced')).toHaveLength(3);
  });
});

// ---------------------------------------------------------------- removing a title (L1)

async function withMatrix() {
  const w = await world();
  w.write('media/movies/The Matrix (1999)/The Matrix (1999) Bluray-1080p.mkv', 4000);
  w.write('media/movies/The Matrix (1999)/The Matrix (1999) Bluray-1080p.en.srt', 20);
  w.write('media/movies/The Matrix (1999)/poster.jpg', 30);
  w.write('media/movies/Up (2009)/Up (2009) WEBDL-720p.mkv', 2000);
  await w.scan();
  return w;
}

describe('removing a title', () => {
  it('shows what would happen first, then forgets it without touching disk', async () => {
    const w = await withMatrix();
    const id = w.movieId(603)!;
    const pre = (await w.api('GET', `/api/movies/${id}/removal`)).body as RemovalPreview;
    expect(pre.title).toBe('The Matrix (1999)');
    expect(pre.files.map((f) => path.basename(f.path))).toEqual(['The Matrix (1999) Bluray-1080p.en.srt', 'The Matrix (1999) Bluray-1080p.mkv']);
    expect(pre.totalBytes).toBe(4020);
    const res = await w.api('POST', `/api/movies/${id}/remove`, { leaveOut: false, onTheWay: 'remove' });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/Removed from Marquee\. Its files were left on disk\./);
    expect((await w.api('GET', `/api/movies/${id}`)).status).toBe(404);
    expect(w.ls('media/movies/The Matrix (1999)')).toHaveLength(3);
    const h = await w.api('GET', '/api/history?event=title_removed');
    expect(h.body.items[0]).toMatchObject({ label: 'Removed from Marquee', titleName: 'The Matrix (1999)', titleLink: null });
    // Not left out: the next scan finds it again.
    await w.scan();
    expect(w.movieId(603)).toBeDefined();
  });

  it('deletes exactly the files the confirm showed, and the folder only when it’s empty', async () => {
    const w = await withMatrix();
    const id = w.movieId(603)!;
    const pre = (await w.api('GET', `/api/movies/${id}/removal`)).body as RemovalPreview;
    // A list that isn't what's on disk now is turned down, and nothing happens.
    const stale = await w.api('POST', `/api/movies/${id}/remove`, { deleteFiles: [pre.files[0]!.path], leaveOut: false });
    expect(stale.status).toBe(409);
    expect(stale.body.message).toMatch(/files changed/);
    expect(w.movieId(603)).toBe(id);
    const res = await w.api('POST', `/api/movies/${id}/remove`, { deleteFiles: pre.files.map((f) => f.path), leaveOut: false });
    expect(res.body.deleted).toHaveLength(2);
    expect(res.body.message).toMatch(/deleted 2 files/);
    expect(res.body.message).toMatch(/stays because other files are in it/);
    // poster.jpg wasn't on the list, so it (and its folder) stay.
    expect(w.ls('media/movies/The Matrix (1999)')).toEqual(['poster.jpg']);
    expect(w.plex.scans.map((s) => s.folder)).toContain(`${w.root}/media/movies/The Matrix (1999)`);
    // Up's folder goes with its only file.
    const up = w.movieId(14160)!;
    const upFiles = ((await w.api('GET', `/api/movies/${up}/removal`)).body as RemovalPreview).files.map((f) => f.path);
    await w.api('POST', `/api/movies/${up}/remove`, { deleteFiles: upFiles, leaveOut: false });
    expect(fs.existsSync(path.join(w.root, 'media/movies/Up (2009)'))).toBe(false);
  });

  it('can leave it out of scans, with a list to let it back in', async () => {
    const w = await withMatrix();
    const id = w.movieId(603)!;
    await w.api('POST', `/api/movies/${id}/remove`, { leaveOut: true });
    await w.scan();
    expect(w.movieId(603)).toBeUndefined();
    expect((await w.api('GET', '/api/library/unmatched')).body.items).toEqual([]);
    const list = (await w.api('GET', '/api/library/left-out')).body.items;
    expect(list).toMatchObject([{ kind: 'movie', tmdbId: 603, title: 'The Matrix', path: `${w.root}/media/movies/The Matrix (1999)`, who: 'Josh' }]);
    // A renamed folder is still skipped: the match is by TMDB id too.
    fs.renameSync(path.join(w.root, 'media/movies/The Matrix (1999)'), path.join(w.root, 'media/movies/The Matrix 1999'));
    await w.scan();
    expect(w.movieId(603)).toBeUndefined();
    expect((await w.api('DELETE', `/api/library/left-out/${list[0].id}`)).body.message).toMatch(/next library scan adds it again/);
    await w.scan();
    expect(w.movieId(603)).toBeDefined();
  });

  it('adding a left-out title by hand takes it off the list', async () => {
    const w = await withMatrix();
    await w.api('POST', `/api/movies/${w.movieId(603)}/remove`, { leaveOut: true });
    await w.api('POST', '/api/library/add', { kind: 'movie', tmdbId: 603 });
    expect((await w.api('GET', '/api/library/left-out')).body.items).toEqual([]);
  });

  it('stops downloads on the way, plainly, and takes requests for it away', async () => {
    const w = await withMatrix();
    const id = w.movieId(603)!;
    await w.api('PUT', '/api/settings/downloader', { url: w.qbit.url, username: 'admin', password: 'adminadmin' });
    w.qbit.list.push(qbitTorrent('aa'), qbitTorrent('bb'));
    w.db.insert(schema.downloads).values([
      { kind: 'movie', movieId: id, title: 'The.Matrix.1999.2160p-A', infoHash: 'aa', addedAt: 0, state: 'downloading' },
      { kind: 'movie', movieId: id, title: 'The.Matrix.1999.1080p-B', infoHash: 'bb', addedAt: 0, state: 'done', importedAt: 5, importedPaths: '[]' },
    ]).run();
    w.db.insert(schema.requests).values({ kind: 'movie', tmdbId: 603, title: 'The Matrix', status: 'approved', titleId: id, createdAt: 0 }).run();
    const pre = (await w.api('GET', `/api/movies/${id}/removal`)).body as RemovalPreview;
    expect(pre.onTheWay).toMatchObject([{ copy: 'The.Matrix.1999.2160p-A' }]);
    expect(pre.sharing).toBe(1);
    expect(pre.requests).toEqual(['Someone no longer here']);
    await w.api('POST', `/api/movies/${id}/remove`, { leaveOut: false, onTheWay: 'remove' });
    expect(w.qbit.actions).toEqual(['remove aa with files']);
    expect(w.db.select().from(schema.requests).all()).toEqual([]);
    // The one already in the library keeps sharing.
    expect(w.db.select().from(schema.downloads).where(eq(schema.downloads.infoHash, 'bb')).get()!.state).toBe('done');
  });

  it('or only stops following them, leaving them in qBittorrent', async () => {
    const w = await withMatrix();
    const id = w.movieId(603)!;
    w.db.insert(schema.downloads).values({ kind: 'movie', movieId: id, title: 'The.Matrix.1999.2160p-A', infoHash: 'aa', addedAt: 0, state: 'downloading' }).run();
    await w.api('POST', `/api/movies/${id}/remove`, { leaveOut: false, onTheWay: 'leave' });
    const d = w.db.select().from(schema.downloads).get()!;
    expect(d).toMatchObject({ state: 'removed', movieId: null });
    expect(d.message).toMatch(/stopped following it when The Matrix \(1999\) was removed\. It’s still in qBittorrent/);
  });

  it('is for admins only', async () => {
    const w = await withMatrix();
    await call(w.app, 'POST', '/api/users', { username: 'ana', password: 'longenough1', displayName: 'Ana', role: 'member' }, w.admin);
    const ana = (await call(w.app, 'POST', '/api/auth/login', { username: 'ana', password: 'longenough1' })).cookie;
    expect((await call(w.app, 'POST', `/api/movies/${w.movieId(603)}/remove`, { leaveOut: false }, ana)).status).toBe(403);
    expect((await call(w.app, 'GET', `/api/movies/${w.movieId(603)}/removal`, undefined, ana)).status).toBe(403);
  });
});

// ---------------------------------------------------------------- renaming (L2)

describe('renaming files to Marquee’s names', () => {
  it('previews every change, moves the folder with everything in it, and can be undone', async () => {
    const w = await withMatrix();
    const id = w.movieId(603)!;
    const before = w.ls('media/movies');
    const plan = (await w.api('GET', `/api/library/rename?kind=movie&id=${id}`)).body as RenamePlanView;
    // The preview touches nothing.
    expect(w.ls('media/movies')).toEqual(before);
    const t = plan.titles[0]!;
    const newFolder = `${w.root}/media/movies/The Matrix (1999) {tmdb-603}`;
    expect(t).toMatchObject({ title: 'The Matrix (1999)', folderFrom: `${w.root}/media/movies/The Matrix (1999)`, folderTo: newFolder, skipped: [] });
    expect(t.moves.map((m) => [m.what, path.relative(newFolder, m.to)])).toEqual([
      ['video', 'The Matrix (1999) [Bluray-1080p].mkv'],
      ['subtitle', 'The Matrix (1999) [Bluray-1080p].en.srt'],
      ['other', 'poster.jpg'],
    ]);

    // A download that became this file still knows where it is afterwards (for "remove once shared enough").
    const oldVideo = t.moves[0]!.from;
    w.db.insert(schema.downloads).values({ kind: 'movie', movieId: id, title: 'x', infoHash: 'zz', addedAt: 0, state: 'done', importedAt: 1, importedPaths: JSON.stringify([oldVideo]) }).run();

    const res = await w.api('POST', '/api/library/rename', { kind: 'movie', id, moves: t.moves.map(({ from, to }) => ({ from, to })) });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ moved: 3, problems: [] });
    expect(res.body.message).toMatch(/Renamed 3 files in The Matrix \(1999\)\. Told Plex\./);
    expect(w.ls('media/movies/The Matrix (1999) {tmdb-603}')).toEqual(['The Matrix (1999) [Bluray-1080p].en.srt', 'The Matrix (1999) [Bluray-1080p].mkv', 'poster.jpg']);
    expect(fs.existsSync(`${w.root}/media/movies/The Matrix (1999)`)).toBe(false);
    expect(w.db.select().from(schema.movies).where(eq(schema.movies.id, id)).get()!.path).toBe(newFolder);
    expect(w.db.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.movieId, id)).get()!.path).toBe(`${newFolder}/The Matrix (1999) [Bluray-1080p].mkv`);
    expect(JSON.parse(w.db.select().from(schema.downloads).get()!.importedPaths!)).toEqual([`${newFolder}/The Matrix (1999) [Bluray-1080p].mkv`]);
    expect((await w.api('GET', `/api/history?movieId=${id}`)).body.items[0]).toMatchObject({ label: 'Renamed', detail: expect.stringMatching(/Renamed 1 video .* and moved 2 other files along\. Folder: The Matrix \(1999\) → The Matrix \(1999\) \{tmdb-603\}\./) });
    // Renaming again finds nothing to do.
    const again = (await w.api('GET', `/api/library/rename?kind=movie&id=${id}`)).body as RenamePlanView;
    expect(again).toMatchObject({ titles: [], alreadyRight: 1 });
    // A rescan keeps the same title (matched by its folder).
    await w.scan();
    expect(w.movieId(603)).toBe(id);

    // Undo puts every file back.
    const runs = (await w.api('GET', '/api/library/renames')).body.items;
    expect(runs).toMatchObject([{ label: 'The Matrix (1999)', files: 3, who: 'Josh', undoneAt: null }]);
    const undo = await w.api('POST', `/api/library/renames/${runs[0].id}/undo`, {});
    expect(undo.body).toMatchObject({ moved: 3, problems: [] });
    expect(w.ls('media/movies')).toEqual(before);
    expect(w.db.select().from(schema.movies).where(eq(schema.movies.id, id)).get()!.path).toBe(`${w.root}/media/movies/The Matrix (1999)`);
    expect(JSON.parse(w.db.select().from(schema.downloads).get()!.importedPaths!)).toEqual([oldVideo]);
    expect((await w.api('POST', `/api/library/renames/${runs[0].id}/undo`, {})).status).toBe(409);
  });

  it('moves only what the preview showed: a changed plan or half a title is turned down', async () => {
    const w = await withMatrix();
    const plan = (await w.api('GET', '/api/library/rename?kind=movie')).body as RenamePlanView;
    expect(plan.titles.map((t) => t.title)).toEqual(['The Matrix (1999)', 'Up (2009)']);
    const matrix = plan.titles[0]!;
    const wrong = await w.api('POST', '/api/library/rename', { kind: 'movie', moves: [{ from: matrix.moves[0]!.from, to: `${w.root}/media/movies/elsewhere.mkv` }] });
    expect(wrong.status).toBe(409);
    expect(wrong.body.message).toMatch(/changed since the preview/);
    const half = await w.api('POST', '/api/library/rename', { kind: 'movie', moves: [matrix.moves[0]].map((m) => ({ from: m!.from, to: m!.to })) });
    expect(half.status).toBe(400);
    expect(half.body.message).toMatch(/all of The Matrix \(1999\)’s files or none/);
    // Picking whole titles is fine: only Up is renamed.
    const up = plan.titles[1]!;
    const res = await w.api('POST', '/api/library/rename', { kind: 'movie', moves: up.moves.map(({ from, to }) => ({ from, to })) });
    expect(res.body.moved).toBe(1);
    expect(w.ls('media/movies')).toContain('Up (2009) {tmdb-14160}/Up (2009) [WEBDL-720p].mkv');
    expect(w.ls('media/movies')).toContain('The Matrix (1999)/The Matrix (1999) Bluray-1080p.mkv');
  });

  it('leaves a title alone when a file already has the new name', async () => {
    const w = await withMatrix();
    w.write('media/movies/The Matrix (1999) {tmdb-603}/The Matrix (1999) [Bluray-1080p].mkv', 5);
    const plan = (await w.api('GET', `/api/library/rename?kind=movie&id=${w.movieId(603)}`)).body as RenamePlanView;
    expect(plan.titles[0]).toMatchObject({ moves: [], skipped: [{ reason: expect.stringMatching(/Another file already has the name The Matrix \(1999\) \[Bluray-1080p\]\.mkv/) }] });
  });

  it('renames a show’s episodes and season folders, with episode titles', async () => {
    const w = await world();
    w.write('media/tv/Severance (2022)/Season 1/Severance.S01E01.2160p.ATVP.WEB-DL.DDP5.1.DV.H.265-FLUX.mkv', 100);
    w.write('media/tv/Severance (2022)/Season 1/season01-poster.jpg', 5);
    w.write('media/tv/Severance (2022)/Season 2/Severance - S02E01.mkv', 100);
    await w.scan();
    const id = w.showId(95396)!;
    const plan = (await w.api('GET', `/api/library/rename?kind=tv&id=${id}`)).body as RenamePlanView;
    const res = await w.api('POST', '/api/library/rename', { kind: 'tv', id, moves: plan.titles[0]!.moves.map(({ from, to }) => ({ from, to })) });
    expect(res.body.problems).toEqual([]);
    expect(w.ls('media/tv')).toEqual([
      'Severance (2022) {tvdb-371980}/Season 01/Severance - S01E01 - Good News About Hell [WEBDL-2160p][DV].mkv',
      'Severance (2022) {tvdb-371980}/Season 01/season01-poster.jpg',
      'Severance (2022) {tvdb-371980}/Season 02/Severance - S02E01 - Hello, Ms. Cobel.mkv',
    ]);
  });
});

// ---------------------------------------------------------------- putting files in the library by hand (L3)

describe('putting files in your library by hand', () => {
  it('browses only the downloads and library folders', async () => {
    const w = await world();
    w.write('torrents/Some.Folder/x.mkv');
    const start = (await w.api('GET', '/api/library/import/browse')).body;
    expect(start.places.map((p: { label: string }) => p.label)).toEqual(['Downloads', 'Movies', 'TV']);
    const inside = (await w.api('GET', `/api/library/import/browse?path=${encodeURIComponent(`${w.root}/torrents`)}`)).body;
    expect(inside).toMatchObject({ path: `${w.root}/torrents`, parent: null, folders: [{ name: 'Some.Folder' }] });
    expect((await w.api('GET', `/api/library/import/browse?path=${encodeURIComponent(`${w.root}/torrents/../`)}`)).status).toBe(400);
    expect((await w.api('GET', '/api/library/import/browse?path=%2Fetc')).status).toBe(400);
  });

  it('guesses what each video is, from your library first and then TMDB', async () => {
    const w = await withMatrix();
    w.write('torrents/The.Matrix.1999.2160p.UHD.BluRay.x265-GRP/The.Matrix.1999.2160p.UHD.BluRay.x265-GRP.mkv', 5000);
    w.write('torrents/The.Matrix.1999.2160p.UHD.BluRay.x265-GRP/sample.mkv', 10);
    w.write('torrents/Blade.Runner.2049.2017.1080p.BluRay.x264-GRP/movie.mkv', 3000);
    w.write('torrents/Blade.Runner.2049.2017.1080p.BluRay.x264-GRP/English.srt', 3);
    w.write('torrents/Severance.S02E01.1080p.WEB-DL-NTb.mkv', 2000);
    const scan = (await w.api('GET', `/api/library/import/scan?path=${encodeURIComponent(`${w.root}/torrents`)}`)).body as ImportScanView;
    expect(scan.inLibraryFolder).toBe(false);
    expect(scan.files.map((f) => [f.name, f.guess?.title, f.guess?.libraryId !== null, f.guess?.season, f.guess?.episodes])).toEqual([
      ['Blade.Runner.2049.2017.1080p.BluRay.x264-GRP/movie.mkv', 'Blade Runner 2049', false, null, []],
      ['Severance.S02E01.1080p.WEB-DL-NTb.mkv', 'Severance', false, 2, [1]],
      ['The.Matrix.1999.2160p.UHD.BluRay.x265-GRP/The.Matrix.1999.2160p.UHD.BluRay.x265-GRP.mkv', 'The Matrix', true, null, []],
    ]);
    expect(scan.files[0]!.subtitles).toEqual([`${w.root}/torrents/Blade.Runner.2049.2017.1080p.BluRay.x264-GRP/English.srt`]);
    // Files already in the library say so.
    const lib = (await w.api('GET', `/api/library/import/scan?path=${encodeURIComponent(`${w.root}/media/movies`)}`)).body as ImportScanView;
    expect(lib.inLibraryFolder).toBe(true);
    expect(lib.files[0]).toMatchObject({ inLibrary: { kind: 'movie', title: 'The Matrix (1999)' }, guess: null });
  });

  it('hardlinks from downloads with the usual names, adding the title and bringing subtitles', async () => {
    const w = await world();
    const src = w.write('torrents/Blade.Runner.2049.2017.1080p.BluRay.x264-GRP/movie.mkv', 3000);
    w.write('torrents/Blade.Runner.2049.2017.1080p.BluRay.x264-GRP/English.srt', 3);
    const ep = w.write('torrents/sev/ep1.mkv', 2000);
    const res = await w.api('POST', '/api/library/import', {
      items: [
        { path: src, kind: 'movie', tmdbId: 335984 },
        { path: ep, kind: 'series', tmdbId: 95396, season: 2, episodes: [1] },
        { path: `${w.root}/torrents/nothing.mkv`, kind: 'movie', tmdbId: 603 },
        { path: ep, kind: 'series', tmdbId: 95396 },
      ],
    });
    expect(res.body.results.map((r: { ok: boolean }) => r.ok)).toEqual([true, true, false, false]);
    expect(res.body.results[2].message).toMatch(/no file at/);
    expect(res.body.results[3].message).toMatch(/Say which season and episode/);
    const movie = `${w.root}/media/movies/Blade Runner 2049 (2017) {tmdb-335984}/Blade Runner 2049 (2017) [Bluray-1080p].mkv`;
    expect(fs.statSync(movie).ino).toBe(fs.statSync(src).ino);
    expect(fs.existsSync(movie.replace('.mkv', '.en.srt'))).toBe(true);
    expect(fs.existsSync(src)).toBe(true);
    expect(w.ls('media/tv')).toEqual(['Severance (2022) {tvdb-371980}/Season 02/Severance - S02E01 - Hello, Ms. Cobel.mkv']);
    // Added, but not Wanted.
    expect(w.db.select().from(schema.movies).where(eq(schema.movies.tmdbId, 335984)).get()!.monitored).toBe(false);
    const h = (await w.api('GET', '/api/history?event=in_library')).body.items;
    expect(h.map((x: { titleName: string }) => x.titleName).sort()).toEqual(['Blade Runner 2049 (2017)', 'Severance · S02E01']);
    expect(h.find((x: { titleName: string }) => x.titleName.startsWith('Blade')).detail).toMatch(/Put in your library by hand from .*A subtitle file came along with it\./);
    expect(w.plex.scans.length).toBeGreaterThanOrEqual(2);
  });

  it('moves a file that’s already in a library folder instead of linking a second one', async () => {
    const w = await world();
    w.write('media/movies/weird-folder-name/movie.mkv', 3000);
    await w.scan();
    expect((await w.api('GET', '/api/library/unmatched')).body.items).toHaveLength(1);
    const src = `${w.root}/media/movies/weird-folder-name/movie.mkv`;
    const res = await w.api('POST', '/api/library/import', { items: [{ path: src, kind: 'movie', tmdbId: 14160 }] });
    expect(res.body.results[0]).toMatchObject({ ok: true, href: `/movies/${w.movieId(14160)}` });
    expect(w.ls('media/movies')).toEqual(['Up (2009) {tmdb-14160}/Up (2009).mkv']);
    expect((await w.api('GET', '/api/library/unmatched')).body.items).toEqual([]);
  });
});

// ---------------------------------------------------------------- refresh from TMDB (L6)

describe('refreshing a title from TMDB', () => {
  it('asks TMDB again instead of using what it kept, and keeps folder, profile and Wanted', async () => {
    const w = await withMatrix();
    const id = w.movieId(603)!;
    await w.api('PUT', `/api/movies/${id}/wanted`, { wanted: true });
    const raw = w.tmdb.movie.bind(w.tmdb);
    w.tmdb.movie = async (tmdbId) => ({ ...(await raw(tmdbId)), title: 'The Matrix (Remastered)', overview: 'New words.' });
    const res = await w.api('POST', `/api/movies/${id}/refresh`, {});
    expect(res.body.message).toMatch(/Up to date with TMDB/);
    const m = (await w.api('GET', `/api/movies/${id}`)).body;
    expect(m).toMatchObject({ title: 'The Matrix (Remastered)', overview: 'New words.', monitored: true, path: `${w.root}/media/movies/The Matrix (1999)` });
    expect((await w.api('POST', '/api/movies/99999/refresh', {})).status).toBe(404);
    const show = await w.api('POST', `/api/shows/1/refresh`, {});
    expect(show.status).toBe(404);
  });
});

// ---------------------------------------------------------------- library filters (L9)

describe('Wanted, nothing yet and Not good enough yet', () => {
  it('filters the library, and Look for these searches for them now', async () => {
    const w = await withMatrix();
    const matrix = w.movieId(603)!;
    const up = w.movieId(14160)!;
    await w.api('POST', '/api/library/add', { kind: 'movie', tmdbId: 335984, wanted: true });
    const br = w.movieId(335984)!;
    const ids = async (filter: string) => (await w.api('GET', `/api/movies?filter=${filter}`)).body.items.map((i: { id: number }) => i.id).sort();
    expect(await ids('wanted_missing')).toEqual([br]);
    // Both files are below 4K Quality's "good enough".
    expect(await ids('not_good_enough')).toEqual([matrix, up].sort());

    // Without qBittorrent there's nothing to send with, and it says so.
    expect((await w.api('POST', '/api/movies/look-now', { ids: [up] })).body.message).toMatch(/Connect qBittorrent first/);
    await w.api('PUT', '/api/settings/downloader', { url: w.qbit.url, username: 'admin', password: 'adminadmin' });
    expect((await w.api('POST', '/api/movies/look-now', { ids: [up] })).body.message).toMatch(/no Sources/);
    await w.api('POST', '/api/settings/sources', { name: 'TPB', url: 'http://tpb.test/api', apiKey: 'good' });
    // Up has Kids & Cartoons (720p), so a 4K copy isn't for it; The Matrix's 1080p file gets a better copy.
    const res = await w.api('POST', '/api/movies/look-now', { ids: [up, matrix] });
    expect(res.status).toBe(202);
    expect(res.body.message).toMatch(/Looking for 2 movies now/);
    await lookNowDone();
    expect(w.qbit.added).toHaveLength(1);
    expect(w.db.select().from(schema.downloads).get()).toMatchObject({ movieId: matrix, title: 'The.Matrix.1999.2160p.UHD.BluRay.x265.HDR.DDP5.1-GRP' });
    expect(w.db.select().from(schema.movies).where(eq(schema.movies.id, up)).get()!.monitored).toBe(true);
  });

  it('finds shows with Wanted episodes missing', async () => {
    const w = await world();
    w.write('media/tv/Severance (2022)/Season 01/Severance - S01E01 [WEBDL-2160p].mkv');
    await w.scan();
    const id = w.showId(95396)!;
    expect((await w.api('GET', '/api/shows?filter=wanted_missing')).body.items).toEqual([]);
    await w.api('PUT', `/api/shows/${id}/wanted`, { wanted: true });
    expect((await w.api('GET', '/api/shows?filter=wanted_missing')).body.items.map((i: { id: number }) => i.id)).toEqual([id]);
    // A 4K WEB file with no rule points yet hasn't reached 4K Quality's "good enough" points.
    expect((await w.api('GET', '/api/shows?filter=not_good_enough')).body.items.map((i: { id: number }) => i.id)).toEqual([id]);
  });
});

// ---------------------------------------------------------------- the replaced folder (L18)

describe('the replaced folder', () => {
  it('shows its size and what emptying it frees, and empties only when confirmed', async () => {
    const w = await world();
    w.write('media/movies/.marquee-replaced/Old (2000)/Old (2000) [WEBDL-720p].mkv', 1000);
    const shared = w.write('media/tv/.marquee-replaced/Show/Season 01/ep.mkv', 500);
    // Still shared by a download: deleting it frees nothing.
    fs.mkdirSync(`${w.root}/torrents`, { recursive: true });
    fs.linkSync(shared, `${w.root}/torrents/ep.mkv`);
    const v = (await w.api('GET', '/api/system/replaced')).body as ReplacedView;
    expect(v).toMatchObject({ files: 2, bytes: 1500, freedBytes: 1000 });
    expect(v.folders.map((f) => [f.label, f.files])).toEqual([['Movies', 1], ['TV', 1], ['Downloads', 0]]);
    expect((await w.api('POST', '/api/system/replaced/empty', {})).status).toBe(400);
    const res = await w.api('POST', '/api/system/replaced/empty', { confirm: true });
    expect(res.body).toMatchObject({ files: 2, bytes: 1500, problems: [], message: 'Deleted 2 files (0 MB).' });
    expect(res.body.view.files).toBe(0);
    expect(fs.existsSync(`${w.root}/media/movies/.marquee-replaced`)).toBe(false);
    expect(fs.existsSync(`${w.root}/torrents/ep.mkv`)).toBe(true);
  });
});

// ---------------------------------------------------------------- the migration

describe('migration 26', () => {
  it('keeps the History and accepts the new kinds', () => {
    const db = openDb(':memory:');
    db.insert(schema.history).values({ at: 1, event: 'title_removed', kind: 'movie', title: 'X' }).run();
    db.insert(schema.history).values({ at: 2, event: 'renamed', kind: 'tv', title: 'Y' }).run();
    expect(db.select().from(schema.history).all()).toHaveLength(2);
  });
});
