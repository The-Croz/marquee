import { describe, expect, it } from 'vitest';
import { notificationChannels, requests } from '../src/db/schema.js';
import { call, makeApp, setupAdmin } from './helpers.js';

const state = (body: { steps: { key: string; state: string }[] }, key: string) => body.steps.find((s) => s.key === key)?.state;

describe('retire Seerr checklist', () => {
  it('starts with everything to do, and the last two steps left to you', async () => {
    const { app } = makeApp();
    const admin = await setupAdmin(app);
    const res = await call(app, 'GET', '/api/retire-seerr', undefined, admin);
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(false);
    expect(res.body.steps.map((s: { key: string }) => s.key)).toEqual(['discover', 'people', 'signed_in', 'notify', 'request', 'family', 'turn_off']);
    expect(state(res.body, 'people')).toBe('todo');
    expect(state(res.body, 'family')).toBe('unknown');
    expect(state(res.body, 'turn_off')).toBe('unknown');
  });

  it('ticks steps off as the family sets up', async () => {
    const { app, db } = makeApp();
    const admin = await setupAdmin(app);
    await call(app, 'PUT', '/api/settings/services', { tmdbApiKey: 'key' }, admin);
    await call(app, 'POST', '/api/users', { username: 'partner', displayName: 'Partner', role: 'member', password: 'a lovely password' }, admin);
    let res = await call(app, 'GET', '/api/retire-seerr', undefined, admin);
    expect(state(res.body, 'discover')).toBe('done');
    expect(state(res.body, 'people')).toBe('done');
    expect(state(res.body, 'signed_in')).toBe('todo');

    await call(app, 'POST', '/api/auth/login', { username: 'partner', password: 'a lovely password' });
    db.insert(notificationChannels).values({ kind: 'ntfy', name: 'Phone', config: '{"topic":"t"}', events: '[]', createdAt: 1 }).run();
    res = await call(app, 'GET', '/api/retire-seerr', undefined, admin);
    expect(state(res.body, 'signed_in')).toBe('done');
    expect(state(res.body, 'notify')).toBe('warn');

    db.update(notificationChannels).set({ lastOkAt: 5 }).run();
    db.insert(requests).values({ kind: 'movie', tmdbId: 1, title: 'Dune', status: 'approved', createdAt: 1 }).run();
    expect(state((await call(app, 'GET', '/api/retire-seerr', undefined, admin)).body, 'request')).toBe('warn');

    db.update(requests).set({ readyAt: 9 }).run();
    res = await call(app, 'GET', '/api/retire-seerr', undefined, admin);
    expect(state(res.body, 'request')).toBe('done');
    expect(res.body.ready).toBe(true);
  });

  it('is for admins only', async () => {
    const { app } = makeApp();
    const admin = await setupAdmin(app);
    await call(app, 'POST', '/api/users', { username: 'partner', displayName: 'P', role: 'member', password: 'a lovely password' }, admin);
    const member = (await call(app, 'POST', '/api/auth/login', { username: 'partner', password: 'a lovely password' })).cookie!;
    expect((await call(app, 'GET', '/api/retire-seerr', undefined, member)).status).toBe(403);
    expect((await call(app, 'GET', '/api/retire-seerr')).status).toBe(401);
  });
});
