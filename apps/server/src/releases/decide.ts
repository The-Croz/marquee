import type { FoundRelease } from '../sources/service.js';
import { matches } from './formats.js';
import { parseRelease, type ParsedRelease } from './parse.js';
import { appFor, appQuality, qualityLabel, ruleInfo, sizeLimit, type FullProfile, type Kind } from './profiles.js';

/**
 * The decision engine: given the copies Sources found for a title and the
 * title's profile, says which copies are acceptable, why the others aren't,
 * and ranks them best first. Pure: no database, disk or network.
 *
 * Ranking follows Radarr: quality group, then points, then Source priority,
 * then freeleech, then people sharing, then size closest to the preferred size.
 */

export interface Wanted {
  kind: Kind;
  title: string;
  /** Other names it goes by (original title, alternative titles). */
  altTitles?: string[];
  year: number | null;
  tmdbId?: number | null;
  imdbId?: string | null;
  tvdbId?: number | null;
  /** TV: the season asked for. */
  season?: number;
  /** TV: the episode asked for; leave out to search a whole season. */
  episode?: number;
  /** Minutes: the movie's runtime, or one episode's. Size limits are skipped when unknown. */
  runtime: number | null;
  /** TV: episodes in the season, to size a season pack. */
  seasonEpisodes?: number;
  /** From TMDB, e.g. "English", for rules about the original language. */
  originalLanguage?: string;
}

export type RejectionCode = 'wrong_title' | 'wrong_year' | 'not_a_movie' | 'wrong_episode' | 'season_pack' | 'no_episode' | 'sample' | 'quality' | 'too_small' | 'too_big' | 'no_seeders' | 'never' | 'low_score';

export interface Rejection {
  code: RejectionCode;
  message: string;
}

export interface ScoredRule {
  trashId: string;
  /** TRaSH's name, for looking it up in the guides. */
  name: string;
  label: string;
  explain: string;
  points: number;
}

export interface Decision {
  /** The copy as the best-priority Source gave it. */
  copy: FoundRelease;
  /** Every Source that had this same copy (same info-hash), best priority first. */
  sources: { id: number; name: string }[];
  /** Most people sharing it across those Sources. */
  seeders: number | null;
  leechers: number | null;
  parsed: ParsedRelease;
  /** Quality in the app's own naming, e.g. "WEBDL-1080p". */
  quality: string;
  qualityLabel: string;
  /** The profile's quality group it falls in, or null if none. */
  tier: string | null;
  /** 0 is the profile's best group. */
  tierRank: number | null;
  score: number;
  /** Every enabled rule that matched, biggest effect first. */
  rules: ScoredRule[];
  rejections: Rejection[];
  accepted: boolean;
}

/** Below this, a rule means "never pick" (TRaSH uses -10000). */
const NEVER = -10000;
const MB = 1024 ** 2;

export function decide(wanted: Wanted, found: FoundRelease[], profile: FullProfile): Decision[] {
  if (profile.kind !== wanted.kind) throw new Error(`A ${profile.kind} profile can't judge a ${wanted.kind}`);
  const decisions = merge(found).map((group) => judge(wanted, group, profile));
  return decisions.sort((a, b) => compare(a, b, wanted, profile));
}

// ---------------------------------------------------------------- merging

