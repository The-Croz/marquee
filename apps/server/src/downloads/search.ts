import { and, eq, inArray, sql } from 'drizzle-orm';
import type { SourceSearchOutcome } from '@marquee/shared';
import type { Db } from '../db/index.js';
import { episodes, mediaFiles, movies, neverPick, series } from '../db/schema.js';
import { HttpError } from '../http.js';
import { OFF_TARGET, decide, type Decision, type RejectionCode, type Wanted } from '../releases/decide.js';
import { ProfileService, type FullProfile } from '../releases/profiles.js';
import { compareToYours, judgeFile, worstFile, type YourFile } from '../releases/upgrade.js';
import { readDownloader } from './service.js';
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
  wanted.minSeeders = readDownloader(db).minSeeders;
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

/**
 * What each title's recent searches brought back (the copies, not the
 * judgement), per database, so "Try another copy" soon after can pick the
 * next best without asking every Source again. Judged afresh each time, so
 * Never pick, the profile and your file are always current.
 */
const recent = new WeakMap<Db, Map<string, { at: number; releases: FoundRelease[]; sources: SourceSearchOutcome[] }>>();
const KEEP_RECENT = 200;
const targetKey = (t: SearchTarget) => (t.kind === 'movie' ? `m:${t.movieId}` : `t:${t.seriesId}:${t.season ?? ''}:${t.episode ?? ''}`);

function remember(db: Db, target: SearchTarget, at: number, releases: FoundRelease[], sources: SourceSearchOutcome[]): void {
  let m = recent.get(db);
  if (!m) recent.set(db, (m = new Map()));
  m.delete(targetKey(target));
  m.set(targetKey(target), { at, releases, sources });
  while (m.size > KEEP_RECENT) m.delete(m.keys().next().value!);
}

export async function searchTitle(
  deps: { db: Db; sources: SourceService; now: () => number },
  target: SearchTarget,
  /** Use copies a search for the same title brought back this recently (ms), instead of searching again. */
  opts: { reuseWithinMs?: number } = {},
): Promise<TitleSearch & { reused?: boolean }> {
  const { db, sources, now } = deps;
  const prep = prepareTitle(db, now, target);
  const earlier = opts.reuseWithinMs ? recent.get(db)?.get(targetKey(target)) : undefined;
  if (earlier && now() - earlier.at <= opts.reuseWithinMs!) {
    return { ...judgeCopies(db, target, prep, earlier.releases), profile: prep.profile, sources: earlier.sources, reused: true };
  }
  if (!sources.view().sources.some((s) => s.enabled)) throw new HttpError(409, 'no_sources', 'There are no Sources to search yet. Add some in Settings → Sources.');
  const outcome = await sources.search(prep.query);
  if (outcome.sources.some((s) => s.status === 'searched')) remember(db, target, now(), outcome.releases, outcome.sources);
  const judged = judgeCopies(db, target, prep, outcome.releases);
  // A search where every Source failed found nothing out there; it says nothing about the copies.
  if (outcome.sources.some((s) => s.status === 'searched')) saveSearchNote(db, target, searchNote(judged.search, prep.profile.name, now()));
  return { ...judged, profile: prep.profile, sources: outcome.sources };
}

/** What a title's last search found, kept on the title so its request can say why nothing was picked. */
export interface SearchNote {
  at: number;
  /** "Season 2" or "S02E03" for shows; null for movies. */
  what: string | null;
  profile: string;
  /** Copies of this title (not of others). */
  found: number;
  /** Of those, how many Marquee would take. */
  taken: number;
  /** Why the rest were turned down, most common first: [reason, how many]. */
  reasons: [string, number][];
}

const WHY: Partial<Record<RejectionCode, string>> = {
  quality: 'not a quality it takes',
  too_small: 'too small',
  too_big: 'too big',
  no_seeders: 'too few people sharing them',
  never: 'on Never pick',
  low_score: 'not enough points',
  sample: 'samples',
};

export function searchNote(search: Omit<CachedSearch, 'at'>, profile: string, at: number): SearchNote {
  const t = search.target;
  const what = t.kind === 'movie' ? null : t.episode !== undefined ? `S${String(t.season ?? 1).padStart(2, '0')}E${String(t.episode).padStart(2, '0')}` : `Season ${t.season ?? 1}`;
  const counts = new Map<string, number>();
  const bump = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
  let found = 0;
  let taken = 0;
  search.decisions.forEach((d, i) => {
    if (d.rejections.some((r) => OFF_TARGET.has(r.code))) return;
    found++;
    if (d.accepted) {
      if (search.vsYours[i]?.better ?? true) taken++;
      else bump('not better than your file');
      return;
    }
    const code = d.rejections.find((r) => WHY[r.code])?.code;
    bump(code ? WHY[code]! : 'turned down for other reasons');
  });
  const reasons = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3);
  return { at, what, profile, found, taken, reasons };
}

function saveSearchNote(db: Db, target: SearchTarget, note: SearchNote): void {
  const value = JSON.stringify(note);
  if (target.kind === 'movie') db.update(movies).set({ searchNote: value }).where(eq(movies.id, target.movieId!)).run();
  else db.update(series).set({ searchNote: value }).where(eq(series.id, target.seriesId!)).run();
}

export function readSearchNote(db: Db, kind: 'movie' | 'series', id: number): SearchNote | null {
  const row = kind === 'movie' ? db.select({ v: movies.searchNote }).from(movies).where(eq(movies.id, id)).get() : db.select({ v: series.searchNote }).from(series).where(eq(series.id, id)).get();
  if (!row?.v) return null;
  try {
    return JSON.parse(row.v) as SearchNote;
  } catch {
    return null;
  }
}

/** "23 copies of Season 2, none good enough for 4K Quality: 15 too big, 6 not a quality it takes." */
export function searchNoteText(n: SearchNote): string {
  const of = n.what ? ` of ${n.what}` : '';
  if (n.found === 0) return `No Source had a copy${of}.`;
  const copies = `${n.found} ${n.found === 1 ? 'copy' : 'copies'}${of}`;
  if (n.taken > 0) return `${copies}; Marquee would take ${n.taken} of them.`;
  const why = n.reasons.map(([r, c]) => `${c} ${r}`).join(', ');
  return `${copies}, none good enough for ${n.profile}${why ? `: ${why}` : ''}.`;
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
