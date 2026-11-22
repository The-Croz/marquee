import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { tmdbCache } from '../db/schema.js';

/**
 * IMDb, Rotten Tomatoes and Metacritic scores, from OMDb (omdbapi.com).
 * TMDB doesn't carry them. Optional: without a key, title pages show
 * TMDB's score only. Answers are kept 3 days, so the free plan's 1,000
 * calls a day go a long way.
 */

const KEEP = 3 * 86_400_000;

export interface OutsideRatings {
  /** 0–10, and how many votes. */
  imdb: { score: number; votes: number } | null;
  /** Critics' Tomatometer, 0–100. */
  rottenTomatoes: number | null;
  /** 0–100. */
  metacritic: number | null;
}

export interface OmdbApi {
  ratings(imdbId: string): Promise<OutsideRatings>;
  ping(): Promise<void>;
}

export class OmdbError extends Error {}

/** Reads one OMDb answer. "N/A" and unknown shapes give nothing. */
export function readOmdb(body: unknown): OutsideRatings {
  const b = (body ?? {}) as { imdbRating?: string; imdbVotes?: string; Metascore?: string; Ratings?: { Source?: string; Value?: string }[] };
  const num = (v: string | undefined) => {
    const n = Number(String(v ?? '').replace(/[,%]/g, '').split('/')[0]);
    return v && v !== 'N/A' && Number.isFinite(n) ? n : null;
  };
  const imdb = num(b.imdbRating);
  const rt = b.Ratings?.find((r) => r.Source === 'Rotten Tomatoes')?.Value;
  const mc = b.Ratings?.find((r) => r.Source === 'Metacritic')?.Value ?? b.Metascore;
  return { imdb: imdb === null ? null : { score: imdb, votes: num(b.imdbVotes) ?? 0 }, rottenTomatoes: num(rt), metacritic: num(mc) };
}

export class OmdbClient implements OmdbApi {
  constructor(
    private readonly apiKey: string,
    private readonly db: Db | null = null,
    private readonly now: () => number = Date.now,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async get(params: Record<string, string>): Promise<unknown> {
    const qs = new URLSearchParams({ ...params, apikey: this.apiKey });
    let res: Response;
    try {
      res = await this.fetchImpl(`https://www.omdbapi.com/?${qs}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new OmdbError('Couldn’t reach OMDb. It tries again next time the page opens.');
    }
    const body = (await res.json().catch(() => null)) as { Response?: string; Error?: string } | null;
    if (res.status === 401 || /api key/i.test(body?.Error ?? '')) throw new OmdbError('OMDb turned the key down. Check it in Settings → Services.');
    if (/limit/i.test(body?.Error ?? '')) throw new OmdbError('OMDb’s daily limit is used up. Scores come back tomorrow.');
    if (!res.ok) throw new OmdbError(`OMDb answered ${res.status}.`);
    return body;
  }

  async ratings(imdbId: string): Promise<OutsideRatings> {
    const key = `omdb:${imdbId}`;
    const hit = this.db?.select().from(tmdbCache).where(eq(tmdbCache.key, key)).get();
    if (hit && this.now() - hit.fetchedAt < KEEP) return JSON.parse(hit.body) as OutsideRatings;
    const out = readOmdb(await this.get({ i: imdbId }));
    this.db
      ?.insert(tmdbCache)
      .values({ key, body: JSON.stringify(out), fetchedAt: this.now() })
      .onConflictDoUpdate({ target: tmdbCache.key, set: { body: JSON.stringify(out), fetchedAt: this.now() } })
      .run();
    return out;
  }

  async ping(): Promise<void> {
    await this.get({ i: 'tt0111161' });
  }
}
