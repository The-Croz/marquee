import { describe, expect, it } from 'vitest';
import { PlexServerClient, JellyfinClient, jellyfinCheckLogin } from '../src/library/mediaServers.js';
import { FakeMediaServer } from './fakes/mediaServers.js';
import { call, makeApp, setupAdmin } from './helpers.js';

function setup() {
  const plex = new FakeMediaServer('plex');
  const jellyfin = new FakeMediaServer('jellyfin');
  plex.people = [
    { id: '1', username: 'josh', name: 'Josh' },
    { id: '2', username: 'ana.m', name: 'Ana' },
  ];
  jellyfin.people = [
    { id: 'jf-sam', username: 'sam', name: 'Sam' },
    { id: 'jf-kid', username: 'riley', name: 'Riley' },
  ];
  const logins: [string, string][] = [];
  const t = makeApp({
    clients: {
      plexServer: (u, k) => plex.as(u, k),
      jellyfin: (u, k) => jellyfin.as(u, k),
      jellyfinLogin: async (_u, name, pw) => {
        logins.push([name, pw]);
        return name === 'sam' && pw === 'right' ? { id: 'jf-sam', name: 'Sam' } : null;
      },
    },
  });
  return { ...t, plex, jellyfin, logins };
}

async function connected() {
  const t = setup();
  const admin = await setupAdmin(t.app);
  await call(t.app, 'PUT', '/api/settings/services', { plexUrl: 'http://plex:32400', plexToken: 'plex-token', jellyfinUrl: 'http://jellyfin:8096', jellyfinApiKey: 'jellyfin-key' }, admin);
  return { ...t, admin };
}

describe('people from Plex and Jellyfin', () => {
  it('asks you to connect the server first', async () => {
    const t = setup();
    const admin = await setupAdmin(t.app);
    const res = await call(t.app, 'GET', '/api/users/server-people?server=jellyfin', undefined, admin);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Settings → Services/);
  });

  it('lists the server\'s people and marks who already has an account', async () => {
    const { app, admin } = await connected();
    await call(app, 'POST', '/api/users/from-server', { server: 'jellyfin', people: [{ id: 'jf-sam', role: 'member' }] }, admin);
    const res = await call(app, 'GET', '/api/users/server-people?server=jellyfin', undefined, admin);
    expect(res.body.people).toEqual([
      { id: 'jf-sam', username: 'sam', name: 'Sam', marqueeUser: 'sam' },
      { id: 'jf-kid', username: 'riley', name: 'Riley', marqueeUser: null },
    ]);
  });

  it('creates accounts with the chosen roles, no password, and skips people already added', async () => {
    const { app, admin } = await connected();
    const body = { server: 'plex', people: [{ id: '2', role: 'kid' }, { id: '999', role: 'member' }] };
    const made = await call(app, 'POST', '/api/users/from-server', body, admin);
    expect(made.status).toBe(201);
    expect(made.body.users).toHaveLength(1);
    expect(made.body.users[0]).toMatchObject({ username: 'ana.m', role: 'kid', plexUsername: 'ana.m', linked: { plex: true, password: false } });
    const again = await call(app, 'POST', '/api/users/from-server', body, admin);
    expect(again.body.users).toHaveLength(0);
  });

  it('picks a free username when theirs is taken', async () => {
    const { app, admin } = await connected();
    const made = await call(app, 'POST', '/api/users/from-server', { server: 'plex', people: [{ id: '1', role: 'member' }] }, admin);
    expect(made.body.users[0].username).toBe('josh2');
  });

  it('is for admins only', async () => {
    const { app, admin } = await connected();
    await call(app, 'POST', '/api/users', { username: 'partner', displayName: 'P', role: 'member', password: 'a lovely password' }, admin);
    const member = (await call(app, 'POST', '/api/auth/login', { username: 'partner', password: 'a lovely password' })).cookie!;
    expect((await call(app, 'GET', '/api/users/server-people?server=plex', undefined, member)).status).toBe(403);
    expect((await call(app, 'POST', '/api/users/from-server', { server: 'plex', people: [{ id: '1', role: 'admin' }] }, member)).status).toBe(403);
  });

  it('says so when the server is down', async () => {
    const { app, admin, plex } = await connected();
    plex.fail = "Couldn't reach Plex.";
    const res = await call(app, 'GET', '/api/users/server-people?server=plex', undefined, admin);
    expect(res.status).toBe(502);
  });
});

