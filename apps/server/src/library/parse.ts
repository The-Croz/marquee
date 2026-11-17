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

export function parseQuality(fileName: string): ParsedQuality {
  const n = fileName.replace(/\.[a-z0-9]{2,4}$/i, '');
  const has = (re: RegExp) => re.test(n);
  const resolution = has(/\b(2160p|4k|uhd)\b/i)
    ? '2160p'
    : has(/\b1080[pi]\b/i)
      ? '1080p'
      : has(/\b720p\b/i)
        ? '720p'
        : has(/\b576p\b/i)
          ? '576p'
          : has(/\b480p\b/i)
            ? '480p'
            : null;
  const source = has(/\bremux\b/i)
    ? 'Remux'
    : has(/\bweb[ ._-]?dl\b|\bweb\b(?![ ._-]?rip)/i)
      ? 'WEB-DL'
      : has(/\bweb[ ._-]?rip\b/i)
        ? 'WEBRip'
        : has(/\b(blu[ ._-]?ray|bdrip|brrip|bd25|bd50)\b/i)
          ? 'Blu-ray'
          : has(/\bhdtv\b/i)
            ? 'HDTV'
            : has(/\b(dvd(rip|r|5|9)?)\b/i)
              ? 'DVD'
              : null;
  const hdr = has(/\b(dv|dovi|dolby[ ._-]?vision)\b/i)
    ? 'Dolby Vision'
    : has(/\bhdr10(\+|plus|p)\b/i)
      ? 'HDR10+'
      : has(/\bhdr10\b/i)
        ? 'HDR10'
        : has(/\bhdr\b/i)
          ? 'HDR'
          : has(/\bhlg\b/i)
            ? 'HLG'
            : null;
  const codec = has(/\b(x265|h[ ._]?265|hevc)\b/i)
    ? 'x265'
    : has(/\b(x264|h[ ._]?264|avc)\b/i)
      ? 'x264'
      : has(/\bav1\b/i)
        ? 'AV1'
        : has(/\bvc-?1\b/i)
          ? 'VC-1'
          : has(/\bmpeg-?2\b/i)
            ? 'MPEG-2'
            : null;
  // Release group: the part after the last dash, e.g. "...x265-GROUP". Ignore things like "WEB-DL".
  const g = n.match(/-([A-Za-z0-9]+)(?:\[[^\]]*\])?$/);
  const group = g?.[1] && !/^(dl|rip|hd|ray)$/i.test(g[1]) ? g[1] : null;
  return { resolution, source, hdr, codec, group };
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
