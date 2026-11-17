import { describe, expect, it } from 'vitest';
import { ADMIN, call, makeApp, setupAdmin } from './helpers.js';

async function withMember() {
  const ctx = makeApp();
  const admin = await setupAdmin(ctx.app);
  const created = await call(ctx.app, 'POST', '/api/users', { username: 'partner', displayName: 'Partner', role: 'member', password: 'a lovely password' }, admin);
  const member = (await call(ctx.app, 'POST', '/api/auth/login', { username: 'partner', password: 'a lovely password' })).cookie!;
  return { ...ctx, admin, member, memberId: created.body.user.id as number };
}

describe('user management', () => {
  it('lets admins create and list users', async () => {
    const { app, admin } = await withMember();
    const list = await call(app, 'GET', '/api/users', undefined, admin);
    expect(list.body.users.map((u: { username: string }) => u.username)).toEqual(['josh', 'partner']);
  });

  it('keeps members out of admin endpoints', async () => {
    const { app, member } = await withMember();
    expect((await call(app, 'GET', '/api/users', undefined, member)).status).toBe(403);
    expect((await call(app, 'POST', '/api/users', { username: 'x1', displayName: 'X', role: 'admin' }, member)).status).toBe(403);
  });

  it('rejects duplicate usernames', async () => {
    const { app, admin } = await withMember();
    const dup = await call(app, 'POST', '/api/users', { username: 'Partner', displayName: 'Again', role: 'member' }, admin);
    expect(dup.status).toBe(409);
  });

  it('never removes the last admin', async () => {
    const { app, admin } = await withMember();
    const me = (await call(app, 'GET', '/api/me', undefined, admin)).body.user;
    const res = await call(app, 'PATCH', `/api/users/${me.id}`, { role: 'member' }, admin);
    expect(res.status).toBe(400);
    expect((await call(app, 'DELETE', `/api/users/${me.id}`, undefined, admin)).status).toBe(400);
  });

  it('signs a user out everywhere when an admin resets their password', async () => {
    const { app, admin, member, memberId } = await withMember();
    await call(app, 'PATCH', `/api/users/${memberId}`, { password: 'brand new password' }, admin);
    expect((await call(app, 'GET', '/api/me', undefined, member)).status).toBe(401);
    expect((await call(app, 'POST', '/api/auth/login', { username: 'partner', password: 'brand new password' })).status).toBe(200);
  });

  it('deletes users and their sessions', async () => {
    const { app, admin, member, memberId } = await withMember();
    expect((await call(app, 'DELETE', `/api/users/${memberId}`, undefined, admin)).status).toBe(200);
    expect((await call(app, 'GET', '/api/me', undefined, member)).status).toBe(401);
  });
});

describe('own account', () => {
  it('changes password only with the current one, keeping this session', async () => {
    const { app, admin } = await withMember();
    const bad = await call(app, 'POST', '/api/me/password', { current: 'wrong', next: 'another long password' }, admin);
    expect(bad.status).toBe(400);
    const ok = await call(app, 'POST', '/api/me/password', { current: ADMIN.password, next: 'another long password' }, admin);
    expect(ok.status).toBe(200);
    expect(ok.cookie).toBeDefined();
    expect((await call(app, 'GET', '/api/me', undefined, admin)).status).toBe(401); // old cookie is gone
    expect((await call(app, 'GET', '/api/me', undefined, ok.cookie)).status).toBe(200);
  });

  it("won't unlink the only way to sign in", async () => {
    const { app, admin } = await withMember();
    // josh only has a password; unlinking plex is a no-op, not an error
    expect((await call(app, 'DELETE', '/api/me/links/plex', undefined, admin)).status).toBe(200);
  });

  it('updates the display name', async () => {
    const { app, member } = await withMember();
    const res = await call(app, 'PATCH', '/api/me', { displayName: 'Jessie' }, member);
    expect(res.body.user.displayName).toBe('Jessie');
  });
});
