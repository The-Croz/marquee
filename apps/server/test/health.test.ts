import { describe, expect, it } from 'vitest';
import { checkHealth } from '../src/notify/health.js';
import { downloads, notificationChannels, notifications, sources, series, episodes } from '../src/db/schema.js';
import { QbitError } from '../src/downloads/qbittorrent.js';
import { FakeQbit, qbitTorrent } from './fakes/qbittorrent.js';
import { call, makeApp, setupAdmin } from './helpers.js';

async function setup() {
  const qbit = new FakeQbit();
  const pushed: string[] = [];
  const push = { send: async (_c: unknown, m: { title: string }) => void pushed.push(m.title) };
  const t = makeApp({ clients: { qbittorrent: (u, n, p) => qbit.as(u, n, p), push } });
  const admin = await setupAdmin(t.app);
  t.db.insert(notificationChannels).values({ kind: 'ntfy', name: 'Phone', config: '{"topic":"t"}', events: JSON.stringify(['source_problem', 'downloader_problem', 'episode_aired']), createdAt: 1 }).run();
  let clock = Date.parse('2026-11-18T12:00:00Z');
  const run = () => checkHealth({ db: t.db, push: push, clients: { qbittorrent: (u, n, p) => qbit.as(u, n, p) }, now: () => clock });
  const inbox = () => t.db.select().from(notifications).all().map((n) => n.title);
  return { ...t, qbit, pushed, run, inbox, admin, day: (d: number) => (clock += d * 86_400_000) };
}

const addSource = (db: ReturnType<typeof makeApp>['db'], over: Partial<typeof sources.$inferInsert>) =>
  db.insert(sources).values({ name: 'IPT', url: 'https://x', createdAt: 1, ...over }).run();

describe('health notifications', () => {
  it('tells admins once when a Source keeps failing, and again only after it recovers', async () => {
    const { db, run, pushed, inbox } = await setup();
    addSource(db, { state: 'blocked', failures: 2 });
    await run();
    expect(pushed).toEqual([]);
    db.update(sources).set({ failures: 3 }).run();
    await run();
    await run();
    expect(pushed).toEqual(['IPT stopped working']);
    expect(inbox()).toEqual(['IPT stopped working']);
    db.update(sources).set({ state: 'working', failures: 0 }).run();
    await run();
    db.update(sources).set({ state: 'unreachable', failures: 4 }).run();
    await run();
    expect(pushed).toHaveLength(2);
  });

  it('ignores paused Sources and ones that only asked us to slow down', async () => {
    const { db, run, pushed } = await setup();
    addSource(db, { enabled: false, state: 'error', failures: 9 });
    addSource(db, { name: 'B', state: 'slowed_down', failures: 9 });
    await run();
    expect(pushed).toEqual([]);
  });

  it('tells admins once when the downloader stops answering', async () => {
    const { app, admin, qbit, run, pushed } = await setup();
    await call(app, 'PUT', '/api/settings/downloader', { url: qbit.url, username: qbit.username, password: qbit.password }, admin);
    await run();
    expect(pushed).toEqual([]);
    qbit.fail = new QbitError('unreachable', 'down');
    await run();
    await run();
    expect(pushed).toEqual(['qBittorrent stopped working']);
  });

  it('tells admins once when most downloads on the way can’t find anyone, and again only after it clears', async () => {
    const { app, admin, qbit, run, pushed, db } = await setup();
    await call(app, 'PUT', '/api/settings/downloader', { url: qbit.url, username: qbit.username, password: qbit.password }, admin);
    const old = Date.parse('2026-11-18T12:00:00Z') - 3_600_000;
    const row = (h: string) => db.insert(downloads).values({ kind: 'movie', title: h, infoHash: h, addedAt: old, state: 'downloading' }).run();
    ['a', 'b', 'c'].forEach(row);
    qbit.list = [qbitTorrent('a', { state: 'metaDL' }), qbitTorrent('b', { state: 'stalledDL' }), qbitTorrent('c', { state: 'downloading', progress: 0.4, seedsConnected: 3 })];
    await run();
    await run();
    expect(pushed).toEqual(['qBittorrent stopped working']);
    qbit.list = [qbitTorrent('a', { progress: 0.1, seedsConnected: 2 }), qbitTorrent('b', { progress: 0.1, seedsConnected: 2 }), qbitTorrent('c', { progress: 0.4, seedsConnected: 3 })];
    await run();
    qbit.list = [qbitTorrent('a', { state: 'metaDL' }), qbitTorrent('b', { state: 'metaDL' }), qbitTorrent('c', { state: 'metaDL' })];
    await run();
    expect(pushed).toHaveLength(2);
  });

  it('one stuck download alone is a bad copy, not a connection problem', async () => {
    const { app, admin, qbit, run, pushed, db } = await setup();
    await call(app, 'PUT', '/api/settings/downloader', { url: qbit.url, username: qbit.username, password: qbit.password }, admin);
    db.insert(downloads).values({ kind: 'movie', title: 'a', infoHash: 'a', addedAt: 0, state: 'downloading' }).run();
    qbit.list = [qbitTorrent('a', { state: 'metaDL' })];
    await run();
    expect(pushed).toEqual([]);
  });

  it('sends one message a day listing wanted episodes that aired', async () => {
    const { db, run, pushed, day } = await setup();
    const show = db.insert(series).values({ tmdbId: 1, title: 'Severance', sortTitle: 'severance', addedAt: 1, refreshedAt: 1, path: '/tv/s', monitored: true } as never).returning().get();
    const other = db.insert(series).values({ tmdbId: 2, title: 'Unwanted', sortTitle: 'unwanted', addedAt: 1, refreshedAt: 1, path: '/tv/u', monitored: false } as never).returning().get();
    db.insert(episodes).values([
      { seriesId: show.id, season: 2, episode: 3, airDate: '2026-11-18' },
      { seriesId: other.id, season: 1, episode: 1, airDate: '2026-11-18' },
    ]).run();
    await run();
    await run();
    expect(pushed).toEqual(['New episode: Severance S02E03']);
    day(1);
    await run();
    expect(pushed).toHaveLength(1);
  });
});
