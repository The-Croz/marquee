import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { episodes, movies, series } from '../db/schema.js';
import { HttpError } from '../http.js';

/**
 * Wanted / not wanted. Marquee only goes looking for titles you've said you
 * want, and nothing starts out wanted. A show is wanted as a whole, with any
 * season or episode left out one by one.
 */

export function setMoviesWanted(db: Db, ids: number[], wanted: boolean): number {
  if (!ids.length) return 0;
  return db.update(movies).set({ monitored: wanted }).where(inArray(movies.id, ids)).run().changes;
}

/** Wanting a whole show wants every episode; not wanting it leaves its episodes as they are. */
export function setShowsWanted(db: Db, ids: number[], wanted: boolean): number {
  if (!ids.length) return 0;
  const changed = db.update(series).set({ monitored: wanted }).where(inArray(series.id, ids)).run().changes;
  if (wanted) db.update(episodes).set({ monitored: true }).where(inArray(episodes.seriesId, ids)).run();
  return changed;
}

/** Wanting a season or episode of a show you didn't want turns the show on, so the choice has an effect. */
export function setSeasonWanted(db: Db, seriesId: number, season: number, wanted: boolean): void {
  const found = db.update(episodes).set({ monitored: wanted }).where(and(eq(episodes.seriesId, seriesId), eq(episodes.season, season))).run().changes;
  if (!found) throw new HttpError(404, 'no_such_season', 'That season isn’t in this show.');
  if (wanted) db.update(series).set({ monitored: true }).where(eq(series.id, seriesId)).run();
}

export function setEpisodeWanted(db: Db, seriesId: number, season: number, episode: number, wanted: boolean): void {
  const found = db
    .update(episodes)
    .set({ monitored: wanted })
    .where(and(eq(episodes.seriesId, seriesId), eq(episodes.season, season), eq(episodes.episode, episode)))
    .run().changes;
  if (!found) throw new HttpError(404, 'no_such_episode', 'That episode isn’t in this show.');
  if (wanted) db.update(series).set({ monitored: true }).where(eq(series.id, seriesId)).run();
}
