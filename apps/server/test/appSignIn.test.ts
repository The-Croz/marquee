import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OAuth2Server } from 'oauth2-mock-server';
import { call, makeApp, setupAdmin } from './helpers.js';
import type { PlexClient } from '../src/auth/plex.js';

// The iPhone app signs in with a token in the answer instead of a cookie, and
// finishes Pocket ID sign-ins at marquee:// with a one-time code.

const PHONE = { id: 'phone-aaaa-1111', name: "Josh's iPhone", kind: 'ios' as const };
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const PASSWORD = 'correct horse battery';

describe('password sign-in from the app', () => {
  it('login with a device returns a token and no cookie', async () => {
    const { app } = makeApp();
    await setupAdmin(app);
    const res = await call(app, 'POST', '/api/auth/login', { username: 'josh', password: PASSWORD, device: PHONE });
    expect(res.status).toBe(200);
    expect(res.body.token).toHaveLength(43);
    expect(res.body.user.username).toBe('josh');
    expect(res.setCookies).toEqual([]);
    const me = await call(app, 'GET', '/api/me', undefined, undefined, bearer(res.body.token));
    expect(me.status).toBe(200);
  });

  it('login without a device still sets the cookie', async () => {
    const { app } = makeApp();
    await setupAdmin(app);
    const res = await call(app, 'POST', '/api/auth/login', { username: 'josh', password: PASSWORD });
    expect(res.cookie).toBeDefined();
    expect(res.body.token).toBeUndefined();
  });

  it('a wrong password with a device is still 401 and rate limited', async () => {
    const { app } = makeApp();
    await setupAdmin(app);
    for (let i = 0; i < 10; i++) {
      expect((await call(app, 'POST', '/api/auth/login', { username: 'josh', password: 'nope nope nope', device: PHONE })).status).toBe(401);
    }
    expect((await call(app, 'POST', '/api/auth/login', { username: 'josh', password: 'nope nope nope', device: PHONE })).status).toBe(429);
  });

  it('signing out from the app signs the device out but keeps it listed', async () => {
    const { app } = makeApp();
    await setupAdmin(app);
    const res = await call(app, 'POST', '/api/auth/login', { username: 'josh', password: PASSWORD, device: PHONE });
    const out = await call(app, 'POST', '/api/auth/logout', {}, undefined, bearer(res.body.token));
    expect(out.status).toBe(200);
    expect((await call(app, 'GET', '/api/me', undefined, undefined, bearer(res.body.token))).status).toBe(401);
  });
});

describe('Plex sign-in from the app', () => {
  it('returns a token and no cookie', async () => {
    const plex = {
      createPin: vi.fn(async () => ({ id: 7, code: 'ABCD' })),
      authUrl: (code: string) => `https://app.plex.tv/auth#?code=${code}`,
      checkPin: vi.fn(async () => 'plex-token'),
      account: vi.fn(async () => ({ id: '4242', username: 'josh-plex', email: 'j@example.com', title: 'Josh' })),
      canAccessServer: vi.fn(async () => true),
    } as unknown as PlexClient;
    const { app } = makeApp({ config: { plex: { enabled: true, serverId: null, autoCreate: false } }, plex });
    const admin = await setupAdmin(app);
    const link = await call(app, 'POST', '/api/auth/plex/start', { link: true }, admin);
    await call(app, 'POST', '/api/auth/plex/check', { flowId: link.body.flowId }, admin);

    const start = await call(app, 'POST', '/api/auth/plex/start', { device: PHONE });
    const check = await call(app, 'POST', '/api/auth/plex/check', { flowId: start.body.flowId });
    expect(check.body.status).toBe('ok');
    expect(check.body.token).toHaveLength(43);
    expect(check.setCookies).toEqual([]);
    expect((await call(app, 'GET', '/api/me', undefined, undefined, bearer(check.body.token))).body.user.username).toBe('josh');
  });
});

describe('Pocket ID sign-in from the app', () => {
  const oidcServer = new OAuth2Server();
  let issuer = '';
  beforeAll(async () => {
    await oidcServer.issuer.keys.generate('RS256');
    await oidcServer.start(0, '127.0.0.1');
    issuer = oidcServer.issuer.url!;
    oidcServer.service.on('beforeTokenSigning', (token) => {
      token.payload.sub = 'pocket-user-1';
      token.payload.preferred_username = 'jess';
      token.payload.name = 'Jess';
    });
  });
  afterAll(() => oidcServer.stop());

  const oidcApp = (now?: () => number) =>
    makeApp({ ...(now ? { now } : {}), config: { baseUrl: 'http://marquee.test', oidc: { issuer, clientId: 'marquee', clientSecret: 'secret', name: 'Pocket ID', autoCreate: true } } });

  async function browserDance(app: ReturnType<typeof oidcApp>['app'], query = '?app=1') {
    const start = await call(app, 'GET', `/api/auth/oidc/start${query}`);
    expect(start.status).toBe(302);
    const flowCookie = start.setCookies.find((c) => c.startsWith('marquee_oidc='))!.split(';')[0]!;
    const authorize = await fetch(start.location!, { redirect: 'manual' });
    const back = new URL(authorize.headers.get('location')!);
    return call(app, 'GET', `/api/auth/oidc/callback${back.search}`, undefined, flowCookie);
  }

  it('ends at marquee:// with a one-time code the app trades for a token', async () => {
    const { app } = oidcApp();
    await setupAdmin(app);
    const done = await browserDance(app);
    expect(done.status).toBe(302);
    expect(done.location).toMatch(/^marquee:\/\/signed-in\?code=/);
    expect(done.cookie).toBeUndefined();
    const code = new URL(done.location!).searchParams.get('code')!;
    const swap = await call(app, 'POST', '/api/auth/app-token', { code, device: PHONE });
    expect(swap.status).toBe(200);
    expect(swap.body.user.username).toBe('jess');
    expect((await call(app, 'GET', '/api/me', undefined, undefined, bearer(swap.body.token))).status).toBe(200);
    const again = await call(app, 'POST', '/api/auth/app-token', { code, device: PHONE });
    expect(again.status).toBe(400);
    expect(again.body).toMatchObject({ error: 'code_expired', message: 'That sign-in took too long. Try again.' });
  });

  it('the code stops working after a minute', async () => {
    let clock = 1_800_000_000_000;
    const { app } = oidcApp(() => clock);
    await setupAdmin(app);
    const done = await browserDance(app);
    const code = new URL(done.location!).searchParams.get('code')!;
    clock += 61_000;
    expect((await call(app, 'POST', '/api/auth/app-token', { code, device: PHONE })).status).toBe(400);
  });

  it('a failed sign-in goes back to the app with the reason', async () => {
    const { app } = oidcApp();
    const start = await call(app, 'GET', '/api/auth/oidc/start?app=1');
    const flowCookie = start.setCookies.find((c) => c.startsWith('marquee_oidc='))!.split(';')[0]!;
    const res = await call(app, 'GET', '/api/auth/oidc/callback?state=wrong&code=nope', undefined, flowCookie);
    expect(res.location).toBe('marquee://signed-in?error=oidc_failed');
  });

  it("the app can't link an account", async () => {
    const { app } = oidcApp();
    const admin = await setupAdmin(app);
    const res = await call(app, 'GET', '/api/auth/oidc/start?app=1&link=1', undefined, admin);
    expect(res.status).toBe(400);
  });

  it('an unknown code is refused', async () => {
    const { app } = makeApp();
    expect((await call(app, 'POST', '/api/auth/app-token', { code: 'x'.repeat(30), device: PHONE })).status).toBe(400);
  });
});
