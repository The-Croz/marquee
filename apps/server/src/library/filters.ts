import { and, eq, gt, inArray, isNotNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { episodes, mediaFiles, movies, series } from '../db/schema.js';
import { ProfileService, type FullProfile } from '../releases/profiles.js';
import { doneUpgrading, judgeFile, worstFile } from '../releases/upgrade.js';

/**
 * The Library's "Wanted, nothing yet" and "Not good enough yet" filters
 * (older apps' Wanted → Missing and Cutoff Unmet pages, as filters instead).
 *
 * Wanted, nothing yet: a Wanted movie with no file; a Wanted show with aired,
 * Wanted episodes that aren't on disk.
 * Not good enough yet: a file below its profile's "good enough", so Marquee
 * would still take a better copy (a show counts when any season is).
 */

const today = (now: number) => new Date(now).toISOString().slice(0, 10);

export function wantedNothingYet(db: Db, kind: 'movie' | 'series', now: number): Set<number> {
  if (kind === 'movie') {
    const withFiles = new Set(db.selectDistinct({ id: mediaFiles.movieId }).from(mediaFiles).where(isNotNull(mediaFiles.movieId)).all().map((r) => r.id!));
    return new Set(db.select({ id: movies.id }).from(movies).where(eq(movies.monitored, true)).all().map((r) => r.id).filter((id) => !withFiles.has(id)));
  }
  const shows = db.select({ id: series.id }).from(series).where(eq(series.monitored, true)).all().map((r) => r.id);
  if (!shows.length) return new Set();
  const have = new Set(
    db
      .select({ s: mediaFiles.seriesId, season: mediaFiles.season, eps: mediaFiles.episodes })
      .from(mediaFiles)
      .where(inArray(mediaFiles.seriesId, shows))
      .all()
      .flatMap((f) => (JSON.parse(f.eps ?? '[]') as number[]).map((e) => `${f.s}:${f.season}:${e}`)),
  );
  const t = today(now);
  const out = new Set<number>();
  for (const e of db.select().from(episodes).where(and(inArray(episodes.seriesId, shows), gt(episodes.season, 0), eq(episodes.monitored, true))).all()) {
    if (e.airDate && e.airDate <= t && !have.has(`${e.seriesId}:${e.season}:${e.episode}`)) out.add(e.seriesId);
  }
  return out;
}

export function notGoodEnough(db: Db, kind: 'movie' | 'series', now: () => number): Set<number> {
  const profiles = new ProfileService(db, now);
  const cache = new Map<string, FullProfile>();
  const profile = (k: 'movie' | 'tv', key: string) => {
    const id = `${k}:${key}`;
    if (!cache.has(id)) cache.set(id, profiles.forTitle(k, key));
    return cache.get(id)!;
  };
  const out = new Set<number>();
  if (kind === 'movie') {
    const byMovie = new Map<number, string[]>();
    for (const f of db.select({ id: mediaFiles.movieId, path: mediaFiles.path }).from(mediaFiles).where(isNotNull(mediaFiles.movieId)).all()) byMovie.set(f.id!, [...(byMovie.get(f.id!) ?? []), f.path]);
    for (const m of db.select().from(movies).where(inArray(movies.id, [...byMovie.keys()])).all()) {
      const p = profile('movie', m.profile);
      const wanted = { kind: 'movie' as const, title: m.title, year: m.year, tmdbId: m.tmdbId, imdbId: m.imdbId, runtime: m.runtime };
      const yours = worstFile(byMovie.get(m.id)!.map((f) => judgeFile(wanted, f, p)));
      if (yours && !doneUpgrading(yours, p)) out.add(m.id);
    }
    return out;
  }
  const bySeason = new Map<string, string[]>();
  for (const f of db.select({ id: mediaFiles.seriesId, season: mediaFiles.season, path: mediaFiles.path }).from(mediaFiles).where(and(isNotNull(mediaFiles.seriesId), gt(mediaFiles.season, 0))).all()) {
    const k = `${f.id}:${f.season}`;
    bySeason.set(k, [...(bySeason.get(k) ?? []), f.path]);
  }
  const ids = [...new Set([...bySeason.keys()].map((k) => Number(k.split(':')[0])))];
  const shows = new Map(ids.length ? db.select().from(series).where(inArray(series.id, ids)).all().map((s) => [s.id, s]) : []);
  for (const [k, files] of bySeason) {
    const [id, season] = k.split(':').map(Number) as [number, number];
    const s = shows.get(id);
    if (!s || out.has(id)) continue;
    const p = profile('tv', s.profile);
    const wanted = { kind: 'tv' as const, title: s.title, year: s.year, tmdbId: s.tmdbId, imdbId: s.imdbId, tvdbId: s.tvdbId, season, runtime: null };
    const yours = worstFile(files.map((f) => judgeFile(wanted, f, p)));
    if (yours && !doneUpgrading(yours, p)) out.add(id);
  }
  return out;
}
