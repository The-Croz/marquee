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
