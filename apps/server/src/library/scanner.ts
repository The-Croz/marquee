import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray, like, lt } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { episodes, mediaFiles, movies, scanItems, series, type Movie, type Series } from '../db/schema.js';
import { TmdbError, type TmdbApi, type TmdbSearchResult } from './tmdb.js';
import type { ArrApi, ArrTitle } from './arr.js';
import { chooseProfile, factsFrom } from '../releases/choose.js';
import { EXTRAS_FOLDERS, VIDEO_EXTENSIONS, normalizeTitle, parseEpisode, parseQuality, parseTitleName, sortTitle } from './parse.js';

/**
 * Reads your movie and TV folders and matches each title to TMDB.
 *
 * READ-ONLY: this never creates, moves, renames or deletes anything on disk.
 * It only records what it finds in Marquee's database.
 *
 * Matching order for each folder:
 *   1. Already matched on an earlier scan (same folder)
 *   2. An ID in the folder name: {tmdb-123}, {tvdb-123}, {imdb-tt123}
 *   3. Radarr/Sonarr's record for that folder (if connected)
 *   4. A TMDB search by title and year, accepted only on an exact title match
 * Anything else goes to "Needs a match" with the closest TMDB suggestions.
 */

export interface ScanSources {
  tmdb: TmdbApi;
  radarr: ArrApi | null;
  sonarr: ArrApi | null;
  moviesRoot: string;
  tvRoot: string;
}

export interface ScanStatus {
  running: boolean;
  phase: 'idle' | 'preparing' | 'movies' | 'shows' | 'cleanup' | 'done' | 'failed';
  startedAt: number | null;
  finishedAt: number | null;
  processed: number;
  total: number;
  matched: number;
  unmatched: number;
  warnings: string[];
  error: string | null;
}

const CONCURRENCY = 4;
const SERIES_REFRESH_MS = 12 * 60 * 60 * 1000;

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

interface FoundFile {
  path: string;
  name: string;
  size: number;
  mtime: number;
}

async function listDir(dir: string) {
  return fs.readdir(dir, { withFileTypes: true });
}

/** Video files under `dir`, skipping extras folders and sample clips. */
async function videoFiles(dir: string, depth: number): Promise<FoundFile[]> {
  const out: FoundFile[] = [];
  for (const entry of await listDir(dir).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0 && !EXTRAS_FOLDERS.has(entry.name.toLowerCase()) && !entry.name.startsWith('.')) out.push(...(await videoFiles(full, depth - 1)));
    } else if (entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      const stat = await fs.stat(full).catch(() => null);
      if (!stat) continue;
      const isSample = /(^|[ ._-])sample([ ._-]|$)/i.test(entry.name) && stat.size < 400 * 1024 * 1024;
      if (!isSample) out.push({ path: full, name: entry.name, size: stat.size, mtime: Math.floor(stat.mtimeMs) });
    }
  }
  return out;
}

/** Picks the TMDB result that is clearly the same title, or nothing. */
export function pickMatch(results: TmdbSearchResult[], title: string, year: number | null): TmdbSearchResult | null {
  const want = normalizeTitle(title);
  const same = results.filter((r) => normalizeTitle(r.title) === want);
  const close = year === null ? same : same.filter((r) => r.year !== null && Math.abs(r.year - year) <= 1);
  if (close.length === 0) return null;
  // Prefer the exact year, then the more popular title (e.g. the film over a short with the same name).
  return close.sort((a, b) => Number(b.year === year) - Number(a.year === year) || b.popularity - a.popularity)[0]!;
}

const folderKey = (p: string) => path.basename(p.replace(/\/+$/, '')).toLowerCase();

interface Attempt {
  /** Where the id came from, in plain English, e.g. "Sonarr's TMDB ID" */
  source: string;
  id: () => Promise<number | null>;
}

/**
 * Tries each way of identifying a title, in order. A TMDB id that no longer
 * exists (TMDB merges and deletes duplicates) falls through to the next way
 * instead of failing the whole folder.
 */
