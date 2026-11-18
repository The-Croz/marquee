import path from 'node:path';
import type { FoundRelease } from '../sources/service.js';
import { decide, type Decision, type Wanted } from './decide.js';
import type { FullProfile } from './profiles.js';

/**
 * "Is this better than the file you have?" Judges your file's name with the
 * same profile as the copies, then compares quality group first and points
 * second, like Radarr. Pure: no database, disk or network.
 */

export interface YourFile {
  name: string;
  qualityLabel: string;
  /** 0 is the profile's best group; null when the quality isn't in the profile. */
  tierRank: number | null;
  score: number;
}

export interface VsYours {
  better: boolean;
  message: string;
}

/** Judges a file name (e.g. "The Matrix (1999) Bluray-1080p.mkv") against the profile. */
export function judgeFile(wanted: Wanted, filePath: string, profile: FullProfile): YourFile {
  const name = path.basename(filePath).replace(/\.[a-z0-9]{2,4}$/i, '');
  const fake: FoundRelease = {
    title: name, size: null, seeders: null, leechers: null, grabs: null, publishedAt: null, downloadUrl: '', infoUrl: null, guid: filePath,
    infoHash: null, categories: [], imdbId: null, tmdbId: null, tvdbId: null, freeleech: false, sourceId: 0, sourceName: '', sourcePriority: 0,
  } as FoundRelease;
  const d = decide(wanted, [fake], profile)[0]!;
  return { name: path.basename(filePath), qualityLabel: d.qualityLabel, tierRank: d.tierRank, score: d.score };
}

/** The worst of several files (a season with mixed qualities is only as good as its worst episode). */
export function worstFile(files: YourFile[]): YourFile | null {
  return files.reduce<YourFile | null>((w, f) => (!w || rank(f) > rank(w) || (rank(f) === rank(w) && f.score < w.score) ? f : w), null);
}

const rank = (f: { tierRank: number | null }) => (f.tierRank === null || f.tierRank < 0 ? Infinity : f.tierRank);

export function compareToYours(d: Decision, yours: YourFile | null, profile: FullProfile): VsYours | null {
  if (!yours) return null;
  const cutoffRank = profile.tiers.findIndex((t) => t.name === profile.cutoff);
  if (!profile.upgrades) return { better: false, message: `You already have ${yours.qualityLabel}, and ${profile.name} doesn't look for better copies.` };
  const mine = rank(yours);
  const theirs = rank(d);
  if (theirs < mine) {
    if (cutoffRank >= 0 && mine <= cutoffRank && yours.score >= profile.cutoffScore) {
      return { better: false, message: `Your ${yours.qualityLabel} is already good enough for ${profile.name}.` };
    }
    return { better: true, message: `Better than your ${yours.qualityLabel}.` };
  }
  if (theirs > mine) return { better: false, message: `Lower quality than your ${yours.qualityLabel}.` };
  const gain = d.score - yours.score;
  if (gain > 0 && gain >= profile.minUpgradeScore && yours.score < profile.cutoffScore) return { better: true, message: `Same quality as yours, ${gain} more points.` };
  if (gain > 0 && yours.score >= profile.cutoffScore) return { better: false, message: `Your ${yours.qualityLabel} already has enough points for ${profile.name}.` };
  return { better: false, message: gain === 0 ? `About the same as your ${yours.qualityLabel}.` : `Not better than your ${yours.qualityLabel}.` };
}

/**
 * Nothing would count as better than this file: the profile doesn't look for
 * better copies, or the file is already "good enough" (at the profile's
 * cutoff quality with enough points). Lets Marquee skip searching for it.
 */
export function doneUpgrading(yours: YourFile, profile: FullProfile): boolean {
  if (!profile.upgrades) return true;
  const cutoffRank = profile.tiers.findIndex((t) => t.name === profile.cutoff);
  return cutoffRank >= 0 && rank(yours) <= cutoffRank && yours.score >= profile.cutoffScore;
}
