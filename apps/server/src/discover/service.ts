import { and, desc, eq, or } from 'drizzle-orm';
import type { CardState, DiscoverCard, DiscoverPage, DiscoverPrefs, DiscoverRow, DiscoverTitle, PersonDetail, ServiceTop, TitleRatings } from '@marquee/shared';
import type { Db } from '../db/index.js';
import { movies, requests, series, userPrefs, type User } from '../db/schema.js';
import { HttpError } from '../http.js';
import { GENRES, SERVICES, TmdbError, type TmdbApi, type TmdbCard } from '../library/tmdb.js';
import { prettyDate, requestView, showCoverage, titleStates } from '../requests/service.js';
import { isKidSafe } from './kids.js';
import { movieHomeDate, movieStage } from '../library/availability.js';
import type { OmdbApi, OutsideRatings } from '../library/omdb.js';
import { watchedTitles } from './seeds.js';
import { StreamingTopError, type StreamingTopApi } from './streamingTop.js';

/**
 * Discover: what's new and popular, what's on each streaming service, and
 * rows made for each person from what's in the library, what they asked for
 * and (from Milestone 6) what they watched. Kids see only titles that pass
 * the same age-rating rule as the library.
 */

export interface DiscoverDeps {
  db: Db;
  tmdb: TmdbApi;
  now: () => number;
  /** The services' own Top 10s; null without a Streaming Availability key. */
  top?: StreamingTopApi | null;
  /** Shows admins what to do when the Top 10 isn't the real one. */
  isAdmin?: boolean;
  /** IMDb and Rotten Tomatoes scores; null without an OMDb key. */
  omdb?: OmdbApi | null;
}

const DAY = 86_400_000;
const KID_GENRES = new Set([16, 10751, 10762]);
const ROW_MAX = 20;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const genreName = new Map<number, string>();
for (const k of ['movie', 'series'] as const) for (const g of GENRES[k]) genreName.set(g.id, g.name);

export function readPrefs(db: Db, userId: number): DiscoverPrefs {
  const p = db.select().from(userPrefs).where(eq(userPrefs.userId, userId)).get();
  return { hiddenServices: p ? (JSON.parse(p.hiddenServices) as string[]) : [], trailers: p ? p.trailers : true };
}

export function writePrefs(db: Db, userId: number, prefs: DiscoverPrefs): DiscoverPrefs {
  const hidden = prefs.hiddenServices.filter((k) => SERVICES.some((s) => s.key === k));
  db.insert(userPrefs)
    .values({ userId, hiddenServices: JSON.stringify(hidden), trailers: prefs.trailers })
    .onConflictDoUpdate({ target: userPrefs.userId, set: { hiddenServices: JSON.stringify(hidden), trailers: prefs.trailers } })
    .run();
  return { hiddenServices: hidden, trailers: prefs.trailers };
}

/** Runs `fn` over `items` a few at a time. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/** For a kid: only titles that look made for kids, then only those with a kid-safe US rating. */
async function forUser(deps: DiscoverDeps, user: User, cards: TmdbCard[]): Promise<TmdbCard[]> {
  if (user.role !== 'kid') return cards;
  const maybe = cards.filter((c) => c.genreIds.some((g) => KID_GENRES.has(g)));
  const checked = await mapLimit(maybe, 8, async (c) => {
    try {
      const cert = c.kind === 'movie' ? (await deps.tmdb.movie(c.tmdbId)).certification : (await deps.tmdb.show(c.tmdbId)).certification;
      return isKidSafe(c.kind, cert) ? c : null;
    } catch {
      return null;
    }
  });
  return checked.filter((c): c is TmdbCard => c !== null);
}

/** Tries a TMDB call; a row that can't load is just left out. */
async function soft<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof TmdbError && err.status === 401) throw new HttpError(400, 'tmdb_rejected', 'TMDB turned the API key down. Check it in Settings → Services.');
    return fallback;
  }
}

