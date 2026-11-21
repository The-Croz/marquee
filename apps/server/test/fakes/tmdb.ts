import type { TmdbApi, TmdbCard, TmdbDiscoverQuery, TmdbEpisode, TmdbExtras, TmdbList, TmdbMovie, TmdbSearchResult, TmdbShow } from '../../src/library/tmdb.js';
import { GENRES, SERVICES, TmdbError } from '../../src/library/tmdb.js';
import { normalizeTitle } from '../../src/library/parse.js';

/** A tiny TMDB with a handful of real titles, for tests. */

/** Facts rules look at; tests and demo mode give a few titles real ones. */
type Facts = Partial<Pick<TmdbMovie, 'genres' | 'originalLanguage' | 'companies' | 'keywords'>>;
type M = Omit<TmdbMovie, 'originalTitle' | 'releaseDate' | 'overview' | 'backdropPath' | 'runtime' | 'genres' | 'originalLanguage' | 'companies' | 'keywords'> & { popularity: number } & Facts;
type S = Omit<TmdbShow, 'overview' | 'backdropPath' | 'network' | 'genres' | 'seasons' | 'status' | 'originalLanguage' | 'companies' | 'keywords'> & { popularity: number; episodes: TmdbEpisode[] } & Facts;

export const MOVIES: M[] = [
  { tmdbId: 603, imdbId: 'tt0133093', title: 'The Matrix', year: 1999, certification: 'R', posterPath: '/matrix.jpg', popularity: 90 },
  { tmdbId: 604, imdbId: 'tt0234215', title: 'The Matrix Reloaded', year: 2003, certification: 'R', posterPath: '/reloaded.jpg', popularity: 60 },
  { tmdbId: 693134, imdbId: 'tt15239678', title: 'Dune: Part Two', year: 2024, certification: 'PG-13', posterPath: '/dune2.jpg', popularity: 300, genres: ['Science Fiction', 'Adventure'], companies: ['Legendary Pictures'], keywords: ['desert', 'based on novel or book'] },
  { tmdbId: 1022789, imdbId: 'tt22022452', title: 'Inside Out 2', year: 2024, certification: 'PG', posterPath: '/io2.jpg', popularity: 250, genres: ['Animation', 'Family', 'Comedy'], companies: ['Pixar', 'Walt Disney Pictures'], keywords: ['emotions', 'sequel'] },
  { tmdbId: 14160, imdbId: 'tt1049413', title: 'Up', year: 2009, certification: 'PG', posterPath: '/up.jpg', popularity: 80, genres: ['Animation', 'Family', 'Adventure'], companies: ['Pixar'], keywords: ['balloon', 'old man'] },
  { tmdbId: 78, imdbId: 'tt0083658', title: 'Blade Runner', year: 1982, certification: 'R', posterPath: '/br.jpg', popularity: 70 },
  { tmdbId: 335984, imdbId: 'tt1856101', title: 'Blade Runner 2049', year: 2017, certification: 'R', posterPath: '/br2049.jpg', popularity: 75 },
  { tmdbId: 402431, imdbId: 'tt10638522', title: 'Wicked', year: 2024, certification: 'PG', posterPath: '/wicked.jpg', popularity: 280, genres: ['Drama', 'Fantasy', 'Romance'] },
  { tmdbId: 558449, imdbId: 'tt9218128', title: 'Gladiator II', year: 2024, certification: 'R', posterPath: '/glad2.jpg', popularity: 270, genres: ['Action', 'Adventure'] },
  { tmdbId: 1241982, imdbId: 'tt13622970', title: 'Moana 2', year: 2024, certification: 'PG', posterPath: '/moana2.jpg', popularity: 260, genres: ['Animation', 'Family', 'Adventure'] },
  { tmdbId: 1184918, imdbId: 'tt29623480', title: 'The Wild Robot', year: 2024, certification: 'PG', posterPath: '/robot.jpg', popularity: 240, genres: ['Animation', 'Science Fiction', 'Family'] },
  { tmdbId: 1064213, imdbId: 'tt28607951', title: 'Anora', year: 2024, certification: 'R', posterPath: '/anora.jpg', popularity: 120, genres: ['Drama', 'Comedy', 'Romance'] },
  { tmdbId: 990001, imdbId: 'tt9990001', title: 'Frozen Three', year: 2027, certification: null, posterPath: '/frozen3.jpg', popularity: 190, genres: ['Animation', 'Family', 'Fantasy'] },
];

export const SHOWS: S[] = [
  {
    tmdbId: 95396,
    tvdbId: 371980,
    imdbId: 'tt11280740',
    title: 'Severance',
    year: 2022,
    certification: 'TV-MA',
    genres: ['Drama', 'Mystery', 'Sci-Fi & Fantasy'],
    companies: ['Apple TV+'],
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
    genres: ['Animation', 'Kids', 'Family'],
    companies: ['ABC Kids', 'Ludo Studio'],
    posterPath: '/bluey.jpg',
    popularity: 150,
    episodes: [
      { season: 1, episode: 1, title: 'Magic Xylophone', airDate: '2018-10-01', overview: null },
      { season: 1, episode: 2, title: 'Hospital', airDate: '2018-10-01', overview: null },
      { season: 1, episode: 3, title: 'Keepy Uppy', airDate: '2018-10-02', overview: null },
    ],
  },
];

