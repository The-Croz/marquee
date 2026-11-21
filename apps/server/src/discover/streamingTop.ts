import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { tmdbCache } from '../db/schema.js';

/**
 * The streaming services' own Top 10s, from Streaming Availability (Movie of
 * the Night). TMDB only knows what's popular overall, so its "popular on
 * Netflix" is mostly the same big titles on every service; this is what each
 * service itself ranks. Optional: without a key Discover shows TMDB's popular
 * list, without numbers. Answers are kept 12 hours, so a day costs at most
 * a few dozen calls on the free plan.
 */

const HOUR = 3_600_000;
const KEEP = 12 * HOUR;

/** Where a key can come from: RapidAPI, or Movie of the Night's own developer site. */
const HOSTS = [
  { base: 'https://streaming-availability.p.rapidapi.com', header: 'X-RapidAPI-Key', host: 'streaming-availability.p.rapidapi.com' },
  { base: 'https://api.movieofthenight.com/v4', header: 'X-API-Key', host: null },
] as const;

export interface TopTitle {
  kind: 'movie' | 'series';
  tmdbId: number;
  title: string;
}

export interface StreamingTopApi {
  /** One service's Top 10 in the US, best first. `service` is Streaming Availability's id ("netflix", "hbo"…). */
  top(service: string, kind: 'movie' | 'series'): Promise<TopTitle[]>;
  /** Checks the key with one small call. */
  ping(): Promise<void>;
}

export class StreamingTopError extends Error {
  constructor(
    readonly kind: 'key' | 'limit' | 'down',
    message: string,
  ) {
    super(message);
  }
}

/** "movie/550" → 550 and "tv/1399" → 1399. */
export function parseTmdbRef(ref: unknown): { kind: 'movie' | 'series'; id: number } | null {
  if (typeof ref !== 'string') return null;
  const m = ref.match(/^(movie|tv)\/(\d+)$/);
  return m ? { kind: m[1] === 'movie' ? 'movie' : 'series', id: Number(m[2]) } : null;
}

/** The titles in a /shows/top answer, best first. Unknown shapes give nothing. */
export function readTop(body: unknown, kind: 'movie' | 'series'): TopTitle[] {
  const list = Array.isArray(body) ? body : Array.isArray((body as { shows?: unknown })?.shows) ? (body as { shows: unknown[] }).shows : [];
  const out: TopTitle[] = [];
  for (const item of list) {
    const ref = parseTmdbRef((item as { tmdbId?: unknown })?.tmdbId);
    if (!ref || ref.kind !== kind || out.some((t) => t.tmdbId === ref.id)) continue;
    out.push({ kind, tmdbId: ref.id, title: String((item as { title?: unknown }).title ?? '') });
  }
  return out.slice(0, 10);
}

export class StreamingAvailabilityClient implements StreamingTopApi {
  /** Which host this key works on, once one has answered. */
  private hostIndex: number | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly db: Db,
    private readonly now: () => number = Date.now,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(path: string): Promise<unknown> {
    const order = this.hostIndex === null ? [0, 1] : [this.hostIndex];
    let last: StreamingTopError | null = null;
    for (const i of order) {
      const h = HOSTS[i]!;
      let res: Response;
      try {
        const headers: Record<string, string> = { [h.header]: this.apiKey, accept: 'application/json' };
        if (h.host) headers['X-RapidAPI-Host'] = h.host;
        res = await this.fetchImpl(`${h.base}${path}`, { headers, signal: AbortSignal.timeout(15_000) });
      } catch {
        last = new StreamingTopError('down', 'Streaming Availability didn’t answer. Marquee tries again later.');
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        last = new StreamingTopError('key', 'Streaming Availability turned the key down. Check it in Settings → Services.');
        continue;
      }
      if (res.status === 429) throw new StreamingTopError('limit', 'Streaming Availability says the key has used up its calls for now. Marquee shows TMDB’s popular list until it can ask again.');
      if (!res.ok) throw new StreamingTopError('down', `Streaming Availability answered ${res.status}. Marquee tries again later.`);
      this.hostIndex = i;
      return res.json();
    }
    throw last ?? new StreamingTopError('down', 'Streaming Availability didn’t answer.');
  }

  async top(service: string, kind: 'movie' | 'series'): Promise<TopTitle[]> {
    const qs = new URLSearchParams({ country: 'us', service, show_type: kind === 'movie' ? 'movie' : 'series', output_language: 'en' });
    const key = `streaming-top:/shows/top?${qs}`;
    const hit = this.db.select().from(tmdbCache).where(eq(tmdbCache.key, key)).get();
    if (hit && this.now() - hit.fetchedAt < KEEP) return readTop(JSON.parse(hit.body), kind);
    try {
      const body = await this.call(`/shows/top?${qs}`);
      this.db
        .insert(tmdbCache)
        .values({ key, body: JSON.stringify(body), fetchedAt: this.now() })
        .onConflictDoUpdate({ target: tmdbCache.key, set: { body: JSON.stringify(body), fetchedAt: this.now() } })
        .run();
      return readTop(body, kind);
    } catch (err) {
      // An old list beats none while the service is down or out of calls.
      if (hit && !(err instanceof StreamingTopError && err.kind === 'key')) return readTop(JSON.parse(hit.body), kind);
      throw err;
    }
  }

  async ping(): Promise<void> {
    await this.call(`/shows/top?${new URLSearchParams({ country: 'us', service: 'netflix', show_type: 'movie' })}`);
  }
}
