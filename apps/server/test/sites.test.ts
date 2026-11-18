import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BringOverResult, CopiesResult, SitesView, SolverView, SourceView, SourcesView } from '@marquee/shared';
import { schema } from '../src/db/index.js';
import { FakeQbit, fakeFetchTorrent } from './fakes/qbittorrent.js';
import { FakeSites, site } from './fakes/sources.js';
import { BOT_CHECK, FakeSolver, FakeWeb, catalogueZip } from './fakes/sites.js';
import { call, makeApp, setupAdmin } from './helpers.js';

const FIX = path.resolve(import.meta.dirname, 'fixtures/sites');
const yml = (n: string) => fs.readFileSync(path.join(FIX, `${n}.yml`), 'utf8');
const DUNE_4K = 'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX';
const DUNE_1080 = 'Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.H.264-FLUX';
const MAGNET = 'magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&dn=dune';

const page = (rows: string) => `<html><body><table class="list">${rows}</table></body></html>`;
const bayRow = (id: number, title: string, cat = 1, seeds = 290) =>
  `<tr><td><a class="name" data-cat="${cat}" href="/torrent/${id}/">${title}</a></td><td class="size">25.1 GB</td><td class="seeds">${seeds}</td><td class="leech">12</td><td class="age">3 hours</td></tr>`;

async function setup() {
  const web = new FakeWeb();
  const solver = new FakeSolver(web);
  const qbit = new FakeQbit();
  const fetched: string[] = [];
  const sentHeaders: Record<string, string>[] = [];
  const feeds = new FakeSites();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-sites-'));
  let zip: Uint8Array | Error = catalogueZip(Object.fromEntries(['examplebay', 'examplejson', 'exampleprivate', 'examplecookie', 'examplecaptcha', 'examplemusic'].map((n) => [`${n}.yml`, yml(n)])));
  const t = makeApp({
    now: () => Date.parse('2026-11-18T12:00:00Z'),
    config: { dataDir },
    clients: {
      siteFetch: web.fetch,
      solver: () => solver,
      fetchCatalogue: async () => {
        if (zip instanceof Error) throw zip;
        return zip;
      },
      qbittorrent: (u, n, p) => qbit.as(u, n, p),
      fetchTorrent: fakeFetchTorrent(fetched, sentHeaders),
      torznab: feeds.torznab,
      prowlarr: feeds.prowlarr,
    },
  });
  const cookie = await setupAdmin(t.app);
  await call(t.app, 'PUT', '/api/settings/downloader', { url: qbit.url, username: 'admin', password: 'adminadmin' }, cookie);
  await call(t.app, 'POST', '/api/settings/sources/sites/refresh', {}, cookie);
  const movie = t.db
    .insert(schema.movies)
    .values({ tmdbId: 693134, imdbId: 'tt15239678', title: 'Dune: Part Two', sortTitle: 'dune part two', year: 2024, runtime: 166, profile: 'cinema', addedAt: 0, refreshedAt: 0 })
    .returning()
    .get();
  const addSite = (siteId: string, settings: Record<string, unknown> = {}, extra: object = {}) => call(t.app, 'POST', '/api/settings/sources/sites', { siteId, settings, ...extra }, cookie);
  const sources = async () => ((await call(t.app, 'GET', '/api/settings/sources', undefined, cookie)).body as SourcesView).sources;
  const search = async () => (await call(t.app, 'POST', `/api/movies/${movie.id}/search`, {}, cookie)).body as CopiesResult;
  const send = (s: CopiesResult, title: string) => call(t.app, 'POST', '/api/downloads', { searchId: s.searchId, copyId: s.copies.find((c) => c.title === title)!.id }, cookie);
  return { ...t, web, solver, qbit, fetched, sentHeaders, feeds, dataDir, cookie, movie, addSite, sources, search, send, setZip: (z: Uint8Array | Error) => (zip = z) };
}

