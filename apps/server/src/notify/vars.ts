import type { RequestRow } from '../db/schema.js';
import type { Vars } from './template.js';

/** A TMDB poster path as a full picture address, for notification images. */
export const posterUrl = (path: string | null | undefined) => (path ? `https://image.tmdb.org/t/p/w500${path.startsWith('/') ? '' : '/'}${path}` : null);

/** The facts every request message carries. */
export function requestVars(r: Pick<RequestRow, 'id' | 'kind' | 'title' | 'year' | 'posterPath' | 'seasons'>): Vars {
  const seasons = r.seasons ? (JSON.parse(r.seasons) as number[]) : null;
  return {
    requestId: r.id,
    title: r.title,
    year: r.year,
    kind: r.kind === 'movie' ? 'movie' : 'show',
    seasons: r.kind === 'movie' ? null : seasons ? seasons.map((n) => `Season ${n}`).join(', ') : 'All',
    poster: posterUrl(r.posterPath),
  };
}
