import { openDb } from '../src/db/index.js';
import { ActivityMonitor } from '../src/activity/live.js';
import { readServices } from '../src/library/services.js';
import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { RateLimiter } from '../src/auth/rateLimit.js';
import { OidcProvider } from '../src/auth/oidc.js';
import type { PlexClient } from '../src/auth/plex.js';
import { LibraryScanner } from '../src/library/scanner.js';
import type { Clients } from '../src/http.js';
import { SourceService } from '../src/sources/service.js';
import type { LogBook } from '../src/system/logs.js';
import { FakeUnpacker } from './fakes/unpack.js';

export interface TestOptions {
  config?: Partial<Config>;
  plex?: Partial<PlexClient>;
  clients?: Partial<Clients>;
  now?: () => number;
  /** The log book behind Settings → Logs. */
  logs?: LogBook;
  /** Built-in profiles on TRaSH, as before Dictionarry (for download tests with made-up copy names). */
  trashPresets?: boolean;
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
    mdblist: () => {
      throw new Error('no MDBList in this test');
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
    // A fake 7-Zip, so no test depends on one being installed.
    unpacker: new FakeUnpacker(),
    ...opts.clients,
  };
  const now = opts.now ?? Date.now;
  const sources = new SourceService(db, clients, now, async () => {});
  const activity = new ActivityMonitor({ db, clients, now, tmdbKey: () => readServices(db, config).tmdbApiKey, notify: () => ({ db, push: clients.push, now, baseUrl: () => null }) });
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
  if (opts.trashPresets) useTrashPresets(db);
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

// ---------------------------------------------------------------- TRaSH profiles (the presets before Dictionarry)

import { TRASH } from '../src/releases/formats.js';
import { eq } from 'drizzle-orm';
import { schema as dbSchema, type Db } from '../src/db/index.js';
import { fromTrash, writeRules, type FullProfile, type Kind, type SizeLimit } from '../src/releases/profiles.js';

/**
 * The three presets as they were built on TRaSH before Dictionarry became the
 * default, for tests about the decision engine's mechanics (sizes, ranking,
 * TRaSH's points). TRaSH stays a choice for new profiles.
 */
export function trashPreset(kind: Kind, key: 'cinema' | 'everyday-hd' | 'kids'): FullProfile {
  const kidsSizes = (): Record<string, SizeLimit> => {
    const out: Record<string, SizeLimit> = {};
    for (const q of ['WEBDL-1080p', 'WEBRip-1080p']) out[q] = { min: TRASH.radarr.sizes.find((s) => s.quality === q)!.min, preferred: 39, max: 40 };
    return out;
  };
  const text = { name: key === 'cinema' ? '4K Quality' : key === 'kids' ? 'Kids & Cartoons' : 'Everyday HD', description: '' };
  const v =
    kind === 'movie'
      ? key === 'cinema'
        ? fromTrash('radarr', 'UHD Bluray + WEB', ['HD Bluray + WEB'], ['Bluray-2160p', 'WEB 2160p', 'Bluray-1080p', 'WEB 1080p'], 'Bluray-2160p', text)
        : key === 'everyday-hd'
          ? fromTrash('radarr', 'HD Bluray + WEB', [], ['Bluray-1080p', 'WEB 1080p', 'Bluray-720p'], 'Bluray-1080p', text)
          : fromTrash('radarr', 'HD Bluray + WEB', [], ['Bluray-720p', 'WEB 720p', 'WEB 1080p'], 'Bluray-720p', text, kidsSizes())
      : key === 'cinema'
        ? fromTrash('sonarr', 'WEB-2160p', ['WEB-1080p'], ['WEB 2160p', 'WEB 1080p'], 'WEB 2160p', text)
        : key === 'everyday-hd'
          ? fromTrash('sonarr', 'WEB-1080p', [], ['WEB 1080p', 'Bluray-1080p'], 'WEB 1080p', text)
          : fromTrash('sonarr', 'WEB-1080p', [], ['WEB 1080p', 'Bluray-1080p', 'WEB 720p', 'Bluray-720p', 'HDTV-720p', 'WEB 480p', 'DVD', 'SDTV'], 'WEB 1080p', text);
  return { id: 0, kind, key: `trash-${key}`, preset: null, ...v };
}

/**
 * Puts the six built-in profiles back on TRaSH, as they were before Dictionarry,
 * for tests about downloading rather than profiles: their made-up copy names
 * ("…-GROUP") are fine for TRaSH but not ranked by Dictionarry.
 */
export function useTrashPresets(db: Db): void {
  for (const row of db.select().from(dbSchema.profiles).all()) {
    if (!row.preset) continue;
    const v = trashPreset(row.kind, row.preset as 'cinema' | 'everyday-hd' | 'kids');
    db.update(dbSchema.profiles)
      .set({ tiers: JSON.stringify(v.tiers), cutoff: v.cutoff, upgrades: v.upgrades, minScore: v.minScore, cutoffScore: v.cutoffScore, minUpgradeScore: v.minUpgradeScore, sizes: JSON.stringify(v.sizes), database: 'trash', base: v.base ?? null, preferRepacks: true })
      .where(eq(dbSchema.profiles.id, row.id))
      .run();
    writeRules(db, row.id, v.rules);
  }
}
