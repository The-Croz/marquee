import { sqliteTable, text, integer, real, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';

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
  /** ISO 639-1, from TMDB. */
  originalLanguage: text('original_language'),
  /** JSON string[]: studios (movies) or networks and studios (TV), from TMDB. */
  companies: text('companies').notNull().default('[]'),
  /** JSON string[]: TMDB keywords. */
  keywords: text('keywords').notNull().default('[]'),
  releaseDate: text('release_date'),
  /** Folder on disk; null for a wanted movie with nothing downloaded yet. */
  path: text('path').unique(),
  monitored: integer('monitored', { mode: 'boolean' }).notNull().default(true),
  profile: text('profile').notNull().default('cinema'),
  /** You picked the profile yourself, so the profile rules leave it alone. */
  profileByHand: integer('profile_by_hand', { mode: 'boolean' }).notNull().default(false),
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
  /** ISO 639-1, from TMDB. */
  originalLanguage: text('original_language'),
  /** JSON string[]: studios (movies) or networks and studios (TV), from TMDB. */
  companies: text('companies').notNull().default('[]'),
  /** JSON string[]: TMDB keywords. */
  keywords: text('keywords').notNull().default('[]'),
  path: text('path').unique(),
  monitored: integer('monitored', { mode: 'boolean' }).notNull().default(true),
  profile: text('profile').notNull().default('cinema'),
  /** You picked the profile yourself, so the profile rules leave it alone. */
  profileByHand: integer('profile_by_hand', { mode: 'boolean' }).notNull().default(false),
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

/**
 * Places Marquee searches for copies (older apps call these indexers). Each is
 * a Torznab feed; ones linked from Prowlarr carry its site ID.
 */
export const sources = sqliteTable('sources', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  url: text('url').notNull(),
  apiKey: text('api_key').notNull().default(''),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** 1–50, lower is asked first and wins ties. */
  priority: integer('priority').notNull().default(25),
  private: integer('private', { mode: 'boolean' }).notNull().default(false),
  forMovies: integer('for_movies', { mode: 'boolean' }).notNull().default(true),
  forTv: integer('for_tv', { mode: 'boolean' }).notNull().default(true),
  minSeeders: integer('min_seeders').notNull().default(1),
  /** Most searches in 24 hours; 0 means no limit. */
  dailyLimit: integer('daily_limit').notNull().default(0),
  minGapMs: integer('min_gap_ms').notNull().default(2000),
  timeoutSeconds: integer('timeout_seconds').notNull().default(30),
  /** Keep sharing until this ratio; null uses the default, 0 means no ratio limit. */
  seedRatio: real('seed_ratio'),
  /** Keep sharing for this many days; null uses the default, 0 means no time limit. */
  seedDays: real('seed_days'),
  /** JSON TorznabCaps from the last successful check. */
  caps: text('caps'),
  prowlarrId: integer('prowlarr_id').unique(),
  state: text('state', { enum: ['unchecked', 'working', 'unreachable', 'key_refused', 'slowed_down', 'set_aside', 'blocked', 'not_a_feed', 'error'] })
    .notNull()
    .default('unchecked'),
  stateMessage: text('state_message'),
  failures: integer('failures').notNull().default(0),
  /** While failing: skipped until this time, then tried again. */
  retryAt: integer('retry_at'),
  checkedAt: integer('checked_at'),
  createdAt: integer('created_at').notNull(),
});

export const sourceCalls = sqliteTable('source_calls', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceId: integer('source_id')
    .notNull()
    .references(() => sources.id, { onDelete: 'cascade' }),
  at: integer('at').notNull(),
  kind: text('kind', { enum: ['test', 'search'] }).notNull(),
  ok: integer('ok', { mode: 'boolean' }).notNull(),
  ms: integer('ms').notNull(),
  results: integer('results').notNull().default(0),
  message: text('message'),
});

/**
 * Quality profiles: which copies a title accepts and how they're ranked. One
 * set for movies and one for TV, since TRaSH's rules and qualities differ
 * between the two. Titles point at a profile by `key` (movies.profile, series.profile).
 */
export const profiles = sqliteTable(
  'profiles',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind', { enum: ['movie', 'tv'] }).notNull(),
    /** Stable name titles refer to ("cinema"); never changes, even on rename. */
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** The preset it can be reset to, or null for one you made. */
    preset: text('preset'),
    /** JSON Tier[]: groups of qualities, best first. */
    tiers: text('tiers').notNull(),
    /** Name of the tier that's "good enough": no upgrades past it. */
    cutoff: text('cutoff').notNull(),
    upgrades: integer('upgrades', { mode: 'boolean' }).notNull().default(true),
    minScore: integer('min_score').notNull().default(0),
    cutoffScore: integer('cutoff_score').notNull().default(10000),
    minUpgradeScore: integer('min_upgrade_score').notNull().default(1),
    /** JSON Record<quality, { min, preferred, max }> in MB per minute; overrides TRaSH's sizes. */
    sizes: text('sizes').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('profiles_kind_key').on(t.kind, t.key)],
);

/**
 * Which profile a new title gets: checked in order, first match wins, else
 * the library's default. A rule matches when the title has any of its genres
 * (or it lists none) and any of its age ratings (or it lists none).
 */
export const profileChoices = sqliteTable('profile_choices', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind', { enum: ['movie', 'tv'] }).notNull(),
  position: integer('position').notNull(),
  profile: text('profile').notNull(),
  /** JSON string[]: TMDB genre names. */
  genres: text('genres').notNull().default('[]'),
  /** JSON string[]: US age ratings. */
  ratings: text('ratings').notNull().default('[]'),
  /** JSON Condition[]: all must match. Replaces genres/ratings, which older rules used. */
  conditions: text('conditions').notNull().default('[]'),
});

