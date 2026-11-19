import { eq, sql } from 'drizzle-orm';
import type { AutomationView } from '@marquee/shared';
import type { Db } from '../db/index.js';
import { movies, series } from '../db/schema.js';
import { dailyLimit, sentToday } from './wantedLimits.js';
import { lastWantedRuns, lookingForWanted } from './wanted.js';
import { lastWantedTvRuns, lookingForWantedTv } from './wantedTv.js';

/** Settings → Automatic searching: whether Marquee looks for Wanted movies and episodes by itself, and what it did lately. */
export function automationView(db: Db, now: number): AutomationView {
  const wantedMovies = db.select({ n: sql<number>`count(*)` }).from(movies).where(eq(movies.monitored, true)).get()!.n;
  const wantedShows = db.select({ n: sql<number>`count(*)` }).from(series).where(eq(series.monitored, true)).get()!.n;
  return {
    movies: { on: lookingForWanted(db), wanted: wantedMovies, runs: lastWantedRuns(db) },
    tv: { on: lookingForWantedTv(db), wanted: wantedShows, runs: lastWantedTvRuns(db) },
    dailyLimit: dailyLimit(db),
    sentToday: sentToday(db, now).length,
  };
}
