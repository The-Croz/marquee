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
  /** `href` is the show's page (real data only). */
  upcoming: { day: string; title: string; note: string; href?: string }[];
}

// ---- Settings → Services ----

export interface ServicesView {
  tmdb: { configured: boolean; fromEnvironment: boolean };
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
export type SourceState = 'unchecked' | 'working' | 'paused' | 'unreachable' | 'key_refused' | 'slowed_down' | 'set_aside' | 'blocked' | 'not_a_feed' | 'error';

export interface SourceView {
  id: number;
  name: string;
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
  /** The library files it became. */
  importedPaths: string[] | null;
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

// ---------------------------------------------------------------- comparison mode (against Radarr)

export type CompareVerdict = 'same' | 'same_quality' | 'higher' | 'lower' | 'nothing';

export interface ComparisonView {
  id: number;
  /** Marquee's movie, if it's in the library. */
  movieId: number | null;
  title: string;
  grabbedAt: number;
  status: 'waiting' | 'done' | 'failed';
  /** own_search: Marquee searched its own Sources. same_list: Marquee judged the copies Radarr itself saw. */
  mode: 'own_search' | 'same_list' | null;
  profileName: string | null;
  verdict: CompareVerdict | null;
  /** One plain sentence on what happened. */
  summary: string;
  /** What Radarr downloaded. */
  radarrTitle: string;
  radarrQuality: string;
  radarrScore: number;
  /** Radarr's download as Marquee judges it (null until compared). */
  radarrCopy: CopyView | null;
  /** What Marquee would have picked. */
  marqueeCopy: CopyView | null;
  message: string | null;
  checkedAt: number | null;
}

export interface CompareView {
  enabled: boolean;
  radarrConnected: boolean;
  lastRun: number | null;
  waiting: number;
  total: number;
  counts: Record<CompareVerdict, number>;
  /** Share of compared downloads where both picked the same quality or copy, 0–100; null before any. */
  agreement: number | null;
  items: ComparisonView[];
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

// ---------------------------------------------------------------- switching movies over from Radarr

export interface CutoverStep {
  key: 'agree' | 'movies_first' | 'downloader' | 'import' | 'media' | 'radarr_queue' | 'radarr_off' | 'sonarr_queue' | 'sonarr_off' | 'take_over';
  title: string;
  /** done: checked and fine · todo: needs doing · warn: works but worth a look · unknown: Marquee can't check */
  state: 'done' | 'todo' | 'warn' | 'unknown';
  /** What Marquee found, and what to do. */
  detail: string;
  action: { label: string; to: string } | null;
}

export interface WantedRunView {
  at: number;
  /** missing: titles with no file · better: titles you have · new: new episodes from the Sources' newest copies */
  kind: 'missing' | 'better' | 'new';
  /** Searches made (for "new": copies looked at). */
  searched: number;
  /** `href` is the movie or show page; `title` says which season or episode for TV. */
  sent: { href: string; title: string; copy: string }[];
  problems: string[];
}

export interface CutoverView {
  kind: 'movie' | 'tv';
  steps: CutoverStep[];
  /** Every step before "Marquee looks for wanted movies" is done. */
  ready: boolean;
  lookingForWanted: boolean;
  /** The last few searches Marquee ran by itself, newest first. */
  runs: WantedRunView[];
}

// ---- Calendar ----

export interface CalendarItem {
  seriesId: number;
  show: string;
  posterPath: string | null;
  season: number;
  episode: number;
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
