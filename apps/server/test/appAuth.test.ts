import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { call, makeApp, setupAdmin } from './helpers.js';
import { signInDevice } from '../src/auth/devices.js';
import { devices } from '../src/db/schema.js';
import { findUserByUsername } from '../src/auth/users.js';

const DAY = 24 * 60 * 60 * 1000;
const PHONE = { id: 'phone-aaaa-1111', name: "Josh's iPhone", kind: 'ios' as const };
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function setup(startAt = 1_800_000_000_000) {
  let clock = startAt;
  const t = makeApp({ now: () => clock });
  await setupAdmin(t.app);
  const josh = findUserByUsername(t.db, 'josh')!;
  return { ...t, josh, advance: (ms: number) => (clock += ms), clock: () => clock };
}

describe('bearer tokens and devices', () => {
  it('accepts a bearer token like a cookie', async () => {
    const t = await setup();
    const token = signInDevice(t.db, t.josh, PHONE, 'Marquee/1', t.clock());
    const res = await call(t.app, 'GET', '/api/me', undefined, undefined, bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('josh');
  });

  it('a bad bearer token is signed out', async () => {
    const t = await setup();
    const res = await call(t.app, 'GET', '/api/me', undefined, undefined, bearer('nope'));
    expect(res.status).toBe(401);
  });

  it('app sessions last 180 days and slide; web ones last 30', async () => {
    const t = await setup();
    const token = signInDevice(t.db, t.josh, PHONE, undefined, t.clock());
    t.advance(179 * DAY);
    expect((await call(t.app, 'GET', '/api/me', undefined, undefined, bearer(token))).status).toBe(200);
    t.advance(179 * DAY); // used 179 days ago, so still good
    expect((await call(t.app, 'GET', '/api/me', undefined, undefined, bearer(token))).status).toBe(200);
    t.advance(181 * DAY);
    expect((await call(t.app, 'GET', '/api/me', undefined, undefined, bearer(token))).status).toBe(401);

    const web = await call(t.app, 'POST', '/api/auth/login', { username: 'josh', password: 'correct horse battery' });
    t.advance(31 * DAY);
    expect((await call(t.app, 'GET', '/api/me', undefined, web.cookie)).status).toBe(401);
  });

  it('signing in again on the same phone reuses the device', async () => {
    const t = await setup();
    const first = signInDevice(t.db, t.josh, PHONE, undefined, t.clock());
    const second = signInDevice(t.db, t.josh, PHONE, undefined, t.clock() + 1000);
    expect(t.db.select().from(devices).all()).toHaveLength(1);
    expect((await call(t.app, 'GET', '/api/me', undefined, undefined, bearer(first))).status).toBe(401);
    expect((await call(t.app, 'GET', '/api/me', undefined, undefined, bearer(second))).status).toBe(200);
  });

  it('another person on the same phone takes the device over', async () => {
    const t = await setup();
    const other = (await call(t.app, 'POST', '/api/users', { username: 'sam', displayName: 'Sam', password: 'a long password', role: 'member' }, (await call(t.app, 'POST', '/api/auth/login', { username: 'josh', password: 'correct horse battery' })).cookie)).body;
    signInDevice(t.db, t.josh, PHONE, undefined, t.clock());
    const sam = findUserByUsername(t.db, 'sam') ?? other;
    signInDevice(t.db, sam, PHONE, undefined, t.clock());
    expect(t.db.select().from(devices).where(eq(devices.id, PHONE.id)).get()?.userId).toBe(sam.id);
  });
});
