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