/** The TRaSH rules a profile scores, and how many points each is worth. */
export const profileRules = sqliteTable(
  'profile_rules',
  {
    profileId: integer('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    trashId: text('trash_id').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    score: integer('score').notNull(),
  },
  (t) => [primaryKey({ columns: [t.profileId, t.trashId] })],
);

/**
 * Comparison mode: each copy Radarr downloaded, and what Marquee would have
 * picked for the same movie. Read-only towards Radarr.
 */
export const comparisons = sqliteTable('comparisons', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  radarrHistoryId: integer('radarr_history_id').notNull().unique(),
  radarrMovieId: integer('radarr_movie_id').notNull(),
  movieId: integer('movie_id').references(() => movies.id, { onDelete: 'set null' }),
  tmdbId: integer('tmdb_id'),
  title: text('title').notNull(),
  grabbedAt: integer('grabbed_at').notNull(),
  status: text('status', { enum: ['waiting', 'done', 'failed'] }).notNull().default('waiting'),
  /** own_search: Marquee searched its own Sources; same_list: judged Radarr's own list of copies. */
  mode: text('mode', { enum: ['own_search', 'same_list'] }),
  profile: text('profile'),
  verdict: text('verdict', { enum: ['same', 'same_quality', 'higher', 'lower', 'nothing'] }),
  /** JSON ComparedCopy: Radarr's download, as Marquee judges it. */
  radarr: text('radarr').notNull(),
  /** JSON ComparedCopy | null: Marquee's pick. */
  marquee: text('marquee'),
  /** Why it failed, or a note. */
  message: text('message'),
  checkedAt: integer('checked_at'),
});

/**
 * Downloads Marquee sent to qBittorrent, or found already there (adopted).
 * `state` is one of DOWNLOAD_STATES; the Downloads page (M3 PR 3) moves it on.
 */
export const downloads = sqliteTable('downloads', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind', { enum: ['movie', 'tv'] }).notNull(),
  movieId: integer('movie_id').references(() => movies.id, { onDelete: 'set null' }),
  seriesId: integer('series_id').references(() => series.id, { onDelete: 'set null' }),
  season: integer('season'),
  /** JSON array of episode numbers; null for a whole season or a movie. */
  episodes: text('episodes'),
  /** The copy's name. */
  title: text('title').notNull(),
  /** Lowercase hex. */
  infoHash: text('info_hash').notNull(),
  sourceId: integer('source_id').references(() => sources.id, { onDelete: 'set null' }),
  sourceName: text('source_name'),
  profile: text('profile'),
  quality: text('quality'),
  score: integer('score'),
  size: integer('size'),
  requestedBy: integer('requested_by').references(() => users.id, { onDelete: 'set null' }),
  addedAt: integer('added_at').notNull(),
  state: text('state', { enum: ['sent', 'downloading', 'done', 'failed', 'removed'] }).notNull().default('sent'),
  /** 1 when qBittorrent already had it and Marquee only started following it. */
  adopted: integer('adopted', { mode: 'boolean' }).notNull().default(false),
  progress: real('progress').notNull().default(0),
  lastProgressAt: integer('last_progress_at'),
  message: text('message'),
  /** qBittorrent's own state word, from the last check. Never shown as-is. */
  qbitState: text('qbit_state'),
  /** Bytes a second, seconds left and people sharing, from the last check. */
  speed: integer('speed'),
  eta: integer('eta'),
  seeds: integer('seeds'),
  /** The file list has been checked for programs and fakes. */
  filesChecked: integer('files_checked', { mode: 'boolean' }).notNull().default(false),
  checkedAt: integer('checked_at'),
  finishedAt: integer('finished_at'),
  /** qBittorrent's save folder for it, as qBittorrent sees it. */
  savePath: text('save_path'),
  importedAt: integer('imported_at'),
  /** JSON string[]: the library files it became. */
  importedPaths: text('imported_paths'),
  /** Why putting it in the library failed last time, in plain words. */
  importError: text('import_error'),
  importTriedAt: integer('import_tried_at'),
  /** The library file is a copy, not a hardlink (different disks), so it takes twice the space. */
  importCopied: integer('import_copied', { mode: 'boolean' }).notNull().default(false),
  /** Uploaded ÷ downloaded, and time spent sharing, from the last check. */
  ratio: real('ratio'),
  seedingSeconds: integer('seeding_seconds'),
  /** When it met its seeding rule. */
  sharedEnoughAt: integer('shared_enough_at'),
});

export type Download = typeof downloads.$inferSelect;

/** Copies never to pick again for a title ("Never pick"), with the reason. */
export const neverPick = sqliteTable('never_pick', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind', { enum: ['movie', 'tv'] }).notNull(),
  movieId: integer('movie_id').references(() => movies.id, { onDelete: 'cascade' }),
  seriesId: integer('series_id').references(() => series.id, { onDelete: 'cascade' }),
  infoHash: text('info_hash'),
  /** The copy's name. */
  title: text('title').notNull(),
  reason: text('reason').notNull(),
  at: integer('at').notNull(),
});
export type User = typeof users.$inferSelect;
export type Movie = typeof movies.$inferSelect;
export type Series = typeof series.$inferSelect;
export type MediaFile = typeof mediaFiles.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Source = typeof sources.$inferSelect;
export type Profile = typeof profiles.$inferSelect;
