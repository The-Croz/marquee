import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { tmdbCache } from '../db/schema.js';

/**
 * The Movie Database (TMDB) client. Read-only. Accepts either a v3 API key
 * (32 hex chars, sent as ?api_key=) or a v4 read access token (a long JWT,
 * sent as a Bearer token). Responses are cached in SQLite so rescans are fast
 * and kind to TMDB's rate limits.
 */

const API = 'https://api.themoviedb.org/3';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export interface TmdbSearchResult {
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  overview: string;
  popularity: number;
}

export interface TmdbMovie {
  tmdbId: number;
  imdbId: string | null;
  title: string;
  originalTitle: string;
  year: number | null;
  releaseDate: string | null;
  overview: string;
  posterPath: string | null;
  backdropPath: string | null;
  runtime: number | null;
  genres: string[];
  certification: string | null;
  /** ISO 639-1 code, e.g. "en", "ja". */
  originalLanguage: string | null;
  /** Studios (movies) or networks and studios (TV). */
  companies: string[];
  keywords: string[];
  /** US release dates by kind, "2026-12-20": in cinemas, out to stream or buy, on disc. */
  cinemaRelease?: string | null;
  digitalRelease?: string | null;
  physicalRelease?: string | null;
}

export interface TmdbShow {
  tmdbId: number;
  tvdbId: number | null;
  imdbId: string | null;
  title: string;
  year: number | null;
  overview: string;
  posterPath: string | null;
  backdropPath: string | null;
  status: string | null;
  network: string | null;
  genres: string[];
  certification: string | null;
  /** ISO 639-1 code, e.g. "en", "ja". */
  originalLanguage: string | null;
  /** Studios (movies) or networks and studios (TV). */
  companies: string[];
  keywords: string[];
  seasons: { season: number; episodeCount: number }[];
}

export interface TmdbEpisode {
  season: number;
  episode: number;
  title: string | null;
  airDate: string | null;
  overview: string | null;
}

/** A title in a list (trending, popular, a service's catalogue, recommendations…). No rating or runtime; those come from `extras`. */
export interface TmdbCard {
  tmdbId: number;
  kind: 'movie' | 'series';
  title: string;
  year: number | null;
  posterPath: string | null;
  backdropPath: string | null;
  overview: string;
  /** TMDB's 0–10 score. */
  score: number;
  genreIds: number[];
  /** Release date (movies) or first air date (shows). */
  date: string | null;
  popularity: number;
}

export type TmdbList = 'trending' | 'popular' | 'top_rated' | 'upcoming' | 'now_playing' | 'airing_today' | 'on_the_air';

export interface TmdbDiscoverQuery {
  genre?: number;
  /** TMDB watch-provider ids (Netflix = 8…), any of them, US flat-rate catalogue. */
  provider?: readonly number[];
  /** Movies: only those released this way (digital = out to stream or buy) between `from` and `to`. */
  releaseType?: 'digital';
  sort?: 'popularity.desc' | 'vote_average.desc' | 'date.desc';
  /** Release (or first air) date range, "2026-11-18". */
  from?: string;
  to?: string;
  page?: number;
}

export interface TmdbCastMember {
  /** TMDB person id. */
  id: number | null;
  name: string;
  character: string | null;
  profilePath: string | null;
}

/** A person (actor, director…) and what they've been in. */
export interface TmdbPerson {
  id: number;
  name: string;
  profilePath: string | null;
  biography: string | null;
  birthday: string | null;
  deathday: string | null;
  placeOfBirth: string | null;
  /** "Acting", "Directing"… */
  knownFor: string | null;
  /** Movies and shows, the more popular first, each with their part. */
  credits: (TmdbCard & { role: string | null })[];
}

/**
 * Streaming add-ons ("HBO Max Amazon Channel", "Cinemax Apple TV Channel",
 * "Netflix Standard with Ads") fold into the service's own name, and repeats go.
 */
