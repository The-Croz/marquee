// Ratings a kid profile can see: the same rule as the library (US ratings; unrated is hidden).
export const KID_MOVIE_RATINGS = ['G', 'PG'];
export const KID_TV_RATINGS = ['TV-Y', 'TV-Y7', 'TV-Y7-FV', 'TV-G', 'TV-PG'];

export function isKidSafe(kind: 'movie' | 'series', certification: string | null): boolean {
  return certification !== null && (kind === 'movie' ? KID_MOVIE_RATINGS : KID_TV_RATINGS).includes(certification);
}