interface RawRow {
  id: string;
  title: string;
  subtitle?: string | null;
  cards: TmdbCard[];
  min?: number;
}

/** Same few titles, in the same order for everyone, but changing a little every day. */
function dayShuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let x = seed || 1;
  for (let i = out.length - 1; i > 0; i--) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const j = x % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

interface Seed {
  kind: 'movie' | 'series';
  tmdbId: number;
  title: string;
}

function librarySeeds(db: Db): Seed[] {
  const m = db.select({ tmdbId: movies.tmdbId, title: movies.title }).from(movies).orderBy(desc(movies.addedAt)).limit(60).all().map((x) => ({ kind: 'movie' as const, ...x }));
  const s = db.select({ tmdbId: series.tmdbId, title: series.title }).from(series).orderBy(desc(series.addedAt)).limit(60).all().map((x) => ({ kind: 'series' as const, ...x }));
  return [...m, ...s];
}

function requestedSeeds(db: Db, userId: number): Seed[] {
  return db
    .select({ kind: requests.kind, tmdbId: requests.tmdbId, title: requests.title })
    .from(requests)
    .where(and(eq(requests.requestedBy, userId), or(eq(requests.status, 'approved'), eq(requests.status, 'pending'))))
    .orderBy(desc(requests.createdAt))
    .limit(20)
    .all();
}

const dedupe = (cards: TmdbCard[]): TmdbCard[] => {
  const seen = new Set<string>();
  return cards.filter((c) => !seen.has(`${c.kind}${c.tmdbId}`) && !!seen.add(`${c.kind}${c.tmdbId}`));
};

/** Movies and shows mixed, the more popular first. */
const mix = (...lists: TmdbCard[][]): TmdbCard[] => lists.flat().sort((a, b) => b.popularity - a.popularity);

