import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';

// Timestamps are stored as Unix milliseconds.

export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    username: text('username').notNull().unique(),
    displayName: text('display_name').notNull(),
    email: text('email'),
    /** Null for accounts that only sign in through Plex or OIDC. */
    passwordHash: text('password_hash'),
    role: text('role', { enum: ['admin', 'member', 'kid'] }).notNull().default('member'),
    plexId: text('plex_id').unique(),
    plexUsername: text('plex_username'),
    oidcIssuer: text('oidc_issuer'),
    oidcSubject: text('oidc_subject'),
    createdAt: integer('created_at').notNull(),
    lastLoginAt: integer('last_login_at'),
  },
  (t) => [uniqueIndex('users_oidc_identity').on(t.oidcIssuer, t.oidcSubject)],
);

export const sessions = sqliteTable('sessions', {
  /** SHA-256 of the cookie token, so a leaked database can't be used to sign in. */
  id: text('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull(),
  userAgent: text('user_agent'),
});

/** Short-lived state for multi-step sign-ins (OIDC redirects, Plex PINs). */
export const loginFlows = sqliteTable('login_flows', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['oidc', 'plex'] }).notNull(),
  data: text('data').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const movies = sqliteTable('movies', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tmdbId: integer('tmdb_id').notNull().unique(),
  imdbId: text('imdb_id'),
  title: text('title').notNull(),
  sortTitle: text('sort_title').notNull(),
  year: integer('year'),
  overview: text('overview'),
  posterPath: text('poster_path'),
  backdropPath: text('backdrop_path'),
  runtime: integer('runtime'),
  certification: text('certification'),
  /** JSON array of genre names */
  genres: text('genres').notNull().default('[]'),
  releaseDate: text('release_date'),
  /** Folder on disk; null for a wanted movie with nothing downloaded yet. */
  path: text('path').unique(),
  monitored: integer('monitored', { mode: 'boolean' }).notNull().default(true),
  profile: text('profile').notNull().default('cinema'),
  addedAt: integer('added_at').notNull(),
  refreshedAt: integer('refreshed_at').notNull(),
});

export const series = sqliteTable('series', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tmdbId: integer('tmdb_id').notNull().unique(),
  tvdbId: integer('tvdb_id'),
  imdbId: text('imdb_id'),
  title: text('title').notNull(),
  sortTitle: text('sort_title').notNull(),
  year: integer('year'),
  overview: text('overview'),
  posterPath: text('poster_path'),
  backdropPath: text('backdrop_path'),
  status: text('status'),
  network: text('network'),
  certification: text('certification'),
  genres: text('genres').notNull().default('[]'),
  path: text('path').unique(),
  monitored: integer('monitored', { mode: 'boolean' }).notNull().default(true),
  profile: text('profile').notNull().default('cinema'),
  addedAt: integer('added_at').notNull(),
  refreshedAt: integer('refreshed_at').notNull(),
});

export const episodes = sqliteTable('episodes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  seriesId: integer('series_id').notNull().references(() => series.id, { onDelete: 'cascade' }),
  season: integer('season').notNull(),
  episode: integer('episode').notNull(),
  title: text('title'),
  airDate: text('air_date'),
  overview: text('overview'),
}, (t) => [uniqueIndex('episodes_series_season_episode').on(t.seriesId, t.season, t.episode)]);

export const mediaFiles = sqliteTable('media_files', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  path: text('path').notNull().unique(),
  movieId: integer('movie_id').references(() => movies.id, { onDelete: 'cascade' }),
  seriesId: integer('series_id').references(() => series.id, { onDelete: 'cascade' }),
  season: integer('season'),
  /** JSON array of episode numbers in this file (multi-episode files have several) */
  episodes: text('episodes'),
  size: integer('size').notNull(),
  mtime: integer('mtime').notNull(),
  resolution: text('resolution'),
  source: text('source'),
  hdr: text('hdr'),
  codec: text('codec'),
  releaseGroup: text('release_group'),
  addedAt: integer('added_at').notNull(),
  seenAt: integer('seen_at').notNull(),
});

/** Folders the scanner couldn't match on its own. */
export const scanItems = sqliteTable('scan_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind', { enum: ['movie', 'series'] }).notNull(),
  path: text('path').notNull().unique(),
  parsedTitle: text('parsed_title'),
  parsedYear: integer('parsed_year'),
  status: text('status', { enum: ['unmatched', 'ignored'] }).notNull().default('unmatched'),
  /** JSON array of { tmdbId, title, year, posterPath } */
  candidates: text('candidates').notNull().default('[]'),
  reason: text('reason'),
  seenAt: integer('seen_at').notNull(),
});

export const tmdbCache = sqliteTable('tmdb_cache', {
  key: text('key').primaryKey(),
  body: text('body').notNull(),
  fetchedAt: integer('fetched_at').notNull(),
});

export type User = typeof users.$inferSelect;
export type Movie = typeof movies.$inferSelect;
export type Series = typeof series.$inferSelect;
export type MediaFile = typeof mediaFiles.$inferSelect;
export type NewUser = typeof users.$inferInsert;
