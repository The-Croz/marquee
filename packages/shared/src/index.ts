// Types shared by the server and the web app. Keep this file free of runtime
// dependencies so both sides can import it.

export type Role = 'admin' | 'member' | 'kid';

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  linked: { plex: boolean; oidc: boolean; password: boolean; jellyfin: boolean };
}

/** Posters for the sign-in screen's wall: popular titles from TMDB, never what's in your library. */
export interface SignInWall {
  posters: string[];
}

export interface AuthStatus {
  /** True until the first admin account exists. */
  setupRequired: boolean;
  providers: {
    password: true;
    oidc: { enabled: boolean; name: string };
    plex: { enabled: boolean };
    /** True once Jellyfin is connected under Settings → Services. */
    jellyfin: { enabled: boolean };
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
  jellyfinUsername: string | null;
  createdAt: number;
  lastLoginAt: number | null;
}

// ---- Home screen (sample data until Milestones 1-6 land) ----

/** Home: what's happening, what needs you, what's new and what's next. Everything here is real. */
export interface HomeData {
  /** Admins: what needs a person, most urgent first. Empty when all is well. */
  needsYou: HomeAttention[];
  /** Admins: who is watching right now, from Plex and Jellyfin. */
  watching: NowPlayingView[];
  /** Admins: downloads on their way, closest to done first. */
  onItsWay: HomeDownload[];
  /** Members and kids: their own requests that aren't in the library yet. */
  myRequests: RequestView[];
  /** The newest requests, whatever their state (admins: everyone's; others: their own). */
  recentRequests: RequestView[];
  /** The newest titles in the library (kids: only ones for them). */
  recent: HomeTitle[];
  /** Episodes airing and Wanted movies coming out in the next 7 days. `href` is the title’s page. */
  upcoming: { day: string; title: string; note: string; href?: string; posterPath?: string | null; backdropPath?: string | null }[];
  /** One quiet line of library numbers. `to` is where each one leads. */
  stats: { label: string; value: string; to?: string }[];
  /** The big picture at the top: what's playing, what's ready for you, or what just arrived. Null when there's nothing. */
  hero: HomeHero | null;
  /** Admins on a new install: the "Get set up" checklist. Null once every step that isn't optional is done. */
  setup: SetupStep[] | null;
}

export interface SetupStep {
  key: 'tmdb' | 'scan' | 'downloader' | 'sources' | 'mediaServer' | 'people';
  title: string;
  /** Why it matters, in one line. */
  detail: string;
  to: string;
  done: boolean;
  optional?: boolean;
}

export interface HomeHero {
  kind: 'watching' | 'ready' | 'arrived';
  /** "Now showing · Living room TV", "Ready to watch · you asked", "Just arrived · 2 hours ago" */
  eyebrow: string;
  title: string;
  chips: string[];
  href: string | null;
  backdropPath: string | null;
  posterPath: string | null;
  /** The poster's main colour, for the glow behind it. */
  color: string | null;
  /** 0–100, while playing. */
  progress: number | null;
  /** "1 h 01 of 2 h 46" style line, or who's watching. */
  note: string | null;
  /** About the title, when Marquee knows it. */
  year: number | null;
  /** US age rating, "PG-13", "TV-MA". */
  rating: string | null;
  /** Minutes (movies). */
  runtime: number | null;
  genres: string[];
  /** TMDB's 0–10 review score and how many votes it's from. */
  score: number | null;
  votes: number | null;
  overview: string | null;
  /** "Movie" or "Show · 3 seasons", "Ended". */
  kindLabel: string | null;
}

export interface HomeAttention {
  key: string;
  /** problem: something broke · attention: someone is waiting on you */
  tone: 'problem' | 'attention';
  title: string;
  /** What it means, or when it tries again by itself. */
  detail: string | null;
  posterPath?: string | null;
  /** Where to fix it. */
  to: string;
  action: string;
  /** A request that can be approved right here. */
  approveId?: number;
}

export interface HomeDownload {
  id: number;
  title: string;
  href: string | null;
  posterPath: string | null;
  /** 0–100 */
  percent: number;
  /** "Downloading · 4.2 MB/s · about 12 min left" */
  label: string;
}

export interface HomeTitle {
  title: string;
  /** "Movie · 4K" or "S2 E7 · 1080p" */
  sub: string;
  posterPath: string | null;
  /** The poster's main colour, `#rrggbb`, once Marquee has picked it. */
  posterColor: string | null;
  href: string;
  addedAt: number;
}

// ---- Settings → Services ----

export interface ServicesView {
  tmdb: { configured: boolean; fromEnvironment: boolean };
  /** Streaming Availability key for real Top 10s (never sent back). */
  streamingTop: { configured: boolean };
  /** OMDb key for IMDb and Rotten Tomatoes scores (never sent back). */
  omdb: { configured: boolean };
  radarr: { url: string | null; configured: boolean };
  sonarr: { url: string | null; configured: boolean };
  moviesRoot: string;
  tvRoot: string;
  /** Name patterns for files Marquee puts in the library. */
  naming: { movie: string; tv: string; defaultMovie: string; defaultTv: string };
  plex: MediaServerView;
  jellyfin: MediaServerView;
}

/** A Plex or Jellyfin server Marquee asks to scan. The token or key is never sent back. */
export interface MediaServerView {
  url: string | null;
  configured: boolean;
  /** Picked library ids; null means Marquee picks. */
  movieLibrary: string | null;
  tvLibrary: string | null;
}

export interface MediaLibraryView {
  id: string;
  name: string;
  kind: 'movie' | 'tv' | 'other';
  locations: string[];
}

export interface MediaLibrariesResult {
  libraries: MediaLibraryView[];
  /** What Marquee would scan for movies and TV with the current choices. */
  picked: { movie: string | null; tv: string | null };
}

export interface ServicesUpdate {
  tmdbApiKey?: string | null;
  streamingTopKey?: string | null;
  omdbKey?: string | null;
  radarrUrl?: string | null;
  radarrApiKey?: string | null;
  sonarrUrl?: string | null;
  sonarrApiKey?: string | null;
  moviesRoot?: string;
  tvRoot?: string;
  /** "" puts it back to the default. */
  moviePattern?: string;
  tvPattern?: string;
  plexUrl?: string | null;
  plexToken?: string | null;
  plexMovieLibrary?: string | null;
  plexTvLibrary?: string | null;
  jellyfinUrl?: string | null;
  jellyfinApiKey?: string | null;
  jellyfinMovieLibrary?: string | null;
  jellyfinTvLibrary?: string | null;
}

export interface ServiceTestResult {
  ok: boolean;
  message: string;
}

// ---- Settings → Downloader (qBittorrent) ----

export type DownloaderState =
  | 'not_set_up'
  | 'working'
  | 'unreachable'
  | 'password_refused'
  | 'banned'
  | 'needs_password'
  | 'not_qbittorrent'
  | 'too_old'
  | 'no_internet'
  | 'firewalled'
  | 'error';

export interface DownloaderView {
  url: string | null;
  username: string;
  /** Whether a password is saved. The password itself is never sent back. */
  hasPassword: boolean;
  category: string;
  /** Hours without progress before a download counts as stuck. */
  stuckHours: number;
  /** Hours without progress before Marquee tries another copy by itself. */
  giveUpHours: number;
  /** Try another copy by itself (after giveUpHours, or when a download looks fake). */
  tryAnother: boolean;
  /** When qBittorrent sees the download folder under another name than Marquee does. */
  folderPairs: { from: string; to: string }[];
  /** Keep sharing until this ratio (0 = no ratio limit)… */
  seedRatio: number;
  /** …or for this many days (0 = no time limit), whichever comes first. */
  seedDays: number;
  /** Private sites keep sharing with no limit unless their Source has its own rule. */
  privateKeepSharing: boolean;
  /** Remove a download from qBittorrent once it's in the library and has shared enough. */
  removeWhenShared: boolean;
}

export interface DownloaderUpdate {
  url?: string | null;
  username?: string;
  /** Omit to keep the saved one; null clears it. */
  password?: string | null;
  category?: string;
  stuckHours?: number;
  giveUpHours?: number;
  tryAnother?: boolean;
  folderPairs?: { from: string; to: string }[];
  seedRatio?: number;
  seedDays?: number;
  privateKeepSharing?: boolean;
  removeWhenShared?: boolean;
}

export interface DownloaderHealth {
  state: DownloaderState;
  /** Working well enough to download (firewalled still downloads). */
  ok: boolean;
  label: string;
  /** What to do about it, or null when nothing needs doing. */
  fix: string | null;
  /** The specific error, if any. */
  detail: string | null;
  checkedAt: number;
  version?: string;
  /** qBittorrent's default save folder, as qBittorrent sees it. */
  savePath?: string;
  freeSpace?: number | null;
  /** Whether Marquee's category already exists in qBittorrent (it's made on the first download). */
  categoryExists?: boolean;
}

// ---- Settings → Sources ----

/** Health of a Source, in words the UI shows as-is via `stateLabel`. */
export type SourceState = 'unchecked' | 'working' | 'paused' | 'unreachable' | 'key_refused' | 'sign_in_failed' | 'slowed_down' | 'set_aside' | 'blocked' | 'not_a_feed' | 'not_supported' | 'error';

export interface SourceView {
  id: number;
  name: string;
  /** feed: a Torznab address (often through Prowlarr) · site: Marquee searches the site itself */
  kind: 'feed' | 'site';
  /** For sites: which one, its name in the catalogue, and its settings (secrets hidden). */
  siteId: string | null;
  siteName: string | null;
  siteSettings: SiteSettingsView | null;
  /** Brought over from Prowlarr, so "Put back" can undo it. */
  canPutBack: boolean;
  /** The Torznab address. Never includes the key. */
  url: string;
  hasKey: boolean;
  enabled: boolean;
  priority: number;
  private: boolean;
  forMovies: boolean;
  forTv: boolean;
  minSeeders: number;
  dailyLimit: number;
  /** Its own seeding rule; null uses the default. 0 means no limit for that part. */
  seedRatio: number | null;
  seedDays: number | null;
  minGapMs: number;
  timeoutSeconds: number;
  fromProwlarr: boolean;
  state: SourceState;
  stateLabel: string;
  /** What happened last time, when it failed. */
  stateMessage: string | null;
  /** What to do about it. */
  fix: string | null;
  /** While failing: when Marquee tries again by itself. */
  retryAt: number | null;
  checkedAt: number | null;
  /** e.g. "Searches by TMDB, IMDb ID, so matches are exact." Null until checked. */
  searchesById: string | null;
  week: { calls: number; failures: number; avgMs: number | null; searchesToday: number };
}

export interface SourcesView {
  sources: SourceView[];
  prowlarr: { url: string | null; linked: boolean; syncedAt: number | null; syncMessage: string | null };
}

export interface SourceInput {
  name: string;
  url: string;
  apiKey?: string;
}

export interface SourceUpdate {
  name?: string;
  url?: string;
  apiKey?: string;
  enabled?: boolean;
  priority?: number;
  forMovies?: boolean;
  forTv?: boolean;
  minSeeders?: number;
  dailyLimit?: number;
  seedRatio?: number | null;
  seedDays?: number | null;
  minGapMs?: number;
  timeoutSeconds?: number;
}

export interface SourceCheckResult {
  ok: boolean;
  state: SourceState;
  message: string;
}

export interface ProwlarrSyncResult {
  ok: boolean;
  message: string;
  added: string[];
  updated: string[];
  removed: string[];
  skipped: { name: string; reason: string }[];
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
  /** The poster's main colour, `#rrggbb`, once Marquee has picked it. */
  posterColor: string | null;
  certification: string | null;
  /** Movies: has a file. Shows: has every aired episode. */
  complete: boolean;
  /** "4K HDR", "1080p", "5 of 8 episodes" … */
  badge: string;
  sizeBytes: number;
  addedAt: number;
  /** You want Marquee to look for it. */
  wanted: boolean;
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
  posterColor: string | null;
  backdropPath: string | null;
  runtime: number | null;
  certification: string | null;
  genres: string[];
  path: string | null;
  monitored: boolean;
  profile: string;
  /** You picked the profile yourself; the profile rules leave it alone. */
  profileByHand: boolean;
  addedAt: number;
  files: MediaFileView[];
}

export interface EpisodeView {
  episode: number;
  title: string | null;
  airDate: string | null;
  aired: boolean;
  /** Wanted (only counts while the show is wanted). */
  wanted: boolean;
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
  posterColor: string | null;
  backdropPath: string | null;
  status: string | null;
  network: string | null;
  certification: string | null;
  genres: string[];
  path: string | null;
  monitored: boolean;
  profile: string;
  /** You picked the profile yourself; the profile rules leave it alone. */
  profileByHand: boolean;
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

// ---------------------------------------------------------------- Settings → Quality (profiles)

export type ProfileKind = 'movie' | 'tv';
export type ProfileDefaultSlot = 'movie' | 'tv' | 'kids';

/** A group of qualities that rank the same, best group first. */
export interface QualityTier {
  name: string;
  qualities: string[];
  allowed: boolean;
}

export interface ProfileSummary {
  id: number;
  kind: ProfileKind;
  /** What titles point at; never changes. */
  key: string;
  name: string;
  description: string;
  /** Set for the built-in profiles, which can be reset to TRaSH's values. */
  preset: string | null;
  /** Name of the "good enough" quality group. */
  cutoff: string;
  /** How many movies or shows use it. */
  titles: number;
  defaultFor: ProfileDefaultSlot[];
}

export interface ProfilesView {
  profiles: ProfileSummary[];
  defaults: Record<ProfileDefaultSlot, string>;
  /** TRaSH's own profiles, which a new profile can start from. */
  trashProfiles: { kind: ProfileKind; name: string; description: string }[];
}

export interface ProfileRuleView {
  trashId: string;
  /** TRaSH's name, shown small beside the label. */
  name: string;
  label: string;
  explain: string;
  /** TRaSH's group, e.g. "[Unwanted] Unwanted Formats". */
  group: string | null;
  enabled: boolean;
  score: number;
  /** TRaSH's own points, to show when you've changed them. */
  trashScore: number;
}

/** MB per minute of runtime. */
export interface SizeLimitView {
  quality: string;
  label: string;
  min: number;
  preferred: number;
  max: number;
  /** The largest size is at the top of the scale: no limit. */
  unlimited: boolean;
  /** You changed it from TRaSH's value. */
  changed: boolean;
}

export interface ProfileDetail extends ProfileSummary {
  tiers: QualityTier[];
  upgrades: boolean;
  minScore: number;
  cutoffScore: number;
  minUpgradeScore: number;
  sizes: SizeLimitView[];
  rules: ProfileRuleView[];
  /** Plain words for each quality name ("WEBDL-1080p" → "1080p web download"). */
  qualityLabels: Record<string, string>;
}

// ---------------------------------------------------------------- Copies we found (search)

export interface CopyRejection {
  code: string;
  message: string;
}

export interface CopyRuleView {
  trashId: string;
  /** TRaSH's name, shown small. */
  name: string;
  label: string;
  explain: string;
  points: number;
}

/** One copy Marquee found, judged against the title's profile. No download link: that stays on the server. */
export interface CopyView {
  /** Points at this copy in its search, for "Download this". Only on search results. */
  id?: string;
  /** Compared with the file you already have, when you have one. */
  vsYours?: { better: boolean; message: string } | null;
  title: string;
  sizeBytes: number | null;
  seeders: number | null;
  leechers: number | null;
  publishedAt: number | null;
  infoUrl: string | null;
  /** Every Source that had it, best priority first. */
  sources: { id: number; name: string }[];
  quality: string;
  qualityLabel: string;
  /** Quality group in the profile, or null if it isn't in one. */
  tier: string | null;
  score: number;
  rules: CopyRuleView[];
  rejections: CopyRejection[];
  accepted: boolean;
  /** What the name says, for badges. */
  details: { resolution: number | null; hdr: string[]; codec: string | null; audio: string | null; atmos: boolean; service: string | null; group: string | null; editions: string[]; repack: boolean };
}

export interface SourceSearchOutcome {
  sourceId: number;
  name: string;
  status: 'searched' | 'failed' | 'skipped';
  results: number;
  ms: number;
  message: string | null;
}

export interface CopiesResult {
  /** Send with a copy's id to download it. Good for an hour. */
  searchId: string;
  /** The file you have now, as the profile judges it. */
  yours: { name: string; qualityLabel: string; score: number } | null;
  profile: { id: number; key: string; name: string };
  /** Best first; turned-down copies after the accepted ones. */
  copies: CopyView[];
  sources: SourceSearchOutcome[];
  ms: number;
}

// ---------------------------------------------------------------- downloads

export type DownloadState = 'sent' | 'downloading' | 'done' | 'failed' | 'removed';

export interface DownloadView {
  id: number;
  kind: 'movie' | 'tv';
  /** The title's poster and its colour, for the row's art. */
  posterPath: string | null;
  posterColor: string | null;
  movieId: number | null;
  seriesId: number | null;
  season: number | null;
  episodes: number[] | null;
  /** The copy's name. */
  title: string;
  infoHash: string;
  sourceName: string | null;
  quality: string | null;
  score: number | null;
  size: number | null;
  addedAt: number;
  state: DownloadState;
  /** qBittorrent already had it; Marquee only follows it. */
  adopted: boolean;
  progress: number;
  message: string | null;
  /** "Dune: Part Two (2024)" or "Severance · S02E03". */
  titleName: string;
  /** Where its page is, e.g. /movies/12. */
  titleLink: string | null;
  /** What's happening, in plain words. */
  status: DownloadStatus;
  /** Marquee can pause, remove or replace it (not for downloads it adopted from another app). */
  canControl: boolean;
  /** Finished and not in the library yet: "Try again" puts it there. */
  canImport: boolean;
  /** In the library and still in qBittorrent: can be removed from qBittorrent (the library file stays). */
  canRemoveShared: boolean;
  /** "Try another copy" turns this one down and sends the next best: on the way, or finished but not in the library. */
  canTryAnother: boolean;
  /** The library file was unpacked from .rar files, so it's its own file rather than a hardlink. */
  unpacked: boolean;
  /** The library files it became. */
  importedPaths: string[] | null;
  /** From qBittorrent's last check; null before the first one. */
  speed: number | null;
  uploadSpeed: number | null;
  /** Seconds left, when qBittorrent knows. */
  eta: number | null;
  /** People sharing the whole copy, and others connected. */
  seeds: number | null;
  peers: number | null;
  ratio: number | null;
  uploaded: number | null;
  finishedAt: number | null;
  /** The profile it was picked for ("4K Quality"). */
  profileName: string | null;
}

/** What qBittorrent says about one download right now (Downloads → a row's details). */
export interface DownloadDetails {
  id: number;
  /** Null when qBittorrent couldn't be asked or no longer has it; `note` says why. */
  live: {
    savePath: string;
    contentPath: string;
    category: string | null;
    tags: string[];
    /** The tracker's host name only. */
    tracker: string | null;
    size: number;
    progress: number;
    downloaded: number | null;
    uploaded: number | null;
    ratio: number;
    downloadSpeed: number;
    uploadSpeed: number;
    eta: number | null;
    seedsConnected: number;
    seedsKnown: number;
    peersConnected: number;
    peersKnown: number;
    addedAt: number | null;
    completedAt: number | null;
    activeSeconds: number | null;
    seedingSeconds: number;
    files: { name: string; size: number; progress: number | null }[];
  } | null;
  note: string | null;
}

export interface DownloadStatus {
  /** e.g. "Downloading · 4.2 MB/s · about 12 min left", "Stuck · nobody is sharing it". */
  label: string;
  /** What it means and what happens next. */
  detail: string | null;
  tone: 'good' | 'busy' | 'warn' | 'bad' | 'done' | 'quiet';
  /** When Marquee will try another copy by itself, if it will. */
  nextTryAt: number | null;
}

export interface DownloadsView {
  items: DownloadView[];
  /** qBittorrent couldn't be checked: its health label and what to do. Null when it answered. */
  problem: { label: string; fix: string | null } | null;
  checkedAt: number | null;
}

/** What happened to a download, for the History page and a title's History. */
export type HistoryEvent = 'sent' | 'in_library' | 'upgraded' | 'replaced' | 'removed' | 'import_failed' | 'allowed_again' | 'title_removed' | 'renamed';

export interface HistoryItem {
  id: number;
  at: number;
  event: HistoryEvent;
  /** "Sent to qBittorrent", "Upgraded"… */
  label: string;
  tone: 'good' | 'bad' | 'quiet' | 'busy';
  kind: 'movie' | 'tv';
  movieId: number | null;
  seriesId: number | null;
  /** "Dune: Part Two (2024)" or "Severance · S02E03". */
  titleName: string;
  /** Its page, or null when it's no longer in the library. */
  titleLink: string | null;
  /** The copy's name. */
  copy: string | null;
  source: string | null;
  quality: string | null;
  size: number | null;
  /** Why, or what else happened. */
  detail: string | null;
  /** Who did it, when a person did. */
  who: string | null;
}

export interface HistoryView {
  items: HistoryItem[];
  /** Pass as `before` for the next (older) page; null when there's no more. */
  next: string | null;
}

/** A copy turned down for a title: searches skip it. */
export interface NeverPickItem {
  id: number;
  at: number;
  kind: 'movie' | 'tv';
  titleName: string;
  titleLink: string | null;
  /** The copy's name. */
  copy: string;
  reason: string;
}

export interface NeverPickView {
  items: NeverPickItem[];
}

export interface DownloadActionResult {
  message: string;
  /** The new download when "Try another copy" sent one. */
  next: DownloadView | null;
}

export interface SendRequest {
  searchId: string;
  copyId: string;
  /** Send it even though Marquee wouldn't pick it, or it isn't better than your file. */
  anyway?: boolean;
}

export interface SendResult {
  download: DownloadView;
  /** One plain sentence on what happened. */
  message: string;
}

// ---------------------------------------------------------------- which profile a title gets

export type ConditionField = 'genre' | 'rating' | 'year' | 'company' | 'language' | 'keyword';
export type ConditionOp = 'any' | 'all' | 'none' | 'between';

/** One test in a rule. List fields use `values`; year uses `min`/`max` (either may be open). */
export interface ConditionView {
  field: ConditionField;
  op: ConditionOp;
  values?: string[];
  min?: number | null;
  max?: number | null;
}

export interface ProfileChoiceView {
  profile: string;
  /** All must hold. */
  conditions: ConditionView[];
}

export interface ProfileChoicesView {
  /** Checked in order, first match wins; otherwise the library's default. */
  rules: Record<ProfileKind, ProfileChoiceView[]>;
  genres: Record<ProfileKind, string[]>;
  ratings: Record<ProfileKind, string[]>;
  /** ISO 639-1 code → plain name. */
  languageNames: Record<string, string>;
  /** Values from your library, most common first, to suggest while editing. */
  suggestions: Record<ProfileKind, { companies: string[]; keywords: string[]; languages: string[] }>;
}

export interface TitleFactsView {
  genres: string[];
  certification: string | null;
  year: number | null;
  companies: string[];
  language: string | null;
  keywords: string[];
}

/** How a set of rules (saved or a draft) sorts your library, and how it treats some titles. */
export interface ChoicesCheckView {
  /** Titles each rule picks (first match), then everything else. */
  counts: { rules: number[]; rest: number };
  titles: {
    id: number;
    title: string;
    year: number | null;
    facts: TitleFactsView;
    /** For each rule, whether each condition holds. */
    rules: boolean[][];
    picked: number | null;
    profile: string;
    byHand: boolean;
  }[];
}

export interface ProfileChangeView {
  id: number;
  title: string;
  year: number | null;
  from: string;
  to: string;
  /** Rule number that picked it, or null for the library default. */
  rule: number | null;
}

// ---------------------------------------------------------------- automatic searching

export interface WantedRunView {
  at: number;
  /** missing: titles with no file · better: titles you have · new: new episodes from the Sources' newest copies */
  kind: 'missing' | 'better' | 'new';
  /** Searches made (for "new": copies looked at). */
  searched: number;
  /** `href` is the movie or show page; `title` says which season or episode for TV. */
  sent: { href: string; title: string; copy: string }[];
  problems: string[];
  /** A preview: what it would send. Nothing was sent. */
  preview?: boolean;
  /** Stopped early at the daily limit. */
  capped?: boolean;
}

/** Settings → Automatic searching: Marquee looking for Wanted movies and episodes by itself. */
export interface AutomationView {
  movies: AutomationKind;
  tv: AutomationKind;
  /** Copies Marquee may send by itself in 24 hours (0 = no limit), and how many it has sent in the last 24 hours. */
  dailyLimit: number;
  sentToday: number;
}

export interface AutomationKind {
  on: boolean;
  /** How many movies (or shows) are marked Wanted. */
  wanted: number;
  /** The last few searches Marquee ran by itself, newest first. */
  runs: WantedRunView[];
}

// ---- Calendar ----

export interface CalendarItem {
  /** An episode of a show, or a movie coming out. */
  kind: 'episode' | 'movie';
  /** Episodes: the show. Movies: null. */
  seriesId: number | null;
  /** Movies: the movie. Episodes: null. */
  movieId: number | null;
  /** The show's or movie's name. */
  show: string;
  posterPath: string | null;
  /** Episodes only (0 for movies). */
  season: number;
  episode: number;
  /** Episodes: the episode's name. Movies: how it comes out ("In cinemas", "Out to stream or buy", "On disc"). */
  title: string | null;
  /** "2026-11-18" */
  airDate: string;
  /** have: in your library · downloading · missing: aired, not here · coming: not aired yet · not_watched: the show isn't watched */
  state: 'have' | 'downloading' | 'missing' | 'coming' | 'not_watched';
  /** What happens next, in plain words. */
  note: string;
}

export interface CalendarView {
  from: string;
  to: string;
  today: string;
  items: CalendarItem[];
}

// ---- Built-in sites ----

/** One setting a site asks for when you add it. */
export interface SiteField {
  name: string;
  /** info: text to read, nothing to fill in. */
  type: 'text' | 'password' | 'checkbox' | 'select' | 'multiselect' | 'info';
  label: string;
  /** For info. */
  text?: string;
  /** Never sent back once saved (passwords, cookies, keys). */
  secret?: boolean;
  default?: string | string[] | boolean | null;
  options?: { value: string; label: string }[];
}

/** A site in Marquee's catalogue. */
export interface SiteSummary {
  id: string;
  name: string;
  description: string;
  /** public: anyone can use it · private: needs an account · semiPrivate: an account helps */
  type: 'public' | 'private' | 'semiPrivate';
  language: string | null;
  /** catalogue: from Prowlarr's list · custom: a file in your sites folder · builtin: written into Marquee */
  origin: 'catalogue' | 'custom' | 'builtin';
  movies: boolean;
  tv: boolean;
  /** Why Marquee can't run it yet, or null. */
  unsupported: string | null;
}

export interface SiteForm extends SiteSummary {
  /** Addresses the site answers on, first is usual. */
  links: string[];
  fields: SiteField[];
}

export interface SitesView {
  sites: SiteSummary[];
  catalogue: { refreshedAt: number | null; message: string | null; count: number; customFolder: string };
}

/** Values of a site's settings. Secrets come back as { saved: true } instead of their value. */
export type SiteSettingsView = Record<string, string | string[] | boolean | { saved: boolean } | null>;

export interface BringOverResult {
  /** Now run by Marquee itself. */
  moved: string[];
  /** Moved, but Prowlarr doesn't share passwords and cookies: type them once. */
  needSignIn: string[];
  /** Not in Marquee's catalogue, so still searched through Prowlarr. */
  notInCatalogue: string[];
  message: string;
}

export interface SolverView {
  enabled: boolean;
  /** Another solver's address (For experts); null uses the one inside Marquee. */
  url: string | null;
  /** Whether this install has a solver inside it. */
  bundled: boolean;
  /** off · starting · ready · failed · missing (no solver here and no address given) */
  state: 'off' | 'starting' | 'ready' | 'failed' | 'missing';
  message: string;
}


// ---- Discover, requests and notifications (Milestone 5) ----

/** Where a title stands for the person looking at it. */
export type CardState = 'in_library' | 'downloading' | 'pending' | 'approved' | 'declined' | 'none';

export interface DiscoverCard {
  kind: 'movie' | 'series';
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  backdropPath: string | null;
  overview: string;
  /** TMDB's 0–10 score; null when it has none yet. */
  score: number | null;
  genres: string[];
  state: CardState;
  /** The movie or show in your library, when it's there. */
  libraryId: number | null;
  /** "New", "Coming", "Trending"… */
  badge: string | null;
}

export interface DiscoverRow {
  id: string;
  title: string;
  subtitle: string | null;
  items: DiscoverCard[];
}

export interface ServiceChip {
  key: string;
  name: string;
}

export interface DiscoverPage {
  type: 'all' | 'movie' | 'series';
  /** "all" or a service key. */
  service: string;
  /** Services this person hasn't hidden. */
  services: ServiceChip[];
  hero: DiscoverCard[];
  rows: DiscoverRow[];
  /** Genres to browse, by name. */
  genres: string[];
  /** The genre being browsed, if any. */
  genre: string | null;
}

/** Everything TMDB knows about a title that a page can show. */
export interface TitleDetails {
  /** Release date (movies) or first air date (shows), "2026-12-20". */
  releaseDate: string | null;
  /** False for a movie not out yet, or a show whose first episode hasn't aired. */
  released: boolean;
  /** Movies, US: premiere, cinema, digital and disc dates. */
  releases: { kind: string; date: string }[];
  originalTitle: string | null;
  language: string | null;
  status: string | null;
  /** TMDB's 0–10 score and how many votes. */
  score: number | null;
  votes: number;
  directors: string[];
  writers: string[];
  studios: string[];
  networks: string[];
  countries: string[];
  budget: number | null;
  revenue: number | null;
  homepage: string | null;
  seasonCount: number | null;
  episodeCount: number | null;
  lastAirDate: string | null;
  nextAirDate: string | null;
  /** Movies: not out anywhere yet, only in cinemas, or out to stream or buy. Shows are always "out". */
  stage: 'announced' | 'cinemas' | 'out';
  /** Movies: when it's out to stream or buy. `known` is false when it's a guess (cinema date + 90 days). */
  homeRelease: { date: string; known: boolean } | null;
}

/** Scores from TMDB and, with an OMDb key, IMDb, Rotten Tomatoes and Metacritic. */
export interface TitleRatings {
  tmdb: { score: number; votes: number } | null;
  imdb: { score: number; votes: number } | null;
  /** Critics' Tomatometer, 0–100. */
  rottenTomatoes: number | null;
  metacritic: number | null;
  imdbId: string | null;
}

export interface CastMember {
  /** TMDB person id; opens their page. */
  id: number | null;
  name: string;
  character: string | null;
  profilePath: string | null;
}

/** An actor or director on TMDB and what they've been in. */
export interface PersonDetail {
  id: number;
  name: string;
  profilePath: string | null;
  biography: string | null;
  birthday: string | null;
  deathday: string | null;
  placeOfBirth: string | null;
  knownFor: string | null;
  /** Movies and shows, the more popular first; `role` is their part. */
  credits: (DiscoverCard & { role: string | null })[];
}

export interface DiscoverTitle {
  details: TitleDetails;
  card: DiscoverCard;
  tagline: string | null;
  runtime: number | null;
  certification: string | null;
  genres: string[];
  /** YouTube video key; null when there's no trailer or the person turned trailers off. */
  trailerKey: string | null;
  cast: CastMember[];
  /** Services streaming it in the US, one per service. */
  providers: string[];
  /** The same, with logos. */
  watchOn: { name: string; logoPath: string | null }[];
  ratings: TitleRatings;
  /** Shows: each season with where it stands. */
  seasons: { season: number; episodeCount: number; state: CardState }[];
  similar: DiscoverRow | null;
  /** This person's own open request for it, if any. */
  request: RequestView | null;
  /** False when there's nothing left to ask for (already here, or already asked for). */
  canRequest: boolean;
  /** Plain words for why not. */
  note: string | null;
}

/** The top 10 movies and top 10 shows on one streaming service. */
export interface ServiceTop {
  service: string;
  movies: DiscoverCard[];
  shows: DiscoverCard[];
  /** True when these are the service's own Top 10 (from Streaming Availability); false for TMDB's "popular on it", shown without numbers. */
  ranked: boolean;
  /** Admins: why the list isn't the real Top 10 and what to do, in plain words. Null when it is. */
  note: string | null;
}

export interface DiscoverPrefs {
  hiddenServices: string[];
  trailers: boolean;
  /** Every service there is a chip for (sent back with the person's choices). */
  all?: ServiceChip[];
}

export type RequestState = 'pending' | 'unreleased' | 'searching' | 'looking' | 'downloading' | 'ready' | 'declined';

export interface RequestView {
  id: number;
  kind: 'movie' | 'series';
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  /** null = the whole show (or a movie). */
  seasons: number[] | null;
  requestedBy: { id: number; name: string } | null;
  state: RequestState;
  /** A plain sentence for the state. */
  stateText: string;
  /** The profile picked on approval (its name); null = chosen by the rules. */
  profile: string | null;
  reason: string | null;
  decidedBy: string | null;
  createdAt: number;
  decidedAt: number | null;
  /** The movie or show page, once it's in the library. */
  href: string | null;
}

export interface NewRequest {
  kind: 'movie' | 'series';
  tmdbId: number;
  /** Shows: which seasons; omit for the whole show. */
  seasons?: number[];
}

/** One bit of information a notification carries, for {{key}} in its wording. */
export interface NotificationVar {
  key: string;
  label: string;
  /** Shown in the wording editor's preview. */
  example: string;
}

export type NotificationGroup = 'Requests' | 'Downloads' | 'Problems' | 'Watching' | 'Marquee';

export interface NotificationEventInfo {
  key: string;
  group: NotificationGroup;
  /** Off until you turn it on (chatty events, like every pause). */
  quiet?: boolean;
  label: string;
  description: string;
  /** Who it's for: admins (channels and inbox), or the person who asked. */
  audience: 'admins' | 'requester';
  vars: NotificationVar[];
  /** Marquee's own wording (templates). */
  title: string;
  body: string;
  image: string;
}

export interface NotificationChannelView {
  id: number;
  kind: 'pushover' | 'ntfy';
  name: string;
  enabled: boolean;
  events: string[];
  /** Non-secret part of the setup, e.g. the ntfy topic. */
  detail: string;
  lastOkAt: number | null;
  /** What went wrong last time, in plain words. */
  lastError: string | null;
}

export interface NotificationInboxItem {
  id: number;
  event: string;
  title: string;
  body: string;
  link: string | null;
  image: string | null;
  createdAt: number;
  read: boolean;
}

/** The wording for one event: Marquee's, or the admin's own. */
export interface NotificationTemplateView {
  event: string;
  title: string;
  body: string;
  image: string;
  /** True when an admin changed it. */
  custom: boolean;
}

export interface NotificationPreview {
  title: string;
  body: string;
  image: string | null;
  /** Names in the wording this event doesn't have. */
  unknown: string[];
}

/** Someone on Plex or Jellyfin who could get a Marquee account. */
export interface ServerPerson {
  id: string;
  username: string;
  name: string;
  /** Marquee username if they already have an account. */
  marqueeUser: string | null;
  /** An existing Marquee account with the same name, to link instead of making a new one. */
  suggest: number | null;
}

// ---- Activity (Plex and Jellyfin watching) ----

export interface NowPlayingView {
  server: 'plex' | 'jellyfin';
  /** The server's id for the stream; send it to stop the stream. */
  sessionId: string;
  platform: string;
  /** "4k", "1080", "720", "480" or "sd". */
  resolution: string | null;
  startedAt: number;
  user: string;
  /** The movie or show. */
  title: string;
  /** Year for a movie; "S02E03 · Episode name" for TV. */
  subtitle: string | null;
  device: string;
  state: 'playing' | 'paused' | 'buffering';
  /** 0 to 1 */
  progress: number;
  transcoding: boolean;
  /** The title's page in Marquee, if the library has it. */
  href: string | null;
}

export interface PlayView {
  id: number;
  server: 'plex' | 'jellyfin';
  user: string;
  title: string;
  subtitle: string | null;
  at: number;
  href: string | null;
}

export interface ActivityStats {
  days: number;
  total: number;
  last24h: number;
  perDay: { day: string; plays: number }[];
  /** Watches by hour of the day (0 to 23), in the server's time zone. */
  hours: number[];
  /** Watches by day of the week, Sunday first. */
  weekdays: number[];
  users: { name: string; plays: number }[];
  movies: { name: string; plays: number }[];
  shows: { name: string; plays: number }[];
  servers: { plex: number; jellyfin: number };
  /** From streams Marquee saw happen (not the servers' older history). */
  live: {
    streams: number;
    watchHours: number;
    /** Most streams playing at once. */
    peakStreams: number;
    direct: number;
    converted: number;
    platforms: { name: string; plays: number }[];
    resolutions: { name: string; plays: number }[];
    watchTime: { name: string; hours: number }[];
  };
  library: { files: number; bytes: number; resolutions: { name: string; count: number }[]; codecs: { name: string; count: number }[] };
}

export interface PersonSummary {
  name: string;
  plays: number;
  hours: number;
  last: number | null;
  devices: string[];
}

export interface StreamView {
  id: number;
  server: 'plex' | 'jellyfin';
  title: string;
  subtitle: string | null;
  device: string;
  platform: string;
  resolution: string | null;
  converted: boolean;
  startedAt: number;
  watchedMs: number;
  progress: number;
  /** Still playing. */
  going: boolean;
}

export interface PersonView extends PersonSummary {
  top: { name: string; plays: number }[];
  recent: PlayView[];
  streams: StreamView[];
}

export interface WatchersView {
  watchers: { user: string; plays: number; last: number; /** Different episodes seen (TV only). */ episodes: number | null }[];
}

// ---------------- Watched sync (Plex ↔ Jellyfin) ----------------

export interface WatchSyncPerson {
  userId: number;
  name: string;
  /** linked: on both servers; not_linked: needs a link; problem: couldn't read. */
  state: 'linked' | 'not_linked' | 'problem';
  /** What to do, in plain words, when it isn't linked or failed. */
  note: string | null;
  toPlex: number;
  toJellyfin: number;
  /** A few titles that would get a tick. */
  examples?: string[];
}

export interface WatchSyncPlan {
  ready: boolean;
  problem: string | null;
  people: WatchSyncPerson[];
  /** Ticks that would be added. */
  total: number;
}

export interface WatchSyncRun {
  at: number;
  ticked: number;
  failed: number;
  problem: string | null;
}

export interface WatchSyncStatus {
  enabled: boolean;
  last: WatchSyncRun | null;
  runs: { at: number; ticks: number; undone: number; items: { person: string; title: string; server: string }[] }[];
}

// ---------------- Running Marquee: Health, backups, logs ----------------

/** A background job on the Health page. */
export interface JobView {
  id: string;
  label: string;
  description: string;
  /** "Every 5 minutes", "Only when you ask". */
  every: string;
  /** ok: last run went fine (or hasn't run yet) · busy: running now · problem: last run failed · off: switched off. */
  tone: 'ok' | 'busy' | 'problem' | 'off';
  running: boolean;
  /** Why it's off, in plain words (and where to turn it on). */
  off: string | null;
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  /** null while running or before the first run. */
  lastOk: boolean | null;
  /** What the last run did, or what went wrong. */
  lastMessage: string | null;
  /** When it runs by itself next; null when off or only by hand. */
  nextAt: number | null;
}

/** One thing Marquee depends on (a Source, qBittorrent, Plex, TMDB…) and how it is. */
export interface ConnectionView {
  key: string;
  group: 'Sources' | 'Downloader' | 'Media servers' | 'Services';
  name: string;
  tone: 'ok' | 'attention' | 'problem' | 'off';
  /** Plain state, e.g. "Working", "Key turned down". */
  state: string;
  /** What to do about it, or null when nothing's needed. */
  fix: string | null;
  /** What it said, when that helps. Never holds secrets. */
  detail: string | null;
  /** The page where it's fixed. */
  to: string;
}

/** Free space on one folder Marquee writes to. */
export interface DiskView {
  key: 'downloads' | 'movies' | 'tv';
  label: string;
  path: string;
  /** Bytes; null when Marquee can't see the folder. */
  free: number | null;
  total: number | null;
  tone: 'ok' | 'problem';
  state: string;
  fix: string | null;
}

export interface DiskSettingsView {
  /** Where downloads land, as Marquee sees it. */
  downloadsFolder: string;
  /** false: worked out from the downloader's folder pairs (or /data/torrents). */
  downloadsFolderSet: boolean;
  /** Marquee keeps at least this much free on each disk. */
  minFreeGb: number;
  defaultMinFreeGb: number;
}

export interface DiskSettingsUpdate {
  /** null or "" works it out again. */
  downloadsFolder?: string | null;
  /** null puts the default back. */
  minFreeGb?: number | null;
}

export interface HealthView {
  checkedAt: number;
  /** How many rows need you. */
  problems: number;
  connections: ConnectionView[];
  disks: DiskView[];
  disk: DiskSettingsView;
  jobs: JobView[];
}

export type BackupKind = 'nightly' | 'by_hand' | 'before_restore';

export interface BackupView {
  /** File name; also its id in the API. */
  name: string;
  size: number;
  createdAt: number;
  kind: BackupKind;
}

export interface BackupsView {
  /** Where backups are kept, inside Marquee's data folder. */
  folder: string;
  keepDays: number;
  /** Newest first. */
  backups: BackupView[];
  lastNightly: number | null;
  nextNightly: number | null;
}

export interface RestoreResult {
  restored: BackupView;
  /** The backup taken just before, to undo the restore. */
  safety: BackupView;
  message: string;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogLine {
  id: number;
  at: number;
  level: LogLevel;
  /** The part of Marquee it came from ("sources", "downloads"), when it said. */
  area: string | null;
  message: string;
}

export interface LogsView {
  /** Oldest first. */
  lines: LogLine[];
  /** Lines kept in memory right now (all levels). */
  kept: number;
  /** The most Marquee keeps. */
  keepMax: number;
}

// ---------------- Library care (remove, rename, manual import, replaced files) ----------------

/** What "Remove from Marquee" would do, shown before anything happens. */
export interface RemovalPreview {
  kind: 'movie' | 'series';
  title: string;
  /** The library files Marquee knows for it, plus their subtitles: exactly what "Delete its files too" deletes. */
  files: { path: string; sizeBytes: number }[];
  totalBytes: number;
  /** The title's folder, when it has one. Removed only if it's empty afterwards. */
  folder: string | null;
  /** Downloads for it that haven't reached the library yet. */
  onTheWay: { id: number; copy: string; status: string }[];
  /** Downloads already in the library and still sharing; they carry on until their seeding rule. */
  sharing: number;
  /** People who asked for it. Their requests are taken away so it can be asked for again. */
  requests: string[];
}

export interface RemovalInput {
  /** Also delete these files. Must be exactly the preview's list, so nothing is deleted that wasn't shown. */
  deleteFiles?: string[];
  /** Don't add it back when scanning the library folders. */
  leaveOut: boolean;
  /** Downloads on the way: stop them and remove them from qBittorrent with what's downloaded so far, or only stop following them. */
  onTheWay: 'remove' | 'leave';
}

export interface RemovalResult {
  message: string;
  deleted: string[];
  /** Files that couldn't be deleted, with why. */
  problems: string[];
}

/** A title left out of scans. */
export interface LeftOutItem {
  id: number;
  kind: 'movie' | 'series';
  tmdbId: number;
  title: string;
  year: number | null;
  path: string | null;
  at: number;
  who: string | null;
}

export interface RenameMove {
  from: string;
  to: string;
  what: 'video' | 'subtitle' | 'other';
}

export interface RenameTitlePlan {
  kind: 'movie' | 'series';
  id: number;
  title: string;
  /** The title's folder now, and after. Equal when the folder keeps its name. */
  folderFrom: string | null;
  folderTo: string | null;
  moves: RenameMove[];
  /** Files left as they are, with why ("Another file already has that name."). */
  skipped: { path: string; reason: string }[];
}

/** "Rename files": every change, before anything moves. */
export interface RenamePlanView {
  kind: 'movie' | 'tv';
  /** Only titles with something to change. */
  titles: RenameTitlePlan[];
  /** Files already named the way the pattern says. */
  alreadyRight: number;
  pattern: string;
}

export interface RenameRunView {
  id: number;
  at: number;
  kind: 'movie' | 'tv';
  label: string;
  files: number;
  who: string | null;
  undoneAt: number | null;
}

export interface RenameResult {
  run: RenameRunView | null;
  moved: number;
  problems: string[];
  message: string;
}

export interface BrowseView {
  /** The folder shown, or null for the list of places you can start from. */
  path: string | null;
  parent: string | null;
  folders: { name: string; path: string }[];
  /** Where you can start: the downloads folder and the two library folders. */
  places: { label: string; path: string }[];
}

/** One video file found in a folder for "Put files in your library". */
export interface ImportFile {
  path: string;
  name: string;
  sizeBytes: number;
  /** Subtitles beside it that come along. */
  subtitles: string[];
  /** Already in your library under this title (nothing to do). */
  inLibrary: { kind: 'movie' | 'series'; id: number; title: string } | null;
  /** Marquee's guess, which you can change. */
  guess: ImportGuess | null;
}

export interface ImportGuess {
  kind: 'movie' | 'series';
  tmdbId: number;
  title: string;
  year: number | null;
  /** Shows only. */
  season: number | null;
  episodes: number[];
  /** Already in your library (its id there). */
  libraryId: number | null;
}

export interface ImportScanView {
  folder: string;
  files: ImportFile[];
  /** Under a library folder: files are moved, not linked. */
  inLibraryFolder: boolean;
}

export interface ImportItemInput {
  path: string;
  kind: 'movie' | 'series';
  tmdbId: number;
  season?: number;
  episodes?: number[];
}

export interface ImportItemResult {
  path: string;
  ok: boolean;
  message: string;
  href: string | null;
}

/** The hidden `.marquee-replaced` folders: files set aside by upgrades. */
export interface ReplacedView {
  folders: { label: string; path: string; files: number; bytes: number; freedBytes: number }[];
  files: number;
  bytes: number;
  /** What emptying them gives back. Files still shared by a download in qBittorrent free nothing. */
  freedBytes: number;
}
