/**
 * Demo mode: runs Marquee with a fake TMDB and a generated sample library, so
 * the UI can be tried without internet access or real media.
 *   pnpm --filter @marquee/server demo        (serves the built web app on :9797)
 * Data lives in a temp folder and is thrown away. Sign up as any admin.
 * Settings → Sources: link Prowlarr at http://prowlarr:9696 with the key prowlarr-key.
 * Settings → Downloader: a fake qBittorrent at http://qbittorrent:8080 (admin / adminadmin).
 * Settings → Services: fake Plex at http://plex:32400 (token plex-token), Jellyfin at http://jellyfin:8096 (key jellyfin-key).
 * Radarr (http://radarr:7878) and Sonarr (http://sonarr:8989) are fakes too, already filled in.
 * Settings → Sources → Add a site: ExampleBay (behind a fake bot check: turn on bot-check solving
 * with any address under For experts), ExampleJSON, and ExamplePrivate (josh / hunter2). Prowlarr's
 * fake sites can be brought over too.
 * Severance season 2 airs around today, so the Calendar and "Coming up this week" have something to show.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDb, setSetting } from '../src/db/index.js';
import { RateLimiter } from '../src/auth/rateLimit.js';
import { PlexClient, plexClientId } from '../src/auth/plex.js';
import { LibraryScanner } from '../src/library/scanner.js';
import { colorPosters } from '../src/library/posterColor.js';
import sharp from 'sharp';
import { FakeTmdb } from '../test/fakes/tmdb.js';
import { FakeStreamingTop } from '../test/fakes/streamingTop.js';
import { FakeSites, release, site } from '../test/fakes/sources.js';
import { SourceService } from '../src/sources/service.js';
import { TorznabError } from '../src/sources/torznab.js';
import { FakeRadarr } from '../test/fakes/radarr.js';
import { FakeQbit, fakeFetchTorrent } from '../test/fakes/qbittorrent.js';
import { FakeMediaServer } from '../test/fakes/mediaServers.js';
import { BOT_CHECK, FakeSolver, FakeWeb, catalogueZip } from '../test/fakes/sites.js';
import { refreshCatalogue } from '../src/sources/sites/catalogue.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-demo-'));
const GB = 1024 ** 3;
function file(rel: string, size: number, ageDays: number) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const fd = fs.openSync(p, 'w');
  fs.ftruncateSync(fd, size);
  fs.closeSync(fd);
  const t = new Date(Date.now() - ageDays * 86400_000);
  fs.utimesSync(p, t, t);
}
file('movies/The Matrix (1999)/The Matrix (1999) Bluray-1080p.mkv', 8 * GB, 400);
file('movies/Dune Part Two (2024) {tmdb-693134}/Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.DV.HDR.H.265-FLUX.mkv', 21 * GB, 2);
file('movies/Inside.Out.2.2024.1080p.WEB-DL.DDP5.1.H.264-GRP/Inside.Out.2.2024.1080p.WEB-DL.DDP5.1.H.264-GRP.mkv', 6 * GB, 3);
file('movies/Blade Runner 2049 (2017)/Blade Runner 2049 (2017) Remux-2160p.mkv', 60 * GB, 100);
file('movies/Up (2009)/Up (2009) WEBDL-720p.mkv', 2 * GB, 30);
file('movies/weird-folder-name/movie.mkv', 4 * GB, 50);
file('tv/Severance (2022)/Season 01/Severance - S01E01 - Good News About Hell [WEBDL-2160p][DV HDR10][h265].mkv', 5 * GB, 5);
file('tv/Severance (2022)/Season 01/Severance - S01E02 - Half Loop [WEBDL-2160p][DV HDR10][h265].mkv', 5 * GB, 5);
file('tv/Severance (2022)/Season 02/Severance - S02E01 - Hello, Ms. Cobel [WEBDL-2160p].mkv', 5 * GB, 1);
file('tv/Bluey (2018) {tvdb-353546}/Season 1/Bluey.S01E01-E03.720p.WEBRip.mkv', GB, 10);

const config = { ...loadConfig(), dataDir: root, webDir: process.env.MARQUEE_WEB_DIR ?? path.resolve('../web/dist') };
const db = openDb(':memory:');
setSetting(db, 'services.tmdb_api_key', 'good-key');
setSetting(db, 'library.movies_root', path.join(root, 'movies'));
setSetting(db, 'library.tv_root', path.join(root, 'tv'));
const tmdb = new FakeTmdb();
// Move Severance season 2 and a new Bluey episode around today, so the calendar has something on it.
const dayOffset = (d: number) => new Date(Date.now() + d * 86400_000).toISOString().slice(0, 10);
const tmdbSeason = tmdb.season.bind(tmdb);
tmdb.season = async (showId, season) => {
  const eps = await tmdbSeason(showId, season);
  if (showId === 95396 && season === 2) {
    return [
      { ...eps[0]!, airDate: dayOffset(-8) },
      { season: 2, episode: 2, title: 'Goodbye, Mrs. Selvig', airDate: dayOffset(-1), overview: null },
      { season: 2, episode: 3, title: 'Who Is Alive?', airDate: dayOffset(2), overview: null },
      { season: 2, episode: 4, title: 'Woe’s Hollow', airDate: dayOffset(9), overview: null },
    ];
  }
  if (showId === 82728 && season === 1) return [...eps, { season: 1, episode: 4, title: 'Daddy Robot', airDate: dayOffset(1), overview: null }];
  return eps;
};

// A fake Prowlarr at http://prowlarr:9696 (key "prowlarr-key") with a few sites, one of them failing.
const sites = new FakeSites();
sites.prowlarrSites = [
  site(1, 'YTS', { categories: [2000, 2040, 2045], definitionName: 'examplejson' }),
  site(2, 'EZTV', { categories: [5000, 5040] }),
  site(3, 'IPTorrents', { privacy: 'private', priority: 10 }),
  site(4, 'MyAnonamouse', { privacy: 'private', categories: [7000, 3030] }),
  site(5, 'The Pirate Bay', { definitionName: 'examplebay' }),
];
// Every feed answers every search with these; Marquee sorts out which fit the title.
const dune = [
  release('Dune.Part.Two.2024.2160p.UHD.BluRay.x265.10bit.HDR.DDP5.1.Atmos-GROUP', { seeders: 412, size: 18 * GB, infoHash: 'a1' }),
  release('Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX', { seeders: 290, size: 25 * GB, infoHash: 'a2' }),
  release('Dune.Part.Two.2024.2160p.MA.WEB-DL.DDP5.1.HDR.H.265-HONE', { seeders: 41, size: 20 * GB, infoHash: 'a3' }),
  release('Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.Atmos.H.264-FLUX', { seeders: 260, size: 7 * GB, infoHash: 'a4' }),
  release('Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.DV.HDR.HEVC.TrueHD.7.1.Atmos-FGT', { seeders: 88, size: 72 * GB, infoHash: 'a5' }),
  release('Dune.Part.Two.2024.1080p.WEBRip.x265.10bit-LAMA', { seeders: 900, size: 2 * GB, infoHash: 'a6' }),
  release('Dune.Part.Two.2024.2160p.WEB-DL.H.265-TINY', { seeders: 12, size: 3 * GB, infoHash: 'a7' }),
  release('Dune.Part.Two.2024.1080p.WEB-DL.H.264-NOBODY', { seeders: 0, size: 6 * GB, infoHash: 'a8' }),
  release('Dune.2021.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX', { seeders: 150, size: 22 * GB, infoHash: 'a9' }),
  release('Severance.S02E01.Hello.Ms.Cobel.2160p.ATVP.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX', { seeders: 120, size: 6 * GB, infoHash: 'b1' }),
  release('Severance.S02E01.1080p.ATVP.WEB-DL.DDP5.1.H.264-NTb', { seeders: 300, size: 3 * GB, infoHash: 'b2' }),
  release('Severance.S02E02.1080p.ATVP.WEB-DL.DDP5.1.H.264-NTb', { seeders: 250, size: 3 * GB, infoHash: 'b3' }),
  release('Severance.S02.2160p.ATVP.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX', { seeders: 80, size: 60 * GB, infoHash: 'b4' }),
];
sites.feed('http://prowlarr:9696/1/api', { releases: dune });
sites.feed('http://prowlarr:9696/2/api', { releases: [] });
sites.feed('http://prowlarr:9696/3/api', { releases: dune });
sites.feed('http://prowlarr:9696/5/api', { fail: new TorznabError('blocked', 'The site has a bot check in front of it.') });
// A fake Radarr at http://radarr:7878 (read-only, for matching the library).
const radarr = new FakeRadarr();
radarr.movies = [
  { title: 'Dune: Part Two', monitored: true },
  { title: 'The Matrix', monitored: true },
  { title: 'Up', monitored: false },
];
setSetting(db, 'services.radarr_url', 'http://radarr:7878');
setSetting(db, 'services.radarr_api_key', 'radarr-key');
// A fake Sonarr at http://sonarr:8989.
const sonarr = new FakeRadarr();
sonarr.movies = [
  { title: 'Severance', monitored: true },
  { title: 'Bluey', monitored: true },
];
setSetting(db, 'services.sonarr_url', 'http://sonarr:8989');
setSetting(db, 'services.sonarr_api_key', 'sonarr-key');
// A fake qBittorrent at http://qbittorrent:8080 (admin / adminadmin), behind a VPN that's up.
const qbit = new FakeQbit();
setSetting(db, 'downloader.url', 'http://qbittorrent:8080');
setSetting(db, 'downloader.username', 'admin');
setSetting(db, 'downloader.password', 'adminadmin');
const qbitTvHashes = new Set<string>();
/** The copy name for each fake torrent, so finished ones get a real-looking file name. */
const qbitNames = new Map<string, string>();
// Make the fake qBittorrent's downloads move along. TV episodes get stuck with nobody sharing, to show that state.
setInterval(() => {
  for (const t of qbit.list) {
    if (t.progress >= 1) {
      // Sharing: the ratio climbs so the seeding rule can be seen working.
      t.ratio += 0.25;
      t.seedingSeconds += 6 * 3600;
      continue;
    }
    if (t.state === 'stoppedDL') continue;
    if (t.state === 'metaDL') {
      t.state = 'downloading';
      continue;
    }
    if (qbitTvHashes.has(t.hash)) {
      Object.assign(t, { state: 'stalledDL', downloadSpeed: 0, seedsConnected: 0, seedsKnown: 0 });
      continue;
    }
    t.progress = Math.min(1, t.progress + 0.05);
    if (t.progress >= 1) {
      // Finished: put a (sparse) file where qBittorrent would have saved it, so Marquee can put it in the library.
      t.name = qbitNames.get(t.hash) ?? t.name;
      t.size = 3 * GB;
      file(`torrents/${t.name}/${t.name}.mkv`, t.size, 0);
      t.savePath = path.join(root, 'torrents');
    }
    Object.assign(t, { downloadSpeed: 6.5 * 1024 ** 2, eta: Math.round(((1 - t.progress) / 0.02) * 3), seedsConnected: 40, state: t.progress >= 1 ? 'stalledUP' : 'downloading' });
  }
}, 3000).unref();
// Fake Plex (http://plex:32400, token plex-token) and Jellyfin (http://jellyfin:8096, key jellyfin-key), using the demo's library folders.
const plex = new FakeMediaServer('plex', [
  { id: '1', name: 'Movies', kind: 'movie', locations: [path.join(root, 'movies')] },
  { id: '2', name: 'TV Shows', kind: 'tv', locations: [path.join(root, 'tv')] },
]);
const jellyfin = new FakeMediaServer('jellyfin', [
  { id: 'a1', name: 'Movies', kind: 'movie', locations: [path.join(root, 'movies')] },
  { id: 'b2', name: 'Shows', kind: 'tv', locations: [path.join(root, 'tv')] },
]);
plex.people = [
  { id: '1001', username: 'josh', name: 'Josh' },
  { id: '1002', username: 'ana.m', name: 'Ana' },
];
jellyfin.people = [
  { id: 'jf-sam', username: 'sam', name: 'Sam' },
  { id: 'jf-kid', username: 'riley', name: 'Riley' },
];
const hoursAgo = (h: number) => Date.now() - h * 3_600_000;
plex.plays = [
  { kind: 'movie', title: 'Dune: Part Two', show: null, season: null, episode: null, year: 2024, tmdbId: 693134, userId: '1', user: 'josh', key: 'p1', playedAt: hoursAgo(5) },
  { kind: 'episode', title: 'Pilot', show: 'Severance', season: 1, episode: 1, year: null, tmdbId: null, userId: '2', user: 'ana', key: 'p2', playedAt: hoursAgo(30) },
  { kind: 'episode', title: 'Half Loop', show: 'Severance', season: 1, episode: 2, year: null, tmdbId: null, userId: '2', user: 'ana', key: 'p3', playedAt: hoursAgo(54) },
];
jellyfin.plays = [{ kind: 'movie', title: 'Dune: Part Two', show: null, season: null, episode: null, year: 2024, tmdbId: 693134, userId: 'jf-sam', user: 'sam', key: 'j1', playedAt: hoursAgo(80) }];
plex.playing = [{ sessionId: 's1', platform: 'Plex for Roku', resolution: '4k', kind: 'movie', title: 'Dune: Part Two', show: null, season: null, episode: null, year: 2024, tmdbId: 693134, user: 'ana', device: 'Living room TV', state: 'playing', progress: 0.37, transcoding: false }];
// Fake sites Marquee searches itself, and the catalogue they come from (the test site files).
const web = new FakeWeb();
const fixtures = path.resolve(import.meta.dirname, '../test/fixtures/sites');
const catalogue = catalogueZip(Object.fromEntries(fs.readdirSync(fixtures).map((n) => [n, fs.readFileSync(path.join(fixtures, n), 'utf8')])));
const bayRows = dune
  .map((r, i) => `<tr><td><a class="name" data-cat="${/S\d\dE?/.test(r.title) ? 2 : 1}" href="/torrent/${i}/">${r.title}</a></td><td class="size">${((r.size ?? 0) / 1e9).toFixed(1)} GB</td><td class="seeds">${r.seeders}</td><td class="leech">3</td><td class="age">${i + 1} hours</td></tr>`)
  .join('');
