import { parseRelease, type ParsedRelease } from '../releases/parse.js';

/**
 * Reads titles, years, IDs, episode numbers and quality out of folder and file
 * names. Pure functions: no disk or network access, so they're easy to test.
 */

export const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.mov', '.wmv', '.ts', '.m2ts', '.webm', '.mpg', '.mpeg']);

/** Folders inside a title's folder that hold bonus content, not the title itself. */
export const EXTRAS_FOLDERS = new Set([
  'extras', 'featurettes', 'behind the scenes', 'deleted scenes', 'interviews', 'scenes', 'shorts', 'trailers', 'other', 'samples', 'sample',
]);

export interface ParsedName {
  title: string;
  year: number | null;
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
}

const YEAR = '(?:19|20)\\d{2}';

function cleanTitle(raw: string): string {
  return raw
    .replace(/[._]+/g, ' ')
    .replace(/\s*[-–]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function ids(name: string): Pick<ParsedName, 'tmdbId' | 'tvdbId' | 'imdbId'> {
  // Radarr/Sonarr/Plex/Jellyfin naming styles: {tmdb-123} [tmdbid-123] {tmdbid=123} (tvdb-456) {imdb-tt0111161}
  const num = (re: RegExp) => {
    const m = name.match(re);
    return m?.[1] ? Number(m[1]) : null;
  };
  return {
    tmdbId: num(/[{[(]\s*tmdb(?:id)?[-=: ]\s*(\d+)\s*[}\])]/i),
    tvdbId: num(/[{[(]\s*tvdb(?:id)?[-=: ]\s*(\d+)\s*[}\])]/i),
    imdbId: name.match(/\b(tt\d{7,9})\b/i)?.[1]?.toLowerCase() ?? null,
  };
}

/** Removes ID tags like {tmdb-123} or [imdbid-tt123] from a name. */
function stripTags(name: string): string {
  return name.replace(/[{[(]\s*(?:tmdb|tvdb|imdb)(?:id)?[-=: ][^}\])]*[}\])]/gi, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * "The Matrix (1999) {tmdb-603}", "Dune.Part.Two.2024.2160p.WEB-DL", "Up (2009)",
 * "1917 (2019)", "Blade Runner 2049 (2017)".
 */
export function parseTitleName(name: string): ParsedName {
  const tags = ids(name);
  const base = stripTags(name.replace(/\.[a-z0-9]{2,4}$/i, (ext) => (VIDEO_EXTENSIONS.has(ext.toLowerCase()) ? '' : ext)));

  // "Title (Year)" — the clean library style
  let m = base.match(new RegExp(`^(.+?)\\s*\\((${YEAR})\\)`));
  if (m?.[1] && m[2]) return { title: cleanTitle(m[1]), year: Number(m[2]), ...tags };

  // Release style: "Title.Year.1080p..." — take the LAST plausible year before quality tags,
  // so "Blade.Runner.2049.2017.1080p" gives "Blade Runner 2049" / 2017.
  const quality = base.search(/[ ._\-[(](?:2160p|1080p|720p|576p|480p|4k|uhd|web[ ._-]?(?:dl|rip)|bluray|blu-ray|bdrip|brrip|hdtv|remux|dvdrip|x26[45]|h\.?26[45]|hevc)\b/i);
  const head = quality > 0 ? base.slice(0, quality) : base;
  const years = [...head.matchAll(new RegExp(`[ ._\\-[(](${YEAR})(?=$|[ ._\\-\\])])`, 'g'))];
  const last = years.at(-1);
  if (last?.index !== undefined && last.index > 0) {
    return { title: cleanTitle(head.slice(0, last.index)), year: Number(last[1]), ...tags };
  }

  return { title: cleanTitle(head), year: null, ...tags };
}

export interface ParsedEpisode {
  season: number;
  episodes: number[];
}

/** "Show.S01E02.mkv", "S01E01-E02", "S01E01E02", "1x02", "Season 1 Episode 2". Null when it isn't an episode. */
export function parseEpisode(fileName: string): ParsedEpisode | null {
  let m = fileName.match(/\bS(\d{1,2})[ ._-]?E(\d{1,3})((?:[ ._-]?-?[ ._-]?E\d{1,3})*)/i);
  if (m?.[1] && m[2]) {
    const first = Number(m[2]);
    const more = [...(m[3] ?? '').matchAll(/E(\d{1,3})/gi)].map((x) => Number(x[1]));
    // "S01E01-E03" means 1, 2 and 3
    const all = more.length === 1 && /-/.test(m[3] ?? '') && more[0]! > first + 1 ? range(first, more[0]!) : [first, ...more];
    return { season: Number(m[1]), episodes: [...new Set(all)] };
  }
  m = fileName.match(/(?:^|[ ._-])(\d{1,2})x(\d{2,3})(?:[ ._-]|$)/i);
  if (m?.[1] && m[2]) return { season: Number(m[1]), episodes: [Number(m[2])] };
  m = fileName.match(/season[ ._-]?(\d{1,2})[ ._-]*episode[ ._-]?(\d{1,3})/i);
  if (m?.[1] && m[2]) return { season: Number(m[1]), episodes: [Number(m[2])] };
  return null;
}

function range(a: number, b: number): number[] {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

export interface ParsedQuality {
  resolution: '2160p' | '1080p' | '720p' | '576p' | '480p' | null;
  source: 'Remux' | 'Blu-ray' | 'WEB-DL' | 'WEBRip' | 'HDTV' | 'DVD' | null;
  hdr: 'Dolby Vision' | 'HDR10+' | 'HDR10' | 'HDR' | 'HLG' | null;
  codec: 'x265' | 'x264' | 'AV1' | 'VC-1' | 'MPEG-2' | null;
  group: string | null;
}

/** Quality of a file in the library, in the shape stored on `media_files`. Read with the release-name parser. */
export function parseQuality(fileName: string): ParsedQuality {
  const r = parseRelease(fileName);
  const resolution = r.resolution === 2160 ? '2160p' : r.resolution === 1440 || r.resolution === 1080 ? '1080p' : r.resolution === 720 ? '720p' : r.resolution === 576 ? '576p' : r.resolution === 480 ? '480p' : null;
  const sources: Partial<Record<NonNullable<ParsedRelease['source']>, ParsedQuality['source']>> = {
    remux: 'Remux',
    bluray: 'Blu-ray',
    brdisk: 'Blu-ray',
    webdl: 'WEB-DL',
    webrip: 'WEBRip',
    hdtv: 'HDTV',
    dvd: 'DVD',
    dvdr: 'DVD',
  };
  const hdr = r.hdr.includes('DV') ? 'Dolby Vision' : r.hdr.includes('HDR10+') ? 'HDR10+' : r.hdr.includes('HDR10') ? 'HDR10' : r.hdr.includes('HDR') ? 'HDR' : r.hdr.includes('HLG') ? 'HLG' : null;
  const codecs: Partial<Record<NonNullable<ParsedRelease['codec']>, ParsedQuality['codec']>> = { h265: 'x265', h264: 'x264', av1: 'AV1', vc1: 'VC-1', mpeg2: 'MPEG-2' };
  return {
    resolution,
    source: (r.source && sources[r.source]) ?? null,
    hdr,
    codec: (r.codec && codecs[r.codec]) ?? null,
    group: r.group,
  };
}

/** For comparing titles: lowercase, no accents or punctuation, "&" → "and", no leading "the". */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^the /, '')
    .trim();
}

/** Sort key: "The Bear" sorts under B. */
export function sortTitle(title: string): string {
  return title.replace(/^(the|a|an)\s+/i, '').toLowerCase();
}
