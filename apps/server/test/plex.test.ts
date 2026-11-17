import { describe, expect, it, vi } from 'vitest';
import { PlexClient } from '../src/auth/plex.js';
import { call, makeApp, setupAdmin } from './helpers.js';

const ACCOUNT = { id: '4242', username: 'jessplex', email: 'j@example.com', title: 'Jess' };

function fakePlex(overrides: Partial<PlexClient> = {}) {
  return {
    createPin: vi.fn(async () => ({ id: 99, code: 'abcd' })),
    authUrl: (code: string) => `https://app.plex.tv/auth#?code=${code}`,
    checkPin: vi.fn(async () => 'plex-token'),
    account: vi.fn(async () => ACCOUNT),
    canAccessServer: vi.fn(async () => true),
    ...overrides,
  } as unknown as PlexClient;
}

const enabled = (extra: object = {}) => ({ plex: { enabled: true, serverId: null, autoCreate: false, ...extra } });

describe('Plex sign-in', () => {
  it('is off unless PLEX_LOGIN is set', async () => {
    const { app } = makeApp({ plex: fakePlex() });
    expect((await call(app, 'POST', '/api/auth/plex/start', {})).status).toBe(404);
    expect((await call(app, 'GET', '/api/auth/status')).body.providers.plex.enabled).toBe(false);
  });

  it('reports pending until the PIN is approved', async () => {
    const plex = fakePlex({ checkPin: vi.fn(async () => null) });
    const { app } = makeApp({ config: enabled(), plex });
    const start = await call(app, 'POST', '/api/auth/plex/start', {});
    expect(start.body.authUrl).toContain('code=abcd');
    expect((await call(app, 'POST', '/api/auth/plex/check', { flowId: start.body.flowId })).body).toEqual({ status: 'pending' });
  });

  it("denies a Plex account that isn't linked when auto-create is off", async () => {
    const { app } = makeApp({ config: enabled(), plex: fakePlex() });
    await setupAdmin(app);
    const start = await call(app, 'POST', '/api/auth/plex/start', {});
    const res = await call(app, 'POST', '/api/auth/plex/check', { flowId: start.body.flowId });
    expect(res.body.status).toBe('denied');
    expect(res.cookie).toBeUndefined();
  });

  it('links Plex to a signed-in user, who can then sign in with Plex', async () => {
    const { app } = makeApp({ config: enabled(), plex: fakePlex() });
    const admin = await setupAdmin(app);
    const link = await call(app, 'POST', '/api/auth/plex/start', { link: true }, admin);
    const linked = await call(app, 'POST', '/api/auth/plex/check', { flowId: link.body.flowId }, admin);
    expect(linked.body).toMatchObject({ status: 'ok', user: { username: 'josh', linked: { plex: true } } });

    const start = await call(app, 'POST', '/api/auth/plex/start', {});
    const signin = await call(app, 'POST', '/api/auth/plex/check', { flowId: start.body.flowId });
    expect(signin.body).toMatchObject({ status: 'ok', user: { username: 'josh' } });
    expect(signin.cookie).toBeDefined();
  });

  it('auto-creates members who can see your Plex server, and refuses others', async () => {
    const yes = makeApp({ config: enabled({ serverId: 'srv1', autoCreate: true }), plex: fakePlex() });
    await setupAdmin(yes.app);
    const s1 = await call(yes.app, 'POST', '/api/auth/plex/start', {});
    const r1 = await call(yes.app, 'POST', '/api/auth/plex/check', { flowId: s1.body.flowId });
    expect(r1.body).toMatchObject({ status: 'ok', user: { username: 'jessplex', displayName: 'Jess', role: 'member' } });

    const no = makeApp({ config: enabled({ serverId: 'srv1', autoCreate: true }), plex: fakePlex({ canAccessServer: vi.fn(async () => false) }) });
    await setupAdmin(no.app);
    const s2 = await call(no.app, 'POST', '/api/auth/plex/start', {});
    expect((await call(no.app, 'POST', '/api/auth/plex/check', { flowId: s2.body.flowId })).body.status).toBe('denied');
  });

  it("won't auto-create a duplicate of an existing local account", async () => {
    const { app } = makeApp({ config: enabled({ serverId: 'srv1', autoCreate: true }), plex: fakePlex() });
    const admin = await setupAdmin(app);
    await call(app, 'POST', '/api/users', { username: 'jessplex', displayName: 'Jess', role: 'member' }, admin);
    const start = await call(app, 'POST', '/api/auth/plex/start', {});
    const res = await call(app, 'POST', '/api/auth/plex/check', { flowId: start.body.flowId });
    expect(res.body.status).toBe('denied');
    expect(res.body.message).toMatch(/already have a Marquee account/);
  });

  it('treats an unknown flow as expired', async () => {
    const { app } = makeApp({ config: enabled(), plex: fakePlex() });
    expect((await call(app, 'POST', '/api/auth/plex/check', { flowId: 'x'.repeat(32) })).body).toEqual({ status: 'expired' });
  });
});

describe('PlexClient', () => {
  it('sends the Plex headers and checks server access', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/resources')) {
        return Response.json([
          { clientIdentifier: 'player1', provides: 'player' },
          { clientIdentifier: 'srv1', provides: 'server' },
        ]);
      }
      return Response.json({});
    }) as unknown as typeof fetch;
    const client = new PlexClient('marquee-test', fetchImpl);
    expect(await client.canAccessServer('tok', 'srv1')).toBe(true);
    expect(await client.canAccessServer('tok', 'player1')).toBe(false);
    const [, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(init.headers).toMatchObject({ 'X-Plex-Client-Identifier': 'marquee-test', 'X-Plex-Token': 'tok' });
    expect(client.authUrl('abc')).toContain('clientID=marquee-test');
  });
});
