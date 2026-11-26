import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrations, openDb } from '../src/db/index.js';
import { devices, notificationChannels, userPrefs, users } from '../src/db/schema.js';
import { notifyAdmins, notifyUser } from '../src/notify/service.js';
import { call, makeApp, setupAdmin } from './helpers.js';

/**
 * Settings → Notifications: every place (the web UI, each phone, each added
 * service) is ticked on its own, an added service can be shared with the
 * other admins, and the iPhone app picks its own messages.
 */

const TOKEN = 'a'.repeat(64);

async function setup() {
  const sent: { kind: string; event?: string }[] = [];
  const push = { send: async (c: { kind: string }, m: { event?: string }) => void sent.push({ kind: c.kind, event: m.event }) };
  const t = makeApp({ clients: { push } });
  const admin = await setupAdmin(t.app);
  const person = async (username: string, role: 'admin' | 'member') => {
    await call(t.app, 'POST', '/api/users', { username, displayName: username, role, password: `${username} password` }, admin);
    return (await call(t.app, 'POST', '/api/auth/login', { username, password: `${username} password` })).cookie!;
  };
  const sam = await person('sam', 'admin');
  const jessie = await person('jessie', 'member');
  const id = (username: string) => t.db.select().from(users).all().find((u) => u.username === username)!.id;
  const signInPhone = async (username: string, password: string, push = true) => {
    const r = await call(t.app, 'POST', '/api/auth/login', { username, password, device: { id: `phone-${username}-1`, name: 'iPhone', kind: 'ios' } });
    const bearer = { authorization: `Bearer ${r.body.token}` };
    const list = await call(t.app, 'GET', '/api/me/devices', undefined, undefined, bearer);
    const device = list.body.devices[0].id as string;
    if (push) await call(t.app, 'POST', `/api/me/devices/${device}/push`, { token: TOKEN }, undefined, bearer);
    return { device, bearer };
  };
  const deps = { db: t.db, push, now: () => 1 };
  const add = async (who: string, base: string, events?: string[]) =>
    (await call(t.app, 'POST', base, { kind: 'pushover', name: 'House', appToken: 'a', userKey: 'u', ...(events ? { events } : {}) }, who)).body as { id: number; shared: boolean; events: string[] };
  const list = async (who: string, base: string) => (await call(t.app, 'GET', base, undefined, who)).body.items as { id: number; shared: boolean; events: string[] }[];
  return { ...t, admin, sam, jessie, sent, deps, id, signInPhone, add, list };
}

const MINE = '/api/notifications/channels';
const SHARED = '/api/settings/notifications';
const inbox = async (t: Awaited<ReturnType<typeof setup>>, who: string) => (await call(t.app, 'GET', '/api/notifications', undefined, who)).body.items as { event: string }[];

describe('each place is ticked on its own', () => {
  it('sends to a ticked phone even when the web UI is unticked', async () => {
    const t = await setup();
    await t.add(t.jessie, MINE, ['request_declined']);
    await call(t.app, 'PUT', '/api/notifications/muted', { muted: ['request_declined'] }, t.jessie);
    await notifyUser(t.deps, t.id('jessie'), 'request_declined', { vars: { title: 'Up' } });
    expect(t.sent).toEqual([{ kind: 'pushover', event: 'request_declined' }]);
    expect(await inbox(t, t.jessie)).toEqual([]);
  });

  it('does the same for an admin message, per admin', async () => {
    const t = await setup();
    await t.add(t.admin, MINE, ['disk_low']);
    await call(t.app, 'PUT', '/api/notifications/muted', { muted: ['disk_low'] }, t.admin);
    await notifyAdmins(t.deps, 'disk_low', { vars: {} });
    expect(t.sent).toEqual([{ kind: 'pushover', event: 'disk_low' }]);
    expect(await inbox(t, t.admin)).toEqual([]);
    expect((await inbox(t, t.sam)).map((n) => n.event)).toEqual(['disk_low']);
  });

  it('keeps the web UI message when no phone is ticked', async () => {
    const t = await setup();
    await t.add(t.jessie, MINE, []);
    await notifyUser(t.deps, t.id('jessie'), 'request_declined', { vars: {} });
    expect(t.sent).toEqual([]);
    expect(await inbox(t, t.jessie)).toHaveLength(1);
  });
});

