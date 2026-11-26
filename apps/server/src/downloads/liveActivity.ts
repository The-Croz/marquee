import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { downloads, liveActivities } from '../db/schema.js';
import type { ApnsClient } from '../notify/apns.js';
import { isGone } from '../notify/apns.js';
import { describeDownload } from './view.js';

/** A Live Activity ends after this long, whatever happens. */
export const LIVE_ACTIVITY_MAX = 8 * 60 * 60 * 1000;
/** It is updated when the percent moves by this much, or the state changes. */
export const LIVE_STEP = 5;

interface Deps {
  db: Db;
  apns: ApnsClient | null;
  now: () => number;
}

/** What the Lock Screen card shows. Plain words, from the same place the Downloads page gets them. */
function contentState(db: Db, row: typeof downloads.$inferSelect, now: number) {
  const d = describeDownload(db, row, now);
  return { progress: Math.max(0, Math.min(1, row.progress)), status: d.status.label, eta: row.eta ?? null, done: Boolean(row.importedAt) };
}

/**
 * Keeps the Live Activities on people's phones up to date. Called after each look at qBittorrent:
 * pushes an update when the percent moved by 5 (or the state changed) and ends the activity when the
 * download is in the library, failed, removed, or 8 hours old. Phones Apple says are gone are forgotten.
 */
export async function updateLiveActivities({ db, apns, now }: Deps): Promise<void> {
  if (!apns?.ready) return;
  for (const live of db.select().from(liveActivities).all()) {
    const row = db.select().from(downloads).where(eq(downloads.id, live.downloadId)).get();
    const t = now();
    const finished = !row || row.state === 'removed' || row.state === 'failed' || Boolean(row.importedAt);
    const old = t - live.startedAt > LIVE_ACTIVITY_MAX;
    const percent = row ? Math.floor(row.progress * 100) : live.lastPercent;
    const state = row ? `${row.state}|${row.importedAt ? 'in' : ''}` : 'gone';
    if (!finished && !old && Math.abs(percent - live.lastPercent) < LIVE_STEP && state === live.lastState) continue;
    const end = finished || old;
    try {
      const answer = await apns.send({
        token: live.token,
        environment: live.environment,
        pushType: 'liveactivity',
        topicSuffix: '.push-type.liveactivity',
        priority: end ? 10 : 5,
        payload: {
          aps: {
            timestamp: Math.floor(t / 1000),
            event: end ? 'end' : 'update',
            'content-state': row ? contentState(db, row, t) : { progress: live.lastPercent / 100, status: 'Removed', eta: null, done: false },
            ...(end ? { 'dismissal-date': Math.floor(t / 1000) + 5 * 60 } : {}),
          },
        },
      });
      if (isGone(answer) || end) db.delete(liveActivities).where(eq(liveActivities.id, live.id)).run();
      else if (answer.status === 200) db.update(liveActivities).set({ lastPercent: percent, lastState: state }).where(eq(liveActivities.id, live.id)).run();
    } catch (err) {
      console.warn(`[live activity] couldn't update: ${(err as Error).message}`);
    }
  }
}
