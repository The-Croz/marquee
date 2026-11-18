/**
 * Read-only access to Prowlarr (API v1). Marquee lists Prowlarr's sites and
 * adds one Torznab Source per site. Nothing is ever written to Prowlarr.
 */

export interface ProwlarrSite {
  id: number;
  name: string;
  enabled: boolean;
  protocol: 'torrent' | 'usenet' | string;
  privacy: 'public' | 'private' | 'semiPrivate' | string;
  /** Prowlarr's 1–50 priority; lower is preferred. */
  priority: number;
  /** Category IDs, including subcategories. */
  categories: number[];
}

export interface ProwlarrApi {
  ping(): Promise<{ version: string }>;
  sites(): Promise<ProwlarrSite[]>;
}

export class ProwlarrError extends Error {}

export class ProwlarrClient implements ProwlarrApi {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async get<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}/api/v1${path}`, {
        headers: { 'X-Api-Key': this.apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if ((err as Error).name === 'TimeoutError') throw new ProwlarrError(`Prowlarr at ${this.baseUrl} didn't answer within 30 seconds. Check the address, and that Marquee's container can reach it.`);
      const cause = (err as { cause?: { code?: string } }).cause?.code;
      throw new ProwlarrError(`Couldn't reach Prowlarr at ${this.baseUrl}${cause ? ` (${cause})` : ''}. Check the address, and that Marquee's container can reach it.`);
    }
    if (res.status === 401) throw new ProwlarrError('Prowlarr turned down the API key. Copy it again from Prowlarr → Settings → General.');
    if (!res.ok) throw new ProwlarrError(`Prowlarr answered ${res.status}.`);
    try {
      return (await res.json()) as T;
    } catch {
      throw new ProwlarrError("That address answered, but it isn't Prowlarr.");
    }
  }

  async ping(): Promise<{ version: string }> {
    const s = await this.get<{ appName?: string; version?: string }>('/system/status');
    if (s.appName && s.appName.toLowerCase() !== 'prowlarr') throw new ProwlarrError(`That address is ${s.appName}, not Prowlarr.`);
    return { version: s.version ?? 'unknown' };
  }

  async sites(): Promise<ProwlarrSite[]> {
    type Cat = { id: number; subCategories?: Cat[] };
    type Row = { id: number; name: string; enable: boolean; protocol: string; privacy?: string; priority?: number; capabilities?: { categories?: Cat[] } };
    const rows = await this.get<Row[]>('/indexer');
    const flatten = (cats: Cat[] = []): number[] => cats.flatMap((c) => [c.id, ...flatten(c.subCategories)]);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      enabled: r.enable,
      protocol: r.protocol,
      privacy: r.privacy ?? 'public',
      priority: r.priority ?? 25,
      categories: flatten(r.capabilities?.categories),
    }));
  }
}

/** The Torznab address Prowlarr serves for one of its sites. */
export function prowlarrFeedUrl(baseUrl: string, siteId: number): string {
  return `${baseUrl.replace(/\/+$/, '')}/${siteId}/api`;
}
