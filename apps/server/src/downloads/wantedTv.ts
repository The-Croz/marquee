import { and, eq, gt, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { getSetting, setSetting } from '../db/index.js';
import { downloads, episodes, mediaFiles, series, type Episode, type Series } from '../db/schema.js';
import { normalizeTitle } from '../releases/decide.js';
import { parseRelease } from '../releases/parse.js';
import { doneUpgrading, judgeFile, worstFile } from '../releases/upgrade.js';
import type { FoundRelease } from '../sources/service.js';
import type { SearchTarget } from './cache.js';
import { bestPick, judgeCopies, prepareTitle, searchTitle } from './search.js';
import { deliver } from './wantedLimits.js';
import { readDownloader } from './service.js';
import { lastRunAt, type WantedDeps, type WantedRun } from './wanted.js';

/**
 * "Marquee looks for wanted episodes": once Sonarr stops, Marquee does its job.
 *
 * - Every 30 minutes it reads each Source's newest TV copies (older apps call
 *   this RSS) and sends any that are a missing episode of a show you watch,
 *   or better than the one you have. This is how new episodes arrive.
 * - Every 6 hours it searches for episodes that have aired but you don't
 *   have. When most of a finished season is missing it looks for the whole
 *   season in one copy first, then for single episodes.
 * - Once a day it checks finished seasons you have for a better copy of the
 *   whole season, skipping seasons already "good enough" for their profile.
 *
 * Specials (season 0) are only searched when you ask, from the show's page.
 * A few searches per run, longest-waiting first. Off until you turn it on at
 * the end of the TV switch-over checklist.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const NEW_EVERY = 30 * MINUTE;
export const MISSING_EVERY = 6 * HOUR;
export const BETTER_EVERY = 24 * HOUR;
/** Searches per run. */
export const PER_RUN = 10;

const KEY = 'tv.look_for_wanted';
const LAST = 'tv.wanted_last_run';

export function lookingForWantedTv(db: Db): boolean {
  return getSetting(db, KEY) === '1';
}

export function setLookingForWantedTv(db: Db, on: boolean): void {
  setSetting(db, KEY, on ? '1' : '0');
}

export function lastWantedTvRuns(db: Db): WantedRun[] {
  return JSON.parse(getSetting(db, LAST) || '[]') as WantedRun[];
}

function save({ db, preview, manual }: { db: Db; preview?: boolean; manual?: boolean }, run: WantedRun): WantedRun {
  if (preview || manual) return run;
  setSetting(db, LAST, JSON.stringify([run, ...lastWantedTvRuns(db)].slice(0, 8)));
  return run;
}

/** "2026-11-18" in UTC, to compare with TMDB air dates. */
export const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const aired = (e: Pick<Episode, 'airDate'>, today: string) => !!e.airDate && e.airDate <= today;
const pad = (n: number) => String(n).padStart(2, '0');
const label = (s: Series, season: number, episode?: number) => `${s.title} · S${pad(season)}${episode === undefined ? '' : `E${pad(episode)}`}`;

/** Which episodes you have, and which have a download on the way, as "series:season:episode" (or "series:season:*" for a whole season). */
class Library {
  readonly have = new Set<string>();
  readonly busy = new Set<string>();

  constructor(db: Db, seriesIds?: number[]) {
    const files = db
      .select({ seriesId: mediaFiles.seriesId, season: mediaFiles.season, episodes: mediaFiles.episodes })
      .from(mediaFiles)
      .where(seriesIds ? inArray(mediaFiles.seriesId, seriesIds) : isNotNull(mediaFiles.seriesId))
      .all();
    for (const f of files) for (const e of JSON.parse(f.episodes ?? '[]') as number[]) this.have.add(`${f.seriesId}:${f.season}:${e}`);
    const active = db
      .select()
      .from(downloads)
      .where(and(eq(downloads.kind, 'tv'), or(inArray(downloads.state, ['sent', 'downloading']), and(eq(downloads.state, 'done'), isNull(downloads.importedAt)))))
      .all();
    for (const d of active) {
      const eps = d.episodes ? (JSON.parse(d.episodes) as number[]) : ['*'];
      for (const e of eps) this.busy.add(`${d.seriesId}:${d.season}:${e}`);
    }
  }

  /** With no episode: is anything in the season on the way (a whole-season copy would clash with it)? */
  isBusy(seriesId: number, season: number, episode?: number): boolean {
    if (episode === undefined) return [...this.busy].some((k) => k.startsWith(`${seriesId}:${season}:`));
    return this.busy.has(`${seriesId}:${season}:*`) || this.busy.has(`${seriesId}:${season}:${episode}`);
  }

  /** After sending: nothing else for these episodes this run. */
  sent(t: SearchTarget): void {
    this.busy.add(`${t.seriesId}:${t.season}:${t.episode ?? '*'}`);
  }

  has(e: Pick<Episode, 'seriesId' | 'season' | 'episode'>): boolean {
    return this.have.has(`${e.seriesId}:${e.season}:${e.episode}`);
  }
}

/** One search to make: a whole season, or one episode. */
interface Unit {
  show: Series;
  season: number;
  episode?: number;
  /** The episodes it would bring, to mark as searched. */
  eps: Episode[];
  /** When it was last searched (0 = never), for longest-waiting first. */
  waited: number;
  /** Newest air date in it, to break ties. */
  airDate: string;
}

const waitedSince = (eps: Episode[]) => Math.min(...eps.map((e) => e.lastSearchedAt ?? 0));
const newestAir = (eps: Episode[]) => eps.reduce((a, e) => (e.airDate && e.airDate > a ? e.airDate : a), '');
const byWaiting = (a: Unit, b: Unit) => a.waited - b.waited || b.airDate.localeCompare(a.airDate) || a.show.id - b.show.id;

/** Monitored shows' regular seasons (no specials), grouped as "series:season". */
function watchedSeasons(db: Db, only?: number): { shows: Map<number, Series>; seasons: Map<string, Episode[]> } {
  const shows = new Map(db.select().from(series).where(and(eq(series.monitored, true), only ? eq(series.id, only) : undefined)).all().map((s) => [s.id, s]));
  const seasons = new Map<string, Episode[]>();
  if (!shows.size) return { shows, seasons };
  const rows = db.select().from(episodes).where(and(inArray(episodes.seriesId, [...shows.keys()]), gt(episodes.season, 0))).all();
  for (const e of rows) {
    const k = `${e.seriesId}:${e.season}`;
    seasons.set(k, [...(seasons.get(k) ?? []), e]);
  }
  return { shows, seasons };
}

function missingUnits(db: Db, today: string, lib: Library, only?: number): Unit[] {
  const { shows, seasons } = watchedSeasons(db, only);
  const units: Unit[] = [];
  for (const eps of seasons.values()) {
    const show = shows.get(eps[0]!.seriesId)!;
    const season = eps[0]!.season;
    const missing = eps.filter((e) => e.monitored && aired(e, today) && !lib.has(e) && !lib.isBusy(show.id, season, e.episode));
    if (!missing.length) continue;
    const finished = eps.every((e) => aired(e, today));
    // A whole-season copy would bring episodes you left out.
    const allWanted = eps.every((e) => e.monitored);
    // Most of a finished season missing: one copy of the whole season is kinder to Sources and usually better.
    if (finished && allWanted && missing.length >= 2 && missing.length * 2 >= eps.length && !lib.isBusy(show.id, season)) {
      units.push({ show, season, eps: missing, waited: waitedSince(missing), airDate: newestAir(missing) });
    } else {
      for (const e of missing) units.push({ show, season, episode: e.episode, eps: [e], waited: waitedSince([e]), airDate: e.airDate ?? '' });
    }
  }
  return units.sort(byWaiting);
}

function betterUnits(deps: WantedDeps, today: string, lib: Library): Unit[] {
  const { db, now } = deps;
  const { shows, seasons } = watchedSeasons(db, deps.only?.id);
  const units: Unit[] = [];
  for (const eps of seasons.values()) {
    const show = shows.get(eps[0]!.seriesId)!;
    const season = eps[0]!.season;
    if (!eps.every((e) => aired(e, today)) || !eps.every((e) => e.monitored) || !eps.some((e) => lib.has(e)) || lib.isBusy(show.id, season)) continue;
    // Skip seasons nothing could beat, so Sources aren't asked for nothing.
    const prep = prepareTitle(db, now, { kind: 'tv', seriesId: show.id, season });
    const yours = worstFile(prep.files.map((f) => judgeFile(prep.wanted, f, prep.profile)));
    if (yours && doneUpgrading(yours, prep.profile)) continue;
    units.push({ show, season, eps, waited: waitedSince(eps), airDate: newestAir(eps) });
  }
  return units.sort(byWaiting);
}

async function trySend(deps: WantedDeps, run: WantedRun, lib: Library, show: Series, search: Parameters<typeof deliver>[2], pick: number): Promise<void> {
  const copy = await deliver({ db: deps.db, now: deps.now, qbittorrent: deps.clients.qbittorrent, fetchTorrent: deps.clients.fetchTorrent, ...(deps.preview ? { preview: true } : {}), ...(deps.manual ? { manual: true } : {}) }, run, search, pick);
  if (copy === null) return;
  lib.sent(search.target);
  run.sent.push({ href: `/shows/${show.id}`, title: label(show, search.target.season!, search.target.episode), copy });
}

export async function lookForWantedTv(deps: WantedDeps, kind: 'missing' | 'better', limit = PER_RUN): Promise<WantedRun> {
  const { db, now } = deps;
  const run: WantedRun = { at: now(), kind, searched: 0, sent: [], problems: [], ...(deps.preview ? { preview: true } : {}) };
  if (!readDownloader(db).url) {
    run.problems.push('qBittorrent isn’t connected, so nothing can be sent. Connect it in Settings → Downloader.');
    return save(deps, run);
  }
  const today = isoDay(now());
  const lib = new Library(db);
  const queue = kind === 'missing' ? missingUnits(db, today, lib, deps.only?.id) : betterUnits(deps, today, lib);
  while (queue.length && run.searched < limit) {
    if (run.capped) break;
    const u = queue.shift()!;
    const target: SearchTarget = { kind: 'tv', seriesId: u.show.id, season: u.season, ...(u.episode !== undefined ? { episode: u.episode } : {}) };
    if (!deps.preview) db.update(episodes).set({ lastSearchedAt: now() }).where(inArray(episodes.id, u.eps.map((e) => e.id))).run();
    run.searched++;
    try {
      const found = await searchTitle({ db, sources: deps.sources, now }, target);
      const pick = bestPick(found.search, u.episode === undefined);
      if (pick !== null) {
        await trySend(deps, run, lib, u.show, found.search, pick);
      } else if (kind === 'missing' && u.episode === undefined) {
        // No copy of the whole season: look for its episodes one by one next.
        queue.unshift(...u.eps.map((e) => ({ ...u, episode: e.episode, eps: [e] })));
      }
    } catch (err) {
      run.problems.push(`${label(u.show, u.season, u.episode)}: ${(err as Error).message}`);
    }
  }
  return save(deps, run);
}

/**
 * Reads the Sources' newest TV copies and sends the ones you want: a missing
 * episode of a show you watch, or a better copy than yours. Whole seasons are
 * looked at before single episodes, so a season doesn't arrive twice, but
 * only once the season has finished airing.
 */
export async function catchNewEpisodes(deps: WantedDeps): Promise<WantedRun> {
  const { db, now } = deps;
  const run: WantedRun = { at: now(), kind: 'new', searched: 0, sent: [], problems: [], ...(deps.preview ? { preview: true } : {}) };
  if (!readDownloader(db).url) {
    run.problems.push('qBittorrent isn’t connected, so nothing can be sent. Connect it in Settings → Downloader.');
    return save(deps, run);
  }
  const shows = db.select().from(series).where(eq(series.monitored, true)).all();
  if (!shows.length) return save(deps, run);
  const outcome = await deps.sources.recent('tv');
  for (const s of outcome.sources) if (s.status === 'failed' && s.message) run.problems.push(`${s.name}: ${s.message}`);
  run.searched = outcome.releases.length;

  const byTvdb = new Map(shows.filter((s) => s.tvdbId).map((s) => [s.tvdbId!, s]));
  const byName = new Map<string, Series>();
  for (const s of shows) {
    const bare = s.title.replace(/\s*\(\d{4}\)\s*$/, '');
    byName.set(normalizeTitle(s.title), s);
    byName.set(normalizeTitle(bare), s);
    if (s.year) byName.set(`${normalizeTitle(bare)}${s.year}`, s);
  }

  // Group the copies by what they'd bring: a whole season, or an episode.
  const groups = new Map<string, { show: Series; target: SearchTarget; releases: FoundRelease[] }>();
  for (const r of outcome.releases) {
    const p = parseRelease(r.title);
    const show = (r.tvdbId && byTvdb.get(r.tvdbId)) || byName.get(normalizeTitle(p.title)) || (p.year ? byName.get(`${normalizeTitle(p.title)}${p.year}`) : undefined);
    if (!show) continue;
    const season = p.season ?? (p.seasons.length === 1 ? p.seasons[0]! : null);
    if (season === null || season === 0 || p.seasons.length > 1) continue;
    const episode = p.fullSeason ? undefined : p.episodes[0];
    if (!p.fullSeason && episode === undefined) continue;
    const key = `${show.id}:${season}:${episode ?? '*'}`;
    const g = groups.get(key) ?? { show, target: { kind: 'tv', seriesId: show.id, season, ...(episode !== undefined ? { episode } : {}) }, releases: [] };
    g.releases.push(r);
    groups.set(key, g);
  }
  if (!groups.size) return save(deps, run);

  const lib = new Library(db, [...new Set([...groups.values()].map((g) => g.show.id))]);
  const today = isoDay(now());
  const known = new Set<string>();
  /** Episodes you left out, and seasons with any left out (no whole-season copy for those). */
  const skipped = new Set<string>();
  const partial = new Set<string>();
  /** Seasons still airing: a whole-season copy of one would be partial, and would hold up the episodes still to come. */
  const airing = new Set<string>();
  for (const e of db.select().from(episodes).where(inArray(episodes.seriesId, [...new Set([...groups.values()].map((g) => g.show.id))])).all()) {
    known.add(`${e.seriesId}:${e.season}:${e.episode}`);
    if (!e.monitored) {
      skipped.add(`${e.seriesId}:${e.season}:${e.episode}`);
      partial.add(`${e.seriesId}:${e.season}`);
    }
    if (!aired(e, today)) airing.add(`${e.seriesId}:${e.season}`);
  }
  const ordered = [...groups.values()].sort((a, b) => Number(a.target.episode !== undefined) - Number(b.target.episode !== undefined));
  for (const g of ordered) {
    const { show, target } = g;
    if (lib.isBusy(show.id, target.season!, target.episode)) continue;
    // Only episodes TMDB knows about, so a mislabeled copy can't invent one.
    if (target.episode !== undefined && !known.has(`${show.id}:${target.season}:${target.episode}`)) continue;
    if (target.episode === undefined && airing.has(`${show.id}:${target.season}`)) continue;
    if (target.episode !== undefined ? skipped.has(`${show.id}:${target.season}:${target.episode}`) : partial.has(`${show.id}:${target.season}`)) continue;
    if (run.capped) break;
    try {
      const judged = judgeCopies(db, target, prepareTitle(db, now, target), g.releases);
      const pick = bestPick(judged.search, target.episode === undefined);
      if (pick !== null) await trySend(deps, run, lib, show, judged.search, pick);
    } catch (err) {
      run.problems.push(`${label(show, target.season!, target.episode)}: ${(err as Error).message}`);
    }
  }
  return save(deps, run);
}

/** Runs whichever TV job is due: new episodes first, then missing ones, then better copies. */
export async function wantedTvTick(deps: WantedDeps): Promise<WantedRun | null> {
  const { db, now } = deps;
  if (!lookingForWantedTv(db)) return null;
  const last = lastRunAt(lastWantedTvRuns(db));
  if (now() - last('new') >= NEW_EVERY) return catchNewEpisodes(deps);
  if (now() - last('missing') >= MISSING_EVERY) return lookForWantedTv(deps, 'missing');
  if (now() - last('better') >= BETTER_EVERY) return lookForWantedTv(deps, 'better');
  return null;
}
