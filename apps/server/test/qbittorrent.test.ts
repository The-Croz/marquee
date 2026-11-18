import { describe, expect, it } from 'vitest';
import { QbitClient, QbitError, apiAtLeast } from '../src/downloads/qbittorrent.js';
import { checkDownloader } from '../src/downloads/service.js';
import { FakeQbit } from './fakes/qbittorrent.js';
import { call, makeApp, setupAdmin } from './helpers.js';

/** Speaks just enough of qBittorrent's Web API v2 over a fake fetch. */
function fakeServer(opts: { modern?: boolean; password?: string; bypass?: boolean; banned?: boolean; connection?: string; api?: string; notQbit?: boolean; down?: boolean } = {}) {
  const seen: { path: string; method: string; cookie: string | null; referer: string | null; body: string | null }[] = [];
  const impl = (async (input: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(input));
    const h = new Headers(init.headers);
    const body = init.body ? String(init.body) : null;
    seen.push({ path: u.pathname + u.search, method: init.method ?? 'GET', cookie: h.get('cookie'), referer: h.get('referer'), body });
    if (opts.down) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (opts.notQbit) return new Response('<html>nginx</html>', { status: 404 });
    const p = u.pathname.replace('/api/v2', '');
    if (p === '/auth/login') {
      if (opts.banned) return new Response('Your IP address has been banned', { status: 403 });
      const f = new URLSearchParams(body ?? '');
      const good = f.get('username') === 'admin' && f.get('password') === (opts.password ?? 'secret');
      if (opts.modern) {
        // qBittorrent 5.2: 204 with no body on success, 401 on a wrong password.
        if (good) return new Response(null, { status: 204, headers: { 'set-cookie': 'QBT_SID_8080=abc123; HttpOnly; path=/' } });
        return new Response('Fails.', { status: 401 });
      }
      if (good) return new Response('Ok.', { headers: { 'set-cookie': 'QBT_SID_8080=abc123; HttpOnly; path=/' } });
      return new Response('Fails.');
    }
    if (!opts.bypass && h.get('cookie') !== 'QBT_SID_8080=abc123') return new Response('Forbidden', { status: 403 });
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    switch (p) {
      case '/app/version':
        return new Response('v5.0.4');
      case '/app/webapiVersion':
        return new Response(opts.api ?? '2.11.2');
      case '/app/preferences':
        return json({ save_path: '/data/torrents/', current_network_interface: 'tun0' });
      case '/transfer/info':
        return json({ connection_status: opts.connection ?? 'connected', dht_nodes: 300 });
      case '/sync/maindata':
        return json({ rid: 1, server_state: { free_space_on_disk: 1000 } });
      case '/torrents/categories':
        return json({ radarr: { name: 'radarr', savePath: '/data/torrents/movies' }, marquee: { name: 'marquee', savePath: '' } });
    }
    return new Response('Not Found', { status: 404 });
  }) as typeof fetch;
  return { impl, seen };
}

const client = (f: ReturnType<typeof fakeServer>, password = 'secret') => new QbitClient('http://qbit:8080/', 'admin', password, f.impl);

