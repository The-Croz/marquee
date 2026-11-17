import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OAuth2Server } from 'oauth2-mock-server';
import { call, makeApp, setupAdmin } from './helpers.js';

// A real OIDC round trip against a local mock provider: discovery, PKCE,
// state, nonce, code exchange and ID-token validation all run for real.

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
    token.payload.email = 'jess@example.com';
  });
});
afterAll(() => oidcServer.stop());

function oidcApp(autoCreate = true) {
  return makeApp({
    config: {
      baseUrl: 'http://marquee.test',
      oidc: { issuer, clientId: 'marquee', clientSecret: 'secret', name: 'Pocket ID', autoCreate },
    },
  });
}

/** Browser dance: start → provider authorize (auto-approves) → our callback. */
async function signInWithOidc(app: ReturnType<typeof oidcApp>['app'], cookie?: string, link = false) {
  const start = await call(app, 'GET', `/api/auth/oidc/start${link ? '?link=1' : ''}`, undefined, cookie);
  expect(start.status).toBe(302);
  const flowCookie = start.setCookies.find((c) => c.startsWith('marquee_oidc='))!.split(';')[0]!;
  const authorize = await fetch(start.location!, { redirect: 'manual' });
  const back = new URL(authorize.headers.get('location')!);
  expect(back.origin + back.pathname).toBe('http://marquee.test/api/auth/oidc/callback');
  const cookies = [flowCookie, cookie].filter(Boolean).join('; ');
  return call(app, 'GET', `/api/auth/oidc/callback${back.search}`, undefined, cookies);
}

describe('OIDC sign-in', () => {
  it('advertises the provider name', async () => {
    const { app } = oidcApp();
    expect((await call(app, 'GET', '/api/auth/status')).body.providers.oidc).toEqual({ enabled: true, name: 'Pocket ID' });
  });

  it('creates a member on first sign-in and reuses the account after', async () => {
    const { app } = oidcApp();
    await setupAdmin(app);
    const first = await signInWithOidc(app);
    expect(first.status).toBe(302);
    expect(first.location).toBe('/');
    const me = await call(app, 'GET', '/api/me', undefined, first.cookie);
    expect(me.body.user).toMatchObject({ username: 'jess', displayName: 'Jess', role: 'member', linked: { oidc: true, password: false } });

    const second = await signInWithOidc(app);
    const me2 = await call(app, 'GET', '/api/me', undefined, second.cookie);
    expect(me2.body.user.id).toBe(me.body.user.id);
  });

  it("won't create a duplicate when a local account already has that username", async () => {
    const { app } = oidcApp();
    const admin = await setupAdmin(app);
    await call(app, 'POST', '/api/users', { username: 'jess', displayName: 'Jess', role: 'member', password: 'jess password 1' }, admin);
    const res = await signInWithOidc(app);
    expect(res.location).toBe('/login?error=oidc_account_exists');
    expect(res.cookie).toBeUndefined();
    const list = await call(app, 'GET', '/api/users', undefined, admin);
    expect(list.body.users.map((u: { username: string }) => u.username)).toEqual(['josh', 'jess']);
  });

  it('refuses unknown identities when auto-create is off', async () => {
    const { app } = oidcApp(false);
    await setupAdmin(app);
    const res = await signInWithOidc(app);
    expect(res.location).toBe('/login?error=oidc_no_account');
    expect(res.cookie).toBeUndefined();
  });

  it('links an identity to the signed-in user', async () => {
    const { app } = oidcApp(false);
    const admin = await setupAdmin(app);
    const linked = await signInWithOidc(app, admin, true);
    expect(linked.location).toBe('/settings/account?linked=oidc');
    const signin = await signInWithOidc(app);
    expect((await call(app, 'GET', '/api/me', undefined, signin.cookie)).body.user.username).toBe('josh');
  });

  it('rejects a callback without the flow cookie', async () => {
    const { app } = oidcApp();
    await setupAdmin(app);
    const res = await call(app, 'GET', '/api/auth/oidc/callback?code=x&state=y');
    expect(res.location).toBe('/login?error=oidc_expired');
  });
});

describe('OIDC provider unreachable', () => {
  it('sends you back to sign-in with a clear error instead of a server error', async () => {
    const { app } = makeApp({
      config: { oidc: { issuer: 'http://127.0.0.1:9', clientId: 'x', clientSecret: 'y', name: 'Pocket ID', autoCreate: true } },
    });
    await setupAdmin(app);
    const res = await call(app, 'GET', '/api/auth/oidc/start');
    expect(res.status).toBe(302);
    expect(res.location).toBe('/login?error=oidc_unreachable');
  });

  it('explains network errors with their underlying cause', async () => {
    const { describeError } = await import('../src/auth/oidc.js');
    const err = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND id.example.com'), { code: 'ENOTFOUND' }) });
    expect(describeError(err)).toBe('fetch failed ← ENOTFOUND: getaddrinfo ENOTFOUND id.example.com');
  });
});