export function cleanProviders<T extends { name: string }>(list: T[]): T[] {
  const base = (n: string) =>
    n
      .replace(/\s+(Amazon|Apple TV|Roku Premium|Prime Video)\s+Channels?$/i, '')
      .replace(/\s+(Standard|Basic|Premium|Essential)?\s*with Ads$/i, '')
      .trim();
  const out: T[] = [];
  for (const p of list) {
    const name = base(p.name);
    if (!out.some((o) => o.name.toLowerCase() === name.toLowerCase())) out.push({ ...p, name });
  }
  return out;
}

/** What a title's page needs beyond its list card. */
export interface TmdbExtras {
  /** Release date (movies) or first air date (shows), "2026-12-20". */
  releaseDate: string | null;
  /** Movies: when it came or comes out in the US, by kind. */
  releases: { kind: 'Premiere' | 'Limited' | 'Theatrical' | 'Digital' | 'Physical' | 'TV'; date: string }[];
  originalTitle: string | null;
  /** "English", "Japanese"… */
  language: string | null;
  /** TMDB's 0–10 score and how many votes it's from. */
  score: number | null;
  votes: number;
  /** Directors (movies) or creators (shows). */
  directors: string[];
  /** Writers, for movies. */
  writers: string[];
  studios: string[];
  networks: string[];
  countries: string[];
  budget: number | null;
  revenue: number | null;
  homepage: string | null;
  /** Shows: counts, last and next air dates. */
  seasonCount: number | null;
  episodeCount: number | null;
  lastAirDate: string | null;
  nextAirDate: string | null;
  tagline: string | null;
  runtime: number | null;
  certification: string | null;
  genres: string[];
  /** YouTube video key of the best trailer. */
  trailerKey: string | null;
  cast: TmdbCastMember[];
  /** Names of US services streaming it (flat rate), one per service (add-on channels folded in). */
  providers: string[];
  /** The same services with their logos. */
  watchOn: { name: string; logoPath: string | null }[];
  /** "tt1234567", for outside ratings. */
  imdbId: string | null;
  status: string | null;
  /** Shows: real seasons (not specials) with their episode count. */
  seasons: { season: number; episodeCount: number }[];
}

/** What the scanner and routes need. Tests provide a fake. */
export interface TmdbApi {
  ping(): Promise<void>;
  searchMovie(query: string, year?: number | null): Promise<TmdbSearchResult[]>;
  searchShow(query: string, year?: number | null): Promise<TmdbSearchResult[]>;
  movie(id: number): Promise<TmdbMovie>;
  show(id: number): Promise<TmdbShow>;
  season(showId: number, season: number): Promise<TmdbEpisode[]>;
  /** Looks up a show by its TheTVDB id (Sonarr's id) or an IMDb id. */
  findShow(external: { tvdbId?: number | null; imdbId?: string | null }): Promise<number | null>;
  findMovie(external: { imdbId: string }): Promise<number | null>;
  /** Discover: charts and lists. */
  list(kind: 'movie' | 'series', list: TmdbList): Promise<TmdbCard[]>;
  discover(kind: 'movie' | 'series', query: TmdbDiscoverQuery): Promise<TmdbCard[]>;
  /** "People who liked this also liked…" */
  recommendations(kind: 'movie' | 'series', id: number): Promise<TmdbCard[]>;
  extras(kind: 'movie' | 'series', id: number): Promise<TmdbExtras>;
  person(id: number): Promise<TmdbPerson>;
}

/** TMDB's genre ids, which don't change. */
export const GENRES: Record<'movie' | 'series', { id: number; name: string }[]> = {
  movie: [
    { id: 28, name: 'Action' }, { id: 12, name: 'Adventure' }, { id: 16, name: 'Animation' }, { id: 35, name: 'Comedy' }, { id: 80, name: 'Crime' },
    { id: 99, name: 'Documentary' }, { id: 18, name: 'Drama' }, { id: 10751, name: 'Family' }, { id: 14, name: 'Fantasy' }, { id: 36, name: 'History' },
    { id: 27, name: 'Horror' }, { id: 10402, name: 'Music' }, { id: 9648, name: 'Mystery' }, { id: 10749, name: 'Romance' }, { id: 878, name: 'Science Fiction' },
    { id: 53, name: 'Thriller' }, { id: 10752, name: 'War' }, { id: 37, name: 'Western' },
  ],
  series: [
    { id: 10759, name: 'Action & Adventure' }, { id: 16, name: 'Animation' }, { id: 35, name: 'Comedy' }, { id: 80, name: 'Crime' }, { id: 99, name: 'Documentary' },
    { id: 18, name: 'Drama' }, { id: 10751, name: 'Family' }, { id: 10762, name: 'Kids' }, { id: 9648, name: 'Mystery' }, { id: 10764, name: 'Reality' },
    { id: 10765, name: 'Sci-Fi & Fantasy' }, { id: 10766, name: 'Soap' }, { id: 10768, name: 'War & Politics' }, { id: 37, name: 'Western' },
  ],
};