/** Copies with the same info-hash are the same torrent, often listed by several Sources (Knaben repeats The Pirate Bay). */
function merge(found: FoundRelease[]): FoundRelease[][] {
  const groups = new Map<string, FoundRelease[]>();
  for (const r of found) {
    const key = r.infoHash ? `hash:${r.infoHash.toLowerCase()}` : `name:${r.title.toLowerCase()}|${r.size ?? '?'}|${r.sourceId}|${r.guid}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  return [...groups.values()].map((g) => g.sort((a, b) => a.sourcePriority - b.sourcePriority || (b.seeders ?? -1) - (a.seeders ?? -1)));
}

const maxOf = (xs: (number | null)[]): number | null => (xs.some((x) => x !== null) ? Math.max(...xs.filter((x): x is number => x !== null)) : null);

// ---------------------------------------------------------------- judging one copy

function judge(wanted: Wanted, group: FoundRelease[], profile: FullProfile): Decision {
  const copy = group[0]!;
  const seeders = maxOf(group.map((r) => r.seeders));
  const leechers = maxOf(group.map((r) => r.leechers));
  const parsed = parseRelease(copy.title);
  const quality = appQuality(wanted.kind, parsed.quality);
  const tierRank = profile.tiers.findIndex((t) => t.qualities.includes(quality));
  const tier = tierRank >= 0 ? profile.tiers[tierRank]! : null;
  const rejections: Rejection[] = [];
  const reject = (code: RejectionCode, message: string) => rejections.push({ code, message });

  // ---- is it the right title?
  const idMatch = sameId(wanted, group);
  if (idMatch === false) reject('wrong_title', `This is a different ${wanted.kind === 'movie' ? 'movie' : 'show'} (the Source tagged it with another ID).`);
  else if (idMatch === null && !titleMatches(wanted, parsed)) reject('wrong_title', `The name says “${parsed.title || copy.title}”, not “${wanted.title}”.`);
  if (wanted.kind === 'movie' && idMatch !== true && wanted.year !== null && parsed.year !== null && Math.abs(parsed.year - wanted.year) > 1) {
    reject('wrong_year', `It's from ${parsed.year}; ${wanted.title} is from ${wanted.year}.`);
  }

  // ---- the right episode?
  if (wanted.kind === 'movie') {
    if (parsed.season !== null || parsed.episodes.length) reject('not_a_movie', 'It’s a TV episode or season, not the movie.');
  } else {
    const seasons = parsed.seasons.length ? parsed.seasons : parsed.season !== null ? [parsed.season] : [];
    if (!seasons.length) reject('no_episode', 'The name doesn’t say which season or episode it is.');
    else if (wanted.season !== undefined && !seasons.includes(wanted.season)) reject('wrong_episode', `It's ${describeEpisodes(parsed)}; you asked for season ${wanted.season}.`);
    else if (wanted.episode !== undefined && parsed.fullSeason) reject('season_pack', `It's the whole of ${describeEpisodes(parsed)}; you asked for one episode.`);
    else if (wanted.episode !== undefined && !parsed.episodes.includes(wanted.episode)) reject('wrong_episode', `It's ${describeEpisodes(parsed)}; you asked for episode ${wanted.episode}.`);
  }
  if (parsed.sample) reject('sample', 'It’s only a short sample clip.');

  // ---- quality and size
  if (!tier || !tier.allowed) reject('quality', `${qualityLabel(quality)} isn't one of the qualities ${profile.name} takes.`);
  const minutes = runtimeMinutes(wanted, parsed);
  const limit = sizeLimit(profile, quality);
  if (limit && minutes && copy.size !== null) {
    const mb = copy.size / MB;
    if (mb < limit.min * minutes) reject('too_small', `${gb(copy.size)} is too small for ${qualityLabel(quality)} at this length (at least ${gb(limit.min * minutes * MB)}). It's probably a poor copy or mislabeled.`);
    else if (!limit.unlimited && mb > limit.max * minutes) reject('too_big', `${gb(copy.size)} is bigger than ${profile.name} allows for ${qualityLabel(quality)} (up to ${gb(limit.max * minutes * MB)}).`);
  }
  if (seeders === 0) reject('no_seeders', 'Nobody is sharing it right now, so it would never finish.');

  // ---- rules and points
  const info = ruleInfo(wanted.kind);
  const rules: ScoredRule[] = [];
  for (const setting of profile.rules) {
    if (!setting.enabled || setting.score === 0) continue;
    const r = info.get(setting.trashId);
    if (!r) continue;
    const input = { app: appFor(wanted.kind), title: copy.title, parsed, size: copy.size, freeleech: group.some((g) => g.freeleech), originalLanguage: wanted.originalLanguage };
    if (matches(r.rule, input)) rules.push({ trashId: setting.trashId, name: r.rule.name, label: r.label, explain: r.explain, points: setting.score });
  }
  rules.sort((a, b) => Math.abs(b.points) - Math.abs(a.points) || a.label.localeCompare(b.label));
  const score = rules.reduce((sum, r) => sum + r.points, 0);
  const never = rules.filter((r) => r.points <= NEVER);
  for (const r of never) reject('never', `${r.label}: ${profile.name} never picks these.`);
  if (!never.length && score < profile.minScore) reject('low_score', `It scores ${score} points; ${profile.name} needs at least ${profile.minScore}.`);

  return {
    copy,
    sources: group.map((r) => ({ id: r.sourceId, name: r.sourceName })),
    seeders,
    leechers,
    parsed,
    quality,
    qualityLabel: qualityLabel(quality),
    tier: tier?.name ?? null,
    tierRank: tier ? tierRank : null,
    score,
    rules,
    rejections,
    accepted: rejections.length === 0,
  };
}

