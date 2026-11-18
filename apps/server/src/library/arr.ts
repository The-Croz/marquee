/**
 * Read-only access to Radarr and Sonarr (API v3). Marquee only *reads* from
 * them during the side-by-side period: their IDs make matching your existing
 * library instant and exact. Nothing is ever written back.
 */

export interface ArrTitle {
  title: string;
  year: number | null;
  path: string;
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
  monitored: boolean;
}

export interface ArrApi {
  /** Returns the app name and version, or throws. */
  ping(): Promise<{ app: string; version: string }>;
  titles(): Promise<ArrTitle[]>;
  /** How many downloads it still has on the way. */
  queueSize(): Promise<number>;
}

export class ArrError extends Error {}

export class ArrClient implements ArrApi {
  constructor(
    private readonly kind: 'radarr' | 'sonarr',
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/api/v3${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { 'X-Api-Key': this.apiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause?.code;
      throw new ArrError(`Couldn't reach ${this.name} at ${this.baseUrl}${cause ? ` (${cause})` : ''}.`);
    }
    if (res.status === 401) throw new ArrError(`${this.name} rejected the API key.`);
    if (!res.ok) throw new ArrError(`${this.name} returned ${res.status}.`);
    return (await res.json()) as T;
  }

  private get name(): string {
    return this.kind === 'radarr' ? 'Radarr' : 'Sonarr';
  }

  async ping(): Promise<{ app: string; version: string }> {
    const s = await this.get<{ appName?: string; version: string }>('/system/status');
    const app = s.appName ?? this.name;
    if (app.toLowerCase() !== this.kind) throw new ArrError(`That address is ${app}, not ${this.name}.`);
    return { app, version: s.version };
  }

  async titles(): Promise<ArrTitle[]> {
    type T = { title: string; year?: number; path: string; tmdbId?: number; tvdbId?: number; imdbId?: string; monitored: boolean };
    const rows = await this.get<T[]>(this.kind === 'radarr' ? '/movie' : '/series');
    return rows.map((r) => ({
      title: r.title,
      year: r.year || null,
      path: r.path,
      tmdbId: r.tmdbId || null,
      tvdbId: r.tvdbId || null,
      imdbId: r.imdbId || null,
      monitored: r.monitored,
    }));
  }

  async queueSize(): Promise<number> {
    const q = await this.get<{ totalRecords?: number }>('/queue?pageSize=1');
    return q.totalRecords ?? 0;
  }
}

// ---------------------------------------------------------------- Radarr history (comparison mode)

/** A copy Radarr downloaded, from its history. */
export interface RadarrGrab {
  /** Radarr's history record id. */
  id: number;
  /** Radarr's own movie id, for asking it for the copies it saw. */
  radarrMovieId: number;
  tmdbId: number | null;
  movieTitle: string;
  title: string;
  /** Unix ms. */
  date: number;
  quality: string;
  /** Radarr's custom format score for it. */
  score: number;
  size: number | null;
  indexer: string | null;
}

/** A copy from Radarr's own search for a movie, with what Radarr thought of it. */
export interface RadarrRelease {
  title: string;
  size: number | null;
  seeders: number | null;
  leechers: number | null;
  indexer: string | null;
  infoHash: string | null;
  infoUrl: string | null;
  publishedAt: number | null;
  approved: boolean;
  rejections: string[];
  score: number;
  quality: string;
  freeleech: boolean;
  /** The movie Radarr thinks it is; copies for other movies are left out. */
  mappedMovieId: number | null;
}

/** Read-only: Radarr's downloads and its own release list for a movie. */
export interface RadarrHistoryApi {
  /** How many downloads Radarr still has on the way. */
  queueSize(): Promise<number>;
  grabs(since: number): Promise<RadarrGrab[]>;
  releases(radarrMovieId: number): Promise<RadarrRelease[]>;
}

export class RadarrHistoryClient implements RadarrHistoryApi {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async get<T>(path: string, timeoutMs = 30_000): Promise<T> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/api/v3${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { 'X-Api-Key': this.apiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause?.code;
      throw new ArrError(`Couldn't reach Radarr at ${this.baseUrl}${cause ? ` (${cause})` : ''}.`);
    }
    if (res.status === 401) throw new ArrError('Radarr rejected the API key.');
    if (!res.ok) throw new ArrError(`Radarr returned ${res.status}.`);
    return (await res.json()) as T;
  }

  async queueSize(): Promise<number> {
    const q = await this.get<{ totalRecords?: number }>('/queue?pageSize=1');
    return q.totalRecords ?? 0;
  }

  async grabs(since: number): Promise<RadarrGrab[]> {
    type H = {
      id: number;
      movieId: number;
      sourceTitle: string;
      date: string;
      eventType: string;
      quality?: { quality?: { name?: string } };
      customFormatScore?: number;
      data?: Record<string, string | undefined>;
      movie?: { title?: string; tmdbId?: number };
    };
    // eventType 1 is "grabbed".
    const rows = await this.get<H[]>(`/history/since?date=${encodeURIComponent(new Date(since).toISOString())}&eventType=1&includeMovie=true`);
    return rows
      .filter((r) => r.eventType === 'grabbed')
      .map((r) => ({
        id: r.id,
        radarrMovieId: r.movieId,
        tmdbId: r.movie?.tmdbId || null,
        movieTitle: r.movie?.title ?? r.sourceTitle,
        title: r.sourceTitle,
        date: Date.parse(r.date),
        quality: r.quality?.quality?.name ?? 'Unknown',
        score: r.customFormatScore ?? 0,
        size: r.data?.size ? Number(r.data.size) || null : null,
        indexer: r.data?.indexer ?? null,
      }));
  }

  async releases(radarrMovieId: number): Promise<RadarrRelease[]> {
    type R = {
      title: string;
      size?: number;
      seeders?: number;
      leechers?: number;
      indexer?: string;
      infoHash?: string;
      infoUrl?: string;
      publishDate?: string;
      approved?: boolean;
      rejections?: string[];
      customFormatScore?: number;
      quality?: { quality?: { name?: string } };
      indexerFlags?: number;
      mappedMovieId?: number;
    };
    // Radarr searches every indexer for this, which can take a while.
    const rows = await this.get<R[]>(`/release?movieId=${radarrMovieId}`, 180_000);
    return rows.map((r) => ({
      title: r.title,
      size: r.size ?? null,
      seeders: r.seeders ?? null,
      leechers: r.leechers ?? null,
      indexer: r.indexer ?? null,
      infoHash: r.infoHash ?? null,
      infoUrl: r.infoUrl ?? null,
      publishedAt: r.publishDate ? Date.parse(r.publishDate) : null,
      approved: r.approved ?? false,
      rejections: r.rejections ?? [],
      score: r.customFormatScore ?? 0,
      quality: r.quality?.quality?.name ?? 'Unknown',
      freeleech: ((r.indexerFlags ?? 0) & 1) === 1,
      mappedMovieId: r.mappedMovieId ?? null,
    }));
  }
}
