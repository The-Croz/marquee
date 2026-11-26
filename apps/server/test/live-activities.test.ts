import { afterAll, describe, expect, it, vi } from 'vitest';
import { ApnsClient } from '../src/notify/apns.js';
import { readApns } from '../src/notify/apnsSettings.js';
import { updateLiveActivities, updateWatchingCards } from '../src/downloads/liveActivity.js';
import { downloads, liveStartTokens, movies } from '../src/db/schema.js';
import type { Db } from '../src/db/index.js';
import type { NowPlayingView } from '@marquee/shared';
import { FakeApple } from './fakes/apns.js';
import { call, makeApp, setupAdmin } from './helpers.js';

/** Lock Screen cards that start by themselves: downloads, and who's watching. */

const START = 'c'.repeat(64);
const UPDATE = 'd'.repeat(64);
let apple: FakeApple;
const started: FakeApple[] = [];
afterAll(async () => {
  for (const a of started) await a.stop();
});

async function setup() {
  apple = await new FakeApple().start();
  started.push(apple);
  let dbRef: Db | null = null;
  const apns = new ApnsClient(() => (dbRef ? readApns(dbRef) : null), apple.url);
  let clock = Date.parse('2026-11-26T12:00:00Z');
  const t = makeApp({ now: () => clock, clients: { apns } });
  dbRef = t.db;
  const admin = await setupAdmin(t.app);
  await call(t.app, 'PUT', '/api/settings/notifications/apns', { key: apple.privateKeyPem, keyId: 'KEYID12345', teamId: 'TEAMID1234', bundleId: 'marquee.ios.app' }, admin);
  const signIn = async (username: string, password: string) => {
    const r = await call(t.app, 'POST', '/api/auth/login', { username, password, device: { id: `phone-${username}-1`, name: 'iPhone', kind: 'ios' } });
    const bearer = { authorization: `Bearer ${r.body.token}` };
    const id = (await call(t.app, 'GET', '/api/me/devices', undefined, undefined, bearer)).body.devices[0].id as string;
    const send = (method: string, url: string, body?: unknown) => call(t.app, method, url, body, undefined, bearer);
    return { id, send };
  };
  const phone = await signIn('josh', 'correct horse battery');
  const tokens = async (kind: 'download' | 'watching', p = phone) => p.send('PUT', `/api/me/devices/${p.id}/live/start-token`, { kind, token: START, environment: 'sandbox' });
  const movie = t.db.insert(movies).values({ tmdbId: 693134, title: 'Dune: Part Two', sortTitle: 'dune', year: 2024, profile: 'cinema', addedAt: 0, refreshedAt: 0 }).returning().get();
  const download = (v: Partial<typeof downloads.$inferInsert> = {}) => t.db.insert(downloads).values({ kind: 'movie', movieId: movie.id, title: 'Dune.2160p', infoHash: String(Math.random()), addedAt: clock, state: 'downloading', progress: 0.1, ...v }).returning().get();
  const cards = () => updateLiveActivities({ db: t.db, apns, now: () => clock });
  const stream = (v: Partial<NowPlayingView> = {}): NowPlayingView => ({ server: 'plex', sessionId: 's1', platform: 'Roku', resolution: '4k', startedAt: clock, user: 'ana', title: 'Dune', subtitle: '2024', device: 'Living room TV', state: 'playing', progress: 0.1, transcoding: false, href: null, posterPath: null, backdropPath: null, facts: [], durationMs: null, userAvatar: null, ...v });
  const watching = (sessions: NowPlayingView[]) => updateWatchingCards({ db: t.db, apns, now: () => clock }, sessions);
  const tick = (ms: number) => void (clock += ms);
  return { ...t, admin, phone, signIn, tokens, download, cards, stream, watching, tick };
}

describe('choosing the cards', () => {
  it('starts with downloads on and watching off, and keeps each phone’s choice', async () => {
    const t = await setup();
    const url = `/api/me/devices/${t.phone.id}/live`;
    expect((await t.phone.send('GET', url)).body).toEqual({ downloads: true, watching: false });
    expect((await t.phone.send('PUT', url, { watching: true })).body).toEqual({ downloads: true, watching: true });
    // The web page changes the same switches.
    expect((await call(t.app, 'PUT', url, { downloads: false }, t.admin)).body).toEqual({ downloads: false, watching: true });
  });

  it('offers members none, and keeps other people out', async () => {
    const t = await setup();
    await call(t.app, 'POST', '/api/users', { username: 'jessie', displayName: 'J', role: 'member', password: 'jessie password' }, t.admin);
    const j = await t.signIn('jessie', 'jessie password');
    expect((await j.send('GET', `/api/me/devices/${j.id}/live`)).body).toEqual({ downloads: null, watching: null });
    expect((await j.send('GET', `/api/me/devices/${t.phone.id}/live`)).status).toBe(404);
  });
});