describe('qBittorrent client', () => {
  it('signs in once, keeps the cookie and reads everything the health check needs', async () => {
    const f = fakeServer();
    const s = await client(f).status();
    expect(s).toEqual({ version: '5.0.4', apiVersion: '2.11.2', connection: 'connected', freeSpace: 1000, savePath: '/data/torrents', categories: { radarr: '/data/torrents/movies', marquee: '' } });
    const logins = f.seen.filter((r) => r.path === '/api/v2/auth/login');
    expect(logins).toHaveLength(1);
    expect(logins[0]!.method).toBe('POST');
    expect(f.seen.every((r) => r.referer === 'http://qbit:8080/')).toBe(true);
    expect(f.seen.at(-1)!.cookie).toBe('QBT_SID_8080=abc123');
    // Read-only: nothing but the sign-in is a write.
    expect(f.seen.filter((r) => r.method !== 'GET').map((r) => r.path)).toEqual(['/api/v2/auth/login']);
  });

  it('signs in to qBittorrent 5.2, which answers 204 with no body', async () => {
    const f = fakeServer({ modern: true });
    expect((await client(f).status()).version).toBe('5.0.4');
    expect(f.seen.at(-1)!.cookie).toBe('QBT_SID_8080=abc123');
    const wrong = await client(fakeServer({ modern: true }), 'nope').status().catch((e) => e);
    expect(wrong.kind).toBe('password_refused');
  });

  it('skips signing in when qBittorrent lets this address in without one', async () => {
    const f = fakeServer({ bypass: true });
    await client(f).status();
    expect(f.seen.some((r) => r.path.includes('login'))).toBe(false);
  });

  it('says plainly when the password is wrong, without repeating it', async () => {
    const err = await client(fakeServer(), 'wrong-pass').status().catch((e) => e);
    expect(err).toBeInstanceOf(QbitError);
    expect(err.kind).toBe('password_refused');
    expect(err.message).not.toContain('wrong-pass');
  });

  it('knows when qBittorrent has blocked us for too many wrong passwords', async () => {
    const err = await client(fakeServer({ banned: true })).status().catch((e) => e);
    expect(err.kind).toBe('banned');
  });

  it("knows when the address isn't qBittorrent, or isn't answering", async () => {
    expect((await client(fakeServer({ notQbit: true })).status().catch((e) => e)).kind).toBe('not_qbittorrent');
    const down = await client(fakeServer({ down: true })).status().catch((e) => e);
    expect(down.kind).toBe('unreachable');
    expect(down.message).toBe("Couldn't reach qBittorrent at http://qbit:8080 (ECONNREFUSED).");
  });

  it('compares Web API versions', () => {
    expect(apiAtLeast('2.8.0')).toBe(true);
    expect(apiAtLeast('2.11.2')).toBe(true);
    expect(apiAtLeast('3.0')).toBe(true);
    expect(apiAtLeast('2.7.9')).toBe(false);
    expect(apiAtLeast('')).toBe(false);
  });
});

describe('Downloader health', () => {
  const check = (opts: Parameters<typeof fakeServer>[0], category = 'marquee') => checkDownloader(client(fakeServer(opts)), category, 1);

  it('is Working when connected, with the facts shown on screen', async () => {
    const h = await check({});
    expect(h).toMatchObject({ state: 'working', ok: true, label: 'Working', fix: null, version: '5.0.4', savePath: '/data/torrents', freeSpace: 1000, categoryExists: true });
    expect((await check({}, 'movies-marquee')).categoryExists).toBe(false);
  });

  it('notices the VPN is down, or that nobody can connect in', async () => {
    const off = await check({ connection: 'disconnected' });
    expect(off).toMatchObject({ state: 'no_internet', ok: false, label: 'No internet for downloads' });
    expect(off.fix).toMatch(/VPN/);
    const fw = await check({ connection: 'firewalled' });
    expect(fw).toMatchObject({ state: 'firewalled', ok: true, label: "Others can't connect to you" });
    expect(fw.fix).toMatch(/port forwarding/);
  });

  it('turns every failure into a label and what to do', async () => {
    expect(await check({ password: 'other' })).toMatchObject({ state: 'password_refused', ok: false, label: 'Password turned down' });
    expect(await check({ banned: true })).toMatchObject({ state: 'banned', label: 'Too many wrong passwords' });
    expect(await check({ down: true })).toMatchObject({ state: 'unreachable', label: "Can't reach it" });
    expect(await check({ notQbit: true })).toMatchObject({ state: 'not_qbittorrent', label: 'Not qBittorrent' });
    const old = await check({ api: '2.2.0' });
    expect(old).toMatchObject({ state: 'too_old', ok: false });
    expect(old.fix).toMatch(/4\.5 or newer/);
    for (const h of [old, await check({ down: true })]) expect(h.fix).toBeTruthy();
  });

  it('is Not set up without an address', async () => {
    expect(await checkDownloader(null, 'marquee', 1)).toMatchObject({ state: 'not_set_up', ok: false });
  });
});

