import { getSetting, setSetting, type Db } from '../db/index.js';
import type { Config } from '../config.js';
import { DEFAULT_MOVIE_PATTERN, DEFAULT_TV_PATTERN } from './naming.js';

/**
 * Connection settings for outside services, stored in the database so they
 * can be changed from Settings → Services. Environment variables (e.g.
 * TMDB_API_KEY from the Unraid template) are used when nothing is saved.
 * Secrets are never sent back to the browser, only whether they're set.
 */

export interface ServiceSettings {
  tmdbApiKey: string | null;
  /** Streaming Availability (RapidAPI or Movie of the Night), for the services' own Top 10s. Optional. */
  streamingTopKey: string | null;
  /** OMDb, for IMDb and Rotten Tomatoes scores. Optional. */
  omdbKey: string | null;
  radarrUrl: string | null;
  radarrApiKey: string | null;
  sonarrUrl: string | null;
  sonarrApiKey: string | null;
  moviesRoot: string;
  tvRoot: string;
}

const KEYS = {
  tmdbApiKey: 'services.tmdb_api_key',
  streamingTopKey: 'services.streaming_top_key',
  omdbKey: 'services.omdb_key',
  radarrUrl: 'services.radarr_url',
  radarrApiKey: 'services.radarr_api_key',
  sonarrUrl: 'services.sonarr_url',
  sonarrApiKey: 'services.sonarr_api_key',
  moviesRoot: 'library.movies_root',
  tvRoot: 'library.tv_root',
} as const satisfies Record<keyof ServiceSettings, string>;

export function readServices(db: Db, config: Config): ServiceSettings {
  const get = (k: keyof ServiceSettings) => getSetting(db, KEYS[k]) || null;
  return {
    tmdbApiKey: get('tmdbApiKey') ?? config.tmdbApiKey,
    streamingTopKey: get('streamingTopKey'),
    omdbKey: get('omdbKey'),
    radarrUrl: get('radarrUrl'),
    radarrApiKey: get('radarrApiKey'),
    sonarrUrl: get('sonarrUrl'),
    sonarrApiKey: get('sonarrApiKey'),
    moviesRoot: get('moviesRoot') ?? '/data/media/movies',
    tvRoot: get('tvRoot') ?? '/data/media/tv',
  };
}

/** Saves the given fields. `null` or "" clears a saved value; `undefined` leaves it alone. */
export function writeServices(db: Db, values: Partial<Record<keyof ServiceSettings, string | null>>): void {
  for (const [field, value] of Object.entries(values) as [keyof ServiceSettings, string | null | undefined][]) {
    if (value === undefined) continue;
    setSetting(db, KEYS[field], (value ?? '').trim());
  }
}

/** Where finished movies and TV go. */
export function libraryRoots(db: Db): { movies: string; tv: string } {
  return { movies: getSetting(db, KEYS.moviesRoot) || '/data/media/movies', tv: getSetting(db, KEYS.tvRoot) || '/data/media/tv' };
}

/** Name patterns for files Marquee puts in the library. */
export function readNaming(db: Db): { movie: string; tv: string } {
  return { movie: getSetting(db, 'library.movie_pattern') || DEFAULT_MOVIE_PATTERN, tv: getSetting(db, 'library.tv_pattern') || DEFAULT_TV_PATTERN };
}

/** "" puts a pattern back to the default. */
export function writeNaming(db: Db, v: { movie?: string; tv?: string }): void {
  if (v.movie !== undefined) setSetting(db, 'library.movie_pattern', v.movie.trim());
  if (v.tv !== undefined) setSetting(db, 'library.tv_pattern', v.tv.trim());
}