describe('a download starting', () => {
  it('starts one card by itself, once', async () => {
    const t = await setup();
    expect((await t.tokens('download')).status).toBe(200);
    const d = t.download();
    await t.cards();
    await t.cards();
    expect(apple.pushes).toHaveLength(1);
    expect(apple.pushes[0]!.token).toBe(START);
    expect(apple.pushes[0]!.headers['apns-push-type']).toBe('liveactivity');
    expect(apple.pushes[0]!.payload.aps).toMatchObject({ event: 'start', 'attributes-type': 'DownloadActivityAttributes', attributes: { title: 'Dune: Part Two (2024)', downloadId: d.id }, 'content-state': { progress: 0.1, done: false }, alert: { title: 'Downloading', body: 'Dune: Part Two (2024)' } });
  });

  it('keeps to three at a time, and skips ones that began long ago', async () => {
    const t = await setup();
    await t.tokens('download');
    for (let i = 0; i < 5; i++) t.download();
    t.download({ addedAt: 0 });
    await t.cards();
    await t.cards();
    expect(apple.pushes.filter((p) => p.payload.aps.event === 'start')).toHaveLength(3);
  });

  it('gives no second card to a phone already following that download, but still starts it elsewhere', async () => {
    const t = await setup();
    await call(t.app, 'POST', '/api/users', { username: 'sam', displayName: 'Sam', role: 'admin', password: 'sam password' }, t.admin);
    const sam = await t.signIn('sam', 'sam password');
    await t.tokens('download');
    await sam.send('PUT', `/api/me/devices/${sam.id}/live/start-token`, { kind: 'download', token: 'e'.repeat(64), environment: 'sandbox' });
    const d = t.download();
    await t.phone.send('POST', `/api/downloads/${d.id}/live-activity`, { token: UPDATE, environment: 'sandbox' });
    await t.cards();
    expect(apple.pushes.filter((p) => p.payload.aps.event === 'start').map((p) => p.token)).toEqual(['e'.repeat(64)]);
  });

  it('starts nothing when the switch is off', async () => {
    const t = await setup();
    await t.tokens('download');
    await t.phone.send('PUT', `/api/me/devices/${t.phone.id}/live`, { downloads: false });
    t.download();
    await t.cards();
    expect(apple.pushes).toHaveLength(0);
  });

  it('forgets the phone’s start address when it signs out', async () => {
    const t = await setup();
    await t.tokens('download');
    await t.phone.send('POST', '/api/auth/logout', {});
    expect(t.db.select().from(liveStartTokens).all()).toEqual([]);
  });
});

describe('someone watching', () => {
  async function on() {
    const t = await setup();
    await t.phone.send('PUT', `/api/me/devices/${t.phone.id}/live`, { watching: true });
    await t.tokens('watching');
    return t;
  }

  it('starts a card, updates it as it plays, and ends it when they stop', async () => {
    const t = await on();
    const s = t.stream();
    await t.watching([s]);
    await t.watching([s]);
    expect(apple.pushes).toHaveLength(1);
    const start = apple.pushes[0]!.payload.aps;
    expect(start).toMatchObject({ event: 'start', 'attributes-type': 'WatchingActivityAttributes', attributes: { title: 'Dune', detail: 'ana · Living room TV', ref: `plex:s1:${s.startedAt}` }, 'content-state': { progress: 0.1, status: 'Playing', done: false } });

    // The app hands back the card's own address.
    expect((await t.phone.send('POST', '/api/activity/live-activity', { ref: start.attributes.ref, token: UPDATE, environment: 'sandbox' })).status).toBe(200);
    // The first look brings it up to date; small moves after that wait.
    await t.watching([s]);
    expect(apple.pushes).toHaveLength(2);
    await t.watching([{ ...s, progress: 0.12 }]);
    expect(apple.pushes).toHaveLength(2);
    await t.watching([{ ...s, progress: 0.2, state: 'paused', transcoding: true }]);
    expect(apple.pushes.at(-1)).toMatchObject({ token: UPDATE, payload: { aps: { event: 'update', 'content-state': { status: 'Paused · converting' } } } });
    await t.watching([]);
    expect(apple.pushes.at(-1)!.payload.aps).toMatchObject({ event: 'end', 'content-state': { status: 'Finished', done: true } });
    await t.watching([]);
    expect(apple.pushes).toHaveLength(4);
  });

  it('is off until switched on', async () => {
    const t = await setup();
    await t.tokens('watching');
    await t.watching([t.stream()]);
    expect(apple.pushes).toHaveLength(0);
  });

  it('follows the streams Marquee sees', async () => {
    const t = await on();
    const { FakeMediaServer } = await import('./fakes/mediaServers.js');
    const plex = new FakeMediaServer('plex');
    plex.playing = [{ sessionId: 's9', platform: 'Roku', resolution: null, kind: 'movie', title: 'Up', show: null, season: null, episode: null, year: 2009, tmdbId: null, user: 'ana', device: 'TV', state: 'playing', progress: 0, transcoding: false }];
    t.clients.plexServer = (u: string, k: string) => plex.as(u, k);
    await call(t.app, 'PUT', '/api/settings/services', { plexUrl: 'http://plex:32400', plexToken: 'plex-token' }, t.admin);
    await call(t.app, 'GET', '/api/activity/now', undefined, t.admin);
    await vi.waitFor(() => expect(apple.pushes.map((p) => p.payload.aps.attributes?.title)).toEqual(['Up']));
  });
});
