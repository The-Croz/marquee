import type { Db } from '../db/index.js';

/**
 * Titles a person has watched, newest first, for "Because you watched…" rows.
 * Milestone 6 (Plex and Jellyfin history) fills this in; until then there is
 * nothing, and those rows lean on the library and requests instead.
 */
export function watchedTitles(_db: Db, _userId: number): { kind: 'movie' | 'series'; tmdbId: number; title: string }[] {
  return [];
}