async function firstWorking<T>(attempts: Attempt[], load: (id: number) => Promise<T>): Promise<{ row: T | null; dead: string[] }> {
  const dead: string[] = [];
  const tried = new Set<number>();
  for (const a of attempts) {
    const id = await a.id();
    if (!id || tried.has(id)) continue;
    tried.add(id);
    try {
      return { row: await load(id), dead };
    } catch (err) {
      if (err instanceof TmdbError && err.status === 404) {
        dead.push(`${a.source} ${id}`);
        continue;
      }
      throw err;
    }
  }
  return { row: null, dead };
}

function unmatchedReason(dead: string[], candidates: TmdbSearchResult[]): string {
  if (dead.length) return `TMDB no longer has ${dead.join(' or ')}, and no other match was certain.`;
  return candidates.length ? 'No result had exactly this title and year.' : 'TMDB found nothing for this name.';
}

export class LibraryScanner {
  status: ScanStatus = { running: false, phase: 'idle', startedAt: null, finishedAt: null, processed: 0, total: 0, matched: 0, unmatched: 0, warnings: [], error: null };
  private current: Promise<void> | null = null;

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** Resolves when the current scan (if any) finishes. */
  wait(): Promise<void> {
    return this.current ?? Promise.resolve();
  }

  /** Starts a scan, or returns the one already running. */
  start(sources: ScanSources): Promise<void> {
    if (this.current) return this.current;
    // Strictly after the last scan finished, so files it saw count as "seen before this scan" even within the same millisecond.
    const startedAt = Math.max(this.now(), (this.status.finishedAt ?? 0) + 1);
    this.status = { running: true, phase: 'preparing', startedAt, finishedAt: null, processed: 0, total: 0, matched: 0, unmatched: 0, warnings: [], error: null };
    this.current = this.run(sources)
      .then(() => {
        this.status.phase = 'done';
      })
      .catch((err: Error) => {
        this.status.phase = 'failed';
        this.status.error = err.message;
        console.error('[scan] failed:', err);
      })
      .finally(() => {
        this.status.running = false;
        this.status.finishedAt = this.now();
        this.current = null;
      });
    return this.current;
  }

  private warn(msg: string) {
    if (this.status.warnings.length < 50) this.status.warnings.push(msg);
    console.warn(`[scan] ${msg}`);
  }

  private async run(src: ScanSources): Promise<void> {
    const startedAt = this.status.startedAt!;

    const [movieDirs, showDirs] = await Promise.all([this.titleEntries(src.moviesRoot, 'Movies'), this.titleEntries(src.tvRoot, 'TV')]);
    const [radarr, sonarr] = await Promise.all([this.arrHints(src.radarr, 'Radarr'), this.arrHints(src.sonarr, 'Sonarr')]);
    this.status.total = movieDirs.length + showDirs.length;

    this.status.phase = 'movies';
    await pool(movieDirs, CONCURRENCY, async (dir) => {
      await this.scanMovieFolder(src.tmdb, dir, radarr.get(folderKey(dir.path))).catch((err: Error) => this.warn(`${dir.path}: ${err.message}`));
      this.status.processed++;
    });

    this.status.phase = 'shows';
    await pool(showDirs, CONCURRENCY, async (dir) => {
      await this.scanShowFolder(src.tmdb, dir.path, sonarr.get(folderKey(dir.path))).catch((err: Error) => this.warn(`${dir.path}: ${err.message}`));
      this.status.processed++;
    });

    // Forget files and unmatched folders that weren't seen this time (deleted or renamed on disk).
    // Only Marquee's records change; nothing on disk is touched.
    this.status.phase = 'cleanup';
    for (const root of [src.moviesRoot, src.tvRoot]) {
      const prefix = root.replace(/\/+$/, '') + '/%';
      this.db.delete(mediaFiles).where(and(like(mediaFiles.path, prefix), lt(mediaFiles.seenAt, startedAt))).run();
      this.db.delete(scanItems).where(and(like(scanItems.path, prefix), lt(scanItems.seenAt, startedAt))).run();
    }
  }

