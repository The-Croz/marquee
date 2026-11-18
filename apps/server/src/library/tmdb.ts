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
const DAY = 24 * 60 * 60 * 1000;

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
}

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
      release_dates?: { results: { iso_3166_1: string; release_dates: { certification: string; type: number }[] }[] };
    };
    const m = await this.get<R>(`/movie/${id}`, { append_to_response: 'release_dates,keywords' });
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
}