describe('Settings → Downloader API', () => {
  function setup() {
    const qbit = new FakeQbit();
    const t = makeApp({ clients: { qbittorrent: (u, n, p) => qbit.as(u, n, p) } });
    return { ...t, qbit };
  }

  it('is for admins only', async () => {
    const { app } = setup();
    const admin = await setupAdmin(app);
    await call(app, 'POST', '/api/users', { username: 'kid', password: 'a long kid password', displayName: 'Kid', role: 'kid' }, admin);
    const kid = (await call(app, 'POST', '/api/auth/login', { username: 'kid', password: 'a long kid password' })).cookie;
    expect((await call(app, 'GET', '/api/settings/downloader', undefined, kid)).status).toBe(403);
    expect((await call(app, 'GET', '/api/settings/downloader')).status).toBe(401);
  });

  it('saves the connection and never sends the password back', async () => {
    const { app } = setup();
    const admin = await setupAdmin(app);
    expect((await call(app, 'GET', '/api/settings/downloader', undefined, admin)).body).toEqual({ url: null, username: '', hasPassword: false, category: 'marquee', stuckHours: 6, giveUpHours: 24, tryAnother: true });
    const res = await call(app, 'PUT', '/api/settings/downloader', { url: 'http://qbittorrent:8080/', username: 'admin', password: 'adminadmin' }, admin);
    expect(res.body).toMatchObject({ url: 'http://qbittorrent:8080', username: 'admin', hasPassword: true, category: 'marquee' });
    expect(JSON.stringify(res.body)).not.toContain('adminadmin');
    const health = await call(app, 'GET', '/api/settings/downloader/health', undefined, admin);
    expect(health.body).toMatchObject({ state: 'working', label: 'Working', categoryExists: false, savePath: '/data/torrents' });
  });

  it('checks addresses and categories', async () => {
    const { app } = setup();
    const admin = await setupAdmin(app);
    const bad = await call(app, 'PUT', '/api/settings/downloader', { url: 'qbittorrent:8080' }, admin);
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/http:\/\//);
    expect((await call(app, 'PUT', '/api/settings/downloader', { category: '/movies' }, admin)).status).toBe(400);
    expect((await call(app, 'PUT', '/api/settings/downloader', { category: '' }, admin)).body.category).toBe('marquee');
  });

  it('tests typed values, filling blanks from what is saved', async () => {
    const { app, qbit } = setup();
    const admin = await setupAdmin(app);
    expect((await call(app, 'POST', '/api/settings/downloader/test', {}, admin)).body.state).toBe('not_set_up');
    expect((await call(app, 'POST', '/api/settings/downloader/test', { url: 'http://qbittorrent:8080', username: 'admin', password: 'nope' }, admin)).body.state).toBe('password_refused');
    await call(app, 'PUT', '/api/settings/downloader', { url: 'http://qbittorrent:8080', username: 'admin', password: 'adminadmin' }, admin);
    expect((await call(app, 'POST', '/api/settings/downloader/test', {}, admin)).body.state).toBe('working');
    qbit.state.connection = 'disconnected';
    expect((await call(app, 'POST', '/api/settings/downloader/test', { category: 'radarr' }, admin)).body).toMatchObject({ state: 'no_internet', categoryExists: true });
  });

  it('never sends a saved password to a different address', async () => {
    const { app, qbit } = setup();
    const admin = await setupAdmin(app);
    await call(app, 'PUT', '/api/settings/downloader', { url: 'http://qbittorrent:8080', username: 'admin', password: 'adminadmin' }, admin);
    const res = await call(app, 'POST', '/api/settings/downloader/test', { url: 'http://evil:8080' }, admin);
    expect(res.body).toMatchObject({ state: 'needs_password', label: 'Type the password again' });
    expect(qbit.calls.some((c) => c.password === 'adminadmin' && c.url !== 'http://qbittorrent:8080')).toBe(false);
    // Saving a new address without a password forgets the old one.
    const saved = await call(app, 'PUT', '/api/settings/downloader', { url: 'http://other:8080' }, admin);
    expect(saved.body.hasPassword).toBe(false);
  });

  it('keeps the password when only other fields change, and can disconnect', async () => {
    const { app } = setup();
    const admin = await setupAdmin(app);
    await call(app, 'PUT', '/api/settings/downloader', { url: 'http://qbittorrent:8080', username: 'admin', password: 'adminadmin' }, admin);
    expect((await call(app, 'PUT', '/api/settings/downloader', { url: 'http://qbittorrent:8080', category: 'films' }, admin)).body).toMatchObject({ hasPassword: true, category: 'films' });
    const off = await call(app, 'PUT', '/api/settings/downloader', { url: null, password: null }, admin);
    expect(off.body).toMatchObject({ url: null, hasPassword: false });
    expect((await call(app, 'GET', '/api/settings/downloader/health', undefined, admin)).body.state).toBe('not_set_up');
  });
});