  /** Top-level folders (and loose video files) in a library root. */
  private async titleEntries(root: string, label: string): Promise<{ path: string; looseFile: boolean }[]> {
    let entries;
    try {
      entries = await listDir(root);
    } catch {
      this.warn(`Can't open the ${label} folder ${root}. Check the Data path in the container settings, or the folder in Settings → Services.`);
      return [];
    }
    return entries
      .filter((e) => !e.name.startsWith('.') && !e.name.startsWith('@'))
      .filter((e) => e.isDirectory() || (e.isFile() && VIDEO_EXTENSIONS.has(path.extname(e.name).toLowerCase())))
      .map((e) => ({ path: path.join(root, e.name), looseFile: e.isFile() }));
  }

  private async arrHints(api: ArrApi | null, name: string): Promise<Map<string, ArrTitle>> {
    const map = new Map<string, ArrTitle>();
    if (!api) return map;
    try {
      for (const t of await api.titles()) map.set(folderKey(t.path), t);
    } catch (err) {
      this.warn(`Couldn't read ${name}, matching without it: ${(err as Error).message}`);
    }
    return map;
  }

  // ---------------- Movies ----------------

  private async scanMovieFolder(tmdb: TmdbApi, entry: { path: string; looseFile: boolean }, hint: ArrTitle | undefined): Promise<void> {
    const files = entry.looseFile
      ? await fs.stat(entry.path).then((s) => [{ path: entry.path, name: path.basename(entry.path), size: s.size, mtime: Math.floor(s.mtimeMs) }])
      : await videoFiles(entry.path, 2);
    if (files.length === 0) return; // empty folder: nothing to match

    const parsed = parseTitleName(path.basename(entry.path));
    const existing = this.db.select().from(movies).where(eq(movies.path, entry.path)).get();

    let candidates: TmdbSearchResult[] = [];
    const imdbId = parsed.imdbId ?? hint?.imdbId ?? null;
    const { row: movie, dead } = await firstWorking(
      [
        { source: 'the previous match', id: async () => existing?.tmdbId ?? null },
        { source: 'the TMDB ID in the folder name', id: async () => parsed.tmdbId },
        { source: "Radarr's TMDB ID", id: async () => hint?.tmdbId ?? null },
        { source: 'the IMDb match', id: async () => (imdbId ? tmdb.findMovie({ imdbId }) : null) },
        {
          source: 'the title search',
          id: async () => {
            candidates = await tmdb.searchMovie(parsed.title, parsed.year);
            if (candidates.length === 0 && parsed.year) candidates = await tmdb.searchMovie(parsed.title);
            return pickMatch(candidates, parsed.title, parsed.year)?.tmdbId ?? null;
          },
        },
      ],
      // Titles matched before studios, language and keywords were kept are fetched once more.
      (id) => (existing && id === existing.tmdbId && existing.originalLanguage !== null ? Promise.resolve(existing) : this.upsertMovie(tmdb, id, entry.path, Math.min(...files.map((f) => f.mtime)))),
    );

    if (!movie) {
      this.recordUnmatched('movie', entry.path, parsed.title, parsed.year, candidates, unmatchedReason(dead, candidates));
      return;
    }
    if (dead.length) this.warn(`${entry.path}: TMDB no longer has ${dead.join(' or ')}; matched another way instead.`);
    for (const f of files) this.upsertFile(f, { movieId: movie.id }, path.basename(entry.path));
    this.db.delete(scanItems).where(eq(scanItems.path, entry.path)).run();
    this.status.matched++;
  }

  async upsertMovie(tmdb: TmdbApi, tmdbId: number, folder: string | null, addedAt: number): Promise<Movie> {
    const d = await tmdb.movie(tmdbId);
    const values = {
      imdbId: d.imdbId,
      title: d.title,
      sortTitle: sortTitle(d.title),
      year: d.year,
      overview: d.overview,
      posterPath: d.posterPath,
      backdropPath: d.backdropPath,
      runtime: d.runtime,
      certification: d.certification,
      genres: JSON.stringify(d.genres),
      originalLanguage: d.originalLanguage,
      companies: JSON.stringify(d.companies),
      keywords: JSON.stringify(d.keywords),
      releaseDate: d.releaseDate,
      cinemaRelease: d.cinemaRelease ?? null,
      digitalRelease: d.digitalRelease ?? null,
      physicalRelease: d.physicalRelease ?? null,
      refreshedAt: this.now(),
    };
    const current = this.db.select().from(movies).where(eq(movies.tmdbId, tmdbId)).get();
    if (current) {
      // A second folder for the same movie keeps the first folder as "the" folder.
      return this.db.update(movies).set({ ...values, path: current.path ?? folder }).where(eq(movies.id, current.id)).returning().get();
    }
    return this.db.insert(movies).values({ tmdbId, path: folder, addedAt, monitored: false, profile: chooseProfile(this.db, 'movie', factsFrom(d)), ...values }).returning().get();
  }

