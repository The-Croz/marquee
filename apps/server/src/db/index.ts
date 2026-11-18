import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/**
 * Schema changes, applied in order and recorded in `schema_migrations`.
 * Never edit a migration that has shipped: add a new one.
 */
const migrations: string[] = [
  /* 1: accounts and sign-in */ `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    email TEXT,
    password_hash TEXT,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member', 'kid')),
    plex_id TEXT UNIQUE,
    plex_username TEXT,
    oidc_issuer TEXT,
    oidc_subject TEXT,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  );
  CREATE UNIQUE INDEX users_oidc_identity ON users (oidc_issuer, oidc_subject);
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    user_agent TEXT
  );
  CREATE INDEX sessions_user ON sessions (user_id);
  CREATE TABLE login_flows (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    data TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  /* 2: library (movies, shows, episodes, files) */ `
  CREATE TABLE movies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tmdb_id INTEGER NOT NULL UNIQUE,
    imdb_id TEXT,
    title TEXT NOT NULL,
    sort_title TEXT NOT NULL,
    year INTEGER,
    overview TEXT,
    poster_path TEXT,
    backdrop_path TEXT,
    runtime INTEGER,
    certification TEXT,
    genres TEXT NOT NULL DEFAULT '[]',
    release_date TEXT,
    path TEXT UNIQUE,
    monitored INTEGER NOT NULL DEFAULT 1,
    profile TEXT NOT NULL DEFAULT 'cinema',
    added_at INTEGER NOT NULL,
    refreshed_at INTEGER NOT NULL
  );
  CREATE TABLE series (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tmdb_id INTEGER NOT NULL UNIQUE,
    tvdb_id INTEGER,
    imdb_id TEXT,
    title TEXT NOT NULL,
    sort_title TEXT NOT NULL,
    year INTEGER,
    overview TEXT,
    poster_path TEXT,
    backdrop_path TEXT,
    status TEXT,
    network TEXT,
    certification TEXT,
    genres TEXT NOT NULL DEFAULT '[]',
    path TEXT UNIQUE,
    monitored INTEGER NOT NULL DEFAULT 1,
    profile TEXT NOT NULL DEFAULT 'cinema',
    added_at INTEGER NOT NULL,
    refreshed_at INTEGER NOT NULL
  );
  CREATE TABLE episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id INTEGER NOT NULL REFERENCES series (id) ON DELETE CASCADE,
    season INTEGER NOT NULL,
    episode INTEGER NOT NULL,
    title TEXT,
    air_date TEXT,
    overview TEXT,
    UNIQUE (series_id, season, episode)
  );
  CREATE TABLE media_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    movie_id INTEGER REFERENCES movies (id) ON DELETE CASCADE,
    series_id INTEGER REFERENCES series (id) ON DELETE CASCADE,
    season INTEGER,
    episodes TEXT,
    size INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    resolution TEXT,
    source TEXT,
    hdr TEXT,
    codec TEXT,
    release_group TEXT,
    added_at INTEGER NOT NULL,
    seen_at INTEGER NOT NULL
  );
  CREATE INDEX media_files_movie ON media_files (movie_id);
  CREATE INDEX media_files_series ON media_files (series_id, season);
  CREATE TABLE scan_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('movie', 'series')),
    path TEXT NOT NULL UNIQUE,
    parsed_title TEXT,
    parsed_year INTEGER,
    status TEXT NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched', 'ignored')),
    candidates TEXT NOT NULL DEFAULT '[]',
    reason TEXT,
    seen_at INTEGER NOT NULL
  );
  CREATE TABLE tmdb_cache (
    key TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );
  `,
  /* 3: Sources (Torznab feeds, usually from Prowlarr) and their call log */ `
  CREATE TABLE sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    api_key TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 25,
    private INTEGER NOT NULL DEFAULT 0,
    for_movies INTEGER NOT NULL DEFAULT 1,
    for_tv INTEGER NOT NULL DEFAULT 1,
    min_seeders INTEGER NOT NULL DEFAULT 1,
    daily_limit INTEGER NOT NULL DEFAULT 0,
    min_gap_ms INTEGER NOT NULL DEFAULT 2000,
    timeout_seconds INTEGER NOT NULL DEFAULT 30,
    caps TEXT,
    prowlarr_id INTEGER UNIQUE,
    state TEXT NOT NULL DEFAULT 'unchecked',
    state_message TEXT,
    failures INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER,
    checked_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE source_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('test', 'search')),
    ok INTEGER NOT NULL,
    ms INTEGER NOT NULL,
    results INTEGER NOT NULL DEFAULT 0,
    message TEXT
  );
  CREATE INDEX source_calls_source ON source_calls (source_id, at);
  `,
  /* 4: quality profiles (seeded with the Cinema, Everyday HD and Kids & Cartoons presets on first run) */ `
  CREATE TABLE profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('movie', 'tv')),
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    preset TEXT,
    tiers TEXT NOT NULL,
    cutoff TEXT NOT NULL,
    upgrades INTEGER NOT NULL DEFAULT 1,
    min_score INTEGER NOT NULL DEFAULT 0,
    cutoff_score INTEGER NOT NULL DEFAULT 10000,
    min_upgrade_score INTEGER NOT NULL DEFAULT 1,
    sizes TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (kind, key)
  );
  CREATE TABLE profile_rules (
    profile_id INTEGER NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    trash_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    score INTEGER NOT NULL,
    PRIMARY KEY (profile_id, trash_id)
  );
  `,
  /* 5: comparison mode: what Radarr downloaded vs what Marquee would have picked */ `
  CREATE TABLE comparisons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    radarr_history_id INTEGER NOT NULL UNIQUE,
    radarr_movie_id INTEGER NOT NULL,
    movie_id INTEGER REFERENCES movies (id) ON DELETE SET NULL,
    tmdb_id INTEGER,
    title TEXT NOT NULL,
    grabbed_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'done', 'failed')),
    mode TEXT CHECK (mode IN ('own_search', 'same_list')),
    profile TEXT,
    verdict TEXT CHECK (verdict IN ('same', 'same_quality', 'higher', 'lower', 'nothing')),
    radarr TEXT NOT NULL,
    marquee TEXT,
    message TEXT,
    checked_at INTEGER
  );
  CREATE INDEX comparisons_grabbed ON comparisons (grabbed_at);
  `,
  /* 6: rules that pick a title's profile from its genres and age rating */ `
  ALTER TABLE movies ADD COLUMN profile_by_hand INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE series ADD COLUMN profile_by_hand INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE profile_choices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('movie', 'tv')),
    position INTEGER NOT NULL,
    profile TEXT NOT NULL,
    genres TEXT NOT NULL DEFAULT '[]',
    ratings TEXT NOT NULL DEFAULT '[]'
  );
  `,
  /* 7: more facts about titles for profile rules, and rules as lists of conditions */ `
  ALTER TABLE movies ADD COLUMN original_language TEXT;
  ALTER TABLE movies ADD COLUMN companies TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE movies ADD COLUMN keywords TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE series ADD COLUMN original_language TEXT;
  ALTER TABLE series ADD COLUMN companies TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE series ADD COLUMN keywords TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE profile_choices ADD COLUMN conditions TEXT NOT NULL DEFAULT '[]';
  `,
  /* 8: downloads Marquee sent to qBittorrent (or found already there) */ `
  CREATE TABLE downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('movie', 'tv')),
    movie_id INTEGER REFERENCES movies (id) ON DELETE SET NULL,
    series_id INTEGER REFERENCES series (id) ON DELETE SET NULL,
    season INTEGER,
    episodes TEXT,
    title TEXT NOT NULL,
    info_hash TEXT NOT NULL,
    source_id INTEGER REFERENCES sources (id) ON DELETE SET NULL,
    source_name TEXT,
    profile TEXT,
    quality TEXT,
    score INTEGER,
    size INTEGER,
    requested_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
    added_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'sent',
    adopted INTEGER NOT NULL DEFAULT 0,
    progress REAL NOT NULL DEFAULT 0,
    last_progress_at INTEGER,
    message TEXT
  );
  CREATE INDEX downloads_hash ON downloads (info_hash);
  CREATE INDEX downloads_movie ON downloads (movie_id);
  CREATE INDEX downloads_series ON downloads (series_id, season);
  `,
  /* 9: what qBittorrent last said about each download, and copies never to pick again */ `
  ALTER TABLE downloads ADD COLUMN qbit_state TEXT;
  ALTER TABLE downloads ADD COLUMN speed INTEGER;
  ALTER TABLE downloads ADD COLUMN eta INTEGER;
  ALTER TABLE downloads ADD COLUMN seeds INTEGER;
  ALTER TABLE downloads ADD COLUMN files_checked INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE downloads ADD COLUMN checked_at INTEGER;
  ALTER TABLE downloads ADD COLUMN finished_at INTEGER;
  CREATE TABLE never_pick (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('movie', 'tv')),
    movie_id INTEGER REFERENCES movies (id) ON DELETE CASCADE,
    series_id INTEGER REFERENCES series (id) ON DELETE CASCADE,
    info_hash TEXT,
    title TEXT NOT NULL,
    reason TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX never_pick_movie ON never_pick (movie_id);
  CREATE INDEX never_pick_series ON never_pick (series_id);
  `,
  /* 10: putting finished downloads in the library */ `
  ALTER TABLE downloads ADD COLUMN save_path TEXT;
  ALTER TABLE downloads ADD COLUMN imported_at INTEGER;
  ALTER TABLE downloads ADD COLUMN imported_paths TEXT;
  ALTER TABLE downloads ADD COLUMN import_error TEXT;
  ALTER TABLE downloads ADD COLUMN import_tried_at INTEGER;
  ALTER TABLE downloads ADD COLUMN import_copied INTEGER NOT NULL DEFAULT 0;
  `,
  /* 11: seeding rules per Source, and how much each download has shared */ `
  ALTER TABLE sources ADD COLUMN seed_ratio REAL;
  ALTER TABLE sources ADD COLUMN seed_days REAL;
  ALTER TABLE downloads ADD COLUMN ratio REAL;
  ALTER TABLE downloads ADD COLUMN seeding_seconds INTEGER;
  ALTER TABLE downloads ADD COLUMN shared_enough_at INTEGER;
  `,
];

export function openDb(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  migrate(sqlite);
  return drizzle(sqlite, { schema }) as Db;
}

function migrate(sqlite: Database.Database): void {
  sqlite.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const row = sqlite.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  const current = row.v ?? 0;
  migrations.slice(current).forEach((sql, i) => {
    const version = current + i + 1;
    sqlite.transaction(() => {
      sqlite.exec(sql);
      sqlite.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, Date.now());
    })();
  });
}

export function getSetting(db: Db, key: string): string | undefined {
  return db.select().from(schema.settings).where(eq(schema.settings.key, key)).get()?.value;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.insert(schema.settings).values({ key, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } }).run();
}

export { schema };