/**
 * US streaming services Discover has a chip for. `ids` are TMDB watch-provider
 * ids: a service can have several (plans with and without ads, or an old id
 * TMDB still uses for part of the catalogue), and a title on any of them counts.
 * Paramount+ moved most titles to its Essential and Premium ids, so asking for
 * the old one alone found only a few. `top` is the service's id at Streaming
 * Availability, which has the services' own Top 10 lists; null when it has none.
 */
export const SERVICES = [
  { key: 'netflix', name: 'Netflix', ids: [8, 1796], top: 'netflix' },
  { key: 'max', name: 'HBO Max', ids: [1899, 384], top: 'hbo' },
  { key: 'disney', name: 'Disney+', ids: [337], top: 'disney' },
  { key: 'apple', name: 'Apple TV', ids: [350], top: 'apple' },
  { key: 'prime', name: 'Prime Video', ids: [9, 2100], top: 'prime' },
  { key: 'hulu', name: 'Hulu', ids: [15], top: 'hulu' },
  { key: 'paramount', name: 'Paramount+', ids: [531, 2303, 2616], top: 'paramount' },
  { key: 'peacock', name: 'Peacock', ids: [386, 387], top: null },
] as const;

export class TmdbError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const yearOf = (date: string | null | undefined) => (date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null);

