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
/** Every migration, in order. Exported so a restored backup can be checked against this version. */
export const migrations: string[] = [
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
  /* 12: telling Plex and Jellyfin to scan after an import */ `
  ALTER TABLE downloads ADD COLUMN scan_pending INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE downloads ADD COLUMN scan_message TEXT;
  ALTER TABLE downloads ADD COLUMN scan_tried_at INTEGER;
  `,
  /* 13: Marquee looks for wanted movies itself */ `
  ALTER TABLE movies ADD COLUMN last_searched_at INTEGER;
  `,
  /* 14: Marquee looks for wanted episodes itself */ `
  ALTER TABLE episodes ADD COLUMN last_searched_at INTEGER;
  CREATE INDEX episodes_air_date ON episodes (air_date);
  `,
  /* 15: sites Marquee searches itself (no Prowlarr), and the catalogue of site files */ `
  ALTER TABLE sources ADD COLUMN kind TEXT NOT NULL DEFAULT 'feed';
  ALTER TABLE sources ADD COLUMN site_id TEXT;
  ALTER TABLE sources ADD COLUMN site_settings TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE sources ADD COLUMN site_session TEXT;
  ALTER TABLE sources ADD COLUMN was_feed TEXT;
  CREATE TABLE site_definitions (
    id TEXT PRIMARY KEY,
    origin TEXT NOT NULL CHECK (origin IN ('catalogue', 'custom')),
    yaml TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  /* 16: wanted / not wanted. Nothing is wanted until you say so; episodes can be left out one by one. */ `
  UPDATE movies SET monitored = 0;
  UPDATE series SET monitored = 0;
  ALTER TABLE episodes ADD COLUMN monitored INTEGER NOT NULL DEFAULT 1;
  `,
  /* 17: requests, what each person turned on or off, and notifications */ `
  CREATE TABLE requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('movie', 'series')),
    tmdb_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    year INTEGER,
    poster_path TEXT,
    seasons TEXT,
    requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
    profile TEXT,
    reason TEXT,
    decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    decided_at INTEGER,
    created_at INTEGER NOT NULL,
    title_id INTEGER,
    ready_at INTEGER
  );
  CREATE INDEX requests_title ON requests (kind, tmdb_id);
  CREATE TABLE user_prefs (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    hidden_services TEXT NOT NULL DEFAULT '[]',
    trailers INTEGER NOT NULL DEFAULT 1,
    muted_events TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE notification_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('pushover', 'ntfy')),
    name TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    events TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    last_ok_at INTEGER,
    last_error TEXT
  );
  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    link TEXT,
    created_at INTEGER NOT NULL,
    read_at INTEGER
  );
  CREATE INDEX notifications_user ON notifications (user_id, created_at);
  `,
  /* 18: people from Jellyfin, for Jellyfin sign-in */ `
  ALTER TABLE users ADD COLUMN jellyfin_id TEXT;
  ALTER TABLE users ADD COLUMN jellyfin_username TEXT;
  CREATE UNIQUE INDEX users_jellyfin_id ON users (jellyfin_id) WHERE jellyfin_id IS NOT NULL;
  `,
  /* 19: what people watched, from Plex and Jellyfin */ `
  CREATE TABLE plays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server TEXT NOT NULL CHECK (server IN ('plex', 'jellyfin')),
    server_user_id TEXT NOT NULL,
    user_name TEXT NOT NULL,
    item_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('movie', 'episode')),
    title TEXT NOT NULL,
    show TEXT,
    season INTEGER,
    episode INTEGER,
    year INTEGER,
    tmdb_id INTEGER,
    played_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX plays_once ON plays (server, server_user_id, item_key, played_at);
  CREATE INDEX plays_when ON plays (played_at);
  `,
  /* 20: every stream Marquee watched happen, with how long it was really watched */ `
  CREATE TABLE streams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server TEXT NOT NULL CHECK (server IN ('plex', 'jellyfin')),
    session_id TEXT NOT NULL,
    user_name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('movie', 'episode')),
    title TEXT NOT NULL,
    show TEXT,
    season INTEGER,
    episode INTEGER,
    year INTEGER,
    tmdb_id INTEGER,
    device TEXT NOT NULL,
    platform TEXT NOT NULL,
    resolution TEXT,
    transcoding INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    ended_at INTEGER,
    watched_ms INTEGER NOT NULL DEFAULT 0,
    progress REAL NOT NULL DEFAULT 0
  );
  CREATE INDEX streams_started ON streams (started_at);
  `,
  /* 21: your own wording for each notification; push channels that belong to one person; a picture in the bell */ `
  CREATE TABLE notification_templates (
    event TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    image TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
  );
  ALTER TABLE notification_channels ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
  ALTER TABLE notifications ADD COLUMN image TEXT;
  `,
  /* 22: watched sync between Plex and Jellyfin: every tick Marquee made, so a run can be undone */ `
  CREATE TABLE watch_sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_at INTEGER NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    person TEXT NOT NULL,
    server TEXT NOT NULL CHECK (server IN ('plex', 'jellyfin')),
    server_user_id TEXT NOT NULL,
    item_ref TEXT NOT NULL,
    title TEXT NOT NULL,
    undone_at INTEGER
  );
  CREATE INDEX watch_sync_log_run ON watch_sync_log (run_at);
  `,
  /* 23: each poster's main colour, and which poster it was picked from */ `
  ALTER TABLE movies ADD COLUMN poster_color TEXT;
  ALTER TABLE movies ADD COLUMN poster_color_for TEXT;
  ALTER TABLE series ADD COLUMN poster_color TEXT;
  ALTER TABLE series ADD COLUMN poster_color_for TEXT;
  `,
  /* 24: movies' US cinema, digital and disc dates for the calendar; more of what qBittorrent says about a download */ `
  ALTER TABLE movies ADD COLUMN cinema_release TEXT;
  ALTER TABLE movies ADD COLUMN digital_release TEXT;
  ALTER TABLE movies ADD COLUMN physical_release TEXT;
  ALTER TABLE downloads ADD COLUMN upload_speed INTEGER;
  ALTER TABLE downloads ADD COLUMN peers INTEGER;
  ALTER TABLE downloads ADD COLUMN uploaded INTEGER;
  `,
  /* 25: unpacking copies that come as .rar files; one history of what happened to every download */ `
  ALTER TABLE downloads ADD COLUMN unpack_state TEXT;
  ALTER TABLE downloads ADD COLUMN unpack_started_at INTEGER;
  ALTER TABLE downloads ADD COLUMN import_unpacked INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    event TEXT NOT NULL CHECK (event IN ('sent', 'in_library', 'upgraded', 'replaced', 'removed', 'import_failed', 'allowed_again')),
    kind TEXT NOT NULL CHECK (kind IN ('movie', 'tv')),
    movie_id INTEGER REFERENCES movies (id) ON DELETE SET NULL,
    series_id INTEGER REFERENCES series (id) ON DELETE SET NULL,
    season INTEGER,
    episodes TEXT,
    download_id INTEGER REFERENCES downloads (id) ON DELETE SET NULL,
    copy TEXT,
    title TEXT NOT NULL,
    source TEXT,
    quality TEXT,
    size INTEGER,
    detail TEXT,
    user_id INTEGER REFERENCES users (id) ON DELETE SET NULL
  );
  CREATE INDEX history_at ON history (at);
  CREATE INDEX history_movie ON history (movie_id);
  CREATE INDEX history_series ON history (series_id);
  -- What the downloads so far already say.
  CREATE TEMP VIEW history_base AS
    SELECT d.*, COALESCE(
      (SELECT m.title || COALESCE(' (' || m.year || ')', '') FROM movies m WHERE m.id = d.movie_id),
      (SELECT s.title FROM series s WHERE s.id = d.series_id),
      d.title) AS name
    FROM downloads d WHERE d.adopted = 0;
  INSERT INTO history (at, event, kind, movie_id, series_id, season, episodes, download_id, copy, title, source, quality, size, detail, user_id)
    SELECT added_at, 'sent', kind, movie_id, series_id, season, episodes, id, title, name, source_name, quality, size, NULL, requested_by FROM history_base;
  INSERT INTO history (at, event, kind, movie_id, series_id, season, episodes, download_id, copy, title, source, quality, size, detail, user_id)
    SELECT imported_at, 'in_library', kind, movie_id, series_id, season, episodes, id, title, name, source_name, quality, size,
      CASE WHEN import_copied = 1 THEN 'Copied, not linked: the download folder and the library are on different disks.' END, NULL
    FROM history_base WHERE imported_at IS NOT NULL;
  INSERT INTO history (at, event, kind, movie_id, series_id, season, episodes, download_id, copy, title, source, quality, size, detail, user_id)
    SELECT COALESCE(checked_at, added_at), 'replaced', kind, movie_id, series_id, season, episodes, id, title, name, source_name, quality, size, message, NULL
    FROM history_base WHERE state = 'failed';
  INSERT INTO history (at, event, kind, movie_id, series_id, season, episodes, download_id, copy, title, source, quality, size, detail, user_id)
    SELECT MAX(COALESCE(checked_at, 0), COALESCE(imported_at, 0), added_at), 'removed', kind, movie_id, series_id, season, episodes, id, title, name, source_name, quality, size, message, NULL
    FROM history_base WHERE state = 'removed';
  INSERT INTO history (at, event, kind, movie_id, series_id, season, episodes, download_id, copy, title, source, quality, size, detail, user_id)
    SELECT COALESCE(import_tried_at, finished_at, added_at), 'import_failed', kind, movie_id, series_id, season, episodes, id, title, name, source_name, quality, size, import_error, NULL
    FROM history_base WHERE import_error IS NOT NULL AND imported_at IS NULL;
  DROP VIEW history_base;
  `,
  /* 26: library care: titles left out of scans, a record of every rename (for undo), and two more kinds of History */ `
  CREATE TABLE left_out (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('movie', 'series')),
    tmdb_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    year INTEGER,
    path TEXT,
    at INTEGER NOT NULL,
    user_id INTEGER REFERENCES users (id) ON DELETE SET NULL
  );
  CREATE UNIQUE INDEX left_out_title ON left_out (kind, tmdb_id);
  CREATE TABLE renames (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('movie', 'tv')),
    label TEXT NOT NULL,
    moves TEXT NOT NULL,
    user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
    undone_at INTEGER
  );
  CREATE TABLE history_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    event TEXT NOT NULL CHECK (event IN ('sent', 'in_library', 'upgraded', 'replaced', 'removed', 'import_failed', 'allowed_again', 'title_removed', 'renamed')),
    kind TEXT NOT NULL CHECK (kind IN ('movie', 'tv')),
    movie_id INTEGER REFERENCES movies (id) ON DELETE SET NULL,
    series_id INTEGER REFERENCES series (id) ON DELETE SET NULL,
    season INTEGER,
    episodes TEXT,
    download_id INTEGER REFERENCES downloads (id) ON DELETE SET NULL,
    copy TEXT,
    title TEXT NOT NULL,
    source TEXT,
    quality TEXT,
    size INTEGER,
    detail TEXT,
    user_id INTEGER REFERENCES users (id) ON DELETE SET NULL
  );
  INSERT INTO history_new SELECT * FROM history;
  DROP TABLE history;
  ALTER TABLE history_new RENAME TO history;
  CREATE INDEX history_at ON history (at);
  CREATE INDEX history_movie ON history (movie_id);
  CREATE INDEX history_series ON history (series_id);
  `,
  // 27: profiles from Dictionarry or TRaSH, rule updates, your own rules
  `
  ALTER TABLE profiles ADD COLUMN database TEXT NOT NULL DEFAULT 'trash';
  ALTER TABLE profiles ADD COLUMN base TEXT;
  ALTER TABLE profiles ADD COLUMN prefer_repacks INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE profile_rules ADD COLUMN upstream_score INTEGER;
  CREATE TABLE rule_database_versions (
    name TEXT NOT NULL,
    app TEXT NOT NULL CHECK (app IN ('radarr', 'sonarr')),
    state TEXT NOT NULL CHECK (state IN ('applied', 'pending')),
    commit_sha TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    data TEXT NOT NULL,
    saved_at INTEGER NOT NULL,
    PRIMARY KEY (name, app, state)
  );
  CREATE TABLE own_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('movie', 'tv', 'both')),
    match TEXT NOT NULL CHECK (match IN ('words', 'group', 'language', 'pattern')),
    value TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // 28: getting titles in: show presets, collections, lists (Plex watchlists, Trakt, IMDb, Letterboxd)
  `
  ALTER TABLE series ADD COLUMN want_new INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE movies ADD COLUMN collection_tmdb_id INTEGER;
  ALTER TABLE users ADD COLUMN plex_token TEXT;
  CREATE TABLE collections (
    tmdb_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    overview TEXT NOT NULL DEFAULT '',
    poster_path TEXT,
    backdrop_path TEXT,
    parts TEXT NOT NULL DEFAULT '[]',
    wanted INTEGER NOT NULL DEFAULT 0,
    refreshed_at INTEGER NOT NULL
  );
  CREATE TABLE import_lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('plex_watchlist', 'trakt', 'imdb', 'letterboxd')),
    name TEXT NOT NULL,
    url TEXT,
    user_id INTEGER REFERENCES users (id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 1,
    profile TEXT,
    show_preset TEXT NOT NULL DEFAULT 'all',
    last_sync_at INTEGER,
    last_ok INTEGER,
    last_message TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX import_lists_watchlist ON import_lists (user_id) WHERE kind = 'plex_watchlist';
  CREATE TABLE list_items (
    list_id INTEGER NOT NULL REFERENCES import_lists (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('movie', 'series')),
    tmdb_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    year INTEGER,
    seen_at INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    PRIMARY KEY (list_id, kind, tmdb_id)
  );
  CREATE TABLE list_exclusions (
    kind TEXT NOT NULL CHECK (kind IN ('movie', 'series')),
    tmdb_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    year INTEGER,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (kind, tmdb_id)
  );
  CREATE TABLE letterboxd_films (slug TEXT PRIMARY KEY, tmdb_id INTEGER, kind TEXT, seen_at INTEGER NOT NULL);
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

/** Brings the database up to this version (used after restoring an older backup). */
export function migrateNow(db: Db): void {
  migrate(db.$client);
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