  // ---------------- Shows ----------------

  private async scanShowFolder(tmdb: TmdbApi, folder: string, hint: ArrTitle | undefined): Promise<void> {
    const parsed = parseTitleName(path.basename(folder));
    const existing = this.db.select().from(series).where(eq(series.path, folder)).get();

    const files = await videoFiles(folder, 3);
    let candidates: TmdbSearchResult[] = [];
    const tvdbId = parsed.tvdbId ?? hint?.tvdbId ?? null;
    const imdbId = parsed.imdbId ?? hint?.imdbId ?? null;
    const { row: show, dead } = await firstWorking(
      [
        { source: 'the previous match', id: async () => existing?.tmdbId ?? null },
        { source: 'the TMDB ID in the folder name', id: async () => parsed.tmdbId },
        { source: "Sonarr's TMDB ID", id: async () => hint?.tmdbId ?? null },
        { source: 'the TVDB/IMDb match', id: async () => (tvdbId || imdbId ? tmdb.findShow({ tvdbId, imdbId }) : null) },
        {
          source: 'the title search',
          id: async () => {
            candidates = await tmdb.searchShow(parsed.title, parsed.year);
            if (candidates.length === 0 && parsed.year) candidates = await tmdb.searchShow(parsed.title);
            return pickMatch(candidates, parsed.title, parsed.year)?.tmdbId ?? null;
          },
        },
      ],
      (id) =>
        existing && id === existing.tmdbId && existing.originalLanguage !== null && this.now() - existing.refreshedAt < SERIES_REFRESH_MS
          ? Promise.resolve(existing)
          : this.upsertSeries(tmdb, id, folder, files.length ? Math.min(...files.map((f) => f.mtime)) : this.now()),
    );

    if (!show) {
      if (files.length === 0) return;
      this.recordUnmatched('series', folder, parsed.title, parsed.year, candidates, unmatchedReason(dead, candidates));
      return;
    }
    if (dead.length) this.warn(`${folder}: TMDB no longer has ${dead.join(' or ')}; matched another way instead.`);

    let skipped = 0;
    for (const f of files) {
      const ep = parseEpisode(f.name);
      if (!ep) {
        skipped++;
        continue;
      }
      for (const n of ep.episodes) {
        this.db.insert(episodes).values({ seriesId: show.id, season: ep.season, episode: n }).onConflictDoNothing().run();
      }
      this.upsertFile(f, { seriesId: show.id, season: ep.season, episodes: JSON.stringify(ep.episodes) }, path.basename(folder));
    }
    if (skipped) this.warn(`${folder}: ${skipped} video file(s) without an episode number (like S01E02) were skipped.`);
    this.db.delete(scanItems).where(eq(scanItems.path, folder)).run();
    this.status.matched++;
  }

