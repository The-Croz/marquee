import { and, asc, eq, gte, inArray, isNull, lt, lte, notInArray, or } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { CalendarItem, CalendarView } from '@marquee/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { downloads, episodes, mediaFiles, movies, profiles, series } from '../db/schema.js';
import type { Clients } from '../http.js';
import { lookingForWantedTv } from '../downloads/wantedTv.js';
import { lookingForWanted } from '../downloads/wanted.js';
import type { LibraryScanner } from './scanner.js';
import { readServices } from './services.js';

/**
 * The airing calendar. Episode air dates come from TMDB and are kept fresh by
 * re-reading shows that are still on the air twice a day, so new episodes
 * appear (and moved ones move) without a library scan.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const REFRESH_AFTER = 12 * HOUR;
/** Shows TMDB says are over: nothing new will air. */
const OVER = ['Ended', 'Canceled'];

export async function refreshAiring(deps: { db: Db; config: Config; clients: Pick<Clients, 'tmdb'>; scanner: LibraryScanner; now: () => number }, limit = 20): Promise<{ refreshed: number; problems: string[] }> {
  const { db, config, clients, scanner, now } = deps;
  const key = readServices(db, config).tmdbApiKey;
  if (!key) return { refreshed: 0, problems: [] };
  const tmdb = clients.tmdb(key);
  const due = db
    .select()
    .from(series)
    .where(and(or(isNull(series.status), notInArray(series.status, OVER)), lt(series.refreshedAt, now() - REFRESH_AFTER)))
    .orderBy(asc(series.refreshedAt))
    .limit(limit)
    .all();
  const problems: string[] = [];
  let refreshed = 0;
  for (const s of due) {
    try {
      await scanner.upsertSeries(tmdb, s.tmdbId, null, s.addedAt);
      refreshed++;
    } catch (err) {
      problems.push(`${s.title}: ${(err as Error).message}`);
    }
  }
  // Wanted movies, and any from the last year: their cinema, digital and disc dates move and fill in.
  const yearAgo = isoDay(now() - 365 * DAY);
  const dueMovies = db
    .select()
    .from(movies)
    .where(and(or(and(eq(movies.monitored, true), isNull(movies.path)), gte(movies.releaseDate, yearAgo), isNull(movies.releaseDate)), lt(movies.refreshedAt, now() - REFRESH_AFTER)))
    .orderBy(asc(movies.refreshedAt))
    .limit(limit)
    .all();
  for (const m of dueMovies) {
    try {
      await scanner.upsertMovie(tmdb, m.tmdbId, null, m.addedAt);
      refreshed++;
    } catch (err) {
      problems.push(`${m.title}: ${(err as Error).message}`);
    }
  }
  return { refreshed, problems };
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Episodes airing between two days (inclusive), for the shows in your library,
 * and Wanted movies coming out in cinemas, to stream or buy, or on disc.
 * Kids only see shows and movies with a kids' age rating.
 */
export function calendar(db: Db, opts: { from: string; to: string; now: number; kidRatings?: string[]; kidMovieRatings?: string[] }): CalendarView {
  const today = isoDay(opts.now);
  const rows = db
    .select({ e: episodes, s: series })
    .from(episodes)
    .innerJoin(series, eq(series.id, episodes.seriesId))
    .where(and(gte(episodes.airDate, opts.from), lte(episodes.airDate, opts.to)))
    .orderBy(asc(episodes.airDate), asc(series.sortTitle), asc(episodes.season), asc(episodes.episode))
    .all()
    .filter((r) => !opts.kidRatings || opts.kidRatings.includes(r.s.certification ?? ''));
  const ids = [...new Set(rows.map((r) => r.s.id))];
  const have = new Set<string>();
  const busy = new Set<string>();
  if (ids.length) {
    for (const f of db.select({ seriesId: mediaFiles.seriesId, season: mediaFiles.season, episodes: mediaFiles.episodes }).from(mediaFiles).where(inArray(mediaFiles.seriesId, ids)).all()) {
      for (const e of JSON.parse(f.episodes ?? '[]') as number[]) have.add(`${f.seriesId}:${f.season}:${e}`);
    }
    for (const d of db.select().from(downloads).where(and(inArray(downloads.seriesId, ids), inArray(downloads.state, ['sent', 'downloading']))).all()) {
      for (const e of d.episodes ? (JSON.parse(d.episodes) as (number | '*')[]) : ['*' as const]) busy.add(`${d.seriesId}:${d.season}:${e}`);
    }
  }
  const profileNames = new Map(db.select({ key: profiles.key, name: profiles.name }).from(profiles).where(eq(profiles.kind, 'tv')).all().map((p) => [p.key, p.name]));
  const marquee = lookingForWantedTv(db);

  const items: CalendarItem[] = rows.map(({ e, s }) => {
    const k = `${s.id}:${e.season}:${e.episode}`;
    const profile = profileNames.get(s.profile) ?? s.profile;
    let state: CalendarItem['state'];
    let note: string;
    if (have.has(k)) {
      state = 'have';
      note = 'In your library';
    } else if (busy.has(k) || busy.has(`${s.id}:${e.season}:*`)) {
      state = 'downloading';
      note = 'Downloading';
    } else if (!s.monitored || !e.monitored) {
      state = 'not_watched';
      note = s.monitored ? 'You left this episode out, so it won’t be downloaded' : 'This show isn’t Wanted, so it won’t be downloaded';
    } else if (e.season === 0) {
      state = e.airDate! <= today ? 'missing' : 'coming';
      note = 'A special: find it on the show’s page if you want it';
    } else if (e.airDate! <= today) {
      state = 'missing';
      note = marquee ? `Marquee is looking for it in ${profile}` : profile;
    } else {
      state = 'coming';
      note = marquee ? `Marquee will download it in ${profile}` : profile;
    }
    return {
      kind: 'episode' as const,
      seriesId: s.id,
      movieId: null,
      show: s.title,
      posterPath: s.posterPath,
      season: e.season,
      episode: e.episode,
      title: e.title,
      airDate: e.airDate!,
      state,
      note,
    };
  });
  const all = [...items, ...movieDates(db, opts, today)].sort((a, b) => a.airDate.localeCompare(b.airDate) || (a.kind === b.kind ? 0 : a.kind === 'movie' ? -1 : 1));
  return { from: opts.from, to: opts.to, today, items: all };
}

const HOW = { cinema: 'In cinemas', digital: 'Out to stream or buy', physical: 'On disc' } as const;

/** Wanted movies with a cinema, digital or disc date between the two days. */
function movieDates(db: Db, opts: { from: string; to: string; kidMovieRatings?: string[] }, today: string): CalendarItem[] {
  const inRange = (col: AnySQLiteColumn) => and(gte(col, opts.from), lte(col, opts.to));
  const rows = db
    .select()
    .from(movies)
    .where(and(eq(movies.monitored, true), or(inRange(movies.cinemaRelease), inRange(movies.digitalRelease), inRange(movies.physicalRelease), and(isNull(movies.cinemaRelease), isNull(movies.digitalRelease), inRange(movies.releaseDate)))))
    .all()
    .filter((m) => !opts.kidMovieRatings || opts.kidMovieRatings.includes(m.certification ?? ''));
  if (!rows.length) return [];
  const ids = rows.map((m) => m.id);
  const have = new Set(db.select({ id: mediaFiles.movieId }).from(mediaFiles).where(inArray(mediaFiles.movieId, ids)).all().map((f) => f.id));
  const busy = new Set(db.select({ id: downloads.movieId }).from(downloads).where(and(inArray(downloads.movieId, ids), inArray(downloads.state, ['sent', 'downloading']))).all().map((d) => d.id));
  const profileNames = new Map(db.select({ key: profiles.key, name: profiles.name }).from(profiles).where(eq(profiles.kind, 'movie')).all().map((p) => [p.key, p.name]));
  const marquee = lookingForWanted(db);
  const out: CalendarItem[] = [];
  for (const m of rows) {
    const dates: [keyof typeof HOW, string | null][] = [
      ['cinema', m.cinemaRelease ?? (m.digitalRelease ? null : m.releaseDate)],
      ['digital', m.digitalRelease],
      ['physical', m.physicalRelease],
    ];
    const profile = profileNames.get(m.profile) ?? m.profile;
    for (const [how, date] of dates) {
      if (!date || date < opts.from || date > opts.to) continue;
      let state: CalendarItem['state'];
      let note: string;
      if (have.has(m.id)) {
        state = 'have';
        note = 'In your library';
      } else if (busy.has(m.id)) {
        state = 'downloading';
        note = 'Downloading';
      } else if (how === 'cinema') {
        // Copies worth having rarely exist while it's only in cinemas.
        state = 'coming';
        note = m.digitalRelease ? `Marquee looks for it once it’s out to stream or buy` : marquee ? `Marquee looks for it in ${profile} once it’s out` : profile;
      } else if (date <= today) {
        state = 'missing';
        note = marquee ? `Marquee is looking for it in ${profile}` : profile;
      } else {
        state = 'coming';
        note = marquee ? `Marquee will look for it in ${profile}` : profile;
      }
      out.push({ kind: 'movie', seriesId: null, movieId: m.id, show: m.title, posterPath: m.posterPath, season: 0, episode: 0, title: HOW[how], airDate: date, state, note });
    }
  }
  return out;
}

/** "Coming up this week" on Home: the next 7 days, one line per show and day. */
export function comingUp(db: Db, now: number, kidRatings?: string[], kidMovieRatings?: string[]): { day: string; title: string; note: string; href: string }[] {
  const view = calendar(db, { from: isoDay(now), to: isoDay(now + 6 * DAY), now, kidRatings, kidMovieRatings });
  const lines = new Map<string, { day: string; title: string; note: string; href: string; eps: number[]; season: number; movie: boolean }>();
  for (const i of view.items) {
    const key = i.kind === 'movie' ? `${i.airDate}:m${i.movieId}:${i.title}` : `${i.airDate}:${i.seriesId}`;
    const line = lines.get(key);
    if (line) {
      line.eps.push(i.episode);
      continue;
    }
    const day = new Date(`${i.airDate}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
    lines.set(key, {
      day: i.airDate === view.today ? 'Today' : day,
      title: i.kind === 'movie' ? `${i.show} · ${i.title}` : i.show,
      note: i.note,
      href: i.kind === 'movie' ? `/movies/${i.movieId}` : `/shows/${i.seriesId}`,
      eps: [i.episode],
      season: i.season,
      movie: i.kind === 'movie',
    });
  }
  return [...lines.values()].map((l) => ({
    day: l.day,
    title: l.movie ? l.title : `${l.title} · S${l.season} ${l.eps.length > 1 ? `E${l.eps[0]}–${l.eps.at(-1)}` : `E${l.eps[0]}`}`,
    note: l.note,
    href: l.href,
  }));
}
