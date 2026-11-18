import type { WantedRunView } from '@marquee/shared';
import type { Db } from '../db/index.js';
import { getSetting, setSetting } from '../db/index.js';
import type { CachedSearch } from './cache.js';
import { sendFromSearch, type SendDeps } from './send.js';

/**
 * Guard rails for the jobs that look for wanted titles by themselves:
 *
 * - **A daily limit** on copies Marquee sends on its own (10 a day unless you
 *   change it; 0 means no limit). Searches you start with Download this don't
 *   count. A limit stops the run and says so; the next run carries on.
 * - **Preview**: a run that searches as usual but sends nothing and isn't
 *   remembered, so you can see what turning it on would do.
 */

const HOUR = 3_600_000;
export const DEFAULT_DAILY_LIMIT = 10;
const LIMIT = 'wanted.daily_limit';
const LOG = 'wanted.sent_log';

export function dailyLimit(db: Db): number {
  const v = getSetting(db, LIMIT);
  return v === undefined ? DEFAULT_DAILY_LIMIT : Number(v);
}

export function setDailyLimit(db: Db, n: number): void {
  setSetting(db, LIMIT, String(n));
}

/** When Marquee sent copies by itself in the last 24 hours. */
export function sentToday(db: Db, now: number): number[] {
  return (JSON.parse(getSetting(db, LOG) || '[]') as number[]).filter((t) => now - t < 24 * HOUR);
}

/** How many more copies it may send today; Infinity with no limit. */
export function sendsLeft(db: Db, now: number): number {
  const limit = dailyLimit(db);
  return limit === 0 ? Infinity : Math.max(0, limit - sentToday(db, now).length);
}

export type WantedRun = WantedRunView;

export interface DeliverDeps extends Omit<SendDeps, 'copies'> {
  /** Look and report, but send nothing. */
  preview?: boolean;
}

/**
 * Sends the picked copy (or, in a preview, says it would). Returns the copy's
 * name, or null when today's limit is used up (and says so in the run).
 */
export async function deliver(deps: DeliverDeps, run: WantedRun, search: Omit<CachedSearch, 'at'>, pick: number): Promise<string | null> {
  const { db, now } = deps;
  const left = sendsLeft(db, now()) - (deps.preview ? run.sent.length : 0);
  if (left <= 0) {
    if (!run.capped) {
      run.capped = true;
      const limit = dailyLimit(db);
      run.problems.push(`Reached today’s limit of ${limit} ${limit === 1 ? 'copy' : 'copies'} sent by itself. It carries on when some of the last 24 hours have passed. You can change the limit in Settings → Downloader.`);
    }
    return null;
  }
  if (deps.preview) return search.decisions[pick]!.copy.title;
  const sent = await sendFromSearch(deps, search, pick, null, false);
  setSetting(db, LOG, JSON.stringify([...sentToday(db, now()), now()]));
  return sent.download.title;
}
