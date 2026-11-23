import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { BrowseView, ImportFile, ImportGuess, ImportItemInput, ImportItemResult, ImportScanView } from '@marquee/shared';
import type { Db } from '../db/index.js';
import { history, mediaFiles, movies, scanItems, series, type Download } from '../db/schema.js';
import { HttpError, type Deps } from '../http.js';
import { ImportError, importDownload, videoFiles, REPLACED_FOLDER } from '../downloads/importer.js';
import { titleName } from '../downloads/history.js';
import { parseRelease } from '../releases/parse.js';
import { downloadsFolder } from '../system/disk.js';
import { subtitlesInList } from './extras.js';
import { tellMediaServers } from './mediaServers.js';
import { normalizeTitle, parseTitleName } from './parse.js';
import { pickMatch } from './scanner.js';
import { pruneEmpty } from './remove.js';
import { libraryRoots } from './services.js';
import type { TmdbApi } from './tmdb.js';

/**
 * "Put files in your library" (older apps call it manual import): pick a
 * folder under the downloads folder or a library folder, see the videos in
 * it with Marquee's guess at what each one is, change what's wrong, and put
 * them in the library with the usual rules: hardlinked from downloads (so
 * sharing carries on), clean names, subtitles brought along, an older file
 * set aside in .marquee-replaced. A file already under a library folder is
 * moved instead (same disk), so the library doesn't get two of it.
 */

function places(db: Db): BrowseView['places'] {
  const roots = libraryRoots(db);
  return [
    { label: 'Downloads', path: downloadsFolder(db) },
    { label: 'Movies', path: roots.movies },
    { label: 'TV', path: roots.tv },
  ];
}

/** The place a path is under, or null. `..` can't climb out. */
function placeOf(db: Db, p: string): BrowseView['places'][number] | null {
  const abs = path.resolve(p);
  return places(db).find((pl) => abs === pl.path || abs.startsWith(`${pl.path.replace(/\/+$/, '')}/`)) ?? null;
}

function mustBeInside(db: Db, p: string): string {
  if (!p.startsWith('/') || !placeOf(db, p)) throw new HttpError(400, 'outside', 'Pick a folder inside the downloads folder or one of the library folders.');
  return path.resolve(p);
}

export async function browse(db: Db, at: string | null): Promise<BrowseView> {
  const all = places(db);
  if (!at) return { path: null, parent: null, folders: [], places: all };
  const dir = mustBeInside(db, at);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    throw new HttpError(400, 'cant_open', err.code === 'ENOENT' ? `There’s no folder at ${dir}.` : `Marquee can’t open ${dir} (${err.code}). Check it’s mapped into the container.`);
  });
  const folders = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('@'))
    .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const place = placeOf(db, dir)!;
  return { path: dir, parent: dir === path.resolve(place.path) ? null : path.dirname(dir), folders, places: all };
}

/** Every file under a folder (a few levels down), relative to it, skipping hidden folders and the replaced folder. */
async function listFiles(dir: string, depth = 4, rel = ''): Promise<{ name: string; size: number }[]> {
  const out: { name: string; size: number }[] = [];
  for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith('.') || e.name === REPLACED_FOLDER) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory() && depth > 0) out.push(...(await listFiles(dir, depth - 1, r)));
    else if (e.isFile()) {
      const st = await fs.stat(path.join(dir, r)).catch(() => null);
      if (st) out.push({ name: r, size: st.size });
    }
  }
  return out;
}

/** What a file looks like it is, from its name and its folders' names (ID tags win). */
function readName(file: string, top: string): { title: string; year: number | null; season: number | null; episodes: number[]; tmdbId: number | null; tvdbId: number | null } {
  const p = parseRelease(path.basename(file, path.extname(file)));
  const dirs: string[] = [];
  for (let d = path.dirname(file); d.length >= top.length && d !== path.dirname(d); d = path.dirname(d)) dirs.push(path.basename(d));
  const tagged = dirs.map(parseTitleName).find((n) => n.tmdbId || n.tvdbId);
  let title = p.title;
  let year = p.year;
  // "movie.mkv" or "01.mkv": the folder's name says more.
  if (!title || title.length < 2 || /^(movie|video|episode|e?\d+)$/i.test(title)) {
    const fromDir = dirs.map((d) => parseRelease(d)).find((x) => x.title && !/^(season|series|s)\s*\d+$/i.test(x.title));
    if (fromDir) {
      title = fromDir.title;
      year = year ?? fromDir.year;
    }
  }
  // A season folder ("Season 2") under the show's folder: the show's name is one up.
  if (p.episodes.length && /^season\s*\d+$/i.test(dirs[0] ?? '') && (!title || title.length < 2)) title = parseRelease(dirs[1] ?? '').title;
  return { title: tagged?.title || title, year: tagged?.year ?? year, season: p.season, episodes: p.episodes, tmdbId: tagged?.tmdbId ?? null, tvdbId: tagged?.tvdbId ?? null };
}

