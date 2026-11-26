import { afterAll, describe, expect, it, vi } from 'vitest';
import { ApnsClient, apnsPayload, levelFor } from '../src/notify/apns.js';
import { readApns } from '../src/notify/apnsSettings.js';
import { HttpPushClient } from '../src/notify/push.js';
import type { Db } from '../src/db/index.js';
import { notificationChannels } from '../src/db/schema.js';
import { FakeApple } from './fakes/apns.js';
import { FakeTmdb } from './fakes/tmdb.js';
import { call, makeApp, setupAdmin } from './helpers.js';

// Each test gets its own fake Apple, so a late push from one can't land in the next.
let apple: FakeApple;
const started: FakeApple[] = [];
afterAll(async () => {
  for (const a of started) await a.stop();
});

const TOKEN = 'a'.repeat(64);
const TOKEN2 = 'b'.repeat(64);
const phone = (id: string, name: string) => ({ id, name, kind: 'ios' as const });

async function setup() {
  apple = await new FakeApple().start();
  started.push(apple);
  let dbRef: Db | null = null;
  const apns = new ApnsClient(() => (dbRef ? readApns(dbRef) : null), apple.url);
  const t = makeApp({ clients: { push: new HttpPushClient(fetch, apns), tmdb: () => new FakeTmdb() } });
  dbRef = t.db;
  const admin = await setupAdmin(t.app);
  await call(t.app, 'PUT', '/api/settings/services', { tmdbApiKey: 'good-key' }, admin);
  const configure = () => call(t.app, 'PUT', '/api/settings/notifications/apns', { key: apple.privateKeyPem, keyId: 'KEYID12345', teamId: 'TEAMID1234', bundleId: 'marquee.ios.app' }, admin);
  const signInPhone = async (username: string, password: string, device = phone('phone-aaaa-1111', "Josh's iPhone")) => {
    const r = await call(t.app, 'POST', '/api/auth/login', { username, password, device });
    const list = await call(t.app, 'GET', '/api/me/devices', undefined, undefined, { authorization: `Bearer ${r.body.token}` });
    return { token: r.body.token as string, id: list.body.devices[0].id as string, bearer: { authorization: `Bearer ${r.body.token}` } };
  };
  await call(t.app, 'POST', '/api/users', { username: 'jessie', displayName: 'Jessie', role: 'member', password: 'jessie password' }, admin);
  const jessie = (await call(t.app, 'POST', '/api/auth/login', { username: 'jessie', password: 'jessie password' })).cookie!;
  return { ...t, admin, jessie, configure, signInPhone };
}

describe('the Apple key settings', () => {
  it('saves the key and never sends it back', async () => {
    const t = await setup();
    const saved = await call(t.app, 'PUT', '/api/settings/notifications/apns', { key: apple.privateKeyPem, keyId: 'KEYID12345', teamId: 'TEAMID1234', bundleId: 'marquee.ios.app' }, t.admin);
    expect(saved.body).toEqual({ keySet: true, keyId: 'KEYID12345', teamId: 'TEAMID1234', bundleId: 'marquee.ios.app', ready: true });
    const read = await call(t.app, 'GET', '/api/settings/notifications/apns', undefined, t.admin);
    expect(JSON.stringify(read.body)).not.toMatch(/PRIVATE KEY|MIG/);
  });

  it('refuses something that is not a push key, in plain words', async () => {
    const t = await setup();
    const bad = await call(t.app, 'PUT', '/api/settings/notifications/apns', { key: 'hello', keyId: 'KEYID12345', teamId: 'TEAMID1234', bundleId: 'marquee.ios.app' }, t.admin);
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/doesn’t look like an Apple push key/);
    expect(JSON.stringify(bad.body)).not.toContain('hello');
  });

  it('keeps the saved key when the key is left blank, and needs one the first time', async () => {
    const t = await setup();
    const first = await call(t.app, 'PUT', '/api/settings/notifications/apns', { keyId: 'KEYID12345', teamId: 'TEAMID1234', bundleId: 'marquee.ios.app' }, t.admin);
    expect(first.status).toBe(400);
    await t.configure();
    const again = await call(t.app, 'PUT', '/api/settings/notifications/apns', { keyId: 'NEWKEYID12', teamId: 'TEAMID1234', bundleId: 'marquee.ios.app' }, t.admin);
    expect(again.body).toMatchObject({ keySet: true, keyId: 'NEWKEYID12', ready: true });
  });

  it('is for admins only', async () => {
    const t = await setup();
    expect((await call(t.app, 'GET', '/api/settings/notifications/apns', undefined, t.jessie)).status).toBe(403);
    expect((await call(t.app, 'PUT', '/api/settings/notifications/apns', { keyId: 'KEYID12345', teamId: 'TEAMID1234', bundleId: 'x.y.z' }, t.jessie)).status).toBe(403);
  });
});

