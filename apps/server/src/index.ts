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
import { ArrClient, RadarrHistoryClient } from './library/arr.js';
import { LibraryScanner } from './library/scanner.js';
import { TorznabClient } from './sources/torznab.js';
import { ProwlarrClient } from './sources/prowlarr.js';
import { SourceService } from './sources/service.js';
import { ComparisonService } from './compare/service.js';
import { QbitClient } from './downloads/qbittorrent.js';
import { fetchTorrent } from './downloads/torrent.js';
import { sharedMonitor } from './downloads/monitor.js';
import { wantedTick } from './downloads/wanted.js';
import { JellyfinClient, PlexServerClient } from './library/mediaServers.js';

const config = loadConfig();
const db = openDb(path.join(config.dataDir, 'marquee.sqlite'));
const clientId = plexClientId(db);

const clients = {
  tmdb: (key: string) => new TmdbClient(key, db),
  arr: (kind: 'radarr' | 'sonarr', url: string, key: string) => new ArrClient(kind, url, key),
  radarrHistory: (url: string, key: string) => new RadarrHistoryClient(url, key),
  torznab: (url: string, key: string, timeoutMs: number) => new TorznabClient(url, key, timeoutMs),
  prowlarr: (url: string, key: string) => new ProwlarrClient(url, key),
  qbittorrent: (url: string, username: string, password: string) => new QbitClient(url, username, password),
  fetchTorrent: (url: string) => fetchTorrent(url),
  plexServer: (url: string, token: string) => new PlexServerClient(url, token),
  jellyfin: (url: string, key: string) => new JellyfinClient(url, key),
};
const sources = new SourceService(db, clients);

const app = createApp({
  db,
  config,
  oidc: config.oidc ? new OidcProvider(config.oidc) : null,
  plex: () => new PlexClient(clientId),
  loginLimiter: new RateLimiter(10, 15 * 60 * 1000),
  clients,
  scanner: new LibraryScanner(db),
  sources,
  now: Date.now,
});

purgeExpiredSessions(db);
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

// Comparison mode: every hour, bring in Radarr's new downloads and compare a few.
const comparisons = new ComparisonService(db, config, clients, sources, Date.now);
setInterval(() => {
  if (!comparisons.enabled()) return;
  comparisons.run().then(
    (r) => r.compared && console.log(`[compare] compared ${r.compared}, ${r.waiting} waiting`),
    (err) => console.error('[compare] run failed:', (err as Error).message),
  );
}, 60 * 60 * 1000).unref();

// Downloads: follow qBittorrent every minute; stuck or fake downloads get another copy.
const downloads = sharedMonitor({ db, clients, sources, now: Date.now });
setInterval(() => {
  downloads.check().then(
    (r) => r.replaced && console.log(`[downloads] tried another copy for ${r.replaced}`),
    (err) => console.error('[downloads] check failed:', (err as Error).message),
  );
}, 60 * 1000).unref();

// Once switched over: look for missing movies every 6 hours and better copies once a day.
setInterval(() => {
  wantedTick({ db, clients, sources, now: Date.now }).then(
    (r) => r && console.log(`[wanted] ${r.kind}: searched ${r.searched}, sent ${r.sent.length}`),
    (err) => console.error('[wanted] failed:', (err as Error).message),
  );
}, 5 * 60 * 1000).unref();

const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  console.log(`Marquee listening on http://0.0.0.0:${info.port}`);
  console.log(`  data: ${config.dataDir}`);
  console.log(`  sign-in: password${config.oidc ? `, ${config.oidc.name} (OIDC)` : ''}${config.plex.enabled ? ', Plex' : ''}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    db.$client.close();
    process.exit(0);
  });
}
