import { randomBytes } from 'node:crypto';
import type { Decision, Wanted } from '../releases/decide.js';
import type { VsYours } from '../releases/upgrade.js';

/**
 * The last searches' copies, kept in memory for a while so "Download this"
 * can point at a copy by id. The download links stay on the server.
 */

export interface SearchTarget {
  kind: 'movie' | 'tv';
  movieId?: number;
  seriesId?: number;
  season?: number;
  episode?: number;
}

export interface CachedSearch {
  wanted: Wanted;
  target: SearchTarget;
  profileKey: string;
  decisions: Decision[];
  /** Same order as decisions. */
  vsYours: (VsYours | null)[];
  at: number;
}

const KEEP_MS = 60 * 60_000;
const MAX = 100;

export class CopyCache {
  private readonly items = new Map<string, CachedSearch>();
  constructor(private readonly now: () => number = Date.now) {}

  put(search: Omit<CachedSearch, 'at'>): string {
    const id = randomBytes(9).toString('base64url');
    this.items.set(id, { ...search, at: this.now() });
    for (const [k, v] of this.items) if (this.items.size > MAX || this.now() - v.at > KEEP_MS) this.items.delete(k);
    return id;
  }

  get(id: string): CachedSearch | null {
    const s = this.items.get(id);
    if (!s || this.now() - s.at > KEEP_MS) return null;
    return s;
  }
}
