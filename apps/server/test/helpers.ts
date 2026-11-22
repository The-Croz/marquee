import { openDb } from '../src/db/index.js';
import { ActivityMonitor } from '../src/activity/live.js';
import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { RateLimiter } from '../src/auth/rateLimit.js';
import { OidcProvider } from '../src/auth/oidc.js';
import type { PlexClient } from '../src/auth/plex.js';
import { LibraryScanner } from '../src/library/scanner.js';
import type { Clients } from '../src/http.js';
import { SourceService } from '../src/sources/service.js';
import type { LogBook } from '../src/system/logs.js';

export interface TestOptions {
  config?: Partial<Config>;
  plex?: Partial<PlexClient>;
  clients?: Partial<Clients>;
  now?: () => number;
  /** The log book behind Settings → Logs. */
  logs?: LogBook;
}

export function makeApp(opts: TestOptions = {}) {
  const db = openDb(':memory:');
  const config: Config = { ...loadConfig({}), webDir: null, ...opts.config };
  const scanner = new LibraryScanner(db);
  const clients: Clients = {
    tmdb: () => {
      throw new Error('no TMDB in this test');
    },
    arr: () => {
      throw new Error('no Radarr/Sonarr in this test');
    },
    streamingTop: () => {
      throw new Error('no Streaming Availability in this test');
    },
    omdb: () => {
      throw new Error('no OMDb in this test');
    },
    torznab: () => {
      throw new Error('no Torznab feeds in this test');
    },
    prowlarr: () => {
      throw new Error('no Prowlarr in this test');
    },
    qbittorrent: () => {
      throw new Error('no qBittorrent in this test');
    },
    fetchTorrent: () => {
      throw new Error('no torrent downloads in this test');
    },
    plexServer: () => {
      throw new Error('no Plex server in this test');
    },
    jellyfin: () => {
      throw new Error('no Jellyfin in this test');
    },
    jellyfinLogin: async () => {
      throw new Error('no Jellyfin sign-in in this test');
    },
    push: { send: async () => {} },
    siteFetch: () => {
      throw new Error('no sites in this test');
    },
    solver: () => {
      throw new Error('no bot-check solver in this test');
    },
    fetchCatalogue: () => {
      throw new Error('no site catalogue in this test');
    },
    ...opts.clients,
  };
  const now = opts.now ?? Date.now;
  const sources = new SourceService(db, clients, now, async () => {});
  const activity = new ActivityMonitor({ db, clients, now, notify: () => ({ db, push: clients.push, now, baseUrl: () => null }) });
  const app = createApp({
    activity,
    db,
    config,
    oidc: config.oidc ? new OidcProvider(config.oidc) : null,
    plex: () => opts.plex as PlexClient,
    loginLimiter: new RateLimiter(10, 15 * 60 * 1000),
    clients,
    scanner,
    sources,
    ...(opts.logs ? { logs: opts.logs } : {}),
    now,
  });
  return { app, db, config, scanner, sources, activity };
}

type App = ReturnType<typeof makeApp>['app'];

export interface Res {
  status: number;
  body: any;
  cookie: string | undefined;
  location: string | null;
  setCookies: string[];
}

/** Calls the app like a browser would. Pass `cookie` to act as a signed-in user. */
export async function call(app: App, method: string, path: string, body?: unknown, cookie?: string, headers: Record<string, string> = {}): Promise<Res> {
  const res = await app.request(path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookies = res.headers.getSetCookie();
  const session = setCookies.find((c) => c.startsWith('marquee_session=') && !c.startsWith('marquee_session=;'));
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: parsed, cookie: session?.split(';')[0], location: res.headers.get('location'), setCookies };
}

export const ADMIN = { username: 'josh', password: 'correct horse battery', displayName: 'Josh' };

export async function setupAdmin(app: App): Promise<string> {
  const res = await call(app, 'POST', '/api/auth/setup', ADMIN);
  if (res.status !== 201 || !res.cookie) throw new Error(`setup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.cookie;
}
