import { and, desc, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import type { DiscoverCard, DiscoverPage, HomeData, HomeHero } from '@marquee/shared';
import type { Db } from '../db/index.js';
import { episodes, mediaFiles, movies, requests, series, type User } from '../db/schema.js';
import { playsOf } from '../activity/service.js';
import { normalizeTitle } from '../releases/decide.js';
import { KID_MOVIE_RATINGS, KID_TV_RATINGS } from './library.js';

/**
 * Home's banner: a few slides that take turns. Something you asked for that
 * arrived, what's newest, what just aired, what's coming, a suggestion, one
 * you haven't watched and a lucky dip. Each slide appears only when there is
 * something real to show, and a title is never on two of them. Watching has
 * its own row, not the banner.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MOST = 8;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const shortDay = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

const noFacts = { year: null, rating: null, runtime: null, genres: [], score: null, votes: null, overview: null, kindLabel: null } satisfies Partial<HomeHero>;

/** A library title as a slide, with its artwork. */
function librarySlide(db: Db, href: string, kind: HomeHero['kind'], eyebrow: string, note: string | null = null): HomeHero | null {
  const m = href.match(/^\/(movies|shows)\/(\d+)$/);
  if (!m) return null;
  const table = m[1] === 'movies' ? movies : series;
  const row = db.select({ title: table.title, year: table.year, poster: table.posterPath, backdrop: table.backdropPath, color: table.posterColor }).from(table).where(eq(table.id, Number(m[2]))).get();
  if (!row) return null;
  return { ...noFacts, kind, eyebrow, title: row.title, chips: [], href, discover: null, backdropPath: row.backdrop, posterPath: row.poster, color: row.color, progress: null, note, year: row.year };
}

/** The newest thing to have aired (or come out to stream) that's in the library. */
function justAired(db: Db, now: number, kid: boolean): HomeHero | null {
  const today = isoDay(now);
  const from = isoDay(now - 14 * DAY);
  const rows = db
    .select({ id: series.id, rating: series.certification, season: episodes.season, episode: episodes.episode, date: episodes.airDate })
    .from(episodes)
    .innerJoin(series, eq(series.id, episodes.seriesId))
    .where(and(gte(episodes.airDate, from), lte(episodes.airDate, today), sql`${episodes.season} > 0`))
    .orderBy(desc(episodes.airDate), desc(episodes.season), desc(episodes.episode))
    .all()
    .filter((r) => !kid || KID_TV_RATINGS.includes(r.rating ?? ''));
  const files = rows.length
    ? db.select({ seriesId: mediaFiles.seriesId, season: mediaFiles.season, episodes: mediaFiles.episodes }).from(mediaFiles).where(inArray(mediaFiles.seriesId, [...new Set(rows.map((r) => r.id))])).all()
    : [];
  const have = new Set(files.flatMap((f) => (JSON.parse(f.episodes ?? '[]') as number[]).map((e) => `${f.seriesId}:${f.season}:${e}`)));
  const show = rows.find((r) => have.has(`${r.id}:${r.season}:${r.episode}`));

  const month = isoDay(now - 30 * DAY);
  const movie = db
    .select({ id: movies.id, rating: movies.certification, date: movies.digitalRelease })
    .from(movies)
    .where(and(gte(movies.digitalRelease, month), lte(movies.digitalRelease, today), sql`exists (select 1 from ${mediaFiles} where ${mediaFiles.movieId} = ${movies.id})`))
    .orderBy(desc(movies.digitalRelease))
    .all()
    .find((r) => !kid || KID_MOVIE_RATINGS.includes(r.rating ?? ''));

  if (show && (!movie || show.date! >= movie.date!)) {
    const when = show.date === today ? 'today' : shortDay(show.date!);
    return librarySlide(db, `/shows/${show.id}`, 'aired', `Recently aired · ${when}`, `Season ${show.season}, episode ${show.episode}`);
  }
  return movie ? librarySlide(db, `/movies/${movie.id}`, 'aired', `Recently out · ${shortDay(movie.date!)}`) : null;
}

/** Every library title with a file, as page addresses. */
function onShelf(db: Db, kid: boolean): { href: string; title: string; year: number | null; kind: 'movie' | 'episode' }[] {
  const m = db
    .select({ id: movies.id, title: movies.title, year: movies.year, rating: movies.certification })
    .from(movies)
    .where(sql`exists (select 1 from ${mediaFiles} where ${mediaFiles.movieId} = ${movies.id})`)
    .all()
    .filter((r) => !kid || KID_MOVIE_RATINGS.includes(r.rating ?? ''));
  const showIds = db.selectDistinct({ id: mediaFiles.seriesId }).from(mediaFiles).where(isNotNull(mediaFiles.seriesId)).all().map((r) => r.id!);
  const s = (showIds.length ? db.select({ id: series.id, title: series.title, year: series.year, rating: series.certification }).from(series).where(inArray(series.id, showIds)).all() : []).filter((r) => !kid || KID_TV_RATINGS.includes(r.rating ?? ''));
  return [
    ...m.map((r) => ({ href: `/movies/${r.id}`, title: r.title, year: r.year, kind: 'movie' as const })),
    ...s.map((r) => ({ href: `/shows/${r.id}`, title: r.title, year: r.year, kind: 'episode' as const })),
  ];
}

/** The same pick for an hour, a different one the next: a banner shouldn't change while you look at it. */
function pickOf<T>(list: T[], seed: number): T | undefined {
  if (!list.length) return undefined;
  let x = (seed ^ 0x5bf03635) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) >>> 0;
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39) >>> 0;
  return list[(x ^ (x >>> 15)) % list.length];
}

