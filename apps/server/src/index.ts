import { markReady } from './requests/service.js';
import { HttpPushClient } from './notify/push.js';
import { ApnsClient } from './notify/apns.js';
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
import { MdbListClient } from './library/mdblist.js';
import { ArrClient } from './library/arr.js';
import { LibraryScanner } from './library/scanner.js';
import { TorznabClient } from './sources/torznab.js';
import { ProwlarrClient } from './sources/prowlarr.js';
import { SourceService } from './sources/service.js';
import { QbitClient } from './downloads/qbittorrent.js';
import { fetchTorrent } from './downloads/torrent.js';
import { ActivityMonitor } from './activity/live.js';
import { readServices } from './library/services.js';
import { syncPlays } from './activity/service.js';
import { refreshPlexAvatars } from './auth/avatars.js';
import { checkHealth } from './notify/health.js';
import { announceVersion } from './notify/updated.js';
import { runSync, syncAfterPlays, syncEnabled } from './watchsync/sync.js';
import { once } from './routes/watchSync.js';
import { VERSION } from './version.js';
import { Jobs } from './system/jobs.js';
import { captureConsole, serverLog, watchSecrets } from './system/logs.js';
import { KEEP_DAYS, backUpBeforeUpdate, nightlyBackup } from './system/backups.js';
import { labelRequested } from './library/onServers.js';
import { lookingForWanted } from './downloads/wanted.js';
import { lookingForWantedTv } from './downloads/wantedTv.js';
import { sharedMonitor } from './downloads/monitor.js';
import { wantedTick } from './downloads/wanted.js';
import { wantedTvTick } from './downloads/wantedTv.js';
import { refreshAiring } from './library/airing.js';
import { colorPosters } from './library/posterColor.js';
import { JellyfinClient, PlexServerClient, jellyfinCheckLogin } from './library/mediaServers.js';
import { realSiteFetch } from './sources/sites/http.js';
import { BundledSolver, FlareSolverrClient } from './sources/sites/solver.js';
import { CATALOGUE_URL, catalogueDue, refreshCatalogue } from './sources/sites/catalogue.js';
import { githubFetch } from './releases/dictionarry.js';
import { checkDue, checkForRuleUpdates } from './releases/ruleUpdates.js';

// Keep recent log lines (secrets taken out) for Settings → Logs.
captureConsole(serverLog);
const config = loadConfig();
const db = openDb(path.join(config.dataDir, 'marquee.sqlite'), {
  beforeUpdate: (sqlite, from, to) => console.log(`[backups] Updating the database (${from} → ${to}); backed it up first: ${backUpBeforeUpdate(sqlite, config.dataDir, Date.now())}`),
});
const clientId = plexClientId(db);
watchSecrets(db);

const apnsClient = ApnsClient.forDb(db);
const clients = {
  tmdb: (key: string) => new TmdbClient(key, db),
  streamingTop: (key: string) => new StreamingAvailabilityClient(key, db),
  mdblist: (key: string) => new MdbListClient(key, db),
  arr: (kind: 'radarr' | 'sonarr', url: string, key: string) => new ArrClient(kind, url, key),
  torznab: (url: string, key: string, timeoutMs: number) => new TorznabClient(url, key, timeoutMs),
  prowlarr: (url: string, key: string) => new ProwlarrClient(url, key),
  qbittorrent: (url: string, username: string, password: string) => new QbitClient(url, username, password),
  fetchTorrent: (url: string, headers?: Record<string, string>) => fetchTorrent(url, fetch, 30_000, headers),
  plexServer: (url: string, token: string) => new PlexServerClient(url, token),
  jellyfin: (url: string, key: string) => new JellyfinClient(url, key),
  jellyfinLogin: (url: string, username: string, password: string) => jellyfinCheckLogin(url, username, password),
  push: new HttpPushClient(fetch, apnsClient),
  apns: apnsClient,
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
const jobs = new Jobs(db, Date.now);
// Follows Plex and Jellyfin: their live lines, plus a quick look while anything is playing.
// Watched sync runs shortly after a play stops (the live line tells us), as well as every 30 minutes.
const syncSoon = syncAfterPlays(() => once(() => runSync({ db, clients, now: Date.now })), () => syncEnabled(db));
const activity = new ActivityMonitor({ db, clients, now: Date.now, tmdbKey: () => readServices(db, config).tmdbApiKey, notify: () => ({ db, push: clients.push, now: Date.now, baseUrl: () => config.baseUrl ?? null }), onStopped: () => syncSoon() });
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
  jobs,
  logs: serverLog,
  now: Date.now,
});

