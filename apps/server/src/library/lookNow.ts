import { inArray, isNotNull, and } from 'drizzle-orm';
import { mediaFiles } from '../db/schema.js';
import { HttpError, type Deps } from '../http.js';
import { readDownloader } from '../downloads/service.js';
import { lookForWanted } from '../downloads/wanted.js';
import { lookForWantedTv } from '../downloads/wantedTv.js';
import { setMoviesWanted, setShowsWanted } from './wanted.js';

/**
 * "Look for these" on picked Library titles: they become Wanted and Marquee
 * searches for each one now (one after another, in the background), instead
 * of waiting for the next automatic run. A title without a file gets its
 * best copy; one with a file only gets a copy that beats it under its profile.
 */

const running = new Set<Promise<void>>();

/** Resolves once every "Look for these" started so far has finished (for tests). */
export async function lookNowDone(): Promise<void> {
  while (running.size) await Promise.allSettled([...running]);
}

export function lookNow(deps: Deps, kind: 'movie' | 'series', ids: number[]): { searching: number; message: string } {
  const { db, clients, sources, now } = deps;
  if (!readDownloader(db).url) throw new HttpError(409, 'no_downloader', 'Connect qBittorrent first, in Settings → Downloader, so Marquee can send what it finds.');
  if (!sources.view().sources.some((s) => s.enabled)) throw new HttpError(409, 'no_sources', 'There are no Sources to search yet. Add some in Settings → Sources.');
  if (kind === 'movie') setMoviesWanted(db, ids, true);
  else setShowsWanted(db, ids, true);
  const col = kind === 'movie' ? mediaFiles.movieId : mediaFiles.seriesId;
  const withFiles = new Set(db.selectDistinct({ id: col }).from(mediaFiles).where(and(isNotNull(col), inArray(col, ids))).all().map((r) => r.id!));
  const job = (async () => {
    for (const id of ids) {
      const w = { db, clients, sources, now, only: { id }, manual: true };
      try {
        if (kind === 'movie') await lookForWanted(w, withFiles.has(id) ? 'better' : 'missing', 1);
        else {
          await lookForWantedTv(w, 'missing');
          await lookForWantedTv(w, 'better');
        }
      } catch (err) {
        console.warn(`[look now] ${kind} ${id}: ${(err as Error).message}`);
      }
    }
  })();
  running.add(job);
  void job.finally(() => running.delete(job));
  const noun = kind === 'movie' ? (ids.length === 1 ? 'movie' : 'movies') : ids.length === 1 ? 'show' : 'shows';
  return { searching: ids.length, message: `Looking for ${ids.length} ${noun} now. Anything Marquee sends shows up in Downloads.` };
}