export async function discoverPage(deps: DiscoverDeps, user: User, opts: { type: 'all' | 'movie' | 'series'; service: string; genre: string | null }): Promise<DiscoverPage> {
  const { db, tmdb, now } = deps;
  const prefs = readPrefs(db, user.id);
  const mine = SERVICES.filter((s) => !prefs.hiddenServices.includes(s.key));
  const services = mine.map((s) => ({ key: s.key, name: s.name }));
  const kinds: ('movie' | 'series')[] = opts.type === 'all' ? ['movie', 'series'] : [opts.type];
  const today = iso(now());
  const monthAgo = iso(now() - 30 * DAY);
  const label = (k: 'movie' | 'series') => (k === 'movie' ? 'movies' : 'shows');
  const service = opts.service !== 'all' ? SERVICES.find((s) => s.key === opts.service) : undefined;
  if (opts.service !== 'all' && !service) throw new HttpError(400, 'invalid_input', 'No such service.');

  const raw: RawRow[] = [];
  const add = async (id: string, title: string, subtitle: string | null, jobs: Promise<TmdbCard[]>[], min = opts.genre || service ? 1 : 4) => {
    const lists = await Promise.all(jobs.map((j) => soft(j, [] as TmdbCard[])));
    raw.push({ id, title, subtitle, cards: opts.type === 'all' ? mix(...lists) : lists[0]!, min });
  };

  const tasks: Promise<void>[] = [];
  const genreFor = (k: 'movie' | 'series') => (opts.genre ? GENRES[k].find((g) => g.name === opts.genre)?.id : undefined);

  if (opts.genre) {
    const g = opts.genre;
    tasks.push(add('genre-popular', `Popular in ${g}`, null, kinds.filter(genreFor).map((k) => tmdb.discover(k, { genre: genreFor(k)! }))));
    tasks.push(add('genre-top', `Top rated in ${g}`, 'The best reviewed', kinds.filter(genreFor).map((k) => tmdb.discover(k, { genre: genreFor(k)!, sort: 'vote_average.desc' }))));
    tasks.push(add('genre-new', `New in ${g}`, 'Out in the last few months', kinds.filter(genreFor).map((k) => tmdb.discover(k, { genre: genreFor(k)!, sort: 'date.desc', from: iso(now() - 120 * DAY), to: today }))));
  } else if (service) {
    const p = service.ids;
    tasks.push(add('svc-popular', `Popular on ${service.name}`, null, kinds.map((k) => tmdb.discover(k, { provider: p }))));
    tasks.push(add('svc-new', `New on ${service.name}`, 'Out in the last month', kinds.map((k) => tmdb.discover(k, { provider: p, sort: 'date.desc', from: monthAgo, to: today }))));
    tasks.push(add('svc-top', `Top rated on ${service.name}`, 'The best reviewed', kinds.map((k) => tmdb.discover(k, { provider: p, sort: 'vote_average.desc' }))));
    for (const k of kinds) tasks.push(add(`svc-${k}`, `${service.name} ${label(k)}`, null, [tmdb.discover(k, { provider: p, sort: 'date.desc', to: today })], 1));
  } else {
    tasks.push(add('trending', 'Trending this week', null, kinds.map((k) => tmdb.list(k, 'trending'))));
    // Latest releases: movies out to stream or buy in the last month, and new shows on your services.
    const yours = mine.flatMap((s) => [...s.ids]);
    tasks.push(
      add(
        'latest',
        'Latest releases',
        kinds.length === 2 ? 'Movies out to stream or buy, and new shows, in the last month' : kinds[0] === 'movie' ? 'Out to stream or buy in the last month' : 'New on your services in the last month',
        kinds.map((k) => (k === 'movie' ? tmdb.discover('movie', { releaseType: 'digital', from: monthAgo, to: today }) : tmdb.discover('series', { provider: yours.length ? yours : undefined, from: monthAgo, to: today }))),
      ),
    );
    if (kinds.includes('movie')) tasks.push(add('now-playing', 'In cinemas now', null, [tmdb.list('movie', 'now_playing')]));
    if (kinds.includes('series')) tasks.push(add('airing', 'On the air', 'Shows with new episodes', [tmdb.list('series', 'on_the_air')]));
    for (const k of kinds) tasks.push(add(`popular-${k}`, `Popular ${label(k)}`, null, [tmdb.list(k, 'popular')]));
    if (kinds.includes('movie')) tasks.push(add('upcoming', 'Coming soon', 'Movies not out yet', [tmdb.list('movie', 'upcoming')]));
    for (const k of kinds) tasks.push(add(`top-${k}`, `Top rated ${label(k)}`, 'The best reviewed', [tmdb.list(k, 'top_rated')]));
  }
  await Promise.all(tasks);

  // Rows made for this person (not on service or genre pages).
  const personal: RawRow[] = [];
  if (!opts.genre && !service) {
    const day = Math.floor(now() / DAY);
    const watched = watchedTitles(db, user.id);
    const lib = librarySeeds(db);
    const asked = requestedSeeds(db, user.id);
    const all: Seed[] = [...watched, ...asked, ...lib];
    const inKinds = (s: Seed) => kinds.includes(s.kind);
    const recsFor = async (s: Seed) => (await soft(tmdb.recommendations(s.kind, s.tmdbId), [] as TmdbCard[])).filter((c) => kinds.includes(c.kind));
    const becauseRows = async (id: string, prefix: string, seeds: Seed[], n: number) => {
      const picked = dayShuffle(seeds.filter(inKinds), day + user.id).slice(0, n);
      const lists = await Promise.all(picked.map(recsFor));
      picked.forEach((s, i) => personal.push({ id: `${id}-${s.kind}-${s.tmdbId}`, title: `${prefix} ${s.title}`, subtitle: null, cards: lists[i]!, min: 2 }));
    };
    if (all.length >= 3) {
      const pool = dayShuffle(all, day * 7 + user.id).slice(0, 8);
      const lists = await Promise.all(pool.map(recsFor));
      const score = new Map<string, { c: TmdbCard; s: number }>();
      for (const list of lists) for (const c of list) {
        const k = `${c.kind}${c.tmdbId}`;
        const e = score.get(k) ?? { c, s: 0 };
        e.s += 1 + c.score / 10;
        score.set(k, e);
      }
      personal.push({ id: 'top-picks', title: 'Top picks for you', subtitle: 'From what you watch, ask for and own', cards: [...score.values()].sort((a, b) => b.s - a.s).map((x) => x.c), min: 2 });
    }
    await becauseRows('because-watched', 'Because you watched', watched, 2);
    await becauseRows('because-asked', 'Because you asked for', asked, 2);
    await becauseRows('because-have', 'Because you have', lib, 2);
  }

  // Put everything through the kid rule, then attach each title's state.
  // The everyday rows first; the "made for you" ones after them.
  const rows: RawRow[] = [...raw.sort((a, b) => rank(a.id) - rank(b.id)), ...personal];
  const cleaned = await Promise.all(rows.map(async (r) => ({ ...r, cards: await forUser(deps, user, dedupe(r.cards)) })));
  const states = new Map<string, { state: CardState; libraryId: number | null }>();
  for (const k of ['movie', 'series'] as const) {
    const ids = [...new Set(cleaned.flatMap((r) => r.cards.filter((c) => c.kind === k).map((c) => c.tmdbId)))];
    for (const [id, st] of titleStates(db, k, ids, user.id, now())) states.set(`${k}${id}`, st);
  }
  const card = (c: TmdbCard, badge?: string | null): DiscoverCard => toCard(c, states.get(`${c.kind}${c.tmdbId}`) ?? { state: 'none', libraryId: null }, today, badge);

  // "Because you…" rows only suggest what you don't have or haven't asked for.
  const finalRows: DiscoverRow[] = [];
  const shown = new Set<string>();
  for (const r of cleaned) {
    const own = r.id.startsWith('because') || r.id === 'top-picks';
    let cards = own ? r.cards.filter((c) => (states.get(`${c.kind}${c.tmdbId}`)?.state ?? 'none') === 'none') : r.cards;
    cards = cards.filter((c) => !!c.posterPath);
    if (cards.length < (r.min ?? 4)) continue;
    finalRows.push({ id: r.id, title: r.title, subtitle: r.subtitle ?? null, items: cards.slice(0, ROW_MAX).map((c) => card(c)) });
    cards.slice(0, ROW_MAX).forEach((c) => shown.add(`${c.kind}${c.tmdbId}`));
  }

  // The banner: the first few good-looking titles from the top rows.
  const heroSource = finalRows.find((r) => r.id === 'trending' || r.id === 'svc-popular' || r.id === 'genre-popular' || r.id === 'top-picks') ?? finalRows[0];
  const hero = (heroSource?.items ?? []).filter((c) => c.backdropPath && c.overview).slice(0, 6);

  const genres = opts.type === 'all' ? [...new Set([...GENRES.movie, ...GENRES.series].map((g) => g.name))].sort() : GENRES[opts.type].map((g) => g.name);
  return { type: opts.type, service: opts.service, services, hero, rows: finalRows, genres, genre: opts.genre };
}