announceVersion({ db, push: clients.push, now: Date.now, baseUrl: () => config.baseUrl ?? null }, VERSION).catch((err) => console.error('[notify] version check failed:', (err as Error).message));

// Every background job, in one list (Settings → Health shows them, with Run now).
const notifyDeps = { db, push: clients.push, now: Date.now, baseUrl: () => config.baseUrl ?? null };
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const downloads = sharedMonitor({ db, clients, sources, now: Date.now, notify: notifyDeps });
jobs
  .add({
    id: 'downloads',
    label: 'Follow downloads',
    description: 'Checks qBittorrent, puts finished downloads in the library, and tries another copy for stuck or fake ones.',
    everyMs: MIN,
    run: async () => {
      const r = await downloads.check();
      markReady({ db, notify: notifyDeps, now: Date.now });
      return r.replaced ? `Tried another copy for ${r.replaced}` : 'Checked';
    },
  })
  .add({
    id: 'wanted',
    label: 'Look for wanted titles',
    description: 'Missing movies and episodes every 6 hours, better copies once a day, and new episodes every 30 minutes. Each kind runs only when it’s due.',
    everyMs: 5 * MIN,
    off: () => (lookingForWanted(db) || lookingForWantedTv(db) ? null : 'Turn on automatic searching in Settings → Automatic searching.'),
    run: async () => {
      const said: string[] = [];
      const failed: string[] = [];
      for (const [name, tick] of [['Movies', wantedTick], ['TV', wantedTvTick]] as const) {
        try {
          const r = await tick({ db, clients, sources, now: Date.now });
          if (r) {
            console.log(`[wanted ${name.toLowerCase()}] ${r.kind}: searched ${r.searched}, sent ${r.sent.length}`);
            said.push(`${name}: searched ${r.searched}, sent ${r.sent.length}`);
          }
        } catch (err) {
          failed.push(`${name}: ${(err as Error).message}`);
        }
      }
      if (failed.length) throw new Error([...said, ...failed].join(' · '));
      return said.length ? said.join(' · ') : 'Nothing was due';
    },
  })
  .add({
    id: 'health',
    label: 'Check connections',
    description: 'Tells admins once when a Source, qBittorrent, Plex, Jellyfin or a disk has a problem, and when wanted episodes come out.',
    everyMs: 5 * MIN,
    run: async () => {
      await checkHealth({ db, clients, push: clients.push, now: Date.now, baseUrl: () => config.baseUrl ?? null });
    },
  })
  .add({
    id: 'plays',
    label: 'Copy watches from Plex and Jellyfin',
    description: 'Copies what everyone watched into Marquee’s history.',
    everyMs: 15 * MIN,
    firstAfterMs: MIN,
    run: async () => {
      // Pictures come along: who has an account rarely changes, so their faces ride with the watches.
      await refreshPlexAvatars({ db, clients }).catch((err) => console.warn(`[avatars] couldn't read Plex pictures: ${(err as Error).message}`));
      const r = await syncPlays({ db, clients, now: Date.now });
      if (r.added || r.problems.length) console.log(`[activity] copied ${r.added} watches${r.problems.length ? `; ${r.problems.join('; ')}` : ''}`);
      if (r.problems.length && !r.added) throw new Error(r.problems.join('; '));
      return `Copied ${r.added} ${r.added === 1 ? 'watch' : 'watches'}${r.problems.length ? `; ${r.problems.join('; ')}` : ''}`;
    },
  })
  .add({
    id: 'watch-sync',
    label: 'Watched sync',
    description: 'Ticks on each server what was watched on the other.',
    everyMs: 30 * MIN,
    off: () => (syncEnabled(db) ? null : 'Turn it on in Settings → Watched sync.'),
    run: async () => {
      const r = await once(() => runSync({ db, clients, now: Date.now }));
      if (r.problem) throw new Error(r.problem);
      return `Ticked ${r.ticked}${r.failed ? `, ${r.failed} didn’t take` : ''}`;
    },
  })
  .add({
    id: 'airing',
    label: 'Refresh air dates and release dates',
    description: 'Keeps new episodes, moved air dates and movies’ release dates up to date from TMDB.',
    everyMs: HOUR,
    firstAfterMs: MIN,
    run: async () => {
      const r = await refreshAiring({ db, config, clients, scanner: appScanner, now: Date.now });
      if (r.refreshed) console.log(`[airing] refreshed ${r.refreshed} shows`);
      return `Refreshed ${r.refreshed}${r.problems.length ? `; ${r.problems.join('; ')}` : ''}`;
    },
  })
  .add({
    id: 'posters',
    label: 'Poster colours',
    description: 'Picks each new or changed poster’s main colour for the pages’ glow.',
    everyMs: 10 * MIN,
    firstAfterMs: 90 * 1000,
    run: async () => {
      const r = await colorPosters(db);
      if (r.colored || r.failed) console.log(`[posters] coloured ${r.colored}${r.failed ? `, ${r.failed} had no usable image` : ''}`);
      return `Coloured ${r.colored}${r.failed ? `, ${r.failed} had no usable image` : ''}`;
    },
  })
  .add({
    id: 'sources',
    label: 'Sync Prowlarr and tidy Source history',
    description: 'Brings Prowlarr’s sites up to date (when linked) and forgets Source calls older than 90 days.',
    everyMs: 6 * HOUR,
    firstAfterMs: 0,
    run: async () => {
      sources.prune();
      if (!sources.prowlarrSettings().url) return 'Tidied; Prowlarr isn’t linked';
      const r = await sources.syncProwlarr();
      console.log(`[sources] ${r.message}`);
      return r.message;
    },
  })
  .add({
    id: 'sites',
    label: 'Update the list of sites',
    description: 'Fetches the list of sites Marquee can search itself, once a day.',
    everyMs: HOUR,
    firstAfterMs: 0,
    run: async () => {
      if (!catalogueDue(db, Date.now())) return 'Not due yet';
      const r = await refreshCatalogue({ db, dataDir: config.dataDir, fetchCatalogue: clients.fetchCatalogue, now: Date.now });
      console.log(`[sites] ${r.message}`);
      return r.message;
    },
  })
  .add({
    id: 'rule-updates',
    label: 'Check for rule updates',
    description: 'Asks once a week whether Dictionarry’s rules and profiles have changed. An update waits in Settings → Quality until you apply it.',
    everyMs: HOUR,
    firstAfterMs: 10 * MIN,
    run: async () => {
      if (!checkDue(db, Date.now())) return 'Not due yet';
      const r = await checkForRuleUpdates(db, githubFetch(), Date.now());
      if (!r.ok) throw new Error(r.message);
      return r.message;
    },
  })
  .add({
    id: 'plex-labels',
    label: 'Label requested titles in Plex',
    description: 'Adds your label (and who asked, if you chose that) to requested titles once Plex has them. Turn it on in Settings → Services → Plex.',
    everyMs: 15 * MIN,
    run: () => labelRequested({ db, clients }),
  })
  .add({
    id: 'backup',
    label: 'Nightly backup',
    description: `Backs up Marquee’s database once a day and keeps ${KEEP_DAYS} days of backups.`,
    everyMs: HOUR,
    firstAfterMs: 5 * MIN,
    run: () => nightlyBackup(db, config.dataDir, Date.now()),
  })
  .add({
    id: 'sessions',
    label: 'Sign out old sessions',
    description: 'Forgets sign-ins that have run out.',
    everyMs: 6 * HOUR,
    firstAfterMs: 0,
    run: async () => {
      purgeExpiredSessions(db);
    },
  });
jobs.start();

const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  console.log(`Marquee listening on http://0.0.0.0:${info.port}`);
  console.log(`  data: ${config.dataDir}`);
  console.log(`  sign-in: password${config.oidc ? `, ${config.oidc.name} (OIDC)` : ''}${config.plex.enabled ? ', Plex' : ''}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    jobs.stop();
    activity.stopWatching();
    bundledSolver.stop();
    db.$client.close();
    process.exit(0);
  });
}
