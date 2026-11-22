import { markReady } from './requests/service.js';
import { HttpPushClient } from './notify/push.js';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { createApp } from './app.js';
import { OidcProvider } from './auth/oidc.js';
import { PlexClient, plexClientId } from './auth/plex.js';
import { RateLimiter } from './auth/rateLimit.js';
import { purgeExpiredSessions } from './auth/sessions.js';
import { TmdbClient } from './library/tmdb.js';
import { StreamingAvailabilityClient } from './discover/streamingTop.js';
import { OmdbClient } from './library/omdb.js';
import { ArrClient } from './library/arr.js';
import { LibraryScanner } from './library/scanner.js';
import { TorznabClient } from './sources/torznab.js';
import { ProwlarrClient } from './sources/prowlarr.js';
import { SourceService } from './sources/service.js';
import { QbitClient } from './downloads/qbittorrent.js';
import { fetchTorrent } from './downloads/torrent.js';
import { ActivityMonitor } from './activity/live.js';
import { syncPlays } from './activity/service.js';
import { checkHealth } from './notify/health.js';
import { announceVersion } from './notify/updated.js';
import { runSync, syncEnabled } from './watchsync/sync.js';
import { once } from './routes/watchSync.js';
import { VERSION } from './version.js';
import { sharedMonitor } from './downloads/monitor.js';
import { wantedTick } from './downloads/wanted.js';
import { wantedTvTick } from './downloads/wantedTv.js';
import { refreshAiring } from './library/airing.js';
import { colorPosters } from './library/posterColor.js';
import { JellyfinClient, PlexServerClient, jellyfinCheckLogin } from './library/mediaServers.js';
import { realSiteFetch } from './sources/sites/http.js';
import { BundledSolver, FlareSolverrClient } from './sources/sites/solver.js';
import { CATALOGUE_URL, catalogueDue, refreshCatalogue } from './sources/sites/catalogue.js';

const config = loadConfig();
const db = openDb(path.join(config.dataDir, 'marquee.sqlite'));
const clientId = plexClientId(db);

