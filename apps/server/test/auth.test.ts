import { describe, expect, it } from 'vitest';
import { ADMIN, call, makeApp, setupAdmin } from './helpers.js';

describe('first-run setup', () => {
  it('requires setup until an admin exists, then refuses a second setup', async () => {
    const { app } = makeApp();
    expect((await call(app, 'GET', '/api/auth/status')).body).toMatchObject({ setupRequired: true, user: null });

    const res = await call(app, 'POST', '/api/auth/setup', ADMIN);
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ username: 'josh', role: 'admin', linked: { password: true, plex: false, oidc: false } });
    expect(res.setCookies.find((c) => c.startsWith('marquee_session='))).toMatch(/HttpOnly/i);

    const status = await call(app, 'GET', '/api/auth/status', undefined, res.cookie);
    expect(status.body).toMatchObject({ setupRequired: false, user: { username: 'josh' } });

    const again = await call(app, 'POST', '/api/auth/setup', { ...ADMIN, username: 'intruder' });
    expect(again.status).toBe(409);
  });

  it('validates usernames and passwords', async () => {
    const { app } = makeApp();
    expect((await call(app, 'POST', '/api/auth/setup', { username: 'J', password: 'long enough pw' })).status).toBe(400);
    const short = await call(app, 'POST', '/api/auth/setup', { username: 'josh', password: 'short' });
    expect(short.status).toBe(400);
    expect(short.body.message).toMatch(/10 characters/);
  });
});

describe('password sign-in', () => {
  it('signs in with the right password, case-insensitive username', async () => {
    const { app } = makeApp();
    await setupAdmin(app);
    const res = await call(app, 'POST', '/api/auth/login', { username: 'JOSH', password: ADMIN.password });
    expect(res.status).toBe(200);
    expect(res.cookie).toBeDefined();
  });

  it('gives the same answer for a wrong password and an unknown user', async () => {
    const { app } = makeApp();
    await setupAdmin(app);
    const wrong = await call(app, 'POST', '/api/auth/login', { username: 'josh', password: 'nope nope nope' });
    const unknown = await call(app, 'POST', '/api/auth/login', { username: 'ghost', password: 'nope nope nope' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('rate-limits repeated failures', async () => {
    const { app } = makeApp();
    await setupAdmin(app);
    for (let i = 0; i < 10; i++) await call(app, 'POST', '/api/auth/login', { username: 'josh', password: `wrong-${i}-xxxxx` });
    const blocked = await call(app, 'POST', '/api/auth/login', { username: 'josh', password: ADMIN.password });
    expect(blocked.status).toBe(429);
  });

  it('signs out and invalidates the session', async () => {
    const { app } = makeApp();
    const cookie = await setupAdmin(app);
    expect((await call(app, 'GET', '/api/home', undefined, cookie)).status).toBe(200);
    expect((await call(app, 'POST', '/api/auth/logout', {}, cookie)).status).toBe(200);
    expect((await call(app, 'GET', '/api/home', undefined, cookie)).status).toBe(401);
  });
});

describe('request safety', () => {
  it('rejects non-JSON writes (CSRF guard)', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=evil&password=evilevilevil',
    });
    expect(res.status).toBe(415);
  });

  it('requires a session for app data', async () => {
    const { app } = makeApp();
    expect((await call(app, 'GET', '/api/home')).status).toBe(401);
    expect((await call(app, 'GET', '/api/home', undefined, 'marquee_session=forged')).status).toBe(401);
  });

  it('sends security headers', async () => {
    const { app } = makeApp();
    const res = await app.request('/api/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
});

describe('home', () => {
  it('shows approvals to admins only, and hides adult items from kids', async () => {
    const { app } = makeApp();
    const admin = await setupAdmin(app);
    await call(app, 'POST', '/api/users', { username: 'kids', displayName: 'Kids', role: 'kid', password: 'bluey bluey bluey' }, admin);
    const kid = (await call(app, 'POST', '/api/auth/login', { username: 'kids', password: 'bluey bluey bluey' })).cookie;

    const adminHome = await call(app, 'GET', '/api/home', undefined, admin);
    expect(adminHome.body.approvals.length).toBeGreaterThan(0);
    expect(adminHome.body.sample).toBe(true);

    const kidHome = await call(app, 'GET', '/api/home', undefined, kid);
    expect(kidHome.body.approvals).toEqual([]);
    expect(kidHome.body.nowDownloading).toBeNull();
    expect(kidHome.body.recent.map((r: { title: string }) => r.title)).not.toContain('Dune: Part Two');
  });
});

describe('version', () => {
  it('reports the running version', async () => {
    const { app } = makeApp();
    expect((await call(app, 'GET', '/api/auth/status')).body.version).toBe('dev');
  });
});