/** The order rows appear on the page. */
function rank(id: string): number {
  const order = ['trending', 'latest', 'now-playing', 'airing', 'popular-movie', 'popular-series', 'upcoming', 'top-movie', 'top-series'];
  const i = order.indexOf(id);
  return i === -1 ? 99 : i;
}

function toCard(c: TmdbCard, st: { state: CardState; libraryId: number | null }, today: string, badge?: string | null): DiscoverCard {
  const days = c.date ? (Date.parse(today) - Date.parse(c.date)) / DAY : null;
  return {
    kind: c.kind,
    tmdbId: c.tmdbId,
    title: c.title,
    year: c.year,
    posterPath: c.posterPath,
    backdropPath: c.backdropPath,
    overview: c.overview,
    score: c.score > 0 ? Math.round(c.score * 10) / 10 : null,
    genres: c.genreIds.map((g) => genreName.get(g)).filter((g): g is string => !!g).slice(0, 3),
    state: st.state,
    libraryId: st.libraryId,
    badge: badge ?? (days === null ? null : days < 0 ? 'Coming' : days <= 30 ? 'New' : null),
  };
}

// ---------------- One title ----------------

export async function discoverTitle(deps: DiscoverDeps, user: User, kind: 'movie' | 'series', tmdbId: number): Promise<DiscoverTitle> {
  const { db, tmdb, now } = deps;
  const prefs = readPrefs(db, user.id);
  let core: { title: string; year: number | null; overview: string | null; posterPath: string | null; backdropPath: string | null };
  let extras;
  try {
    [core, extras] = await Promise.all([kind === 'movie' ? tmdb.movie(tmdbId) : tmdb.show(tmdbId), tmdb.extras(kind, tmdbId)]);
  } catch (err) {
    if (err instanceof TmdbError && err.status === 404) throw new HttpError(404, 'not_found', 'TMDB doesn’t have that title.');
    throw new HttpError(502, 'tmdb_failed', 'TMDB didn’t answer. Try again in a moment.');
  }
  if (user.role === 'kid' && !isKidSafe(kind, extras.certification)) throw new HttpError(403, 'not_for_kids', 'That one isn’t for kid profiles.');

  const today = iso(now());
  const st = titleStates(db, kind, [tmdbId], user.id, now()).get(tmdbId)!;
  const genreIds = extras.genres.map((n) => (GENRES[kind].find((g) => g.name === n)?.id)).filter((x): x is number => !!x);
  const card = toCard(
    { tmdbId, kind, title: core.title, year: core.year, posterPath: core.posterPath, backdropPath: core.backdropPath, overview: core.overview ?? '', score: 0, genreIds, date: null, popularity: 0 },
    st,
    today,
    null,
  );
  card.genres = extras.genres.slice(0, 3);
  card.score = extras.score;

  // Open requests (anyone's) decide what can still be asked for.
  const open = db.select().from(requests).where(and(eq(requests.kind, kind), eq(requests.tmdbId, tmdbId), or(eq(requests.status, 'pending'), eq(requests.status, 'approved')))).all();
  const wholeAsked = open.some((r) => r.seasons === null);
  const seasons: DiscoverTitle['seasons'] = extras.seasons.map((s) => {
    let state: CardState = 'none';
    if (st.libraryId !== null) {
      const cov = showCoverage(db, st.libraryId, [s.season], today);
      if (cov.aired > 0 && cov.have >= cov.aired) state = 'in_library';
    }
    if (state === 'none') {
      const mine = open.filter((r) => r.seasons === null || (JSON.parse(r.seasons) as number[]).includes(s.season));
      if (mine.some((r) => r.status === 'approved')) state = 'approved';
      else if (mine.length) state = 'pending';
    }
    return { ...s, state };
  });
  const dated = (k: string) => extras.releases.find((r) => r.kind === k)?.date ?? null;
  const dates = { releaseDate: extras.releaseDate, cinemaRelease: dated('Theatrical') ?? dated('Limited') ?? dated('Premiere'), digitalRelease: dated('Digital'), physicalRelease: dated('Physical') };
  const stage = kind === 'movie' ? movieStage(dates, today) : 'out';
  const home = kind === 'movie' ? movieHomeDate(dates) : null;
  const released = kind === 'movie' ? stage === 'out' : !extras.releaseDate || extras.releaseDate <= today;
  const homeText = home ? `${home.known ? '' : 'around '}${prettyDate(home.date)}` : null;
  const waitText = stage === 'cinemas' ? `It’s in cinemas now and out to stream or buy ${homeText ?? 'later'}` : `It comes out${dates.cinemaRelease ? ` in cinemas ${prettyDate(dates.cinemaRelease)}` : ` ${extras.releaseDate ? prettyDate(extras.releaseDate) : 'later'}`}${homeText ? `, and to stream or buy ${homeText}` : ''}`;
  let canRequest = true;
  let note: string | null = null;
  if (kind === 'movie') {
    if (st.state === 'in_library') ((canRequest = false), (note = 'Already in your library.'));
    else if (open.length) {
      canRequest = false;
      note = open.some((r) => r.status === 'approved')
        ? released
          ? 'Approved. Marquee is looking for it.'
          : `Approved. ${waitText}. Marquee looks for it then.`
        : 'Someone has already asked for it.';
    } else if (!released) note = `Not out to stream or buy yet. ${waitText}. You can ask now; Marquee starts looking when it’s out.`;
  } else if (seasons.length && seasons.every((s) => s.state !== 'none')) {
    canRequest = false;
    note = seasons.every((s) => s.state === 'in_library') ? 'Already in your library.' : 'Every season is here or already asked for.';
  } else if (wholeAsked) {
    canRequest = false;
    note = 'The whole show has already been asked for.';
  }

  const mine = open.find((r) => r.requestedBy === user.id) ?? db.select().from(requests).where(and(eq(requests.kind, kind), eq(requests.tmdbId, tmdbId), eq(requests.requestedBy, user.id))).orderBy(desc(requests.createdAt)).get();

  const [recs, outside] = await Promise.all([soft(tmdb.recommendations(kind, tmdbId), [] as TmdbCard[]), outsideRatings(deps.omdb, extras.imdbId)]);
  const safeRecs = (await forUser(deps, user, dedupe(recs))).filter((c) => !!c.posterPath);
  const states = titleStates(db, kind, safeRecs.map((c) => c.tmdbId), user.id, now());
  const similar: DiscoverRow | null = safeRecs.length >= 2 ? { id: 'similar', title: 'More like this', subtitle: null, items: safeRecs.slice(0, ROW_MAX).map((c) => toCard(c, states.get(c.tmdbId) ?? { state: 'none', libraryId: null }, today)) } : null;

  return {
    details: {
      releaseDate: extras.releaseDate,
      released,
      releases: extras.releases,
      originalTitle: extras.originalTitle && extras.originalTitle !== core.title ? extras.originalTitle : null,
      language: extras.language,
      status: extras.status,
      score: extras.score,
      votes: extras.votes,
      directors: extras.directors,
      writers: extras.writers,
      studios: extras.studios,
      networks: extras.networks,
      countries: extras.countries,
      budget: extras.budget,
      revenue: extras.revenue,
      homepage: extras.homepage,
      seasonCount: extras.seasonCount,
      episodeCount: extras.episodeCount,
      lastAirDate: extras.lastAirDate,
      nextAirDate: extras.nextAirDate,
      stage,
      homeRelease: home,
    },
    card,
    tagline: extras.tagline,
    runtime: extras.runtime,
    certification: extras.certification,
    genres: extras.genres,
    trailerKey: prefs.trailers ? extras.trailerKey : null,
    cast: extras.cast,
    providers: extras.providers,
    watchOn: extras.watchOn,
    ratings: { tmdb: extras.score !== null ? { score: extras.score, votes: extras.votes } : null, ...outside, imdbId: extras.imdbId },
    seasons,
    similar,
    request: mine ? requestView(db, mine, now()) : null,
    canRequest,
    note,
    collection: kind === 'movie' ? ((core as { collection?: { tmdbId: number; name: string } | null }).collection ?? null) : null,
  };
}


