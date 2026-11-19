import { and, asc, eq, inArray, isNull, lte, notInArray, or, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { getSetting, setSetting } from '../db/index.js';
import { downloads, mediaFiles, movies } from '../db/schema.js';
import type { Clients } from '../http.js';
import type { SourceService } from '../sources/service.js';
import { readDownloader } from './service.js';
import { bestPick, searchTitle } from './search.js';
import { deliver } from './wantedLimits.js';

/**
 * "Marquee looks for wanted movies": once Radarr stops, Marquee does its job.
 * Every 6 hours it searches for movies you want that have no file, and once
 * a day it checks movies you have for a better copy (only sending one when
 * it beats your file under the title's profile, so "good enough" and "keep
 * looking for better" are respected). A few movies per run, longest-waiting
 * first, so Sources aren't hammered; each search counts toward their limits.
 *
 * Off until you turn it on in Settings → Automatic searching.
 */

const HOUR = 3_600_000;
export const MISSING_EVERY = 6 * HOUR;
export const BETTER_EVERY = 24 * HOUR;
/** Movies searched per run. */
export const PER_RUN = 10;

const KEY = 'movies.look_for_wanted';
const LAST = 'movies.wanted_last_run';

export type { WantedRun } from './wantedLimits.js';
import type { WantedRun } from './wantedLimits.js';

export function lookingForWanted(db: Db): boolean {
  return getSetting(db, KEY) === '1';
}

export function setLookingForWanted(db: Db, on: boolean): void {
  setSetting(db, KEY, on ? '1' : '0');
}

export function lastWantedRuns(db: Db): WantedRun[] {
  return JSON.parse(getSetting(db, LAST) || '[]') as WantedRun[];
}

export interface WantedDeps {
  db: Db;
  clients: Pick<Clients, 'qbittorrent' | 'fetchTorrent'>;
  sources: SourceService;
  now: () => number;
  /** Search as usual but send nothing and don't remember the run. */
  preview?: boolean;
  /** Only this movie or show (by library id), for an approved request. It skips the daily limit and isn't remembered. */
  only?: { id: number };
  manual?: boolean;
}

/** Movies with a download on the way or waiting to go in the library are left alone. */
function busyMovieIds(db: Db): number[] {
  return db
    .select({ id: downloads.movieId })
    .from(downloads)
    .where(and(eq(downloads.kind, 'movie'), or(inArray(downloads.state, ['sent', 'downloading']), and(eq(downloads.state, 'done'), isNull(downloads.importedAt)))))
    .all()
    .map((r) => r.id)
    .filter((id): id is number => id !== null);
}

export async function lookForWanted(deps: WantedDeps, kind: 'missing' | 'better', limit = PER_RUN): Promise<WantedRun> {
  const { db, now } = deps;
  const run: WantedRun = { at: now(), kind, searched: 0, sent: [], problems: [], ...(deps.preview ? { preview: true } : {}) };
  if (!readDownloader(db).url) {
    run.problems.push('qBittorrent isn’t connected, so nothing can be sent. Connect it in Settings → Downloader.');
    return save(deps, run);
  }
  const busy = busyMovieIds(db);
  const withFiles = db.selectDistinct({ id: mediaFiles.movieId }).from(mediaFiles).where(sql`${mediaFiles.movieId} is not null`).all().map((r) => r.id!);
  const candidates = db
    .select()
    .from(movies)
    .where(
      and(
        eq(movies.monitored, true),
        deps.only ? eq(movies.id, deps.only.id) : undefined,
        // Not out yet: nothing to find. It's picked up once its release date comes.
        or(isNull(movies.releaseDate), lte(movies.releaseDate, new Date(now()).toISOString().slice(0, 10))),
        busy.length ? notInArray(movies.id, busy) : undefined,
        kind === 'missing' ? (withFiles.length ? notInArray(movies.id, withFiles) : undefined) : withFiles.length ? inArray(movies.id, withFiles) : sql`0`,
      ),
    )
    .orderBy(sql`${movies.lastSearchedAt} is not null`, asc(movies.lastSearchedAt), asc(movies.addedAt))
    .limit(limit)
    .all();
  for (const m of candidates) {
    if (run.capped) break;
    if (!deps.preview) db.update(movies).set({ lastSearchedAt: now() }).where(eq(movies.id, m.id)).run();
    run.searched++;
    try {
      const found = await searchTitle({ db, sources: deps.sources, now }, { kind: 'movie', movieId: m.id });
      const pick = bestPick(found.search);
      if (pick === null) continue;
      const copy = await deliver({ db, now, qbittorrent: deps.clients.qbittorrent, fetchTorrent: deps.clients.fetchTorrent, ...(deps.preview ? { preview: true } : {}), ...(deps.manual ? { manual: true } : {}) }, run, found.search, pick);
      if (copy !== null) run.sent.push({ href: `/movies/${m.id}`, title: m.year ? `${m.title} (${m.year})` : m.title, copy });
    } catch (err) {
      run.problems.push(`${m.title}: ${(err as Error).message}`);
    }
  }
  return save(deps, run);
}

/** Keeps the last few runs for the checklist page. */
function save({ db, preview, manual }: { db: Db; preview?: boolean; manual?: boolean }, run: WantedRun): WantedRun {
  if (preview || manual) return run;
  setSetting(db, LAST, JSON.stringify([run, ...lastWantedRuns(db)].slice(0, 6)));
  return run;
}

/** When each kind of run last happened (0 if never). */
export const lastRunAt = (runs: WantedRun[]) => (k: WantedRun['kind']) => runs.find((r) => r.kind === k)?.at ?? 0;

/** Runs whichever search is due. Called every few minutes in the background. */
export async function wantedTick(deps: WantedDeps): Promise<WantedRun | null> {
  const { db, now } = deps;
  if (!lookingForWanted(db)) return null;
  const last = lastRunAt(lastWantedRuns(db));
  if (now() - last('missing') >= MISSING_EVERY) return lookForWanted(deps, 'missing');
  if (now() - last('better') >= BETTER_EVERY) return lookForWanted(deps, 'better');
  return null;
}