/** true: a Source's ID says it's this title; false: it says it's another; null: no IDs to go on. */
function sameId(wanted: Wanted, group: FoundRelease[]): boolean | null {
  let verdict: boolean | null = null;
  for (const r of group) {
    for (const [have, want] of [
      [r.tmdbId, wanted.tmdbId],
      [r.imdbId?.toLowerCase(), wanted.imdbId?.toLowerCase()],
      [r.tvdbId, wanted.tvdbId],
    ] as const) {
      if (have == null || want == null || have === 0 || have === '') continue;
      if (have === want) return true;
      verdict = false;
    }
  }
  return verdict;
}

/** Lowercase letters and digits only, without accents, "the" and "and", so "The Lord of the Rings: The Two Towers" ≈ "Lord of the Rings The Two Towers". */
export function normalizeTitle(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|and|a)\b/g, ' ')
    .replace(/\s+/g, '');
}

function titleMatches(wanted: Wanted, parsed: ParsedRelease): boolean {
  const got = normalizeTitle(parsed.title);
  if (!got) return false;
  const names = [wanted.title, ...(wanted.altTitles ?? [])].flatMap((t) => {
    const n = normalizeTitle(t);
    // "Doctor Who (2005)": the name may carry the year or not.
    const bare = normalizeTitle(t.replace(/\s*\(\d{4}\)\s*$/, ''));
    return wanted.year ? [n, bare, `${bare}${wanted.year}`] : [n, bare];
  });
  return names.includes(got);
}

function describeEpisodes(p: ParsedRelease): string {
  const seasons = p.seasons.length ? p.seasons : p.season !== null ? [p.season] : [];
  const s = seasons.length > 1 ? `seasons ${seasons[0]}–${seasons[seasons.length - 1]}` : `season ${seasons[0]}`;
  if (p.fullSeason || !p.episodes.length) return s;
  return p.episodes.length > 1 ? `${s}, episodes ${p.episodes[0]}–${p.episodes[p.episodes.length - 1]}` : `${s}, episode ${p.episodes[0]}`;
}

/** How many minutes the copy should run, or null when we can't tell. */
function runtimeMinutes(wanted: Wanted, p: ParsedRelease): number | null {
  if (!wanted.runtime) return null;
  if (wanted.kind === 'movie') return wanted.runtime;
  if (p.fullSeason) return wanted.seasonEpisodes && p.seasons.length <= 1 ? wanted.runtime * wanted.seasonEpisodes : null;
  return wanted.runtime * Math.max(1, p.episodes.length);
}

/** Decimal GB, as screens show sizes. */
function gb(bytes: number): string {
  const g = bytes / 1e9;
  return g >= 10 ? `${Math.round(g)} GB` : g >= 1 ? `${g.toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

// ---------------------------------------------------------------- ranking

/** Radarr's revision: a proper, repack or v2 beats the first release of the same copy. */
function revision(p: ParsedRelease): number {
  return Math.max(1, p.version, p.proper ? 2 : 1, p.repack ? 1 + p.repack : 1);
}

/** Radarr compares people sharing on a log scale, so 120 vs 130 is a tie but 10 vs 100 isn't. */
const sharingBucket = (n: number | null): number => (n && n > 0 ? Math.round(Math.log10(n)) : 0);
const ROUND = 200 * MB;

function sizeKey(d: Decision, wanted: Wanted, profile: FullProfile): number {
  const size = d.copy.size ?? 0;
  const limit = sizeLimit(profile, d.quality);
  const minutes = runtimeMinutes(wanted, d.parsed);
  // Closest to the preferred size wins; without a runtime, bigger wins (as Radarr does).
  if (limit && minutes) return -Math.abs(Math.round((size - limit.preferred * minutes * MB) / ROUND));
  return Math.round(size / ROUND);
}

/** Turned down because it's another title or episode: listed after the near misses. */
const OFF_TARGET = new Set<RejectionCode>(['wrong_title', 'wrong_year', 'not_a_movie', 'wrong_episode', 'no_episode', 'season_pack']);
const offTarget = (d: Decision) => Number(d.rejections.some((r) => OFF_TARGET.has(r.code)));

function compare(a: Decision, b: Decision, wanted: Wanted, profile: FullProfile): number {
  return (
    Number(b.accepted) - Number(a.accepted) ||
    offTarget(a) - offTarget(b) ||
    (a.tierRank ?? Infinity) - (b.tierRank ?? Infinity) ||
    revision(b.parsed) - revision(a.parsed) ||
    b.score - a.score ||
    a.copy.sourcePriority - b.copy.sourcePriority ||
    Number(b.copy.freeleech) - Number(a.copy.freeleech) ||
    sharingBucket(b.seeders) - sharingBucket(a.seeders) ||
    sharingBucket(b.leechers) - sharingBucket(a.leechers) ||
    sizeKey(b, wanted, profile) - sizeKey(a, wanted, profile)
  );
}
