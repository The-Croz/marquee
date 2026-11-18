import { and, eq, inArray, sql } from 'drizzle-orm';
import type { SourceSearchOutcome } from '@marquee/shared';
import type { Db } from '../db/index.js';
import { episodes, mediaFiles, movies, neverPick, series } from '../db/schema.js';
import { HttpError } from '../http.js';
import { decide, type Decision, type Wanted } from '../releases/decide.js';
import { ProfileService, type FullProfile } from '../releases/profiles.js';
import { compareToYours, judgeFile, worstFile, type YourFile } from '../releases/upgrade.js';
import type { FoundRelease, SourceService } from '../sources/service.js';
import type { SearchQuery } from '../sources/torznab.js';
import type { CachedSearch, SearchTarget } from './cache.js';

/**
 * Searches every Source for one title (a movie, a season or an episode) and
 * judges what comes back: against the title's profile, against the file you
 * already have, and against the copies you said never to pick. Used by
 * "Copies we found" and by "Try another copy".
 */

export interface TitleSearch {
  search: Omit<CachedSearch, 'at'>;
  profile: FullProfile;
  yours: YourFile | null;
  sources: SourceSearchOutcome[];
}

export interface PreparedTitle {
  wanted: Wanted;
  query: Exclude<SearchQuery, { kind: 'recent' }>;
  profile: FullProfile;
  /** Your files for this movie, season or episode. */
  files: string[];
}

/** What Marquee needs to judge copies for a title: what it is, its profile and your files. */
export function prepareTitle(db: Db, now: () => number, target: SearchTarget): PreparedTitle {
  let wanted: Wanted;
  let query: Exclude<SearchQuery, { kind: 'recent' }>;
  let profileKey: string;
  let files: string[];
  if (target.kind === 'movie') {
    const m = db.select().from(movies).where(eq(movies.id, target.movieId!)).get();
    if (!m) throw new HttpError(404, 'not_found', 'No such movie.');
    wanted = { kind: 'movie', title: m.title, year: m.year, tmdbId: m.tmdbId, imdbId: m.imdbId, runtime: m.runtime };
    query = { kind: 'movie', title: m.title, year: m.year, tmdbId: m.tmdbId, imdbId: m.imdbId };
    profileKey = m.profile;
    files = db.select({ path: mediaFiles.path }).from(mediaFiles).where(eq(mediaFiles.movieId, m.id)).all().map((f) => f.path);
  } else {
    const s = db.select().from(series).where(eq(series.id, target.seriesId!)).get();
    if (!s) throw new HttpError(404, 'not_found', 'No such show.');
    const season = target.season ?? 1;
    const episode = target.episode;
    const count = db.select({ n: sql<number>`count(*)` }).from(episodes).where(and(eq(episodes.seriesId, s.id), eq(episodes.season, season))).get()?.n ?? 0;
    // Shows don't store an episode length yet, so size limits are skipped for TV searches.
    wanted = { kind: 'tv', title: s.title, year: s.year, tmdbId: s.tmdbId, imdbId: s.imdbId, tvdbId: s.tvdbId, season, episode, runtime: null, seasonEpisodes: count || undefined };
    query = { kind: 'tv', title: s.title, tvdbId: s.tvdbId, tmdbId: s.tmdbId, imdbId: s.imdbId, season, episode };
    profileKey = s.profile;
    // Your files for that episode, or for the whole season (judged by its worst episode).
    files = db
      .select({ path: mediaFiles.path, episodes: mediaFiles.episodes })
      .from(mediaFiles)
      .where(and(inArray(mediaFiles.seriesId, [s.id]), eq(mediaFiles.season, season)))
      .all()
      .filter((f) => episode === undefined || (JSON.parse(f.episodes ?? '[]') as number[]).includes(episode))
      .map((f) => f.path);
  }
  const profile = new ProfileService(db, now).forTitle(wanted.kind, profileKey);
  return { wanted, query, profile, files };
}

/** Judges copies for a prepared title: its profile, your file and "Never pick". */
export function judgeCopies(db: Db, target: SearchTarget, prep: PreparedTitle, releases: FoundRelease[]): Pick<TitleSearch, 'search' | 'yours'> {
  const { wanted, profile, files } = prep;
  const decisions = markNeverPick(db, target, decide(wanted, releases, profile));
  const yours = worstFile(files.map((f) => judgeFile(wanted, f, profile)));
  // Only copies Marquee would take are compared with your file; the rest already say why not.
  const vsYours = decisions.map((d) => (d.accepted ? compareToYours(d, yours, profile) : null));
  return { search: { wanted, target, profileKey: profile.key, decisions, vsYours }, yours };
}

export async function searchTitle(deps: { db: Db; sources: SourceService; now: () => number }, target: SearchTarget): Promise<TitleSearch> {
  const { db, sources, now } = deps;
  const prep = prepareTitle(db, now, target);
  if (!sources.view().sources.some((s) => s.enabled)) throw new HttpError(409, 'no_sources', 'There are no Sources to search yet. Add some in Settings → Sources.');
  const outcome = await sources.search(prep.query);
  return { ...judgeCopies(db, target, prep, outcome.releases), profile: prep.profile, sources: outcome.sources };
}

/** Turns down copies you said never to pick for this title, keeping accepted copies first. */
function markNeverPick(db: Db, target: SearchTarget, decisions: Decision[]): Decision[] {
  const rows = db
    .select()
    .from(neverPick)
    .where(target.kind === 'movie' ? eq(neverPick.movieId, target.movieId!) : eq(neverPick.seriesId, target.seriesId!))
    .all();
  if (!rows.length) return decisions;
  for (const d of decisions) {
    const hash = d.copy.infoHash?.toLowerCase();
    const hit = rows.find((r) => (hash && r.infoHash === hash) || r.title.toLowerCase() === d.copy.title.toLowerCase());
    if (hit) {
      d.rejections.push({ code: 'never', message: `Never pick: ${hit.reason}` });
      d.accepted = false;
    }
  }
  return [...decisions].sort((a, b) => Number(b.accepted) - Number(a.accepted));
}

/**
 * The best copy a search found that Marquee would take and that's better than
 * your file. `packsOnly` keeps to whole-season copies.
 */
export function bestPick(search: Omit<CachedSearch, 'at'>, packsOnly = false): number | null {
  const i = search.decisions.findIndex((d, n) => d.accepted && (search.vsYours[n]?.better ?? true) && (!packsOnly || d.parsed.fullSeason));
  return i >= 0 ? i : null;
}