const NO_RATINGS: OutsideRatings = { imdb: null, rottenTomatoes: null, metacritic: null };

/** IMDb and Rotten Tomatoes scores when there's an OMDb key; a failure just leaves them out. */
async function outsideRatings(omdb: OmdbApi | null | undefined, imdbId: string | null): Promise<Omit<TitleRatings, 'tmdb' | 'imdbId'>> {
  if (!omdb || !imdbId) return NO_RATINGS;
  try {
    return await omdb.ratings(imdbId);
  } catch (err) {
    console.warn('[omdb]', (err as Error).message);
    return NO_RATINGS;
  }
}

/** An actor or director and what they've been in, each with where it stands for you. Kids see only kid-safe titles. */
export async function discoverPerson(deps: DiscoverDeps, user: User, personId: number): Promise<PersonDetail> {
  const { db, tmdb, now } = deps;
  let p;
  try {
    p = await tmdb.person(personId);
  } catch (err) {
    if (err instanceof TmdbError && err.status === 404) throw new HttpError(404, 'not_found', 'TMDB doesn’t have that person.');
    throw new HttpError(502, 'tmdb_failed', 'TMDB didn’t answer. Try again in a moment.');
  }
  const today = iso(now());
  const roles = new Map(p.credits.map((c) => [`${c.kind}${c.tmdbId}`, c.role]));
  const safe = (await forUser(deps, user, dedupe(p.credits.slice(0, 80)))).filter((c) => !!c.posterPath);
  const states = new Map<string, { state: CardState; libraryId: number | null }>();
  for (const k of ['movie', 'series'] as const) {
    for (const [id, st] of titleStates(db, k, safe.filter((c) => c.kind === k).map((c) => c.tmdbId), user.id, now())) states.set(`${k}${id}`, st);
  }
  return {
    id: p.id,
    name: p.name,
    profilePath: p.profilePath,
    biography: p.biography,
    birthday: p.birthday,
    deathday: p.deathday,
    placeOfBirth: p.placeOfBirth,
    knownFor: p.knownFor,
    credits: safe.map((c) => ({ ...toCard(c, states.get(`${c.kind}${c.tmdbId}`) ?? { state: 'none', libraryId: null }, today), role: roles.get(`${c.kind}${c.tmdbId}`) ?? null })),
  };
}