  async upsertSeries(tmdb: TmdbApi, tmdbId: number, folder: string | null, addedAt: number): Promise<Series> {
    const d = await tmdb.show(tmdbId);
    const values = {
      tvdbId: d.tvdbId,
      imdbId: d.imdbId,
      title: d.title,
      sortTitle: sortTitle(d.title),
      year: d.year,
      overview: d.overview,
      posterPath: d.posterPath,
      backdropPath: d.backdropPath,
      status: d.status,
      network: d.network,
      certification: d.certification,
      genres: JSON.stringify(d.genres),
      originalLanguage: d.originalLanguage,
      companies: JSON.stringify(d.companies),
      keywords: JSON.stringify(d.keywords),
      refreshedAt: this.now(),
    };
    const current = this.db.select().from(series).where(eq(series.tmdbId, tmdbId)).get();
    const row = current
      ? this.db.update(series).set({ ...values, path: current.path ?? folder }).where(eq(series.id, current.id)).returning().get()
      : this.db.insert(series).values({ tmdbId, path: folder, addedAt, monitored: false, profile: chooseProfile(this.db, 'tv', factsFrom(d)), ...values }).returning().get();

    for (const s of d.seasons) {
      if (s.episodeCount === 0) continue;
      for (const e of await tmdb.season(tmdbId, s.season)) {
        this.db
          .insert(episodes)
          .values({ seriesId: row.id, season: e.season, episode: e.episode, title: e.title, airDate: e.airDate, overview: e.overview })
          .onConflictDoUpdate({ target: [episodes.seriesId, episodes.season, episodes.episode], set: { title: e.title, airDate: e.airDate, overview: e.overview } })
          .run();
      }
    }
    return row;
  }

  // ---------------- Shared ----------------

  private upsertFile(f: FoundFile, owner: { movieId?: number; seriesId?: number; season?: number; episodes?: string }, folderName: string): void {
    const q = parseQuality(f.name);
    // Clean library names often keep quality only on the folder; fall back to it.
    const fq = q.resolution ? q : { ...parseQuality(folderName), group: q.group };
    const values = {
      movieId: owner.movieId ?? null,
      seriesId: owner.seriesId ?? null,
      season: owner.season ?? null,
      episodes: owner.episodes ?? null,
      size: f.size,
      mtime: f.mtime,
      resolution: fq.resolution,
      source: fq.source,
      hdr: fq.hdr,
      codec: fq.codec,
      releaseGroup: fq.group,
      seenAt: this.now(),
    };
    this.db
      .insert(mediaFiles)
      .values({ path: f.path, addedAt: f.mtime, ...values })
      .onConflictDoUpdate({ target: mediaFiles.path, set: values })
      .run();
  }

  private recordUnmatched(kind: 'movie' | 'series', folder: string, title: string, year: number | null, candidates: TmdbSearchResult[], reason: string): void {
    const top = candidates.slice(0, 6).map((c) => ({ tmdbId: c.tmdbId, title: c.title, year: c.year, posterPath: c.posterPath }));
    const existing = this.db.select().from(scanItems).where(eq(scanItems.path, folder)).get();
    if (existing) {
      this.db.update(scanItems).set({ candidates: JSON.stringify(top), reason, seenAt: this.now() }).where(eq(scanItems.id, existing.id)).run();
      if (existing.status === 'ignored') return;
    } else {
      this.db.insert(scanItems).values({ kind, path: folder, parsedTitle: title, parsedYear: year, candidates: JSON.stringify(top), reason, seenAt: this.now() }).run();
    }
    this.status.unmatched++;
  }

  /** Manually matches a "Needs a match" folder, then imports its files. */
  async matchFolder(tmdb: TmdbApi, itemId: number, tmdbId: number): Promise<void> {
    const item = this.db.select().from(scanItems).where(eq(scanItems.id, itemId)).get();
    if (!item) throw new Error('No such folder.');
    if (item.kind === 'movie') {
      const files = await videoFiles(item.path, 2);
      const movie = await this.upsertMovie(tmdb, tmdbId, item.path, files.length ? Math.min(...files.map((f) => f.mtime)) : this.now());
      for (const f of files) this.upsertFile(f, { movieId: movie.id }, path.basename(item.path));
    } else {
      // Pin the match, then let the normal show scan attach files and episodes.
      await this.upsertSeries(tmdb, tmdbId, item.path, this.now());
      await this.scanShowFolder(tmdb, item.path, undefined);
    }
    this.db.delete(scanItems).where(eq(scanItems.id, itemId)).run();
  }

  /** Detaches media files that point at removed titles (used when an admin un-matches). */
  forgetFiles(ids: number[]): void {
    if (ids.length) this.db.delete(mediaFiles).where(inArray(mediaFiles.id, ids)).run();
  }
}