/** Marquee's guess for each video: your library first, then TMDB (one search per name). */
async function guessFor(db: Db, tmdb: TmdbApi | null, n: ReturnType<typeof readName>, cache: Map<string, ImportGuess | null>): Promise<ImportGuess | null> {
  const kind: 'movie' | 'series' = n.episodes.length || n.season !== null || n.tvdbId ? 'series' : 'movie';
  const key = `${kind}:${n.tmdbId ?? ''}:${n.tvdbId ?? ''}:${normalizeTitle(n.title)}:${kind === 'movie' ? (n.year ?? '') : ''}`;
  const base = { season: kind === 'series' ? (n.season ?? 1) : null, episodes: kind === 'series' ? n.episodes : [] };
  if (cache.has(key)) {
    const hit = cache.get(key);
    return hit ? { ...hit, ...base } : null;
  }
  let g: ImportGuess | null = null;
  const want = normalizeTitle(n.title);
  if (kind === 'movie') {
    const m = n.tmdbId
      ? db.select().from(movies).where(eq(movies.tmdbId, n.tmdbId)).get()
      : db.select().from(movies).all().find((x) => normalizeTitle(x.title) === want && (n.year === null || x.year === null || Math.abs(x.year - n.year) <= 1));
    if (m) g = { kind, tmdbId: m.tmdbId, title: m.title, year: m.year, libraryId: m.id, ...base };
  } else {
    const s = n.tmdbId
      ? db.select().from(series).where(eq(series.tmdbId, n.tmdbId)).get()
      : n.tvdbId
        ? db.select().from(series).where(eq(series.tvdbId, n.tvdbId)).get()
        : db.select().from(series).all().find((x) => normalizeTitle(x.title) === want);
    if (s) g = { kind, tmdbId: s.tmdbId, title: s.title, year: s.year, libraryId: s.id, ...base };
  }
  if (!g && tmdb && n.title) {
    try {
      if (kind === 'movie') {
        const results = n.tmdbId ? [] : await tmdb.searchMovie(n.title, n.year);
        const hit = n.tmdbId ? await tmdb.movie(n.tmdbId).then((d) => ({ tmdbId: n.tmdbId!, title: d.title, year: d.year })) : (pickMatch(results, n.title, n.year) ?? results[0]);
        if (hit) g = { kind, tmdbId: hit.tmdbId, title: hit.title, year: hit.year, libraryId: null, ...base };
      } else {
        const found = n.tvdbId ? await tmdb.findShow({ tvdbId: n.tvdbId, imdbId: null }) : null;
        const results = found ? [] : await tmdb.searchShow(n.title);
        const hit = found ? await tmdb.show(found).then((d) => ({ tmdbId: found, title: d.title, year: d.year })) : (pickMatch(results, n.title, null) ?? results[0]);
        if (hit) g = { kind, tmdbId: hit.tmdbId, title: hit.title, year: hit.year, libraryId: null, ...base };
      }
    } catch (err) {
      console.warn(`[import] couldn't ask TMDB about “${n.title}”: ${(err as Error).message}`);
    }
  }
  cache.set(key, g);
  return g;
}

export async function scanForImport(db: Db, tmdb: TmdbApi | null, folder: string): Promise<ImportScanView> {
  const dir = mustBeInside(db, folder);
  const all = await listFiles(dir);
  const videos = videoFiles(all);
  const roots = libraryRoots(db);
  const inLibraryFolder = [roots.movies, roots.tv].some((r) => dir === r || dir.startsWith(`${r}/`));
  const perDir = new Map<string, number>();
  for (const v of videos) perDir.set(path.posix.dirname(v.name), (perDir.get(path.posix.dirname(v.name)) ?? 0) + 1);
  const cache = new Map<string, ImportGuess | null>();
  const files: ImportFile[] = [];
  for (const v of videos.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
    const abs = path.join(dir, v.name);
    const known = db.select().from(mediaFiles).where(eq(mediaFiles.path, abs)).get();
    let inLibrary: ImportFile['inLibrary'] = null;
    if (known?.movieId) {
      const m = db.select({ title: movies.title, year: movies.year }).from(movies).where(eq(movies.id, known.movieId)).get();
      if (m) inLibrary = { kind: 'movie', id: known.movieId, title: m.year ? `${m.title} (${m.year})` : m.title };
    } else if (known?.seriesId) {
      inLibrary = { kind: 'series', id: known.seriesId, title: titleName(db, { kind: 'tv', movieId: null, seriesId: known.seriesId, season: known.season, episodes: known.episodes }, '') };
    }
    files.push({
      path: abs,
      name: v.name,
      sizeBytes: v.size,
      subtitles: subtitlesInList(v.name, all, perDir.get(path.posix.dirname(v.name)) ?? 1).map((s) => path.join(dir, s)),
      inLibrary,
      guess: inLibrary ? null : await guessFor(db, tmdb, readName(abs, dir), cache),
    });
  }
  return { folder: dir, files, inLibraryFolder };
}