/** ExampleBay answers searches and the newest list, and has a magnet on each copy's page. */
function bay(web: FakeWeb, rows = bayRow(1, `[REQ] ${DUNE_4K}`) + bayRow(2, DUNE_1080) + bayRow(3, 'Some.Album.FLAC', 3)) {
  web.on('GET', /^https:\/\/bay\.test\/(search|latest)\//, () => ({ body: page(rows) }));
  web.on('GET', /^https:\/\/bay\.test\/torrent\/\d+\/$/, () => ({ body: `<html><a href="${MAGNET}">Magnet</a></html>` }));
}

describe('the list of sites', () => {
  it('lists built-in sites first, then the catalogue’s sites with movies or TV, saying which Marquee can’t run', async () => {
    const t = await setup();
    const v = (await call(t.app, 'GET', '/api/settings/sources/sites', undefined, t.cookie)).body as SitesView;
    expect(v.sites.map((s) => s.id)).toEqual(['iptorrents', 'knaben', 'examplebay', 'examplecaptcha', 'examplecookie', 'examplejson', 'exampleprivate']);
    expect(v.sites.find((s) => s.id === 'examplecaptcha')!.unsupported).toMatch(/captcha/);
    expect(v.sites.find((s) => s.id === 'exampleprivate')).toMatchObject({ type: 'private', movies: true, tv: true, origin: 'catalogue' });
    expect(v.catalogue).toMatchObject({ count: 7, message: 'Catalogue up to date: 6 sites.' });
    expect(((await call(t.app, 'GET', '/api/settings/sources/sites?q=json', undefined, t.cookie)).body as SitesView).sites.map((s) => s.id)).toEqual(['examplejson']);
  });

  it('gives the form to fill in, in plain labels, with info as text', async () => {
    const t = await setup();
    const form = (await call(t.app, 'GET', '/api/settings/sources/sites/exampleprivate', undefined, t.cookie)).body;
    expect(form.links).toEqual(['https://priv.test/']);
    expect(form.fields.map((f: { name: string; type: string; secret?: boolean }) => [f.name, f.type, !!f.secret])).toEqual([
      ['username', 'text', false],
      ['password', 'password', true],
      ['freeleech', 'checkbox', false],
    ]);
    const cookieForm = (await call(t.app, 'GET', '/api/settings/sources/sites/examplecookie', undefined, t.cookie)).body;
    expect(cookieForm.fields).toEqual([
      expect.objectContaining({ name: 'cookie', secret: true }),
      expect.objectContaining({ name: 'info_cookie', type: 'info', text: expect.stringMatching(/copy the whole "Cookie" line/) }),
    ]);
    expect((await call(t.app, 'GET', '/api/settings/sources/sites/nope', undefined, t.cookie)).status).toBe(404);
  });

  it('won’t add a site Marquee can’t run', async () => {
    const t = await setup();
    const r = await t.addSite('examplecaptcha');
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/can’t run ExampleCaptcha yet: It asks for a captcha/);
  });

  it('lets your own file replace the catalogue’s, and keeps the old list when the download fails', async () => {
    const t = await setup();
    fs.mkdirSync(path.join(t.dataDir, 'sites'));
    fs.writeFileSync(path.join(t.dataDir, 'sites', 'bay.yml'), yml('examplebay').replace('name: ExampleBay', 'name: My ExampleBay'));
    fs.writeFileSync(path.join(t.dataDir, 'sites', 'broken.yml'), 'id: [');
    t.setZip(new Error('answered 503'));
    const r = (await call(t.app, 'POST', '/api/settings/sources/sites/refresh', {}, t.cookie)).body;
    expect(r).toMatchObject({ ok: false, custom: 1 });
    expect(r.message).toMatch(/Couldn’t download the site catalogue \(answered 503\)\. Marquee keeps the copy it has/);
    expect(r.message).toMatch(/broken\.yml in the sites folder couldn’t be read/);
    const sites = (r.view as SitesView).sites;
    expect(sites.find((s) => s.id === 'examplebay')).toMatchObject({ name: 'My ExampleBay', origin: 'custom' });
    expect(sites.some((s) => s.id === 'examplejson')).toBe(true);
  });
});