describe('levels and payloads', () => {
  it('maps the four levels to Apple interruption levels', () => {
    expect(levelFor('silent')).toEqual({ level: 'passive', sound: false });
    expect(levelFor('quiet')).toEqual({ level: 'passive', sound: true });
    expect(levelFor('normal')).toEqual({ level: 'active', sound: true });
    expect(levelFor('high')).toEqual({ level: 'time-sensitive', sound: true });
    expect(levelFor(undefined).level).toBe('active');
  });

  it('only a request waiting gets the Approve / Turn down category', () => {
    const waiting = apnsPayload({ title: 'T', body: 'B', event: 'request_pending', vars: { requestId: 7 }, link: 'https://m/requests', image: 'https://img/p.jpg', priority: 'high' }) as any;
    expect(waiting.aps).toMatchObject({ category: 'request_waiting', 'interruption-level': 'time-sensitive', 'mutable-content': 1, alert: { title: 'T', body: 'B' } });
    expect(waiting).toMatchObject({ requestId: 7, link: 'https://m/requests', image: 'https://img/p.jpg' });
    const plain = apnsPayload({ title: 'T', body: 'B', event: 'request_approved', vars: { requestId: 7 } }) as any;
    expect(plain.aps.category).toBeUndefined();
    expect(apnsPayload({ title: 'T', body: 'B', priority: 'silent' }).aps).not.toHaveProperty('sound');
  });
});

describe('a phone and its channel', () => {
  it('registering twice keeps one channel, listed as on', async () => {
    const t = await setup();
    const p = await t.signInPhone('josh', 'correct horse battery');
    for (const token of [TOKEN, TOKEN2]) expect((await call(t.app, 'POST', `/api/me/devices/${p.id}/push`, { token, environment: 'sandbox' }, undefined, p.bearer)).status).toBe(200);
    const channels = t.db.select().from(notificationChannels).all().filter((c) => c.kind === 'apns');
    expect(channels).toHaveLength(1);
    expect(JSON.parse(channels[0]!.config).token).toBe(TOKEN2);
    const list = await call(t.app, 'GET', '/api/me/devices', undefined, undefined, p.bearer);
    expect(list.body.devices[0].push).toBe(true);
    // The token is a secret: the channel list shows only that it's the iPhone app.
    const mine = await call(t.app, 'GET', '/api/notifications/channels', undefined, undefined, p.bearer);
    expect(JSON.stringify(mine.body)).not.toContain(TOKEN2);
    expect(mine.body.items[0]).toMatchObject({ kind: 'apns', detail: 'iPhone app' });
  });

  it("another person's phone is not theirs to register", async () => {
    const t = await setup();
    const p = await t.signInPhone('josh', 'correct horse battery');
    const res = await call(t.app, 'POST', `/api/me/devices/${p.id}/push`, { token: TOKEN }, t.jessie);
    expect(res.status).toBe(404);
  });

  it('a made-up token is refused', async () => {
    const t = await setup();
    const p = await t.signInPhone('josh', 'correct horse battery');
    expect((await call(t.app, 'POST', `/api/me/devices/${p.id}/push`, { token: 'not hex' }, undefined, p.bearer)).status).toBe(400);
  });

  it('turning it off, signing out and removing the phone all take the channel away', async () => {
    const t = await setup();
    const p = await t.signInPhone('josh', 'correct horse battery');
    const channels = () => t.db.select().from(notificationChannels).all().filter((c) => c.kind === 'apns').length;
    const on = () => call(t.app, 'POST', `/api/me/devices/${p.id}/push`, { token: TOKEN }, undefined, p.bearer);
    await on();
    await call(t.app, 'DELETE', `/api/me/devices/${p.id}/push`, undefined, undefined, p.bearer);
    expect(channels()).toBe(0);
    await on();
    await call(t.app, 'POST', '/api/auth/logout', {}, undefined, p.bearer);
    expect(channels()).toBe(0);
    const p2 = await t.signInPhone('josh', 'correct horse battery');
    await call(t.app, 'POST', `/api/me/devices/${p2.id}/push`, { token: TOKEN }, undefined, p2.bearer);
    await call(t.app, 'DELETE', `/api/me/devices/${p2.id}`, undefined, t.admin);
    expect(channels()).toBe(0);
  });
});