export class TmdbClient implements TmdbApi {
  constructor(
    private readonly key: string,
    private readonly db: Db | null,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private get bearer(): boolean {
    return this.key.startsWith('eyJ') && this.key.length > 60;
  }

  private async get<T>(path: string, params: Record<string, string | number | undefined> = {}, ttl = 7 * DAY): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v));
    const cacheKey = `${path}?${qs.toString()}`;

    if (this.db && ttl > 0) {
      const hit = this.db.select().from(tmdbCache).where(eq(tmdbCache.key, cacheKey)).get();
      if (hit && this.now() - hit.fetchedAt < ttl) return JSON.parse(hit.body) as T;
    }

    if (!this.bearer) qs.set('api_key', this.key);
    const url = `${API}${path}?${qs.toString()}`;
    let res: Response | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      res = await this.fetchImpl(url, { headers: { Accept: 'application/json', ...(this.bearer ? { Authorization: `Bearer ${this.key}` } : {}) } });
      if (res.status !== 429) break;
      // Rate limited: wait as asked (or a moment) and try again.
      const wait = Number(res.headers.get('retry-after')) || 1 + attempt;
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
    if (!res!.ok) {
      if (res!.status === 401) throw new TmdbError(401, 'TMDB rejected the API key.');
      if (res!.status === 404) throw new TmdbError(404, `TMDB has no ${path}.`);
      throw new TmdbError(res!.status, `TMDB returned ${res!.status}.`);
    }
    const body = (await res!.json()) as T;
    if (this.db && ttl > 0) {
      this.db
        .insert(tmdbCache)
        .values({ key: cacheKey, body: JSON.stringify(body), fetchedAt: this.now() })
        .onConflictDoUpdate({ target: tmdbCache.key, set: { body: JSON.stringify(body), fetchedAt: this.now() } })
        .run();
    }
    return body;
  }

  async ping(): Promise<void> {
    await this.get('/configuration', {}, 0);
  }

  async searchMovie(query: string, year?: number | null): Promise<TmdbSearchResult[]> {
    type R = { results: { id: number; title: string; release_date?: string; poster_path: string | null; overview: string; popularity: number }[] };
    const r = await this.get<R>('/search/movie', { query, year: year ?? undefined, include_adult: 'false' }, DAY);
    return r.results.map((m) => ({ tmdbId: m.id, title: m.title, year: yearOf(m.release_date), posterPath: m.poster_path, overview: m.overview, popularity: m.popularity }));
  }

  async searchShow(query: string, year?: number | null): Promise<TmdbSearchResult[]> {
    type R = { results: { id: number; name: string; first_air_date?: string; poster_path: string | null; overview: string; popularity: number }[] };
    const r = await this.get<R>('/search/tv', { query, first_air_date_year: year ?? undefined, include_adult: 'false' }, DAY);
    return r.results.map((s) => ({ tmdbId: s.id, title: s.name, year: yearOf(s.first_air_date), posterPath: s.poster_path, overview: s.overview, popularity: s.popularity }));
  }

  async movie(id: number): Promise<TmdbMovie> {
    type R = {
      id: number;
      imdb_id: string | null;
      title: string;
      original_title: string;
      release_date?: string;
      overview: string;
      poster_path: string | null;
      backdrop_path: string | null;
      runtime: number | null;
      genres: { name: string }[];
      original_language?: string;
      production_companies?: { name: string }[];
      keywords?: { keywords?: { name: string }[] };
      release_dates?: { results: { iso_3166_1: string; release_dates: { certification: string; type: number; release_date?: string }[] }[] };
    };
    const m = await this.get<R>(`/movie/${id}`, { append_to_response: 'release_dates,keywords' });
    // The first US date of each kind (TMDB types: 2 limited, 3 theatrical, 4 digital, 5 physical).
    const first = (types: number[]) =>
      (m.release_dates?.results.find((r) => r.iso_3166_1 === 'US')?.release_dates ?? [])
        .filter((d) => types.includes(d.type) && d.release_date)
        .map((d) => d.release_date!.slice(0, 10))
        .sort()[0] ?? null;
    const us = m.release_dates?.results.find((r) => r.iso_3166_1 === 'US');
    // Prefer the theatrical (3) rating, then any non-empty one.
    const cert = us?.release_dates.find((d) => d.type === 3 && d.certification)?.certification ?? us?.release_dates.find((d) => d.certification)?.certification ?? null;
    return {
      tmdbId: m.id,
      imdbId: m.imdb_id || null,
      title: m.title,
      originalTitle: m.original_title,
      year: yearOf(m.release_date),
      releaseDate: m.release_date || null,
      cinemaRelease: first([2, 3]),
      digitalRelease: first([4]),
      physicalRelease: first([5]),
      overview: m.overview,
      posterPath: m.poster_path,
      backdropPath: m.backdrop_path,
      runtime: m.runtime || null,
      genres: m.genres.map((g) => g.name),
      certification: cert,
      originalLanguage: m.original_language || null,
      companies: (m.production_companies ?? []).map((c) => c.name),
      keywords: (m.keywords?.keywords ?? []).map((k) => k.name),
    };
  }

  async show(id: number): Promise<TmdbShow> {
    type R = {
      id: number;
      name: string;
      first_air_date?: string;
      overview: string;
      poster_path: string | null;
      backdrop_path: string | null;
      status: string | null;
      networks?: { name: string }[];
      genres: { name: string }[];
      original_language?: string;
      production_companies?: { name: string }[];
      keywords?: { results?: { name: string }[] };
      seasons: { season_number: number; episode_count: number }[];
      external_ids?: { tvdb_id: number | null; imdb_id: string | null };
      content_ratings?: { results: { iso_3166_1: string; rating: string }[] };
    };
    const s = await this.get<R>(`/tv/${id}`, { append_to_response: 'external_ids,content_ratings,keywords' }, DAY);
    return {
      tmdbId: s.id,
      tvdbId: s.external_ids?.tvdb_id ?? null,
      imdbId: s.external_ids?.imdb_id ?? null,
      title: s.name,
      year: yearOf(s.first_air_date),
      overview: s.overview,
      posterPath: s.poster_path,
      backdropPath: s.backdrop_path,
      status: s.status,
      network: s.networks?.[0]?.name ?? null,
      genres: s.genres.map((g) => g.name),
      certification: s.content_ratings?.results.find((r) => r.iso_3166_1 === 'US')?.rating || null,
      originalLanguage: s.original_language || null,
      companies: [...new Set([...(s.networks ?? []), ...(s.production_companies ?? [])].map((c) => c.name))],
      keywords: (s.keywords?.results ?? []).map((k) => k.name),
      seasons: s.seasons.map((x) => ({ season: x.season_number, episodeCount: x.episode_count })),
    };
  }

  async season(showId: number, season: number): Promise<TmdbEpisode[]> {
    type R = { episodes: { season_number: number; episode_number: number; name: string | null; air_date: string | null; overview: string | null }[] };
    const r = await this.get<R>(`/tv/${showId}/season/${season}`, {}, DAY);
    return r.episodes.map((e) => ({ season: e.season_number, episode: e.episode_number, title: e.name, airDate: e.air_date, overview: e.overview }));
  }

  async findShow(external: { tvdbId?: number | null; imdbId?: string | null }): Promise<number | null> {
    type R = { tv_results: { id: number }[] };
    if (external.tvdbId) {
      const r = await this.get<R>(`/find/${external.tvdbId}`, { external_source: 'tvdb_id' });
      if (r.tv_results[0]) return r.tv_results[0].id;
    }
    if (external.imdbId) {
      const r = await this.get<R>(`/find/${external.imdbId}`, { external_source: 'imdb_id' });
      if (r.tv_results[0]) return r.tv_results[0].id;
    }
    return null;
  }

  async findMovie(external: { imdbId: string }): Promise<number | null> {
    const r = await this.get<{ movie_results: { id: number }[] }>(`/find/${external.imdbId}`, { external_source: 'imdb_id' });
    return r.movie_results[0]?.id ?? null;
  }

  // ---------------- Discover ----------------

  private cards(kind: 'movie' | 'series', results: RawCard[]): TmdbCard[] {
    return results
      .filter((r) => (r.title ?? r.name) && !r.adult)
      .map((r) => {
        const date = (kind === 'movie' ? r.release_date : r.first_air_date) || null;
        return {
          tmdbId: r.id,
          kind,
          title: (kind === 'movie' ? r.title : r.name) ?? '',
          year: yearOf(date),
          posterPath: r.poster_path ?? null,
          backdropPath: r.backdrop_path ?? null,
          overview: r.overview ?? '',
          score: r.vote_average ?? 0,
          genreIds: r.genre_ids ?? [],
          date,
          popularity: r.popularity ?? 0,
        };
      });
  }

  async list(kind: 'movie' | 'series', list: TmdbList): Promise<TmdbCard[]> {
    const base = kind === 'movie' ? '/movie' : '/tv';
    const path = list === 'trending' ? `/trending/${kind === 'movie' ? 'movie' : 'tv'}/week` : `${base}/${list}`;
    const r = await this.get<{ results: RawCard[] }>(path, { region: 'US', language: 'en-US' }, 6 * HOUR);
    return this.cards(kind, r.results);
  }

  async discover(kind: 'movie' | 'series', q: TmdbDiscoverQuery): Promise<TmdbCard[]> {
    const dateKey = kind === 'movie' ? 'primary_release_date' : 'first_air_date';
    const sort = q.sort === 'date.desc' ? `${dateKey}.desc` : (q.sort ?? 'popularity.desc');
    const digital = kind === 'movie' && q.releaseType === 'digital';
    const r = await this.get<{ results: RawCard[] }>(
      `/discover/${kind === 'movie' ? 'movie' : 'tv'}`,
      {
        sort_by: sort,
        with_genres: q.genre,
        with_watch_providers: q.provider?.length ? q.provider.join('|') : undefined,
        watch_region: q.provider?.length ? 'US' : undefined,
        with_watch_monetization_types: q.provider?.length ? 'flatrate' : undefined,
        // A digital release date (US) instead of the first release anywhere.
        with_release_type: digital ? '4' : undefined,
        region: digital ? 'US' : undefined,
        [`${digital ? 'release_date' : dateKey}.gte`]: q.from,
        [`${digital ? 'release_date' : dateKey}.lte`]: q.to,
        // Newest-first lists are mostly obscure without a vote floor.
        'vote_count.gte': q.sort === 'vote_average.desc' ? 300 : q.sort === 'date.desc' ? 20 : undefined,
        include_adult: 'false',
        language: 'en-US',
        page: q.page,
      },
      6 * HOUR,
    );
    return this.cards(kind, r.results);
  }

  async recommendations(kind: 'movie' | 'series', id: number): Promise<TmdbCard[]> {
    const r = await this.get<{ results: RawCard[] }>(`/${kind === 'movie' ? 'movie' : 'tv'}/${id}/recommendations`, { language: 'en-US' }, DAY);
    return this.cards(kind, r.results);
  }

  async extras(kind: 'movie' | 'series', id: number): Promise<TmdbExtras> {
    type R = {
      tagline?: string;
      runtime?: number | null;
      episode_run_time?: number[];
      status?: string | null;
      genres?: { name: string }[];
      videos?: { results: { site: string; type: string; key: string; official?: boolean; iso_639_1?: string }[] };
      credits?: { cast: { id?: number; name: string; character?: string; profile_path?: string | null }[]; crew?: { name: string; job: string }[] };
      external_ids?: { imdb_id?: string | null };
      release_date?: string;
      first_air_date?: string;
      last_air_date?: string | null;
      original_title?: string;
      original_name?: string;
      original_language?: string;
      spoken_languages?: { iso_639_1: string; english_name: string }[];
      vote_average?: number;
      vote_count?: number;
      created_by?: { name: string }[];
      production_companies?: { name: string }[];
      networks?: { name: string }[];
      production_countries?: { name: string }[];
      origin_country?: string[];
      budget?: number;
      revenue?: number;
      homepage?: string;
      number_of_seasons?: number;
      number_of_episodes?: number;
      next_episode_to_air?: { air_date?: string | null } | null;
      'watch/providers'?: { results?: { US?: { flatrate?: { provider_name: string; logo_path?: string | null }[] } } };
      release_dates?: { results: { iso_3166_1: string; release_dates: { certification: string; type: number; release_date?: string }[] }[] };
      content_ratings?: { results: { iso_3166_1: string; rating: string }[] };
      seasons?: { season_number: number; episode_count: number }[];
    };
    const r = await this.get<R>(
      `/${kind === 'movie' ? 'movie' : 'tv'}/${id}`,
      { append_to_response: `videos,credits,external_ids,watch/providers,${kind === 'movie' ? 'release_dates' : 'content_ratings'}`, include_video_language: 'en,null', language: 'en-US' },
      DAY,
    );
    const trailers = (r.videos?.results ?? []).filter((v) => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'));
    const trailer = trailers.find((v) => v.type === 'Trailer' && v.official) ?? trailers.find((v) => v.type === 'Trailer') ?? trailers[0];
    const us = r.release_dates?.results.find((x) => x.iso_3166_1 === 'US');
    const cert =
      kind === 'movie'
        ? (us?.release_dates.find((d) => d.type === 3 && d.certification)?.certification ?? us?.release_dates.find((d) => d.certification)?.certification ?? null)
        : (r.content_ratings?.results.find((x) => x.iso_3166_1 === 'US')?.rating ?? null);
    const KINDS = { 1: 'Premiere', 2: 'Limited', 3: 'Theatrical', 4: 'Digital', 5: 'Physical', 6: 'TV' } as const;
    const releases: TmdbExtras['releases'] = [];
    for (const d of [...(us?.release_dates ?? [])].sort((a, b) => (a.release_date ?? '').localeCompare(b.release_date ?? ''))) {
      const kindName = KINDS[d.type as keyof typeof KINDS];
      if (kindName && d.release_date && !releases.some((x) => x.kind === kindName)) releases.push({ kind: kindName, date: d.release_date.slice(0, 10) });
    }
    const crew = r.credits?.crew ?? [];
    const lang = r.spoken_languages?.find((l) => l.iso_639_1 === r.original_language)?.english_name ?? null;
    return {
      releaseDate: (kind === 'movie' ? r.release_date : r.first_air_date) || null,
      releases,
      originalTitle: (kind === 'movie' ? r.original_title : r.original_name) || null,
      language: lang,
      score: r.vote_average ? Math.round(r.vote_average * 10) / 10 : null,
      votes: r.vote_count ?? 0,
      directors: kind === 'movie' ? [...new Set(crew.filter((c) => c.job === 'Director').map((c) => c.name))] : (r.created_by ?? []).map((c) => c.name),
      writers: kind === 'movie' ? [...new Set(crew.filter((c) => c.job === 'Screenplay' || c.job === 'Writer').map((c) => c.name))].slice(0, 4) : [],
      studios: (r.production_companies ?? []).map((c) => c.name).slice(0, 5),
      networks: (r.networks ?? []).map((c) => c.name),
      countries: (r.production_countries?.map((c) => c.name) ?? r.origin_country ?? []).slice(0, 4),
      budget: r.budget || null,
      revenue: r.revenue || null,
      homepage: r.homepage || null,
      seasonCount: r.number_of_seasons ?? null,
      episodeCount: r.number_of_episodes ?? null,
      lastAirDate: r.last_air_date ?? null,
      nextAirDate: r.next_episode_to_air?.air_date ?? null,
      tagline: r.tagline || null,
      runtime: (kind === 'movie' ? r.runtime : r.episode_run_time?.[0]) || null,
      certification: cert,
      genres: (r.genres ?? []).map((g) => g.name),
      trailerKey: trailer?.key ?? null,
      cast: (r.credits?.cast ?? []).slice(0, 20).map((c) => ({ id: c.id ?? null, name: c.name, character: c.character || null, profilePath: c.profile_path ?? null })),
      ...(() => {
        const watchOn = cleanProviders((r['watch/providers']?.results?.US?.flatrate ?? []).map((p) => ({ name: p.provider_name, logoPath: p.logo_path ?? null })));
        return { watchOn, providers: watchOn.map((p) => p.name) };
      })(),
      imdbId: r.external_ids?.imdb_id || null,
      status: r.status ?? null,
      seasons: (r.seasons ?? []).filter((x) => x.season_number > 0).map((x) => ({ season: x.season_number, episodeCount: x.episode_count })),
    };
  }

  async person(id: number): Promise<TmdbPerson> {
    type Credit = RawCard & { media_type?: string; character?: string; job?: string };
    const r = await this.get<{
      id: number;
      name: string;
      profile_path?: string | null;
      biography?: string;
      birthday?: string | null;
      deathday?: string | null;
      place_of_birth?: string | null;
      known_for_department?: string;
      combined_credits?: { cast?: Credit[]; crew?: Credit[] };
    }>(`/person/${id}`, { append_to_response: 'combined_credits', language: 'en-US' }, DAY);
    const seen = new Map<string, TmdbCard & { role: string | null }>();
    for (const c of [...(r.combined_credits?.cast ?? []), ...(r.combined_credits?.crew ?? [])]) {
      const kind = c.media_type === 'movie' ? 'movie' : c.media_type === 'tv' ? 'series' : null;
      if (!kind) continue;
      const [card] = this.cards(kind, [c]);
      if (!card) continue;
      const k = `${kind}${card.tmdbId}`;
      const role = c.character || c.job || null;
      const had = seen.get(k);
      if (had) {
        if (role && had.role && !had.role.includes(role)) had.role = `${had.role}, ${role}`;
      } else seen.set(k, { ...card, role });
    }
    return {
      id: r.id,
      name: r.name,
      profilePath: r.profile_path ?? null,
      biography: r.biography || null,
      birthday: r.birthday ?? null,
      deathday: r.deathday ?? null,
      placeOfBirth: r.place_of_birth ?? null,
      knownFor: r.known_for_department ?? null,
      credits: [...seen.values()].sort((a, b) => b.popularity - a.popularity),
    };
  }
}

type RawCard = {
  id: number;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  vote_average?: number;
  genre_ids?: number[];
  popularity?: number;
  adult?: boolean;
};