describe('searching a site from its file', () => {
  it('reads HTML results, keeps to the kind asked for, and opens the copy’s page for the magnet', async () => {
    const t = await setup();
    bay(t.web);
    const add = await t.addSite('examplebay', { sort: 'seeders' });
    expect(add.status).toBe(201);
    expect(add.body.check).toMatchObject({ ok: true, state: 'working' });
    expect((add.body.source as SourceView)).toMatchObject({ kind: 'site', siteId: 'examplebay', siteName: 'ExampleBay', url: 'https://bay.test/', private: false, forMovies: true, forTv: true });

    const s = await t.search();
    expect(t.web.requests.at(-1)!.url).toBe('https://bay.test/search/Dune%20Part%20Two%202024/seeders/');
    expect(s.copies.map((c) => c.title)).toEqual([DUNE_4K, DUNE_1080]);
    const best = s.copies[0]!;
    expect(best).toMatchObject({ seeders: 290, leechers: 12, sizeBytes: Math.round(25.1 * 1024 ** 3), infoUrl: 'https://bay.test/torrent/1/' });
    expect((await t.send(s, DUNE_4K)).status).toBe(201);
    expect(t.web.requests.at(-1)!.url).toBe('https://bay.test/torrent/1/');
    expect(t.fetched).toEqual([MAGNET]);
  });

  it('reads JSON results, searching by IMDb ID when the site can', async () => {
    const t = await setup();
    t.web.on('GET', 'https://json.test/api/list.json', (req) => {
      const q = new URL(req.url).searchParams.get('query_term');
      const body = {
        data: {
          movie_count: q ? 1 : 0,
          movies: q
            ? [{ title: 'Dune: Part Two', year: 2024, imdb_code: 'tt15239678', torrents: [
                { quality: '2160p', url: 'https://json.test/dl/a.torrent', hash: 'A1B2', size_bytes: 5e9, seeds: 40, peers: 3, date_uploaded_unix: 1714573800 },
                { quality: '1080p', url: 'https://json.test/dl/b.torrent', hash: 'C3D4', size_bytes: 2e9, seeds: 90, peers: 9, date_uploaded_unix: 1714573800 },
              ] }]
            : [],
        },
      };
      return { body: JSON.stringify(body) };
    });
    await t.addSite('examplejson');
    const s = await t.search();
    const asked = t.web.to('https://json.test/api/list.json').at(-1)!;
    expect(new URL(asked.url).searchParams.get('query_term')).toBe('tt15239678');
    expect(s.copies.map((c) => c.title).sort()).toEqual(['Dune: Part Two 2024 1080p WEBRip x265-JSN', 'Dune: Part Two 2024 2160p WEBRip x265-JSN']);
    const four = s.copies.find((c) => c.title.includes('2160p'))!;
    expect(four).toMatchObject({ seeders: 40, sizeBytes: 5e9, publishedAt: 1714573800 * 1000 });
  });

  it('signs in with the form, keeps the session, signs in again when it runs out, and sends cookies with downloads', async () => {
    const t = await setup();
    let sessions = 0;
    let valid = '';
    t.web.on('GET', 'https://priv.test/login.php', () => ({ body: '<form id="login" action="takelogin.php" method="post"><input type="hidden" name="token" value="t0k"><input name="username"><input name="password" type="password"><input type="submit" value="Go"></form>' }));
    t.web.on('POST', 'https://priv.test/takelogin.php', (req) => {
      const f = new URLSearchParams(req.body);
      if (f.get('password') !== 'hunter2' || f.get('token') !== 't0k') return { body: '<div class="error">Wrong password, 2 tries left</div>' };
      valid = `s${++sessions}`;
      return { status: 302, headers: { location: '/index.php' }, setCookies: [`sid=${valid}; Path=/; HttpOnly`] };
    });
    const signedIn = (req: { headers?: Record<string, string> }) => !!valid && (req.headers?.Cookie ?? '').includes(`sid=${valid}`);
    t.web.on('GET', 'https://priv.test/index.php', (req) => ({ body: signedIn(req) ? '<a href="logout.php">Log out</a>' : '<a href="login.php">Log in</a>' }));
    t.web.on('GET', 'https://priv.test/browse.php', (req) =>
      signedIn(req)
        ? { body: `<table><tr class="torrent"><td class="name"><a href="details.php?id=9">${DUNE_4K}</a></td><td><a class="dl" href="download.php?id=9">get</a></td><td class="size">22 GB</td><td class="seeds">55</td><td class="leech">1</td><td class="added">2024-05-01 14:30</td><td><span class="free">FL</span></td></tr></table>` }
        : { status: 302, headers: { location: 'https://priv.test/login.php?returnto=browse' } },
    );

    const wrong = await t.addSite('exampleprivate', { username: 'josh', password: 'nope' });
    expect(wrong.body.check).toMatchObject({ ok: false, state: 'sign_in_failed', message: 'Sign-in turned down. The site said: Wrong password, 2 tries left' });
    const id = (wrong.body.source as SourceView).id;
    // Secrets never come back; a blank password keeps the saved one.
    const v = (await t.sources()).find((s) => s.id === id)!;
    expect(v.siteSettings).toEqual({ username: 'josh', password: { saved: true }, freeleech: false });
    expect(JSON.stringify(await t.sources())).not.toContain('nope');
    const fixed = await call(t.app, 'PUT', `/api/settings/sources/${id}/site`, { settings: { password: 'hunter2', freeleech: true } }, t.cookie);
    expect(fixed.body).toMatchObject({ ok: true, state: 'working' });
    expect(sessions).toBe(1);

    const s = await t.search();
    expect(s.copies.map((c) => c.title)).toEqual([DUNE_4K]);
    expect(s.copies[0]).toMatchObject({ seeders: 55, publishedAt: Date.parse('2024-05-01T14:30:00Z'), infoUrl: 'https://priv.test/details.php?id=9' });
    const asked = new URL(t.web.to('https://priv.test/browse.php').at(-1)!.url);
    expect(asked.searchParams.get('search')).toBe('tt15239678');
    expect(asked.searchParams.get('c10')).toBe('1');
    expect(asked.searchParams.get('c20')).toBeNull();
    expect(asked.searchParams.get('free')).toBe('1');
    expect(sessions).toBe(1);

    // The site drops the session: Marquee signs in again and carries on.
    valid = 'expired';
    const again = await t.search();
    expect(again.copies).toHaveLength(1);
    expect(sessions).toBe(2);
    expect((await t.send(again, DUNE_4K)).status).toBe(201);
    expect(t.fetched.at(-1)).toBe('https://priv.test/download.php?id=9');
    expect(t.sentHeaders.at(-1)!.Cookie).toBe('sid=s2');
  });

  it('says when a cookie doesn’t sign in', async () => {
    const t = await setup();
    t.web.on('GET', 'https://cookie.test/', (req) => ({ body: (req.headers?.Cookie ?? '').includes('uid=1') ? '<a class="logout">out</a>' : '<a>in</a>' }));
    t.web.on('GET', 'https://cookie.test/search.php', () => ({ body: '<div class="result"><h3>Severance.S02E01.1080p.WEB-DL-NTb</h3><a class="get" href="/dl/1">get</a></div>' }));
    const bad = await t.addSite('examplecookie', { cookie: 'uid=2; pass=x' });
    expect(bad.body.check).toMatchObject({ ok: false, state: 'sign_in_failed', message: expect.stringMatching(/doesn’t see you as signed in with that cookie/) });
    const good = await call(t.app, 'PUT', `/api/settings/sources/${bad.body.source.id}/site`, { settings: { cookie: 'uid=1; pass=x' } }, t.cookie);
    expect(good.body).toMatchObject({ ok: true, state: 'working' });
  });
});