describe('updating to separate ticks', () => {
  it('unticks, on each person’s own places, what their web UI had switched off, so nothing new arrives', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-places-'));
    const file = path.join(dir, 'marquee.sqlite');
    const first = openDb(file);
    const user = (username: string) => first.insert(users).values({ username, displayName: username, role: 'admin', createdAt: 0, updatedAt: 0 } as never).returning().get().id;
    const one = user('one');
    const two = user('two');
    first.insert(userPrefs).values({ userId: one, mutedEvents: '["disk_low","imported"]' }).run();
    const channel = (userId: number | null, events: string) => first.insert(notificationChannels).values({ kind: 'pushover', name: 'x', userId, events, createdAt: 0 }).returning().get().id;
    const mine = channel(one, '["disk_low","upgraded","imported"]');
    const allOff = channel(one, '["disk_low"]');
    const theirs = channel(two, '["disk_low"]');
    const shared = channel(null, '["disk_low","imported"]');
    first.insert(devices).values({ id: 'd1', userId: one, name: 'iPhone', kind: 'ios', createdAt: 0, lastSeenAt: 0, pushEvents: '["imported","upgraded"]' }).run();
    first.insert(devices).values({ id: 'd2', userId: one, name: 'iPad', kind: 'ios', createdAt: 0, lastSeenAt: 0, pushEvents: null }).run();
    first.$client.close();

    // Put the database one migration behind, then open it again.
    const raw = new Database(file);
    raw.exec(`DELETE FROM schema_migrations WHERE version = ${migrations.length}`);
    raw.close();
    const db = openDb(file);

    const events = Object.fromEntries(db.select().from(notificationChannels).all().map((c) => [c.id, JSON.parse(c.events)]));
    expect(events).toEqual({ [mine]: ['upgraded'], [allOff]: [], [theirs]: ['disk_low'], [shared]: ['disk_low', 'imported'] });
    const kept = Object.fromEntries(db.select().from(devices).all().map((d) => [d.id, d.pushEvents]));
    expect(kept).toEqual({ d1: '["upgraded"]', d2: null });
    db.$client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('sharing an added service', () => {
  it('says which places are shared', async () => {
    const t = await setup();
    expect((await t.add(t.admin, MINE)).shared).toBe(false);
    expect((await t.add(t.admin, SHARED)).shared).toBe(true);
  });

  it('moves it to the shared places and back, keeping only admin messages while shared', async () => {
    const t = await setup();
    const mine = await t.add(t.admin, MINE, ['disk_low', 'request_ready']);
    const on = await call(t.app, 'PUT', `${SHARED}/${mine.id}/shared`, { shared: true }, t.admin);
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ id: mine.id, shared: true, events: ['disk_low'] });
    expect(await t.list(t.admin, MINE)).toEqual([]);
    expect((await t.list(t.sam, SHARED)).map((c) => c.id)).toEqual([mine.id]);

    // Another admin takes it for themselves.
    const off = await call(t.app, 'PUT', `${SHARED}/${mine.id}/shared`, { shared: false }, t.sam);
    expect(off.body).toMatchObject({ shared: false, events: ['disk_low'] });
    expect((await t.list(t.sam, MINE)).map((c) => c.id)).toEqual([mine.id]);
    expect(await t.list(t.admin, SHARED)).toEqual([]);
  });

  it('is for admins, and never reaches someone else’s own place', async () => {
    const t = await setup();
    const jessies = await t.add(t.jessie, MINE);
    const sams = await t.add(t.sam, MINE);
    expect((await call(t.app, 'PUT', `${SHARED}/${jessies.id}/shared`, { shared: true }, t.jessie)).status).toBe(403);
    expect((await call(t.app, 'PUT', `${SHARED}/${sams.id}/shared`, { shared: true }, t.admin)).status).toBe(404);
  });

  it('won’t share an iPhone', async () => {
    const t = await setup();
    await t.signInPhone('josh', 'correct horse battery');
    const [phone] = await t.list(t.admin, MINE);
    const res = await call(t.app, 'PUT', `${SHARED}/${phone!.id}/shared`, { shared: true }, t.admin);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('An iPhone belongs to one person, so it can’t be shared.');
  });
});

describe('the iPhone app’s own choice of messages', () => {
  it('lists what this person can get and what this phone gets, and changes just the ones asked', async () => {
    const t = await setup();
    const p = await t.signInPhone('josh', 'correct horse battery');
    const url = `/api/me/devices/${p.device}/push/events`;
    const first = await call(t.app, 'GET', url, undefined, undefined, p.bearer);
    expect(first.status).toBe(200);
    expect(first.body.events.map((e: { key: string }) => e.key)).toContain('disk_low');
    expect(first.body.on).toContain('disk_low');
    expect(first.body.on).not.toContain('stream_started');

    const changed = await call(t.app, 'PUT', url, { events: ['stream_started', 'stream_paused'], on: true }, undefined, p.bearer);
    expect(changed.body.on).toEqual([...first.body.on, 'stream_started', 'stream_paused']);
    const off = await call(t.app, 'PUT', url, { events: ['disk_low'], on: false }, undefined, p.bearer);
    expect(off.body.on).not.toContain('disk_low');
    expect(off.body.on).toContain('stream_started');
    // The web page shows the same ticks.
    expect((await t.list(t.admin, MINE))[0]!.events).toEqual(off.body.on);
  });

  it('never gives a member an admin message', async () => {
    const t = await setup();
    const p = await t.signInPhone('jessie', 'jessie password');
    const url = `/api/me/devices/${p.device}/push/events`;
    const res = await call(t.app, 'PUT', url, { events: ['disk_low', 'nonsense'], on: true }, undefined, p.bearer);
    expect(res.body.on).not.toContain('disk_low');
    expect(res.body.on).not.toContain('nonsense');
    expect(res.body.events.map((e: { key: string }) => e.key)).not.toContain('disk_low');
  });

  it('says what to do when this phone’s notifications are off, and keeps other people out', async () => {
    const t = await setup();
    const p = await t.signInPhone('jessie', 'jessie password', false);
    const url = `/api/me/devices/${p.device}/push/events`;
    const res = await call(t.app, 'GET', url, undefined, undefined, p.bearer);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Notifications are off for this iPhone. Turn them on first.');
    expect((await call(t.app, 'GET', url, undefined, t.admin)).status).toBe(404);
  });
});
