import { eq, inArray } from 'drizzle-orm';
import type { CollectionView } from '@marquee/shared';
import type { Db } from '../db/index.js';
import { collections, mediaFiles, movies } from '../db/schema.js';
import { HttpError } from '../http.js';
import type { LibraryScanner } from './scanner.js';
import { TmdbError, type TmdbApi, type TmdbCollectionPart } from './tmdb.js';
import { setMoviesWanted } from './wanted.js';
import { isKidSafe } from '../discover/kids.js';

/**
 * Movie collections (TMDB's, like Radarr's and Seerr's): see every film in
 * one, want the whole collection in one go, and have new films in it added
 * (as Wanted) when TMDB lists them. Never removes anything.
 */

const DAY = 24 * 3_600_000;

export interface CollectionDeps {
  db: Db;
  tmdb: TmdbApi;
  scanner: LibraryScanner;
  now: () => number;
}

type Row = typeof collections.$inferSelect;

/** Fetches a collection from TMDB and keeps it (also used to refresh one). */
export async function refreshCollection(deps: Pick<CollectionDeps, 'db' | 'tmdb' | 'now'>, tmdbId: number): Promise<Row> {
  let c;
  try {
    c = await deps.tmdb.collection(tmdbId);
  } catch (err) {
    if (err instanceof TmdbError && err.status === 404) throw new HttpError(404, 'not_found', 'TMDB doesn’t have that collection.');
    throw new HttpError(502, 'tmdb_failed', 'TMDB didn’t answer. Try again in a moment.');
  }
  const values = { name: c.name, overview: c.overview, posterPath: c.posterPath, backdropPath: c.backdropPath, parts: JSON.stringify(c.parts), refreshedAt: deps.now() };
  return deps.db.insert(collections).values({ tmdbId, ...values }).onConflictDoUpdate({ target: collections.tmdbId, set: values }).returning().get();
}

/** The kept collection, fetched when it's new or more than a day old. */
export async function getCollection(deps: Pick<CollectionDeps, 'db' | 'tmdb' | 'now'>, tmdbId: number): Promise<Row> {
  const row = deps.db.select().from(collections).where(eq(collections.tmdbId, tmdbId)).get();
  if (row && deps.now() - row.refreshedAt < DAY) return row;
  try {
    return await refreshCollection(deps, tmdbId);
  } catch (err) {
    if (row) return row; // TMDB is down: show what we have.
    throw err;
  }
}

const today = (now: number) => new Date(now).toISOString().slice(0, 10);

export function collectionView(db: Db, row: Row, now: number, kid = false): CollectionView {
  const parts = JSON.parse(row.parts) as TmdbCollectionPart[];
  const ids = parts.map((p) => p.tmdbId);
  const lib = ids.length ? db.select().from(movies).where(inArray(movies.tmdbId, ids)).all() : [];
  const withFiles = new Set(
    lib.length
      ? db
          .select({ id: mediaFiles.movieId })
          .from(mediaFiles)
          .where(inArray(mediaFiles.movieId, lib.map((m) => m.id)))
          .all()
          .map((f) => f.id)
      : [],
  );
  const t = today(now);
  return {
    tmdbId: row.tmdbId,
    name: row.name,
    overview: row.overview,
    posterPath: row.posterPath,
    backdropPath: row.backdropPath,
    wanted: row.wanted,
    parts: parts
      .map((p) => {
        const m = lib.find((x) => x.tmdbId === p.tmdbId);
        return {
          tmdbId: p.tmdbId,
          title: p.title,
          year: p.year,
          posterPath: p.posterPath,
          overview: p.overview,
          libraryId: m?.id ?? null,
          have: m ? withFiles.has(m.id) : false,
          wanted: m?.monitored ?? false,
          released: !!p.releaseDate && p.releaseDate <= t,
          certification: m?.certification ?? null,
        };
      })
      // Kids see only films Marquee knows are for them.
      .filter((p) => !kid || (p.libraryId !== null && isKidSafe('movie', p.certification)))
      .map(({ certification: _c, ...p }) => p),
  };
}

/**
 * Wants the whole collection: every film not in the library is added and
 * marked Wanted, films already there but not wanted become Wanted, and (with
 * `followNew`) films TMDB adds later are added too. Returns how many changed.
 */
export async function wantCollection(deps: CollectionDeps, tmdbId: number, followNew: boolean): Promise<{ added: number; wanted: number }> {
  const row = await refreshCollection(deps, tmdbId);
  deps.db.update(collections).set({ wanted: followNew }).where(eq(collections.tmdbId, tmdbId)).run();
  return addParts(deps, row);
}

/** Stops adding new films in it. Films already added stay as they are. */
export function stopFollowing(db: Db, tmdbId: number): void {
  const found = db.update(collections).set({ wanted: false }).where(eq(collections.tmdbId, tmdbId)).run().changes;
  if (!found) throw new HttpError(404, 'not_found', 'No such collection.');
}

async function addParts(deps: CollectionDeps, row: Row): Promise<{ added: number; wanted: number }> {
  const parts = JSON.parse(row.parts) as TmdbCollectionPart[];
  let added = 0;
  let wanted = 0;
  for (const p of parts) {
    const existing = deps.db.select().from(movies).where(eq(movies.tmdbId, p.tmdbId)).get();
    let id = existing?.id;
    if (!existing) {
      try {
        id = (await deps.scanner.upsertMovie(deps.tmdb, p.tmdbId, null, deps.now())).id;
        added++;
      } catch (err) {
        console.warn(`[collections] couldn't add ${p.title}: ${(err as Error).message}`);
        continue;
      }
    }
    if (!existing?.monitored) {
      setMoviesWanted(deps.db, [id!], true);
      wanted++;
    }
  }
  return { added, wanted };
}

/** Once a day: for collections you follow, add films TMDB has listed since. */
export async function followCollections(deps: CollectionDeps): Promise<{ checked: number; added: number; problems: string[] }> {
  const out = { checked: 0, added: 0, problems: [] as string[] };
  for (const row of deps.db.select().from(collections).where(eq(collections.wanted, true)).all()) {
    out.checked++;
    try {
      const fresh = await refreshCollection(deps, row.tmdbId);
      // Only films new to the collection are added: one you removed from Marquee yourself stays removed.
      const before = new Set((JSON.parse(row.parts) as TmdbCollectionPart[]).map((p) => p.tmdbId));
      const parts = (JSON.parse(fresh.parts) as TmdbCollectionPart[]).filter((p) => !before.has(p.tmdbId));
      if (parts.length) out.added += (await addParts(deps, { ...fresh, parts: JSON.stringify(parts) })).added;
    } catch (err) {
      out.problems.push(`${row.name}: ${(err as Error).message}`);
    }
  }
  return out;
}