/**
 * The top 10 movies and shows on one service. With a Streaming Availability
 * key these are the service's own Top 10 (numbered on screen). Without one, or
 * for a service it has no list for, TMDB's "popular on it" stands in, shown
 * without numbers: TMDB ranks by popularity everywhere, so its list isn't the
 * service's own and repeats titles that are on several services.
 */
export async function serviceTop(deps: DiscoverDeps, user: User, serviceKey: string): Promise<ServiceTop> {
  const { db, tmdb, now } = deps;
  const service = SERVICES.find((s) => s.key === serviceKey);
  if (!service) throw new HttpError(400, 'invalid_input', 'No such service.');
  const today = iso(now());
  const finish = async (kind: 'movie' | 'series', cards: TmdbCard[]) => {
    const safe = (await forUser(deps, user, dedupe(cards))).filter((c) => !!c.posterPath).slice(0, 10);
    const states = titleStates(db, kind, safe.map((c) => c.tmdbId), user.id, now());
    return safe.map((c) => toCard(c, states.get(c.tmdbId) ?? { state: 'none', libraryId: null }, today));
  };

  let note: string | null = null;
  if (deps.top && service.top) {
    try {
      const [m, s] = await Promise.all([deps.top.top(service.top, 'movie'), deps.top.top(service.top, 'series')]);
      if (m.length || s.length) {
        const [movies, shows] = await Promise.all([finish('movie', await topCards(tmdb, 'movie', m.map((t) => t.tmdbId))), finish('series', await topCards(tmdb, 'series', s.map((t) => t.tmdbId)))]);
        return { service: serviceKey, movies, shows, ranked: true, note: null };
      }
      note = `Streaming Availability has no Top 10 for ${service.name} right now, so this is what’s popular on it.`;
    } catch (err) {
      if (!(err instanceof StreamingTopError)) throw err;
      note = err.message;
    }
  } else if (deps.top) {
    note = `${service.name} doesn’t share a Top 10, so this is what’s popular on it.`;
  } else {
    note = 'These are popular on the service, not its own Top 10. Add a Streaming Availability key in Settings → Services to see each service’s real Top 10.';
  }

  const one = async (kind: 'movie' | 'series') => finish(kind, await soft(tmdb.discover(kind, { provider: service.ids }), [] as TmdbCard[]));
  const [movies, shows] = await Promise.all([one('movie'), one('series')]);
  return { service: serviceKey, movies, shows, ranked: false, note: deps.isAdmin ? note : null };
}

