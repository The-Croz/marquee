import { getSetting, setSetting, type Db } from '../db/index.js';
import type { Config } from '../config.js';

/**
 * Connection settings for outside services, stored in the database so they
 * can be changed from Settings → Services. Environment variables (e.g.
 * TMDB_API_KEY from the Unraid template) are used when nothing is saved.
 * Secrets are never sent back to the browser, only whether they're set.
 */

export interface ServiceSettings {
  tmdbApiKey: string | null;
  radarrUrl: string | null;
  radarrApiKey: string | null;
  sonarrUrl: string | null;
  sonarrApiKey: string | null;
  moviesRoot: string;
  tvRoot: string;
}

const KEYS = {
  tmdbApiKey: 'services.tmdb_api_key',
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
    radarrUrl: get('radarrUrl'),
    radarrApiKey: get('radarrApiKey'),
    sonarrUrl: get('sonarrUrl'),
    sonarrApiKey: get('sonarrApiKey'),
    moviesRoot: get('moviesRoot') ?? '/data/movies',
    tvRoot: get('tvRoot') ?? '/data/tv',
  };
}

/** Saves the given fields. `null` or "" clears a saved value; `undefined` leaves it alone. */
export function writeServices(db: Db, values: Partial<Record<keyof ServiceSettings, string | null>>): void {
  for (const [field, value] of Object.entries(values) as [keyof ServiceSettings, string | null | undefined][]) {
    if (value === undefined) continue;
    setSetting(db, KEYS[field], (value ?? '').trim());
  }
}
