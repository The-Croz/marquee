import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { schema } from '../src/db/index.js';
import { colorPosters, posterColor, type FetchImage } from '../src/library/posterColor.js';
import { makeApp } from './helpers.js';

const png = (background: string) => sharp({ create: { width: 20, height: 30, channels: 3, background } }).png().toBuffer();

describe('poster colour', () => {
  it('picks the main colour and keeps it usable on a dark screen', async () => {
    expectNear(await posterColor(await png('#c8501e')), '#c8501e');
    // Near-black lifts, near-white comes down, both keep their hue.
    const dark = await posterColor(await png('#140805'));
    const light = await posterColor(await png('#fff4ee'));
    for (const c of [dark, light]) {
      const l = (Math.max(...rgb(c)) + Math.min(...rgb(c))) / 2 / 255;
      expect(l).toBeGreaterThanOrEqual(0.31);
      expect(l).toBeLessThanOrEqual(0.59);
    }
    expect(rgb(dark)[0]).toBeGreaterThan(rgb(dark)[2]);
  });

  it('colours new and changed posters once, and leaves missing images alone', async () => {
    const { db } = makeApp();
    const movie = (title: string, tmdbId: number, posterPath: string | null) =>
      db.insert(schema.movies).values({ tmdbId, title, sortTitle: title, profile: 'cinema', addedAt: 0, refreshedAt: 0, posterPath }).returning().get();
    const dune = movie('Dune', 1, '/dune.jpg');
    const gone = movie('Gone', 2, '/gone.jpg');
    movie('No poster', 3, null);
    db.insert(schema.series).values({ tmdbId: 9, title: 'Bluey', sortTitle: 'bluey', profile: 'kids', addedAt: 0, refreshedAt: 0, posterPath: '/bluey.jpg' }).run();

    const asked: string[] = [];
    const images: Record<string, string> = { '/dune.jpg': '#c8501e', '/bluey.jpg': '#3a78c8', '/dune2.jpg': '#2a8a4a' };
    const fetcher: FetchImage = async (url) => {
      asked.push(url);
      const color = images[url.replace('https://image.tmdb.org/t/p/w92', '')];
      return color ? png(color) : null;
    };

    expect(await colorPosters(db, fetcher)).toEqual({ colored: 2, failed: 1 });
    expect(asked).toHaveLength(3);
    expect(asked[0]).toBe('https://image.tmdb.org/t/p/w92/dune.jpg');
    const get = (id: number) => db.select().from(schema.movies).all().find((m) => m.id === id)!;
    expectNear(get(dune.id).posterColor!, '#c8501e');
    expect(get(gone.id)).toMatchObject({ posterColor: null, posterColorFor: '/gone.jpg' });
    expect(db.select().from(schema.series).get()!.posterColor).toMatch(/^#[0-9a-f]{6}$/);

    // Nothing new: nothing fetched.
    asked.length = 0;
    expect(await colorPosters(db, fetcher)).toEqual({ colored: 0, failed: 0 });
    expect(asked).toEqual([]);

    // A new poster gets a new colour.
    db.update(schema.movies).set({ posterPath: '/dune2.jpg' }).run();
    db.update(schema.movies).set({ posterPath: null }).where(eq(schema.movies.id, gone.id)).run();
    await colorPosters(db, fetcher);
    expectNear(get(dune.id).posterColor!, '#2a8a4a');
  });

  it('stops when the network fails, so it tries again later', async () => {
    const { db } = makeApp();
    db.insert(schema.movies).values({ tmdbId: 1, title: 'Dune', sortTitle: 'dune', profile: 'cinema', addedAt: 0, refreshedAt: 0, posterPath: '/dune.jpg' }).run();
    await expect(colorPosters(db, async () => Promise.reject(new Error('offline')))).rejects.toThrow('offline');
    expect(db.select().from(schema.movies).get()).toMatchObject({ posterColor: null, posterColorFor: null });
  });
});

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/** sharp picks the main colour from small buckets, so allow a few shades either way. */
function expectNear(actual: string, expected: string) {
  const a = rgb(actual);
  rgb(expected).forEach((v, i) => expect(Math.abs(a[i]! - v), `${actual} vs ${expected}`).toBeLessThanOrEqual(16));
}