function pickedSlide(card: DiscoverCard, why: string): HomeHero {
  return {
    ...noFacts,
    kind: 'picked',
    eyebrow: why.startsWith('Top picks') ? 'Picked for you' : why,
    title: card.title,
    chips: [],
    href: card.libraryId ? `/${card.kind === 'movie' ? 'movies' : 'shows'}/${card.libraryId}` : null,
    discover: { kind: card.kind, tmdbId: card.tmdbId },
    backdropPath: card.backdropPath,
    posterPath: card.posterPath,
    color: null,
    progress: null,
    note: null,
    year: card.year,
    genres: card.genres,
    score: card.score,
    overview: card.overview || null,
    kindLabel: card.kind === 'movie' ? 'Movie' : 'Show',
  };
}

export async function bannerSlides(deps: { db: Db; now: () => number }, user: User, data: HomeData, discover: () => Promise<DiscoverPage | null>): Promise<HomeHero[]> {
  const { db, now } = deps;
  const kid = user.role === 'kid';
  const t = now();
  const seed = Math.floor(t / HOUR) * 31 + user.id;
  const slides: (HomeHero | null | undefined)[] = [];

  const ready = db
    .select()
    .from(requests)
    .where(and(eq(requests.requestedBy, user.id), gte(requests.readyAt, t - 14 * DAY)))
    .orderBy(desc(requests.readyAt))
    .limit(1)
    .get();
  if (ready?.titleId) slides.push(librarySlide(db, `/${ready.kind === 'movie' ? 'movies' : 'shows'}/${ready.titleId}`, 'ready', 'Ready to watch · you asked for it'));

  for (const fresh of data.recent.slice(0, 2)) {
    const days = Math.floor((t - fresh.addedAt) / DAY);
    slides.push(librarySlide(db, fresh.href, 'arrived', `Recently added · ${days < 1 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`}`, fresh.sub));
  }

  slides.push(justAired(db, t, kid));

  const next = data.upcoming.find((u) => u.href && u.note !== 'In your library');
  if (next?.href) slides.push(librarySlide(db, next.href, 'coming', next.day === 'Today' ? 'Coming today' : `Coming ${next.day}`, next.title));

  const page = await discover();
  const row = page?.rows.find((r) => r.id.startsWith('because-watched')) ?? page?.rows.find((r) => r.id === 'top-picks');
  const card = row && pickOf(row.items.filter((c) => c.backdropPath), seed);
  if (row && card) slides.push(pickedSlide(card, row.title));

  const shelf = onShelf(db, kid);
  const plays = playsOf(db, user);
  // With no watch history for this person, "not watched" would only be a guess.
  if (plays.length) {
    const seen = new Set(plays.map((p) => normalizeTitle((p.kind === 'movie' ? p.title : p.show) ?? '')));
    const unseen = pickOf(shelf.filter((s) => !seen.has(normalizeTitle(s.title))), seed + 1);
    if (unseen) slides.push(librarySlide(db, unseen.href, 'unwatched', 'Not watched yet'));
  }
  const taken = new Set(slides.map((s) => s?.href));
  const lucky = pickOf(shelf.filter((s) => !taken.has(s.href)), seed + 2);
  if (lucky) slides.push(librarySlide(db, lucky.href, 'random', 'From your library'));

  const once = new Set<string>();
  return slides
    .filter((s): s is HomeHero => !!s)
    .filter((s) => {
      const key = s.href ?? `${s.discover?.kind}${s.discover?.tmdbId}`;
      if (once.has(key)) return false;
      once.add(key);
      return true;
    })
    .slice(0, MOST);
}
