/**
 * Clean names for files Marquee puts in the library, from patterns you can
 * edit in Settings → Services. Patterns use {Tokens}; a "/" starts a folder.
 * Empty tokens disappear along with brackets left empty around them.
 *
 * The defaults put TMDB/TVDB ids in the folder name ({tmdb-693134}), which
 * Plex and Jellyfin both use to match exactly, and keep the quality in the
 * file name so Marquee (and Radarr, during the side-by-side) can read it back.
 */

export const DEFAULT_MOVIE_PATTERN = '{Title} ({Year}) {tmdb-{TmdbId}}/{Title} ({Year}) {Edition} [{Quality}][{HDR}]';
export const DEFAULT_TV_PATTERN = '{Show} ({Year}) {tvdb-{TvdbId}}/Season {Season:00}/{Show} - S{Season:00}E{Episode:00} - {Episode Title} [{Quality}][{HDR}]';

export const MOVIE_TOKENS = ['Title', 'Year', 'TmdbId', 'ImdbId', 'Quality', 'HDR', 'Edition', 'Group'] as const;
export const TV_TOKENS = ['Show', 'Year', 'TvdbId', 'TmdbId', 'ImdbId', 'Season', 'Season:00', 'Episode', 'Episode:00', 'Episode Title', 'Quality', 'HDR', 'Group'] as const;

export interface NameValues {
  Title?: string;
  Show?: string;
  Year?: number | null;
  TmdbId?: number | null;
  TvdbId?: number | null;
  ImdbId?: string | null;
  Quality?: string | null;
  HDR?: string | null;
  Edition?: string | null;
  Group?: string | null;
  Season?: number | null;
  /** One or more episode numbers; several make "01-E02". */
  Episodes?: number[];
  'Episode Title'?: string | null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Characters no file system or media server likes. A colon becomes " -" ("Dune - Part Two"). */
function clean(segment: string): string {
  return segment
    .replace(/\s*:\s*/g, ' - ')
    .replace(/[<>"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\{(tmdb|tvdb|imdb)-\}/gi, '')
    .replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+-\s*$/, '')
    .replace(/^[\s.]+|[\s.]+$/g, '');
}

function value(token: string, v: NameValues): string {
  switch (token) {
    case 'Season:00':
      return v.Season == null ? '' : pad(v.Season);
    case 'Season':
      return v.Season == null ? '' : String(v.Season);
    case 'Episode:00':
      return v.Episodes?.length ? v.Episodes.map(pad).join('-E') : '';
    case 'Episode':
      return v.Episodes?.length ? v.Episodes.join('-') : '';
    default: {
      const x = v[token as keyof NameValues];
      return x == null ? '' : String(x);
    }
  }
}

/** The relative path (folders and file name, without the extension) a pattern gives. */
export function renderName(pattern: string, v: NameValues): string {
  const filled = pattern.replace(/\{([A-Za-z ]+(?::00)?)\}/g, (whole, token: string) => {
    if (![...MOVIE_TOKENS, ...TV_TOKENS].includes(token as never)) return whole;
    // Values can't add folders or brackets that look like tokens.
    return value(token, v).replace(/[/\\]/g, ' ').replace(/[{}]/g, '');
  });
  return filled
    .split('/')
    .map(clean)
    .filter(Boolean)
    .join('/');
}

/** Checks a pattern; returns a plain message for the first problem, or null. */
export function patternProblem(pattern: string, kind: 'movie' | 'tv'): string | null {
  const p = pattern.trim();
  if (!p) return 'The pattern is empty.';
  if (p.startsWith('/') || p.split('/').some((s) => s.trim() === '..' || s.trim() === '.')) return 'Patterns are inside the library folder: no leading “/” and no “..”.';
  const known = new Set<string>(kind === 'movie' ? MOVIE_TOKENS : TV_TOKENS);
  for (const m of p.matchAll(/\{([A-Za-z ]+(?::00)?)\}/g)) {
    if (!known.has(m[1]!)) return `{${m[1]}} isn’t something Marquee can fill in for ${kind === 'movie' ? 'movies' : 'TV'}. Use one of: ${[...known].map((t) => `{${t}}`).join(' ')}.`;
  }
  if (kind === 'movie' && !p.includes('{Title}')) return 'Movie names need {Title}.';
  if (kind === 'tv' && !p.includes('{Show}')) return 'TV names need {Show}.';
  if (kind === 'tv' && !/\{Season(:00)?\}/.test(p.split('/').at(-1)!)) return 'TV file names need {Season} or {Season:00}, so episodes don’t collide.';
  if (kind === 'tv' && !/\{Episode(:00)?\}/.test(p.split('/').at(-1)!)) return 'TV file names need {Episode} or {Episode:00}, so episodes don’t collide.';
  return null;
}

/** "DV HDR10" from the parser's flags. */
export function hdrLabel(flags: string[]): string | null {
  const shown = flags.filter((f) => f !== 'SDR');
  return shown.length ? shown.join(' ') : null;
}