/**
 * Puts each file in the library as the title (and episodes) you said. A title
 * not in your library yet is added (not Wanted). Each file is done on its
 * own, so one problem doesn't stop the rest.
 */
export async function importFiles(deps: Deps & { tmdb: () => TmdbApi }, items: ImportItemInput[], userId: number): Promise<ImportItemResult[]> {
  const { db, scanner, now } = deps;
  const roots = libraryRoots(db);
  const out: ImportItemResult[] = [];
  for (const item of items) {
    const name = path.basename(item.path);
    try {
      const src = mustBeInside(db, item.path);
      const st = await fs.stat(src).catch(() => null);
      if (!st?.isFile()) throw new ImportError(`There’s no file at ${src} any more.`);
      if (item.kind === 'series' && (item.season === undefined || !item.episodes?.length)) throw new ImportError('Say which season and episode this is.');

      const title =
        item.kind === 'movie'
          ? (db.select().from(movies).where(eq(movies.tmdbId, item.tmdbId)).get() ?? (await scanner.upsertMovie(deps.tmdb(), item.tmdbId, null, now())))
          : (db.select().from(series).where(eq(series.tmdbId, item.tmdbId)).get() ?? (await scanner.upsertSeries(deps.tmdb(), item.tmdbId, null, now())));
      const move = [roots.movies, roots.tv].some((r) => src.startsWith(`${r}/`));
      const dir = path.dirname(src);
      const siblings = await listFiles(dir, 2);
      const videoCount = videoFiles(siblings).length;
      const subs = subtitlesInList(name, siblings, videoCount);
      const d = {
        id: 0, kind: item.kind === 'movie' ? 'movie' : 'tv', movieId: item.kind === 'movie' ? title.id : null, seriesId: item.kind === 'series' ? title.id : null,
        season: item.kind === 'series' ? item.season! : null, episodes: item.kind === 'series' ? JSON.stringify(item.episodes) : null,
        // The copy's name, for its quality: the file's, or its folder's when the file's says nothing ("movie.mkv").
        title: parseRelease(path.basename(name, path.extname(name))).resolution ? name : path.basename(dir), savePath: dir, adopted: false,
      } as unknown as Download;
      const files = [{ name, size: st.size }, ...subs.map((s) => ({ name: s, size: 0 }))];
      const r = await importDownload(db, d, files, now(), undefined, deps.clients.disk, {
        folder: dir,
        ...(item.kind === 'series' ? { episodes: { season: item.season!, episodes: item.episodes! } } : {}),
        ...(move ? { move: true } : {}),
      });
      // A file moved out of another place in the library: forget it there, and tidy the folder it left.
      if (move) {
        if (!r.paths.includes(src)) db.delete(mediaFiles).where(eq(mediaFiles.path, src)).run();
        const from = src.startsWith(`${roots.movies}/`) ? roots.movies : roots.tv;
        await pruneEmpty(dir, from);
        if (!(await fs.stat(dir).catch(() => null))) db.delete(scanItems).where(eq(scanItems.path, dir)).run();
      }
      const label = titleName(db, { kind: d.kind, movieId: d.movieId, seriesId: d.seriesId, season: d.season, episodes: d.episodes }, name);
      const detail = [
        `Put in your library by hand from ${dir}${move ? ' (moved: it was already in a library folder)' : ''}.`,
        r.copied ? 'Copied, not linked: the folder and the library are on different disks.' : null,
        r.replaced.length ? `The file it replaced (${r.replaced.map((p) => path.basename(p)).join(', ')}) is kept in the library’s .marquee-replaced folder.` : null,
        r.extras.length ? `${r.extras.length === 1 ? 'A subtitle file came' : `${r.extras.length} subtitle files came`} along with it.` : null,
      ].filter(Boolean).join(' ');
      db.insert(history)
        .values({ at: now(), event: r.replaced.length ? 'upgraded' : 'in_library', kind: d.kind, movieId: d.movieId, seriesId: d.seriesId, season: d.season, episodes: d.episodes, copy: name, title: label, size: st.size, detail, userId })
        .run();
      const told = await tellMediaServers(db, deps.clients, d.kind, r.paths.map((p) => path.dirname(p)));
      out.push({
        path: item.path,
        ok: true,
        message: `In your library as ${r.paths.map((p) => path.basename(p)).join(', ')}.${told.told.length ? ` Told ${told.told.join(' and ')}.` : ''}${told.failed.length ? ` ${told.failed.join(' ')}` : ''}`,
        href: item.kind === 'movie' ? `/movies/${title.id}` : `/shows/${title.id}`,
      });
    } catch (err) {
      if (!(err instanceof ImportError) && !(err instanceof HttpError)) throw err;
      out.push({ path: item.path, ok: false, message: err.message.replace(/ ?Press Try another copy\.| ?Marquee tries again (by itself|shortly)\./g, ''), href: null });
    }
  }
  return out;
}

