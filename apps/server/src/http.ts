import type { DictionarryFetch } from './releases/dictionarry.js';
import type { ListFetch } from './library/lists.js';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import type { User } from './db/schema.js';
import type { OidcProvider } from './auth/oidc.js';
import type { PlexClient } from './auth/plex.js';
import type { RateLimiter } from './auth/rateLimit.js';
import { SESSION_COOKIE, SESSION_TTL, createSession } from './auth/sessions.js';
import type { StreamingTopApi } from './discover/streamingTop.js';
import type { TmdbApi } from './library/tmdb.js';
import type { OmdbApi } from './library/omdb.js';
import type { ArrApi } from './library/arr.js';
import type { LibraryScanner } from './library/scanner.js';
import type { SourceClients, SourceService } from './sources/service.js';
import type { QbitApi } from './downloads/qbittorrent.js';
import type { FetchedTorrent } from './downloads/torrent.js';
import type { CopyCache } from './downloads/cache.js';
import type { MediaServerApi } from './library/mediaServers.js';
import type { ActivityMonitor } from './activity/live.js';
import type { PushClient } from './notify/push.js';
import type { DiskProbe } from './system/disk.js';
import type { Unpacker } from './downloads/unpack.js';
import type { Jobs } from './system/jobs.js';
import type { LogBook } from './system/logs.js';

/** Builds clients for outside services. Tests swap these for fakes. */
export interface Clients extends SourceClients {
  tmdb(apiKey: string): TmdbApi;
  /** The streaming services' own Top 10s (Streaming Availability). */
  streamingTop(apiKey: string): StreamingTopApi;
  /** IMDb and Rotten Tomatoes scores (OMDb). */
  omdb(apiKey: string): OmdbApi;
  arr(kind: 'radarr' | 'sonarr', url: string, apiKey: string): ArrApi;
  /** qBittorrent (Web API v2). */
  qbittorrent(url: string, username: string, password: string): QbitApi;
  /** Fetches a copy's torrent or magnet on the server. `headers` (a site's cookies) go only to the link's own host. */
  fetchTorrent(url: string, headers?: Record<string, string>): Promise<FetchedTorrent>;
  /** Downloads the site catalogue (a zip of site files). */
  fetchCatalogue(): Promise<Uint8Array>;
  /** A Plex Media Server, to ask for scans. */
  plexServer(url: string, token: string): MediaServerApi;
  jellyfin(url: string, apiKey: string): MediaServerApi;
  /** Asks Jellyfin whether a username and password are right. */
  jellyfinLogin(url: string, username: string, password: string): Promise<{ id: string; name: string } | null>;
  /** Pushover and ntfy. */
  push: PushClient;
  /** Free space on a folder's disk. Tests fake it; left out, Marquee asks the system. */
  disk?: DiskProbe;
  /** Unpacks copies that come as .rar files. Tests fake it; left out, Marquee uses 7-Zip (7zz). */
  unpacker?: Unpacker;
  /** Dictionarry's newest version, for rule updates. Tests fake it; left out, Marquee asks GitHub. */
  dictionarry?: DictionarryFetch;
  /** Reads list pages and APIs (Plex watchlists, Trakt, IMDb, Letterboxd). Tests fake it; left out, Marquee uses fetch. */
  listFetch?: ListFetch;
}

export interface Deps {
  db: Db;
  config: Config;
  oidc: OidcProvider | null;
  plex: () => PlexClient;
  loginLimiter: RateLimiter;
  clients: Clients;
  scanner: LibraryScanner;
  sources: SourceService;
  /** Recent searches' copies, for "Download this". Made by createApp when not given. */
  copies: CopyCache;
  /** Follows what is playing on Plex and Jellyfin. Made by createApp when not given. */
  activity: ActivityMonitor;
  /** Every background job, for the Health page. Made by createApp when not given. */
  jobs: Jobs;
  /** Recent server log lines, for the Logs page. Made by createApp when not given. */
  logs: LogBook;
  now: () => number;
}

export type Env = { Variables: { user: User | null; deps: Deps } };
export type Ctx = Context<Env>;

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 502,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The public origin of this request, honoring MARQUEE_BASE_URL and reverse-proxy headers. */
export function publicOrigin(c: Ctx): string {
  const { config } = c.get('deps');
  if (config.baseUrl) return config.baseUrl;
  const url = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.replace(':', '');
  const host = c.req.header('x-forwarded-host')?.split(',')[0]?.trim() || c.req.header('host') || url.host;
  return `${proto}://${host}`;
}

export function isSecure(c: Ctx): boolean {
  return publicOrigin(c).startsWith('https://');
}

export function clientIp(c: Ctx): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'local';
}

export function signIn(c: Ctx, user: User): void {
  const { db, now } = c.get('deps');
  const token = createSession(db, user.id, c.req.header('user-agent'), now());
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isSecure(c),
    path: '/',
    maxAge: SESSION_TTL / 1000,
  });
}

export function sessionToken(c: Ctx): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

export function clearSessionCookie(c: Ctx): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export function requireUser(c: Ctx): User {
  const user = c.get('user');
  if (!user) throw new HttpError(401, 'unauthenticated', 'Please sign in.');
  return user;
}

export function requireAdmin(c: Ctx): User {
  const user = requireUser(c);
  if (user.role !== 'admin') throw new HttpError(403, 'forbidden', 'Only admins can do that.');
  return user;
}
