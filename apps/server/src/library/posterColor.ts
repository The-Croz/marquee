import sharp from 'sharp';
import { and, eq, isNotNull, isNull, ne, or } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { movies, series } from '../db/schema.js';

/**
 * Each poster's main colour, picked once and saved, so screens can tint
 * glows and loading tiles to match the art. A small background job does it
 * for new titles, changed posters and (the first time) the whole library.
 */

/** Fetches an image's bytes. Null when the image doesn't exist (404). Throws when the network fails, so it's tried again later. */
export type FetchImage = (url: string) => Promise<Buffer | null>;

export const fetchImage: FetchImage = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`image server said ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

/** The smallest TMDB poster is plenty for one colour. */
export const smallPosterUrl = (path: string) => `https://image.tmdb.org/t/p/w92${path.startsWith('/') ? '' : '/'}${path}`;

/**
 * The poster's main colour as `#rrggbb`, nudged so it works as a glow on
 * Marquee's dark background: never near-black or washed-out white, and
 * never so grey it reads as no colour at all.
 */
export async function posterColor(image: Buffer): Promise<string> {
  const { dominant } = await sharp(image).resize(32, 48, { fit: 'cover' }).removeAlpha().stats();
  const [h, s, l] = toHsl(dominant.r, dominant.g, dominant.b);
  const sat = s < 0.08 ? s : Math.max(s, 0.35);
  return toHex(h, Math.min(sat, 0.85), Math.min(Math.max(l, 0.32), 0.58));
}

/**
 * Colours up to `limit` titles that have a poster with no colour yet, or
 * whose poster changed. Returns how many it coloured. Network failures stop
 * the run (it tries again next time); a missing or broken image is recorded
 * so it isn't fetched again until the poster changes.
 */
export async function colorPosters(db: Db, fetcher: FetchImage = fetchImage, limit = 200): Promise<{ colored: number; failed: number }> {
  let colored = 0;
  let failed = 0;
  for (const table of [movies, series] as const) {
    const todo = db
      .select({ id: table.id, posterPath: table.posterPath })
      .from(table)
      .where(and(isNotNull(table.posterPath), or(isNull(table.posterColorFor), ne(table.posterColorFor, table.posterPath))))
      .limit(limit - colored - failed)
      .all();
    for (const t of todo) {
      const path = t.posterPath!;
      const bytes = await fetcher(smallPosterUrl(path));
      let color: string | null = null;
      if (bytes) {
        try {
          color = await posterColor(bytes);
        } catch {
          color = null;
        }
      }
      db.update(table).set({ posterColor: color, posterColorFor: path }).where(eq(table.id, t.id)).run();
      if (color) colored++;
      else failed++;
    }
  }
  return { colored, failed };
}

function toHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function toHex(h: number, s: number, l: number): string {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