web.on('GET', /^https:\/\/bay\.test\/(search|latest)\//, (req) => ((req.headers?.Cookie ?? '').includes('cf_clearance') ? { body: `<table class="list">${bayRows}</table>` } : BOT_CHECK));
web.on('GET', /^https:\/\/bay\.test\/torrent\/\d+\/$/, (req) => ({ body: `<a href="magnet:?xt=urn:btih:${'b'.repeat(39)}${req.url.match(/(\d+)\/$/)![1]}">Magnet</a>` }));
web.on('GET', 'https://json.test/api/list.json', () => ({
  body: JSON.stringify({ data: { movie_count: 1, movies: [{ title: 'Dune: Part Two', year: 2024, imdb_code: 'tt15239678', torrents: [{ quality: '2160p', url: 'https://json.test/dl/1.torrent', hash: 'c'.repeat(40), size_bytes: 8e9, seeds: 120, peers: 9, date_uploaded_unix: 1714573800 }] }] } }),
}));
let privSession = '';
web.on('GET', 'https://priv.test/login.php', () => ({ body: '<form id="login" action="takelogin.php" method="post"><input name="username"><input name="password" type="password"></form>' }));
web.on('POST', 'https://priv.test/takelogin.php', (req) => {
  const f = new URLSearchParams(req.body);
  if (f.get('username') !== 'josh' || f.get('password') !== 'hunter2') return { body: '<div class="error">Wrong username or password.</div>' };
  privSession = `s${Date.now()}`;
  return { status: 302, headers: { location: '/index.php' }, setCookies: [`sid=${privSession}`] };
});
const privIn = (req: { headers?: Record<string, string> }) => !!privSession && (req.headers?.Cookie ?? '').includes(privSession);
web.on('GET', 'https://priv.test/index.php', (req) => ({ body: privIn(req) ? '<a href="logout.php">Log out</a>' : '' }));
web.on('GET', 'https://priv.test/browse.php', (req) =>
  privIn(req)
    ? { body: `<table>${dune.slice(0, 4).map((r, i) => `<tr class="torrent"><td class="name"><a href="details.php?id=${i}">${r.title}</a></td><td><a class="dl" href="download.php?id=${i}">get</a></td><td class="size">${((r.size ?? 0) / 1e9).toFixed(1)} GB</td><td class="seeds">${r.seeders}</td><td class="leech">2</td><td class="added">2024-05-01 14:30</td></tr>`).join('')}</table>` }
    : { status: 302, headers: { location: 'https://priv.test/login.php' } },
);
const solver = new FakeSolver(web);

// Demo Top 10s, so Discover shows numbered lists without a real key.
const streamingTop = new FakeStreamingTop();
streamingTop.lists = { hbo: { movie: [693134, 603], series: [502] }, disney: { movie: [1241982, 1022789, 14160], series: [82728] }, apple: { series: [95396] }, netflix: { series: [66732] }, hulu: { movie: [1064213], series: [136315] } };
setSetting(db, 'services.streaming_top_key', 'good-top-key');

const clients = {
  streamingTop: (key: string) => streamingTop.as(key),
  plexServer: (url: string, token: string) => plex.as(url, token),
  jellyfin: (url: string, key: string) => jellyfin.as(url, key),
  // Demo Jellyfin sign-in: "sam" / "jellyfin-pass".
  jellyfinLogin: async (_url: string, username: string, password: string) => (username.toLowerCase() === 'sam' && password === 'jellyfin-pass' ? { id: 'jf-sam', name: 'Sam' } : null),
  qbittorrent: (url: string, user: string, pass: string) => qbit.as(url, user, pass),
  fetchTorrent: async (url: string) => {
    const t = await fakeFetchTorrent()(url);
    const name = new URL(url).searchParams.get('file');
    if (name) qbitNames.set(t.infoHash, name);
    if (/S\d\dE\d\d/i.test(decodeURIComponent(url))) qbitTvHashes.add(t.infoHash);
    return t;
  },
  tmdb: () => tmdb, arr: (kind: 'radarr' | 'sonarr') => (kind === 'sonarr' ? sonarr : radarr), torznab: sites.torznab, prowlarr: sites.prowlarr,
  push: { send: async () => {} },
  siteFetch: web.fetch,
  solver: () => solver,
  fetchCatalogue: async () => catalogue,
};

const app = createApp({
  db,
  config,
  oidc: null,
  plex: () => new PlexClient(plexClientId(db)),
  loginLimiter: new RateLimiter(100, 60_000),
  clients,
  scanner: new LibraryScanner(db),
  sources: new SourceService(db, clients),
  now: Date.now,
});
void refreshCatalogue({ db, dataDir: root, fetchCatalogue: clients.fetchCatalogue, now: Date.now });
// Poster colours: the demo has no real posters, so each one is a solid colour picked from its path.
const DEMO_POSTER_COLORS = ['#c8501e', '#3a78c8', '#2a8a4a', '#9a3ab0', '#c89a1e', '#b02a3a', '#1e8aa0'];
const demoPoster = (url: string) => {
  let h = 0;
  for (const ch of url) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return sharp({ create: { width: 8, height: 12, channels: 3, background: DEMO_POSTER_COLORS[h % DEMO_POSTER_COLORS.length]! } }).png().toBuffer();
};
setInterval(() => void colorPosters(db, demoPoster).catch(() => {}), 5_000).unref();

serve({ fetch: app.fetch, port: config.port }, (i) => console.log(`Marquee demo on http://localhost:${i.port} (library at ${root})`));