SHOWS.push(
  { tmdbId: 136315, tvdbId: 403294, imdbId: 'tt14452776', title: 'The Bear', year: 2022, certification: 'TV-MA', genres: ['Drama', 'Comedy'], posterPath: '/bear.jpg', popularity: 180, episodes: [{ season: 1, episode: 1, title: 'System', airDate: '2022-06-23', overview: null }] },
  { tmdbId: 66732, tvdbId: 305288, imdbId: 'tt4574334', title: 'Stranger Things', year: 2016, certification: 'TV-14', genres: ['Sci-Fi & Fantasy', 'Mystery', 'Drama'], posterPath: '/st.jpg', popularity: 220, episodes: [{ season: 1, episode: 1, title: 'Chapter One', airDate: '2016-07-15', overview: null }, { season: 2, episode: 1, title: 'Chapter One', airDate: '2017-10-27', overview: null }] },
  { tmdbId: 502, tvdbId: 75560, imdbId: 'tt0063951', title: 'Sesame Street', year: 1969, certification: 'TV-Y', genres: ['Kids', 'Family'], posterPath: '/sesame.jpg', popularity: 110, episodes: [{ season: 1, episode: 1, title: 'Episode 1', airDate: '1969-11-10', overview: null }] },
);

/** What Discover's fake knows about a title beyond the above: score, backdrop, which services stream it, a recommendation or two. */
const DISC: Record<number, { score: number; providers?: string[]; recs?: number[]; date?: string; trailer?: string }> = {
  603: { score: 8.2, providers: ['max'], recs: [78, 335984], trailer: 'matrixTrailer' },
  693134: { score: 8.1, providers: ['max'], recs: [335984, 558449], trailer: 'duneTrailer' },
  1022789: { score: 7.6, providers: ['disney'], recs: [14160, 1241982, 1184918] },
  14160: { score: 8.0, providers: ['disney'], recs: [1022789, 1241982] },
  78: { score: 7.9, providers: ['prime'] },
  335984: { score: 7.5, providers: ['prime'], recs: [693134, 78] },
  402431: { score: 7.4, providers: ['peacock'], recs: [1241982, 1064213] },
  558449: { score: 6.8, providers: ['paramount'], recs: [693134] },
  1241982: { score: 7.0, providers: ['disney'], recs: [1022789, 1184918, 14160] },
  1184918: { score: 8.3, providers: ['peacock'], recs: [1022789, 14160] },
  1064213: { score: 7.1, providers: ['hulu'] },
  990001: { score: 0, providers: [], date: '2027-11-24' },
  95396: { score: 8.4, providers: ['apple'], recs: [66732, 136315], trailer: 'sevTrailer' },
  82728: { score: 8.6, providers: ['disney'], recs: [502] },
  136315: { score: 8.3, providers: ['hulu'], recs: [95396] },
  66732: { score: 8.6, providers: ['netflix'], recs: [95396] },
  502: { score: 7.5, providers: ['max'], recs: [82728] },
};

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
    return { ...m, originalTitle: m.title, releaseDate: `${m.year}-06-01`, overview: `About ${m.title}.`, backdropPath: null, runtime: 120, genres: m.genres ?? ['Drama'], originalLanguage: m.originalLanguage ?? 'en', companies: m.companies ?? [], keywords: m.keywords ?? [] };
  }
  async show(id: number): Promise<TmdbShow> {
    this.check(`show:${id}`);
    const s = SHOWS.find((x) => x.tmdbId === id);
    if (!s) throw new TmdbError(404, 'not found');
    const seasons = [...new Set(s.episodes.map((e) => e.season))].map((n) => ({ season: n, episodeCount: s.episodes.filter((e) => e.season === n).length }));
    return { tmdbId: s.tmdbId, tvdbId: s.tvdbId, imdbId: s.imdbId, title: s.title, year: s.year, certification: s.certification, posterPath: s.posterPath, overview: '', backdropPath: null, status: 'Returning Series', network: s.companies?.[0] ?? 'Apple TV+', genres: s.genres ?? [], originalLanguage: s.originalLanguage ?? 'en', companies: s.companies ?? [], keywords: s.keywords ?? [], seasons };
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

  // ---------------- Discover ----------------
  private card(kind: 'movie' | 'series', id: number): TmdbCard {
    const t = kind === 'movie' ? MOVIES.find((x) => x.tmdbId === id)! : SHOWS.find((x) => x.tmdbId === id)!;
    const d = DISC[id] ?? { score: 7 };
    const ids = (t.genres ?? ['Drama']).map((g) => GENRES[kind].find((x) => x.name === g)?.id).filter((x): x is number => !!x);
    return {
      tmdbId: id,
      kind,
      title: t.title,
      year: t.year,
      posterPath: t.posterPath,
      backdropPath: `/back${id}.jpg`,
      overview: `About ${t.title}.`,
      score: d.score,
      genreIds: ids,
      date: d.date ?? `${t.year}-06-01`,
      popularity: t.popularity,
    };
  }
  private all(kind: 'movie' | 'series'): TmdbCard[] {
    return (kind === 'movie' ? MOVIES : SHOWS).map((x) => this.card(kind, x.tmdbId));
  }
  async list(kind: 'movie' | 'series', list: TmdbList): Promise<TmdbCard[]> {
    this.check(`list:${kind}:${list}`);
    const all = this.all(kind);
    const today = '2026-11-18';
    if (list === 'top_rated') return all.sort((a, b) => b.score - a.score);
    if (list === 'upcoming') return all.filter((c) => (c.date ?? '') > today);
    if (list === 'now_playing' || list === 'airing_today' || list === 'on_the_air') return all.filter((c) => (c.date ?? '') <= today).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
    return all.filter((c) => (c.date ?? '') <= today).sort((a, b) => b.popularity - a.popularity);
  }
  async discover(kind: 'movie' | 'series', q: TmdbDiscoverQuery): Promise<TmdbCard[]> {
    this.check(`discover:${kind}:${JSON.stringify(q)}`);
    const keys = q.provider ? SERVICES.filter((x) => x.ids.some((id) => q.provider!.includes(id))).map((x) => x.key as string) : null;
    let out = this.all(kind).filter((c) => (!q.genre || c.genreIds.includes(q.genre)) && (!keys || (DISC[c.tmdbId]?.providers ?? []).some((p) => keys.includes(p))));
    if (q.from) out = out.filter((c) => (c.date ?? '') >= q.from!);
    if (q.to) out = out.filter((c) => (c.date ?? '') <= q.to!);
    const by = q.sort ?? 'popularity.desc';
    return out.sort((a, b) => (by === 'vote_average.desc' ? b.score - a.score : by === 'date.desc' ? (b.date ?? '').localeCompare(a.date ?? '') : b.popularity - a.popularity));
  }
  async recommendations(kind: 'movie' | 'series', id: number): Promise<TmdbCard[]> {
    this.check(`recommendations:${kind}:${id}`);
    const pool = new Set((kind === 'movie' ? MOVIES : SHOWS).map((x) => x.tmdbId));
    return (DISC[id]?.recs ?? []).filter((r) => pool.has(r)).map((r) => this.card(kind, r));
  }
  async extras(kind: 'movie' | 'series', id: number): Promise<TmdbExtras> {
    this.check(`extras:${kind}:${id}`);
    const t = kind === 'movie' ? MOVIES.find((x) => x.tmdbId === id) : SHOWS.find((x) => x.tmdbId === id);
    if (!t) throw new TmdbError(404, 'not found');
    const d = DISC[id];
    const seasons = kind === 'series' ? [...new Set(SHOWS.find((x) => x.tmdbId === id)!.episodes.map((e) => e.season))].filter((n) => n > 0).map((n) => ({ season: n, episodeCount: SHOWS.find((x) => x.tmdbId === id)!.episodes.filter((e) => e.season === n).length })) : [];
    const date = d?.date ?? `${t.year}-06-01`;
    return {
      releaseDate: date,
      releases: kind === 'movie' ? [{ kind: 'Theatrical', date }, { kind: 'Digital', date: `${date.slice(0, 4)}-09-01` }] : [],
      originalTitle: t.title,
      language: 'English',
      score: d?.score || null,
      votes: 1200,
      directors: ['A. Director'],
      writers: kind === 'movie' ? ['A. Writer'] : [],
      studios: (t.companies as string[] | undefined)?.slice(0, 2) ?? ['A Studio'],
      networks: kind === 'series' ? ['A Network'] : [],
      countries: ['United States of America'],
      budget: kind === 'movie' ? 100_000_000 : null,
      revenue: kind === 'movie' ? 400_000_000 : null,
      homepage: null,
      seasonCount: kind === 'series' ? seasons.length : null,
      episodeCount: kind === 'series' ? SHOWS.find((x) => x.tmdbId === id)!.episodes.length : null,
      lastAirDate: null,
      nextAirDate: null,
      tagline: null,
      runtime: kind === 'movie' ? 120 : 45,
      certification: t.certification,
      genres: t.genres ?? ['Drama'],
      trailerKey: d?.trailer ?? null,
      cast: [{ name: 'A. Actor', character: 'Lead' }],
      providers: (d?.providers ?? []).map((k) => SERVICES.find((s) => s.key === k)!.name),
      status: null,
      seasons,
    };
  }
}