describe('Jellyfin sign-in', () => {
  it('is off until Jellyfin is connected, then shown on the sign-in page', async () => {
    const t = setup();
    const admin = await setupAdmin(t.app);
    expect((await call(t.app, 'GET', '/api/auth/status')).body.providers.jellyfin.enabled).toBe(false);
    expect((await call(t.app, 'POST', '/api/auth/jellyfin', { username: 'sam', password: 'right' })).status).toBe(404);
    await call(t.app, 'PUT', '/api/settings/services', { jellyfinUrl: 'http://jellyfin:8096', jellyfinApiKey: 'jellyfin-key' }, admin);
    expect((await call(t.app, 'GET', '/api/auth/status')).body.providers.jellyfin.enabled).toBe(true);
  });

  it('signs in someone who was picked from Jellyfin', async () => {
    const { app, admin } = await connected();
    await call(app, 'POST', '/api/users/from-server', { server: 'jellyfin', people: [{ id: 'jf-sam', role: 'member' }] }, admin);
    const res = await call(app, 'POST', '/api/auth/jellyfin', { username: 'sam', password: 'right' });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ username: 'sam', role: 'member', linked: { jellyfin: true } });
    expect((await call(app, 'GET', '/api/me', undefined, res.cookie)).status).toBe(200);
  });

  it('turns down a wrong Jellyfin password', async () => {
    const { app, admin } = await connected();
    await call(app, 'POST', '/api/users/from-server', { server: 'jellyfin', people: [{ id: 'jf-sam', role: 'member' }] }, admin);
    const res = await call(app, 'POST', '/api/auth/jellyfin', { username: 'sam', password: 'nope' });
    expect(res.status).toBe(401);
    expect(res.cookie).toBeUndefined();
  });

  it('does not create accounts: a Jellyfin user nobody picked is told to ask an admin', async () => {
    const { app } = await connected();
    const res = await call(app, 'POST', '/api/auth/jellyfin', { username: 'sam', password: 'right' });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/Ask an admin/);
  });

  it('slows down repeated guesses', async () => {
    const { app } = await connected();
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await call(app, 'POST', '/api/auth/jellyfin', { username: 'sam', password: `bad${i}` })).status;
    expect(last).toBe(429);
  });
});

describe('server clients', () => {
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it('Plex: you plus the friends the server is shared with', async () => {
    const urls: string[] = [];
    const f = (async (url: string) => {
      urls.push(url);
      return url.endsWith('/user') ? reply({ id: 1, username: 'josh', title: 'Josh' }) : reply([{ id: 2, username: 'ana.m', title: 'Ana' }]);
    }) as unknown as typeof fetch;
    const people = await new PlexServerClient('http://plex:32400', 'T', f).people();
    expect(people.map((p) => p.id)).toEqual(['1', '2']);
    expect(urls).toEqual(['https://plex.tv/api/v2/user', 'https://plex.tv/api/v2/friends']);
  });

  it('Jellyfin: lists enabled users only', async () => {
    const f = (async () => reply([{ Id: 'a', Name: 'Sam' }, { Id: 'b', Name: 'Old', Policy: { IsDisabled: true } }])) as unknown as typeof fetch;
    expect((await new JellyfinClient('http://jf:8096', 'K', f).people()).map((p) => p.username)).toEqual(['Sam']);
  });

  it('Jellyfin sign-in check: id on success, null on a wrong password, and the password goes only to Jellyfin', async () => {
    let seen: { url: string; body: string } | null = null;
    const ok = (async (url: string, init: RequestInit) => {
      seen = { url, body: String(init.body) };
      return reply({ User: { Id: 'x1', Name: 'Sam' } });
    }) as unknown as typeof fetch;
    expect(await jellyfinCheckLogin('http://jf:8096/', 'sam', 'pw', ok)).toEqual({ id: 'x1', name: 'Sam' });
    expect(seen!.url).toBe('http://jf:8096/Users/AuthenticateByName');
    const no = (async () => reply({}, 401)) as unknown as typeof fetch;
    expect(await jellyfinCheckLogin('http://jf:8096', 'sam', 'bad', no)).toBeNull();
  });
});
