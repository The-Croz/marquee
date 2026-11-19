import type { Db } from '../db/index.js';
import { movies, series, users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { playsOf } from '../activity/service.js';
import { normalizeTitle } from '../releases/decide.js';

export interface WatchedSeed {
  kind: 'movie' | 'series';
  tmdbId: number;
  title: string;
}

/**
 * Titles a person has watched on Plex or Jellyfin, newest first, for the
 * "Because you watched…" rows. A movie needs a TMDB id (from the server, or
 * the library copy with the same name and year); an episode counts for its
 * show when the show is in the library. Each title shows once.
 */
export function watchedTitles(db: Db, userId: number, limit = 30): WatchedSeed[] {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) return [];
  const mine = playsOf(db, user);
  if (!mine.length) return [];

  const lib = db.select({ tmdbId: movies.tmdbId, title: movies.title, year: movies.year }).from(movies).all();
  const movieByName = new Map(lib.map((m) => [`${normalizeTitle(m.title)}|${m.year ?? ''}`, m]));
  const movieByNameOnly = new Map(lib.map((m) => [normalizeTitle(m.title), m]));
  const shows = new Map(db.select({ tmdbId: series.tmdbId, title: series.title }).from(series).all().map((s) => [normalizeTitle(s.title), s]));

  const out: WatchedSeed[] = [];
  const seen = new Set<string>();
  for (const p of mine) {
    let seed: WatchedSeed | null = null;
    if (p.kind === 'movie') {
      const n = normalizeTitle(p.title);
      const m = movieByName.get(`${n}|${p.year ?? ''}`) ?? (p.year ? undefined : movieByNameOnly.get(n));
      const tmdbId = p.tmdbId ?? m?.tmdbId ?? null;
      if (tmdbId) seed = { kind: 'movie', tmdbId, title: m?.title ?? p.title };
    } else if (p.show) {
      const s = shows.get(normalizeTitle(p.show));
      if (s?.tmdbId) seed = { kind: 'series', tmdbId: s.tmdbId, title: s.title };
    }
    if (!seed) continue;
    const k = `${seed.kind}${seed.tmdbId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(seed);
    if (out.length >= limit) break;
  }
  return out;
}
