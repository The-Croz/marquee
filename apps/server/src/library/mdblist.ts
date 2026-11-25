import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { tmdbCache } from '../db/schema.js';

/**
 * IMDb, Rotten Tomatoes and Metacritic scores, from MDBList (mdblist.com).
 * TMDB doesn't carry them, and OMDb stopped sending Rotten Tomatoes in
 * November 2026. Optional: without a key, title pages show TMDB's score only.
 * Answers are kept 3 days, so the free plan's 1,000 lookups a day go a long way.
 */

const BASE = 'https://api.mdblist.com';
const KEEP = 3 * 86_400_000;
/** An answer with no scores at all (MDBList doesn't know the title yet) is asked again sooner. */
const KEEP_EMPTY = 6 * 3_600_000;

export interface OutsideRatings {
  /** 0–10, and how many votes. */
  imdb: { score: number; votes: number } | null;
  /** Critics' Tomatometer, 0–100. */
  rottenTomatoes: number | null;
  /** 0–100. */
  metacritic: number | null;
}

export const NO_RATINGS: OutsideRatings = { imdb: null, rottenTomatoes: null, metacritic: null };
const empty = (r: OutsideRatings) => r.imdb === null && r.rottenTomatoes === null && r.metacritic === null;

export interface RatingsApi {
  ratings(kind: 'movie' | 'series', tmdbId: number): Promise<OutsideRatings>;
  /** Checks the key; says how much of today's allowance is used when MDBList tells. */
  ping(): Promise<{ used: number | null; perDay: number | null }>;
}

export class RatingsError extends Error {}

/**
 * Reads one MDBList title. Its `ratings` list has one entry per source
 * (`imdb`, `tomatoes`, `metacritic`, …) with `value` (the source's own scale:
 * IMDb 0–10, the others 0–100) and `score` (0–100). Missing or empty values give nothing.
 */
export function readMdbList(body: unknown): OutsideRatings {
  const list = ((body ?? {}) as { ratings?: unknown }).ratings;
  if (!Array.isArray(list)) return NO_RATINGS;
  const find = (source: string) => list.find((r): r is Record<string, unknown> => !!r && typeof r === 'object' && String((r as { source?: unknown }).source).toLowerCase() === source);
  const num = (v: unknown) => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const imdb = find('imdb');
  // IMDb's own score is 0–10; fall back to MDBList's 0–100 score.
  const imdbScore = num(imdb?.value) ?? (num(imdb?.score) !== null ? num(imdb?.score)! / 10 : null);
  const hundred = (r: Record<string, unknown> | undefined) => {
    const n = num(r?.value) ?? num(r?.score);
    return n === null ? null : Math.round(n);
  };
  return {
    imdb: imdbScore === null ? null : { score: Math.round(imdbScore * 10) / 10, votes: num(imdb?.votes) ?? 0 },
    rottenTomatoes: hundred(find('tomatoes')),
    metacritic: hundred(find('metacritic')),
  };
}

export class MdbListClient implements RatingsApi {
  constructor(
    private readonly apiKey: string,
    private readonly db: Db | null = null,
    private readonly now: () => number = Date.now,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** null when MDBList doesn't have the title. */
  private async get(path: string): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${BASE}${path}?${new URLSearchParams({ apikey: this.apiKey })}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new RatingsError('Couldn’t reach MDBList. It tries again next time the page opens.');
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    if (res.status === 401 || res.status === 403) throw new RatingsError('MDBList turned the key down. Check it in Settings → Services.');
    if (res.status === 429) throw new RatingsError(/daily/i.test(body?.error ?? '') ? 'MDBList’s daily limit is used up. Scores come back after midnight UTC.' : 'MDBList asked Marquee to slow down. Scores come back in a few minutes.');
    if (res.status === 404) return null;
    if (!res.ok) throw new RatingsError(`MDBList answered ${res.status}.`);
    return body;
  }

  async ratings(kind: 'movie' | 'series', tmdbId: number): Promise<OutsideRatings> {
    const type = kind === 'movie' ? 'movie' : 'show';
    const key = `mdblist:${type}:${tmdbId}`;
    const hit = this.db?.select().from(tmdbCache).where(eq(tmdbCache.key, key)).get();
    if (hit) {
      const kept = JSON.parse(hit.body) as OutsideRatings;
      if (this.now() - hit.fetchedAt < (empty(kept) ? KEEP_EMPTY : KEEP)) return kept;
    }
    const out = readMdbList(await this.get(`/tmdb/${type}/${tmdbId}`));
    this.db
      ?.insert(tmdbCache)
      .values({ key, body: JSON.stringify(out), fetchedAt: this.now() })
      .onConflictDoUpdate({ target: tmdbCache.key, set: { body: JSON.stringify(out), fetchedAt: this.now() } })
      .run();
    return out;
  }

  async ping(): Promise<{ used: number | null; perDay: number | null }> {
    const u = ((await this.get('/user')) ?? {}) as { api_requests?: unknown; api_requests_count?: unknown };
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return { used: n(u.api_requests_count), perDay: n(u.api_requests) };
  }
}
