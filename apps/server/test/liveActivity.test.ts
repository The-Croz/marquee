import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ApnsClient } from '../src/notify/apns.js';
import { readApns } from '../src/notify/apnsSettings.js';
import { LIVE_ACTIVITY_MAX, updateLiveActivities } from '../src/downloads/liveActivity.js';
import { downloads, liveActivities } from '../src/db/schema.js';
import { FakeApple } from './fakes/apns.js';
import { call, makeApp, setupAdmin } from './helpers.js';

const started: FakeApple[] = [];
afterAll(async () => {
  for (const a of started) await a.stop();
});

const TOKEN = 'c'.repeat(64);
const START = Date.parse('2026-11-25T12:00:00Z');

async function setup() {
  const apple = await new FakeApple().start();
  started.push(apple);
  let clock = START;
  const t = makeApp({ now: () => clock });
  const apns = new ApnsClient(() => readApns(t.db), apple.url, () => clock);
  const admin = await setupAdmin(t.app);
  await call(t.app, 'PUT', '/api/settings/notifications/apns', { key: apple.privateKeyPem, keyId: 'KEYID12345', teamId: 'TEAMID1234', bundleId: 'app.marquee.ios' }, admin);
  const login = await call(t.app, 'POST', '/api/auth/login', { username: 'josh', password: 'correct horse battery', device: { id: 'phone-aaaa-1111', name: 'Phone', kind: 'ios' } });
  const bearer = { authorization: `Bearer ${login.body.token}` };
  const movie = t.db.insert((await import('../src/db/schema.js')).movies).values({ tmdbId: 1, title: 'Dune', sortTitle: 'dune', year: 2024, profile: 'cinema', addedAt: 0, refreshedAt: 0 }).returning().get();
  const dl = t.db.insert(downloads).values({ kind: 'movie', movieId: movie.id, title: 'Dune.2024', infoHash: 'a'.repeat(40), addedAt: START, state: 'downloading', progress: 0.1 }).returning().get();
  const follow = () => call(t.app, 'POST', `/api/downloads/${dl.id}/live-activity`, { token: TOKEN, environment: 'sandbox' }, undefined, bearer);
  const set = (fields: Partial<typeof downloads.$inferInsert>) => t.db.update(downloads).set(fields).where(eq(downloads.id, dl.id)).run();
  const tick = () => updateLiveActivities({ db: t.db, apns, now: () => clock });
  return { ...t, apple, admin, bearer, dl, follow, set, tick, advance: (ms: number) => (clock += ms) };
}

describe('Live Activity updates', () => {
  it('updates only when the percent moves by 5, with the right headers', async () => {
    const t = await setup();
    expect((await t.follow()).status).toBe(200);
    await t.tick();
    expect(t.apple.pushes).toHaveLength(0);
    t.set({ progress: 0.13 });
    await t.tick();
    expect(t.apple.pushes).toHaveLength(0);
    t.set({ progress: 0.16 });
    await t.tick();
    expect(t.apple.pushes).toHaveLength(1);
    const push = t.apple.pushes[0]!;
    expect(push).toMatchObject({ token: TOKEN, jwtOk: true });
    expect(push.headers['apns-push-type']).toBe('liveactivity');
    expect(push.headers['apns-topic']).toBe('app.marquee.ios.push-type.liveactivity');
    expect(push.payload.aps).toMatchObject({ event: 'update', 'content-state': { progress: 0.16, done: false } });
    // 16 → 18 is not enough, 16 → 21 is.
    t.set({ progress: 0.18 });
    await t.tick();
    t.set({ progress: 0.21 });
    await t.tick();
    expect(t.apple.pushes).toHaveLength(2);
  });

  it('ends when the download is in the library, and sends nothing after', async () => {
    const t = await setup();
    await t.follow();
    t.set({ progress: 1, state: 'done', importedAt: START + 1000 });
    await t.tick();
    expect(t.apple.pushes.at(-1)!.payload.aps).toMatchObject({ event: 'end', 'content-state': { done: true } });
    expect(t.db.select().from(liveActivities).all()).toHaveLength(0);
    await t.tick();
    expect(t.apple.pushes).toHaveLength(1);
  });

  it('ends when it failed or was removed', async () => {
    const t = await setup();
    await t.follow();
    t.set({ state: 'removed' });
    await t.tick();
    expect(t.apple.pushes.at(-1)!.payload.aps.event).toBe('end');
    expect(t.db.select().from(liveActivities).all()).toHaveLength(0);
  });

  it('ends after 8 hours even if nothing moved', async () => {
    const t = await setup();
    await t.follow();
    t.advance(LIVE_ACTIVITY_MAX + 1000);
    await t.tick();
    expect(t.apple.pushes.at(-1)!.payload.aps.event).toBe('end');
    expect(t.db.select().from(liveActivities).all()).toHaveLength(0);
  });

  it('forgets a phone Apple says is gone', async () => {
    const t = await setup();
    await t.follow();
    t.apple.answers.set(TOKEN, { status: 410, reason: 'Unregistered' });
    t.set({ progress: 0.5 });
    await t.tick();
    expect(t.db.select().from(liveActivities).all()).toHaveLength(0);
  });

  it('sends nothing without an Apple key', async () => {
    const t = await setup();
    await t.follow();
    t.set({ progress: 0.9 });
    await updateLiveActivities({ db: t.db, apns: new ApnsClient(() => null, t.apple.url), now: () => START });
    expect(t.apple.pushes).toHaveLength(0);
  });
});

describe('following a download from the phone', () => {
  it('is for admins, and for the app (not a browser)', async () => {
    const t = await setup();
    const web = await call(t.app, 'POST', `/api/downloads/${t.dl.id}/live-activity`, { token: TOKEN }, t.admin);
    expect(web.status).toBe(400);
    expect(web.body.message).toMatch(/Open the Marquee app/);
    await call(t.app, 'POST', '/api/users', { username: 'jessie', displayName: 'Jessie', role: 'member', password: 'jessie password' }, t.admin);
    const jessie = await call(t.app, 'POST', '/api/auth/login', { username: 'jessie', password: 'jessie password', device: { id: 'phone-bbbb-2222', name: 'Jessie', kind: 'ios' } });
    const res = await call(t.app, 'POST', `/api/downloads/${t.dl.id}/live-activity`, { token: TOKEN }, undefined, { authorization: `Bearer ${jessie.body.token}` });
    expect(res.status).toBe(403);
  });

  it('following twice from one phone keeps one activity', async () => {
    const t = await setup();
    await t.follow();
    await t.follow();
    expect(t.db.select().from(liveActivities).all()).toHaveLength(1);
    await call(t.app, 'DELETE', `/api/downloads/${t.dl.id}/live-activity`, undefined, undefined, t.bearer);
    expect(t.db.select().from(liveActivities).all()).toHaveLength(0);
  });

  it('a bad token is refused', async () => {
    const t = await setup();
    expect((await call(t.app, 'POST', `/api/downloads/${t.dl.id}/live-activity`, { token: 'nope' }, undefined, t.bearer)).status).toBe(400);
  });
});