const clients = {
  tmdb: (key: string) => new TmdbClient(key, db),
  streamingTop: (key: string) => new StreamingAvailabilityClient(key, db),
  omdb: (key: string) => new OmdbClient(key, db),
  arr: (kind: 'radarr' | 'sonarr', url: string, key: string) => new ArrClient(kind, url, key),
  torznab: (url: string, key: string, timeoutMs: number) => new TorznabClient(url, key, timeoutMs),
  prowlarr: (url: string, key: string) => new ProwlarrClient(url, key),
  qbittorrent: (url: string, username: string, password: string) => new QbitClient(url, username, password),
  fetchTorrent: (url: string, headers?: Record<string, string>) => fetchTorrent(url, fetch, 30_000, headers),
  plexServer: (url: string, token: string) => new PlexServerClient(url, token),
  jellyfin: (url: string, key: string) => new JellyfinClient(url, key),
  jellyfinLogin: (url: string, username: string, password: string) => jellyfinCheckLogin(url, username, password),
  push: new HttpPushClient(),
  siteFetch: realSiteFetch,
  solver: (url: string) => new FlareSolverrClient(url),
  fetchCatalogue: async () => {
    const res = await fetch(CATALOGUE_URL, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`answered ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  },
};
// The bot-check solver inside Marquee's image, started only when a site needs it.
const bundledSolver = new BundledSolver(process.env.MARQUEE_SOLVER_BIN ?? null, config.dataDir);
const sources = new SourceService(db, clients, Date.now, undefined, bundledSolver);

const appScanner = new LibraryScanner(db);
// Follows Plex and Jellyfin: their live lines, plus a quick look while anything is playing.
const activity = new ActivityMonitor({ db, clients, now: Date.now, notify: () => ({ db, push: clients.push, now: Date.now, baseUrl: () => config.baseUrl ?? null }) });
activity.start();
const app = createApp({
  activity,
  db,
  config,
  oidc: config.oidc ? new OidcProvider(config.oidc) : null,
  plex: () => new PlexClient(clientId),
  loginLimiter: new RateLimiter(10, 15 * 60 * 1000),
  clients,
  scanner: appScanner,
  sources,
  now: Date.now,
});

purgeExpiredSessions(db);
announceVersion({ db, push: clients.push, now: Date.now, baseUrl: () => config.baseUrl ?? null }, VERSION).catch((err) => console.error('[notify] version check failed:', (err as Error).message));
setInterval(() => purgeExpiredSessions(db), 6 * 60 * 60 * 1000).unref();

// Keep Prowlarr's sites in step every 6 hours, and forget old Source calls.
const housekeeping = () => {
  sources.prune();
  if (sources.prowlarrSettings().url) {
    sources.syncProwlarr().then(
      (r) => console.log(`[sources] ${r.message}`),
      (err) => console.error('[sources] Prowlarr sync failed:', (err as Error).message),
    );
  }
};
housekeeping();
setInterval(housekeeping, 6 * 60 * 60 * 1000).unref();

// The list of sites Marquee can run: Prowlarr's catalogue once a day, plus your own files.
const catalogue = () => {
  if (!catalogueDue(db, Date.now())) return;
  refreshCatalogue({ db, dataDir: config.dataDir, fetchCatalogue: clients.fetchCatalogue, now: Date.now }).then(
    (r) => console.log(`[sites] ${r.message}`),
    (err) => console.error('[sites] catalogue failed:', (err as Error).message),
  );
};
catalogue();
setInterval(catalogue, 60 * 60 * 1000).unref();

// Downloads: follow qBittorrent every minute; stuck or fake downloads get another copy.
const downloads = sharedMonitor({ db, clients, sources, now: Date.now, notify: { db, push: clients.push, now: Date.now, baseUrl: () => config.baseUrl ?? null } });
setInterval(() => {
  downloads.check().then(
    (r) => {
      markReady({ db, notify: { db, push: clients.push, now: Date.now, baseUrl: () => config.baseUrl ?? null }, now: Date.now });
      if (r.replaced) console.log(`[downloads] tried another copy for ${r.replaced}`);
    },
    (err) => console.error('[downloads] check failed:', (err as Error).message),
  );
}, 60 * 1000).unref();

// Copy new watches from Plex and Jellyfin: a minute after start, then every 15 minutes.
const plays = () => syncPlays({ db, clients, now: Date.now }).then(
  (r) => (r.added || r.problems.length) && console.log(`[activity] copied ${r.added} watches${r.problems.length ? `; ${r.problems.join('; ')}` : ''}`),
  (err) => console.error('[activity] failed:', (err as Error).message),
);
setTimeout(plays, 60 * 1000).unref();
setInterval(plays, 15 * 60 * 1000).unref();

// Tell admins once when a Source or the downloader stops working, and when wanted episodes air.
setInterval(() => {
  checkHealth({ db, clients, push: clients.push, now: Date.now, baseUrl: () => config.baseUrl ?? null }).catch((err) => console.error('[health] failed:', (err as Error).message));
}, 5 * 60 * 1000).unref();

// Watched sync (when turned on): every 30 minutes, tick on each server what was watched on the other.
setInterval(() => {
  if (!syncEnabled(db)) return;
  once(() => runSync({ db, clients, now: Date.now })).catch((err) => console.error('[watch sync] failed:', (err as Error).message));
}, 30 * 60 * 1000).unref();

// Once switched over: look for missing movies every 6 hours and better copies once a day;
// for TV also read the Sources' newest copies every 30 minutes. Runs one at a time.
let wantedBusy = false;
setInterval(async () => {
  if (wantedBusy) return;
  wantedBusy = true;
  try {
    for (const [name, tick] of [['movies', wantedTick], ['tv', wantedTvTick]] as const) {
      const r = await tick({ db, clients, sources, now: Date.now }).catch((err: Error) => console.error(`[wanted ${name}] failed:`, err.message));
      if (r) console.log(`[wanted ${name}] ${r.kind}: searched ${r.searched}, sent ${r.sent.length}`);
    }
  } finally {
    wantedBusy = false;
  }
}, 5 * 60 * 1000).unref();

// Keep air dates fresh for shows still on the air (new episodes, moved dates).
const airing = () =>
  refreshAiring({ db, config, clients, scanner: appScanner, now: Date.now }).then(
    (r) => r.refreshed && console.log(`[airing] refreshed ${r.refreshed} shows`),
    (err) => console.error('[airing] failed:', (err as Error).message),
  );
setTimeout(airing, 60 * 1000).unref();
setInterval(airing, 60 * 60 * 1000).unref();

// Pick each poster's main colour: new titles, changed posters, and the whole library the first time.
let coloring = false;
const posterColors = async () => {
  if (coloring) return;
  coloring = true;
  try {
    const r = await colorPosters(db);
    if (r.colored || r.failed) console.log(`[posters] coloured ${r.colored}${r.failed ? `, ${r.failed} had no usable image` : ''}`);
  } catch (err) {
    console.error('[posters] will try again later:', (err as Error).message);
  } finally {
    coloring = false;
  }
};
setTimeout(posterColors, 90 * 1000).unref();
setInterval(posterColors, 10 * 60 * 1000).unref();

const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  console.log(`Marquee listening on http://0.0.0.0:${info.port}`);
  console.log(`  data: ${config.dataDir}`);
  console.log(`  sign-in: password${config.oidc ? `, ${config.oidc.name} (OIDC)` : ''}${config.plex.enabled ? ', Plex' : ''}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    activity.stopWatching();
    bundledSolver.stop();
    db.$client.close();
    process.exit(0);
  });
}