/** List cards for TMDB ids, in the given order. A title TMDB can't find is left out. */
async function topCards(tmdb: TmdbApi, kind: 'movie' | 'series', ids: number[]): Promise<TmdbCard[]> {
  const cards = await mapLimit(ids, 5, async (id): Promise<TmdbCard | null> => {
    try {
      const t = kind === 'movie' ? await tmdb.movie(id) : await tmdb.show(id);
      const date = kind === 'movie' ? (t as { releaseDate: string | null }).releaseDate : null;
      const genreIds = t.genres.map((n) => GENRES[kind].find((g) => g.name === n)?.id).filter((x): x is number => !!x);
      return { tmdbId: id, kind, title: t.title, year: t.year, posterPath: t.posterPath, backdropPath: t.backdropPath, overview: t.overview ?? '', score: 0, genreIds, date: date ?? (t.year ? `${t.year}-01-01` : null), popularity: 0 };
    } catch (err) {
      if (err instanceof TmdbError && err.status === 401) throw err;
      return null;
    }
  });
  return cards.filter((c): c is TmdbCard => c !== null);
}

/**
 * Discover's search: movies and shows on TMDB matching the words, the more
 * popular first, each with where it stands for you. Kids only get titles with
 * a kid-safe US rating.
 */
export async function discoverSearch(deps: DiscoverDeps, user: User, q: string, type: 'all' | 'movie' | 'series'): Promise<DiscoverCard[]> {
  const { db, tmdb, now } = deps;
  const today = iso(now());
  const [m, s] = await Promise.all([
    type !== 'series' ? soft(tmdb.searchMovie(q), []) : Promise.resolve([]),
    type !== 'movie' ? soft(tmdb.searchShow(q), []) : Promise.resolve([]),
  ]);
  let cards: TmdbCard[] = [
    ...m.map((r) => ({ ...r, kind: 'movie' as const })),
    ...s.map((r) => ({ ...r, kind: 'series' as const })),
  ]
    .filter((r) => !!r.posterPath)
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, 24)
    .map((r) => ({ tmdbId: r.tmdbId, kind: r.kind, title: r.title, year: r.year, posterPath: r.posterPath, backdropPath: null, overview: r.overview ?? '', score: 0, genreIds: [], date: r.year ? `${r.year}-01-01` : null, popularity: r.popularity }));
  if (user.role === 'kid') {
    const checked = await mapLimit(cards, 6, async (c) => {
      try {
        const cert = c.kind === 'movie' ? (await tmdb.movie(c.tmdbId)).certification : (await tmdb.show(c.tmdbId)).certification;
        return isKidSafe(c.kind, cert) ? c : null;
      } catch {
        return null;
      }
    });
    cards = checked.filter((c): c is TmdbCard => c !== null);
  }
  const states = new Map<string, { state: CardState; libraryId: number | null }>();
  for (const k of ['movie', 'series'] as const) {
    for (const [id, st] of titleStates(db, k, cards.filter((c) => c.kind === k).map((c) => c.tmdbId), user.id, now())) states.set(`${k}${id}`, st);
  }
  // Search results have no release date beyond the year, so no New / Coming badge.
  return cards.map((c) => ({ ...toCard(c, states.get(`${c.kind}${c.tmdbId}`) ?? { state: 'none', libraryId: null }, today), badge: null }));
}
