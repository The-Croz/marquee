// Types shared by the server and the web app. Keep this file free of runtime
// dependencies so both sides can import it.

export type Role = 'admin' | 'member' | 'kid';

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  linked: { plex: boolean; oidc: boolean; password: boolean };
}

export interface AuthStatus {
  /** True until the first admin account exists. */
  setupRequired: boolean;
  providers: {
    password: true;
    oidc: { enabled: boolean; name: string };
    plex: { enabled: boolean };
  };
  user: SessionUser | null;
  /** Running version, e.g. "1.2.0" or "main-f00a740". */
  version: string;
}

export interface ApiError {
  error: string;
  message: string;
}

export interface PlexPinStart {
  /** Opaque id for polling /api/auth/plex/check. */
  flowId: string;
  authUrl: string;
}

export type PlexPinCheck =
  | { status: 'pending' }
  | { status: 'ok'; user: SessionUser }
  | { status: 'denied'; message: string }
  | { status: 'expired' };

export interface UserSummary extends SessionUser {
  email: string | null;
  plexUsername: string | null;
  createdAt: number;
  lastLoginAt: number | null;
}

// ---- Home screen (sample data until Milestones 1-6 land) ----

export interface HomeData {
  sample: boolean;
  nowDownloading: {
    title: string;
    requestedBy: string;
    quality: string;
    profile: string;
    size: string;
    percent: number;
    speed: string;
    eta: string;
  } | null;
  stats: { label: string; value: string; note: string }[];
  approvals: { id: number; title: string; who: string; plan: string; color: string }[];
  watching: { title: string; who: string; mode: string; percent: number }[];
  recent: { title: string; sub: string; color: string; posterPath?: string | null; href?: string }[];
  /** True once a library scan has found something; "recent" and library stats are then real. */
  libraryReady: boolean;
  upcoming: { day: string; title: string; note: string }[];
}

// ---- Settings → Services ----

export interface ServicesView {
  tmdb: { configured: boolean; fromEnvironment: boolean };
  radarr: { url: string | null; configured: boolean };
  sonarr: { url: string | null; configured: boolean };
  moviesRoot: string;
  tvRoot: string;
}

export interface ServicesUpdate {
  tmdbApiKey?: string | null;
  radarrUrl?: string | null;
  radarrApiKey?: string | null;
  sonarrUrl?: string | null;
  sonarrApiKey?: string | null;
  moviesRoot?: string;
  tvRoot?: string;
}

export interface ServiceTestResult {
  ok: boolean;
  message: string;
}

// ---- Library ----

export interface ScanStatusView {
  running: boolean;
  phase: 'idle' | 'preparing' | 'movies' | 'shows' | 'cleanup' | 'done' | 'failed';
  startedAt: number | null;
  finishedAt: number | null;
  processed: number;
  total: number;
  matched: number;
  unmatched: number;
  warnings: string[];
  error: string | null;
}

export interface QualityView {
  resolution: string | null;
  source: string | null;
  hdr: string | null;
  codec: string | null;
  group: string | null;
  /** e.g. "4K HDR", "1080p", "720p" */
  label: string;
}

export interface LibraryCard {
  id: number;
  kind: 'movie' | 'series';
  title: string;
  year: number | null;
  posterPath: string | null;
  certification: string | null;
  /** Movies: has a file. Shows: has every aired episode. */
  complete: boolean;
  /** "4K HDR", "1080p", "5 of 8 episodes" … */
  badge: string;
  sizeBytes: number;
  addedAt: number;
}

export interface MediaFileView {
  id: number;
  path: string;
  sizeBytes: number;
  quality: QualityView;
  addedAt: number;
}

export interface MovieDetail {
  id: number;
  tmdbId: number;
  imdbId: string | null;
  title: string;
  year: number | null;
  overview: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  runtime: number | null;
  certification: string | null;
  genres: string[];
  path: string | null;
  monitored: boolean;
  profile: string;
  addedAt: number;
  files: MediaFileView[];
}

export interface EpisodeView {
  episode: number;
  title: string | null;
  airDate: string | null;
  aired: boolean;
  file: MediaFileView | null;
}

export interface SeasonView {
  season: number;
  have: number;
  aired: number;
  total: number;
  episodes: EpisodeView[];
}

export interface ShowDetail {
  id: number;
  tmdbId: number;
  tvdbId: number | null;
  title: string;
  year: number | null;
  overview: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  status: string | null;
  network: string | null;
  certification: string | null;
  genres: string[];
  path: string | null;
  monitored: boolean;
  profile: string;
  addedAt: number;
  sizeBytes: number;
  seasons: SeasonView[];
}

export interface UnmatchedItem {
  id: number;
  kind: 'movie' | 'series';
  path: string;
  folder: string;
  parsedTitle: string | null;
  parsedYear: number | null;
  reason: string | null;
  candidates: { tmdbId: number; title: string; year: number | null; posterPath: string | null }[];
}

export interface SearchResult {
  kind: 'movie' | 'series';
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  overview: string;
  /** Marquee id if it's already in your library */
  libraryId: number | null;
}
