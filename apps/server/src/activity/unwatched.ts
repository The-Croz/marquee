import { isNotNull } from 'drizzle-orm';
import type { UnwatchedView } from '@marquee/shared';
import type { Db } from '../db/index.js';
import { mediaFiles, movies, plays, series } from '../db/schema.js';
import { normalizeTitle } from '../library/parse.js';

/**
 * W16: titles in the library nobody has watched, or not in a year, from the
 * plays Marquee copies from Plex and Jellyfin (and Tautulli's history, if
 * imported). Read-only, to help decide what to clear by hand: Marquee never
 * deletes anything by itself.
 */

const YEAR = 365 * 24 * 3_600_000;

export function unwatched(db: Db, kind: 'movie' | 'series', since: 'never' | 'year', now: number): UnwatchedView {
  const all = db.select({ kind: plays.kind, tmdbId: plays.tmdbId, title: plays.title, show: plays.show, year: plays.year, at: plays.playedAt }).from(plays).all();
  const last = new Map<string, { at: number; n: number }>();
  const bump = (k: string, at: number) => {
    const cur = last.get(k);
    last.set(k, { at: Math.max(cur?.at ?? 0, at), n: (cur?.n ?? 0) + 1 });
  };
  for (const p of all) {
    if (p.kind === 'movie') {
      if (p.tmdbId) bump(`tmdb:${p.tmdbId}`, p.at);
      bump(`t:${normalizeTitle(p.title)}:${p.year ?? ''}`, p.at);
    } else if (p.show) bump(`s:${normalizeTitle(p.show)}`, p.at);
  }
  const withFiles = new Set(
    db
      .select({ m: mediaFiles.movieId, s: mediaFiles.seriesId })
      .from(mediaFiles)
      .all()
      .map((f) => (kind === 'movie' ? f.m : f.s))
      .filter((x): x is number => x !== null),
  );
  const cutoff = now - YEAR;
  const rows =
    kind === 'movie'
      ? db.select().from(movies).where(isNotNull(movies.id)).all().map((m) => ({ id: m.id, title: m.title, year: m.year, posterPath: m.posterPath, addedAt: m.addedAt, seen: last.get(`tmdb:${m.tmdbId}`) ?? last.get(`t:${normalizeTitle(m.title)}:${m.year ?? ''}`) }))
      : db.select().from(series).where(isNotNull(series.id)).all().map((s) => ({ id: s.id, title: s.title, year: s.year, posterPath: s.posterPath, addedAt: s.addedAt, seen: last.get(`s:${normalizeTitle(s.title)}`) }));
  const items = rows
    .filter((r) => withFiles.has(r.id))
    .filter((r) => (since === 'never' ? !r.seen : !r.seen || r.seen.at < cutoff))
    // Long-unwatched first: never watched (oldest added first), then the longest since a play.
    .sort((a, b) => (a.seen?.at ?? 0) - (b.seen?.at ?? 0) || a.addedAt - b.addedAt)
    .map((r) => ({ id: r.id, title: r.title, year: r.year, posterPath: r.posterPath, addedAt: r.addedAt, lastPlayed: r.seen?.at ?? null, plays: r.seen?.n ?? 0, href: kind === 'movie' ? `/movies/${r.id}` : `/shows/${r.id}` }));
  const tracked = all.length > 0;
  return { kind, since, items, note: tracked ? null : 'Marquee hasn’t seen any plays yet. Connect Plex or Jellyfin in Settings → Services, or bring in Tautulli’s history on the Watching page.' };
}

