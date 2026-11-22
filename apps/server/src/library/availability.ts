/**
 * When a movie can be downloaded. A cinema release isn't enough: copies only
 * turn up once it's out to stream or buy (digital) or on disc. TMDB often has
 * no digital date for a film still in cinemas, so without one Marquee guesses
 * 90 days after the cinema date, like the arrs' "Released" availability.
 */

export const CINEMA_TO_HOME_DAYS = 90;

export interface MovieDates {
  releaseDate: string | null;
  cinemaRelease?: string | null;
  digitalRelease?: string | null;
  physicalRelease?: string | null;
}

const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** The day it's out to stream, buy or own: the digital or disc date, or the cinema date + 90 days. Null when nothing is known. */
export function movieHomeDate(m: MovieDates): { date: string; known: boolean } | null {
  const home = [m.digitalRelease, m.physicalRelease].filter((d): d is string => !!d).sort()[0];
  if (home) return { date: home, known: true };
  const cinema = m.cinemaRelease ?? m.releaseDate;
  return cinema ? { date: addDays(cinema, CINEMA_TO_HOME_DAYS), known: false } : null;
}

export type MovieStage = 'announced' | 'cinemas' | 'out';

/** Not out anywhere yet, only in cinemas, or out to stream or buy. No dates at all counts as out. */
export function movieStage(m: MovieDates, today: string): MovieStage {
  const home = movieHomeDate(m);
  if (!home || home.date <= today) return 'out';
  const cinema = m.cinemaRelease ?? m.releaseDate;
  return cinema && cinema <= today ? 'cinemas' : 'announced';
}
