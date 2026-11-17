import type { TmdbApi, TmdbEpisode, TmdbMovie, TmdbSearchResult, TmdbShow } from '../../src/library/tmdb.js';
import { TmdbError } from '../../src/library/tmdb.js';
import { normalizeTitle } from '../../src/library/parse.js';

/** A tiny TMDB with a handful of real titles, for tests. */

type M = Omit<TmdbMovie, 'originalTitle' | 'releaseDate' | 'overview' | 'backdropPath' | 'runtime' | 'genres'> & { popularity: number };
type S = Omit<TmdbShow, 'overview' | 'backdropPath' | 'network' | 'genres' | 'seasons' | 'status'> & { popularity: number; episodes: TmdbEpisode[] };

export const MOVIES: M[] = [
  { tmdbId: 603, imdbId: 'tt0133093', title: 'The Matrix', year: 1999, certification: 'R', posterPath: '/matrix.jpg', popularity: 90 },
  { tmdbId: 604, imdbId: 'tt0234215', title: 'The Matrix Reloaded', year: 2003, certification: 'R', posterPath: '/reloaded.jpg', popularity: 60 },
  { tmdbId: 693134, imdbId: 'tt15239678', title: 'Dune: Part Two', year: 2024, certification: 'PG-13', posterPath: '/dune2.jpg', popularity: 300 },
  { tmdbId: 1022789, imdbId: 'tt22022452', title: 'Inside Out 2', year: 2024, certification: 'PG', posterPath: '/io2.jpg', popularity: 250 },
  { tmdbId: 14160, imdbId: 'tt1049413', title: 'Up', year: 2009, certification: 'PG', posterPath: '/up.jpg', popularity: 80 },
  { tmdbId: 78, imdbId: 'tt0083658', title: 'Blade Runner', year: 1982, certification: 'R', posterPath: '/br.jpg', popularity: 70 },
  { tmdbId: 335984, imdbId: 'tt1856101', title: 'Blade Runner 2049', year: 2017, certification: 'R', posterPath: '/br2049.jpg', popularity: 75 },
];

export const SHOWS: S[] = [
  {
    tmdbId: 95396,
    tvdbId: 371980,
    imdbId: 'tt11280740',
    title: 'Severance',
    year: 2022,
    certification: 'TV-MA',
    posterPath: '/sev.jpg',
    popularity: 200,
    episodes: [
      { season: 1, episode: 1, title: 'Good News About Hell', airDate: '2022-02-18', overview: null },
      { season: 1, episode: 2, title: 'Half Loop', airDate: '2022-02-18', overview: null },
      { season: 2, episode: 1, title: 'Hello, Ms. Cobel', airDate: '2025-01-17', overview: null },
      { season: 2, episode: 2, title: 'Not Yet Aired', airDate: '2099-01-01', overview: null },
    ],
  },
  {
    tmdbId: 82728,
    tvdbId: 353546,
    imdbId: 'tt7678620',
    title: 'Bluey',
    year: 2018,
    certification: 'TV-Y',
    posterPath: '/bluey.jpg',
    popularity: 150,
    episodes: [
      { season: 1, episode: 1, title: 'Magic Xylophone', airDate: '2018-10-01', overview: null },
      { season: 1, episode: 2, title: 'Hospital', airDate: '2018-10-01', overview: null },
      { season: 1, episode: 3, title: 'Keepy Uppy', airDate: '2018-10-02', overview: null },
    ],
  },
];

const matches = (title: string, q: string) => normalizeTitle(title).includes(normalizeTitle(q));

export class FakeTmdb implements TmdbApi {
  calls: string[] = [];
  constructor(private readonly key = 'good-key') {}

  private check(call: string) {
    this.calls.push(call);
    if (this.key !== 'good-key') throw new TmdbError(401, 'TMDB rejected the API key.');
  }

  async ping() {
    this.check('ping');
  }
  async searchMovie(query: string, year?: number | null): Promise<TmdbSearchResult[]> {
    this.check(`searchMovie:${query}:${year ?? ''}`);
    return MOVIES.filter((m) => matches(m.title, query) && (!year || m.year === year)).map((m) => ({ tmdbId: m.tmdbId, title: m.title, year: m.year, posterPath: m.posterPath, overview: '', popularity: m.popularity }));
  }
  async searchShow(query: string, year?: number | null): Promise<TmdbSearchResult[]> {
    this.check(`searchShow:${query}:${year ?? ''}`);
    return SHOWS.filter((s) => matches(s.title, query) && (!year || s.year === year)).map((s) => ({ tmdbId: s.tmdbId, title: s.title, year: s.year, posterPath: s.posterPath, overview: '', popularity: s.popularity }));
  }
  async movie(id: number): Promise<TmdbMovie> {
    this.check(`movie:${id}`);
    const m = MOVIES.find((x) => x.tmdbId === id);
    if (!m) throw new TmdbError(404, 'not found');
    return { ...m, originalTitle: m.title, releaseDate: `${m.year}-06-01`, overview: `About ${m.title}.`, backdropPath: null, runtime: 120, genres: ['Drama'] };
  }
  async show(id: number): Promise<TmdbShow> {
    this.check(`show:${id}`);
    const s = SHOWS.find((x) => x.tmdbId === id);
    if (!s) throw new TmdbError(404, 'not found');
    const seasons = [...new Set(s.episodes.map((e) => e.season))].map((n) => ({ season: n, episodeCount: s.episodes.filter((e) => e.season === n).length }));
    return { tmdbId: s.tmdbId, tvdbId: s.tvdbId, imdbId: s.imdbId, title: s.title, year: s.year, certification: s.certification, posterPath: s.posterPath, overview: '', backdropPath: null, status: 'Returning Series', network: 'Apple TV+', genres: [], seasons };
  }
  async season(showId: number, season: number): Promise<TmdbEpisode[]> {
    this.check(`season:${showId}:${season}`);
    return SHOWS.find((x) => x.tmdbId === showId)?.episodes.filter((e) => e.season === season) ?? [];
  }
  async findShow(ext: { tvdbId?: number | null; imdbId?: string | null }): Promise<number | null> {
    this.check(`findShow:${ext.tvdbId ?? ''}:${ext.imdbId ?? ''}`);
    return SHOWS.find((s) => (ext.tvdbId && s.tvdbId === ext.tvdbId) || (ext.imdbId && s.imdbId === ext.imdbId))?.tmdbId ?? null;
  }
  async findMovie(ext: { imdbId: string }): Promise<number | null> {
    this.check(`findMovie:${ext.imdbId}`);
    return MOVIES.find((m) => m.imdbId === ext.imdbId)?.tmdbId ?? null;
  }
}