describe('bot checks', () => {
  it('says “Blocked by a bot check” until solving is on, then gets past it once and reuses the cookie', async () => {
    const t = await setup();
    const rows = page(bayRow(1, DUNE_4K));
    t.web.on('GET', /^https:\/\/bay\.test\//, (req) => ((req.headers?.Cookie ?? '').includes('cf_clearance=solved') ? { body: rows } : BOT_CHECK));
    const add = await t.addSite('examplebay');
    expect(add.body.check).toMatchObject({ ok: false, state: 'blocked', message: expect.stringMatching(/Turn on bot-check solving in Settings → Sources/) });
    const blocked = (await t.sources())[0]!;
    expect(blocked.fix).toMatch(/Turn on bot-check solving/);

    const off = (await call(t.app, 'GET', '/api/settings/sources/solver', undefined, t.cookie)).body as SolverView;
    expect(off).toMatchObject({ enabled: false, state: 'off', bundled: false });
    const missing = (await call(t.app, 'PUT', '/api/settings/sources/solver', { enabled: true }, t.cookie)).body as SolverView;
    expect(missing).toMatchObject({ enabled: true, state: 'missing', message: expect.stringMatching(/Give a solver’s address under For experts/) });
    const on = (await call(t.app, 'PUT', '/api/settings/sources/solver', { enabled: true, url: 'http://byparr:8191' }, t.cookie)).body as SolverView;
    expect(on).toMatchObject({ enabled: true, state: 'ready', url: 'http://byparr:8191' });
    expect((await call(t.app, 'POST', '/api/settings/sources/solver/test', {}, t.cookie)).body).toMatchObject({ ok: true, message: 'The solver answered (version 3.5.2).' });

    const check = await call(t.app, 'POST', `/api/settings/sources/${add.body.source.id}/check`, {}, t.cookie);
    expect(check.body).toMatchObject({ ok: true, state: 'working' });
    expect(t.solver.calls).toHaveLength(1);
    const s = await t.search();
    expect(s.copies.map((c) => c.title)).toEqual([DUNE_4K]);
    // The clearance cookie (and the solver's browser name) were kept: no second trip to the solver.
    expect(t.solver.calls).toHaveLength(1);
    expect(t.web.requests.at(-1)!.headers!['User-Agent']).toBe('SolverBrowser/1.0');
  });

  it('says so when the solver can’t get past it', async () => {
    const t = await setup();
    t.web.on('GET', /^https:\/\/bay\.test\//, () => BOT_CHECK);
    await call(t.app, 'PUT', '/api/settings/sources/solver', { enabled: true, url: 'http://flaresolverr:8191' }, t.cookie);
    const add = await t.addSite('examplebay');
    expect(add.body.check).toMatchObject({ ok: false, state: 'blocked', message: expect.stringMatching(/got the bot check again/) });
    t.solver.fail = 'Error: Challenge not solved';
    const again = await call(t.app, 'POST', `/api/settings/sources/${add.body.source.id}/check`, {}, t.cookie);
    expect(again.body.message).toMatch(/The bot-check solver couldn’t get past it: Error: Challenge not solved/);
  });
});

describe('built-in sites', () => {
  it('IPTorrents: signs in with the cookie and user agent, and sends them with the download', async () => {
    const t = await setup();
    const table = `<a href="/lout.php">Log out</a><table id="torrents"><thead><tr><th>Type</th><th>Name</th><th></th><th></th><th></th><th>Sort by size</th><th>Sort by files</th><th>Sort by snatches</th><th>Sort by seeders</th><th>Sort by leechers</th></tr></thead><tbody>
      <tr><td><a href="?101"><img></a></td><td><a class="hv" href="/details.php?id=5">${DUNE_4K}</a><div class="sub">4K | 2.1 hours ago by x</div><span class="free">FL</span></td><td></td><td><a href="/download.php/5/Dune.torrent">dl</a></td><td></td><td>20.5 GB</td><td>1</td><td>300</td><td>120</td><td>4</td></tr>
    </tbody></table>`;
    t.web.on('GET', /^https:\/\/iptorrents\.com\/t\?/, (req) => ((req.headers?.Cookie ?? '').includes('uid=1') ? { body: table } : { body: '<a href="login.php">Log in</a>' }));
    const bad = await t.addSite('iptorrents', { cookie: 'uid=9', userAgent: 'MyBrowser/1' });
    expect(bad.body.check).toMatchObject({ state: 'sign_in_failed' });
    await call(t.app, 'PUT', `/api/settings/sources/${bad.body.source.id}/site`, { settings: { cookie: 'uid=1; pass=abc' } }, t.cookie);
    const s = await t.search();
    const asked = t.web.requests.at(-1)!;
    expect(asked.headers!['User-Agent']).toBe('MyBrowser/1');
    expect(new URL(asked.url).searchParams.getAll('q')).toEqual(['+(tt15239678)', '+(Dune: Part Two 2024)']);
    expect(s.copies[0]).toMatchObject({ title: DUNE_4K, seeders: 120, leechers: 4, sizeBytes: Math.round(20.5 * 1024 ** 3), infoUrl: 'https://iptorrents.com/details.php?id=5' });
    await t.send(s, DUNE_4K);
    expect(t.fetched.at(-1)).toBe('https://iptorrents.com/download.php/5/Dune.torrent');
    expect(t.sentHeaders.at(-1)).toEqual({ Cookie: 'uid=1; pass=abc', 'User-Agent': 'MyBrowser/1' });
  });

  it('Knaben: asks its search service and prefers the magnet', async () => {
    const t = await setup();
    const asked: unknown[] = [];
    t.web.on('POST', 'https://api.knaben.org/v1', (req) => {
      const body = JSON.parse(req.body!);
      if (body.query) asked.push(body);
      return { body: JSON.stringify({ hits: [{ title: DUNE_4K, categoryId: [3003000], hash: 'ABC', details: 'https://x/1', link: 'https://x/1.torrent', magnetUrl: MAGNET, bytes: 2e10, seeders: 33, peers: 2, date: '2024-05-01T10:00:00' }, { title: 'Dead.Copy.2024', seeders: 0, magnetUrl: MAGNET }] }) };
    });
    const add = await t.addSite('knaben');
    expect(add.body.check).toMatchObject({ ok: true });
    const s = await t.search();
    expect(asked).toEqual([expect.objectContaining({ search_field: 'title', query: 'Dune: Part Two 2024', categories: expect.arrayContaining([3000000, 3003000]) })]);
    expect(s.copies.map((c) => c.title)).toEqual([DUNE_4K]);
    await t.send(s, DUNE_4K);
    expect(t.fetched.at(-1)).toBe(MAGNET);
  });
});

describe('bringing sites over from Prowlarr', () => {
  async function linked() {
    const t = await setup();
    bay(t.web);
    t.feeds.prowlarrSites = [
      site(1, 'ExampleBay (Prowlarr)', { definitionName: 'examplebay', priority: 10, settings: { baseUrl: 'https://bay-mirror.test/', sort: 1 } }),
      site(2, 'ExamplePrivate', { definitionName: 'exampleprivate', privacy: 'private', settings: { username: 'josh', password: '********' } }),
      site(3, 'Somewhere Else', { definitionName: 'notinthelist' }),
    ];
    for (const id of [1, 2, 3]) t.feeds.feed(`http://prowlarr:9696/${id}/api`, { releases: [] });
    await call(t.app, 'PUT', '/api/settings/sources/prowlarr', { url: 'http://prowlarr:9696', apiKey: 'prowlarr-key' }, t.cookie);
    const bay1 = (await t.sources()).find((s) => s.name === 'ExampleBay (Prowlarr)')!;
    await call(t.app, 'PUT', `/api/settings/sources/${bay1.id}`, { dailyLimit: 42 }, t.cookie);
    return t;
  }

  it('moves sites in the catalogue over, keeping names, priority and limits, and says what needs a password', async () => {
    const t = await linked();
    const r = (await call(t.app, 'POST', '/api/settings/sources/prowlarr/bring-over', {}, t.cookie)).body as BringOverResult;
    expect(r).toMatchObject({ moved: ['ExampleBay (Prowlarr)', 'ExamplePrivate'], needSignIn: ['ExamplePrivate'], notInCatalogue: ['Somewhere Else'] });
    expect(r.message).toBe('2 sites now searched by Marquee itself. ExamplePrivate needs a password or cookie typed once (Prowlarr doesn’t share them). 1 still through Prowlarr (not in Marquee’s list yet).');
    const all = await t.sources();
    const b = all.find((s) => s.name === 'ExampleBay (Prowlarr)')!;
    expect(b).toMatchObject({ kind: 'site', siteId: 'examplebay', url: 'https://bay-mirror.test/', priority: 10, dailyLimit: 42, canPutBack: true, siteSettings: { sort: 'time' } });
    expect(all.find((s) => s.name === 'ExamplePrivate')!.siteSettings).toEqual({ username: 'josh', password: { saved: false }, freeleech: false });
    expect(all.find((s) => s.name === 'Somewhere Else')).toMatchObject({ kind: 'feed', url: 'http://prowlarr:9696/3/api' });

    // Syncing with Prowlarr leaves brought-over sites alone.
    await call(t.app, 'POST', '/api/settings/sources/prowlarr/sync', {}, t.cookie);
    expect((await t.sources()).find((s) => s.id === b.id)).toMatchObject({ kind: 'site', url: 'https://bay-mirror.test/' });
    expect((await t.sources()).filter((s) => s.name.startsWith('ExampleBay'))).toHaveLength(1);
  });

  it('puts a site back to Prowlarr, and unlinking keeps the sites Marquee runs', async () => {
    const t = await linked();
    await call(t.app, 'POST', '/api/settings/sources/prowlarr/bring-over', {}, t.cookie);
    const b = (await t.sources()).find((s) => s.name === 'ExampleBay (Prowlarr)')!;
    const back = await call(t.app, 'POST', `/api/settings/sources/${b.id}/put-back`, {}, t.cookie);
    expect(back.status).toBe(200);
    expect((await t.sources()).find((s) => s.id === b.id)).toMatchObject({ kind: 'feed', url: 'http://prowlarr:9696/1/api', canPutBack: false, siteId: null });
    expect((await call(t.app, 'POST', `/api/settings/sources/${b.id}/put-back`, {}, t.cookie)).status).toBe(409);

    await call(t.app, 'POST', '/api/settings/sources/prowlarr/bring-over', {}, t.cookie);
    await call(t.app, 'POST', '/api/settings/sources/prowlarr/unlink', { removeSources: true }, t.cookie);
    const left = await t.sources();
    expect(left.map((s) => [s.name, s.kind, s.fromProwlarr, s.canPutBack])).toEqual([
      ['ExampleBay (Prowlarr)', 'site', false, false],
      ['ExamplePrivate', 'site', false, false],
    ]);
  });
});