describe('sending to a phone', () => {
  it('"someone asked" reaches the admin phone signed, with the Approve category and the request id', async () => {
    const t = await setup();
    await t.configure();
    const p = await t.signInPhone('josh', 'correct horse battery');
    await call(t.app, 'POST', `/api/me/devices/${p.id}/push`, { token: TOKEN, environment: 'sandbox' }, undefined, p.bearer);
    const asked = await call(t.app, 'POST', '/api/requests', { kind: 'movie', tmdbId: 693134 }, t.jessie);
    expect(asked.status).toBe(201);
    expect(apple.pushes).toHaveLength(1);
    const push = apple.pushes[0]!;
    expect(push).toMatchObject({ token: TOKEN, jwtOk: true, jwtKeyId: 'KEYID12345', jwtTeamId: 'TEAMID1234' });
    expect(push.headers['apns-topic']).toBe('marquee.ios.app');
    expect(push.headers['apns-push-type']).toBe('alert');
    expect(push.payload.aps.category).toBe('request_waiting');
    expect(push.payload.requestId).toBe(asked.body.id);
    expect(push.payload.aps.alert.body).toMatch(/Jessie asked for Dune: Part Two/);
    expect(push.payload.image).toMatch(/^https:\/\/image\.tmdb\.org\//);
  });

  it('a member gets "approved" with no buttons, and only their own phone', async () => {
    const t = await setup();
    await t.configure();
    const mine = await t.signInPhone('jessie', 'jessie password', phone('phone-bbbb-2222', "Jessie's iPhone"));
    await call(t.app, 'POST', `/api/me/devices/${mine.id}/push`, { token: TOKEN2 }, undefined, mine.bearer);
    const asked = await call(t.app, 'POST', '/api/requests', { kind: 'movie', tmdbId: 693134 }, t.jessie);
    expect(apple.pushes).toHaveLength(0); // the admin has no phone on
    await call(t.app, 'POST', `/api/requests/${asked.body.id}/approve`, {}, t.admin);
    await vi.waitFor(() => expect(apple.pushes.map((p) => p.token)).toEqual([TOKEN2]));
    expect(apple.pushes[0]!.payload.aps.category).toBeUndefined();
  });

  it('muted events are not sent', async () => {
    const t = await setup();
    await t.configure();
    const p = await t.signInPhone('josh', 'correct horse battery');
    await call(t.app, 'POST', `/api/me/devices/${p.id}/push`, { token: TOKEN }, undefined, p.bearer);
    await call(t.app, 'PUT', '/api/notifications/muted', { muted: ['request_pending'] }, undefined, p.bearer);
    await call(t.app, 'POST', '/api/requests', { kind: 'movie', tmdbId: 693134 }, t.jessie);
    expect(apple.pushes).toHaveLength(0);
  });

  it('a phone Apple says is gone loses its channel', async () => {
    const t = await setup();
    await t.configure();
    const p = await t.signInPhone('josh', 'correct horse battery');
    await call(t.app, 'POST', `/api/me/devices/${p.id}/push`, { token: TOKEN }, undefined, p.bearer);
    apple.answers.set(TOKEN, { status: 410, reason: 'Unregistered' });
    await call(t.app, 'POST', '/api/requests', { kind: 'movie', tmdbId: 693134 }, t.jessie);
    expect(apple.pushes).toHaveLength(1);
    expect(t.db.select().from(notificationChannels).all().filter((c) => c.kind === 'apns')).toHaveLength(0);
  });

  it('says plainly when Apple turns the key down, and keeps the channel', async () => {
    const t = await setup();
    // A different key than the fake Apple knows.
    await call(t.app, 'PUT', '/api/settings/notifications/apns', { key: new FakeApple().privateKeyPem, keyId: 'KEYID12345', teamId: 'TEAMID1234', bundleId: 'marquee.ios.app' }, t.admin);
    const p = await t.signInPhone('josh', 'correct horse battery');
    await call(t.app, 'POST', `/api/me/devices/${p.id}/push`, { token: TOKEN }, undefined, p.bearer);
    const test = await call(t.app, 'POST', '/api/settings/notifications/apns/test', {}, t.admin);
    expect(test.body.ok).toBe(false);
    expect(test.body.message).toMatch(/Apple turned the key down/);
    expect(JSON.stringify(test.body)).not.toContain('PRIVATE');
    expect(t.db.select().from(notificationChannels).all().filter((c) => c.kind === 'apns')).toHaveLength(1);
  });

  it('the Test button reaches the admin phone, or says there is none', async () => {
    const t = await setup();
    await t.configure();
    expect((await call(t.app, 'POST', '/api/settings/notifications/apns/test', {}, t.admin)).body).toMatchObject({ ok: false, message: expect.stringMatching(/None of your iPhones/) });
    const p = await t.signInPhone('josh', 'correct horse battery');
    await call(t.app, 'POST', `/api/me/devices/${p.id}/push`, { token: TOKEN }, undefined, p.bearer);
    const r = await call(t.app, 'POST', '/api/settings/notifications/apns/test', {}, t.admin);
    expect(r.body).toMatchObject({ ok: true });
    expect(apple.pushes).toHaveLength(1);
  });

  it('without a key nothing is sent and the channel says what to do', async () => {
    const t = await setup();
    const p = await t.signInPhone('josh', 'correct horse battery');
    await call(t.app, 'POST', `/api/me/devices/${p.id}/push`, { token: TOKEN }, undefined, p.bearer);
    await call(t.app, 'POST', '/api/requests', { kind: 'movie', tmdbId: 693134 }, t.jessie);
    expect(apple.pushes).toHaveLength(0);
    expect(t.db.select().from(notificationChannels).all().find((c) => c.kind === 'apns')?.lastError).toMatch(/isn’t set up/);
  });

  it('a wrong app id is a setup problem: the channel stays and says what to check', async () => {
    const t = await setup();
    await t.configure();
    const p = await t.signInPhone('josh', 'correct horse battery');
    await call(t.app, 'POST', `/api/me/devices/${p.id}/push`, { token: TOKEN }, undefined, p.bearer);
    apple.answers.set(TOKEN, { status: 400, reason: 'DeviceTokenNotForTopic' });
    await call(t.app, 'POST', '/api/requests', { kind: 'movie', tmdbId: 693134 }, t.jessie);
    const ch = t.db.select().from(notificationChannels).all().find((c) => c.kind === 'apns');
    expect(ch?.lastError).toMatch(/Check the app id/);
  });

  it('a phone whose sign-in is cut off (password changed) stops getting pushes', async () => {
    const t = await setup();
    await t.configure();
    const mine = await t.signInPhone('jessie', 'jessie password', phone('phone-bbbb-2222', "Jessie's iPhone"));
    await call(t.app, 'POST', `/api/me/devices/${mine.id}/push`, { token: TOKEN2 }, undefined, mine.bearer);
    const users = await call(t.app, 'GET', '/api/users', undefined, t.admin);
    const jessieId = users.body.users.find((u: { username: string }) => u.username === 'jessie').id;
    await call(t.app, 'PATCH', `/api/users/${jessieId}`, { password: 'a new long password' }, t.admin);
    expect(t.db.select().from(notificationChannels).all().filter((c) => c.kind === 'apns')).toHaveLength(0);
  });
});
