import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DownloadsView } from '@marquee/shared';
import { schema } from '../src/db/index.js';
import { seedRule, sharedEnough, sharingProgress } from '../src/downloads/seeding.js';
import { FakeQbit, qbitTorrent } from './fakes/qbittorrent.js';
import { call, makeApp, setupAdmin } from './helpers.js';

const DAY = 86_400;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function setup(opts: { privateSite?: boolean; libraryFile?: boolean } = {}) {
  const qbit = new FakeQbit();
  let clock = Date.parse('2026-11-18T12:00:00Z');
  const t = makeApp({ now: () => clock, clients: { qbittorrent: (u, n, p) => qbit.as(u, n, p) } });
  const cookie = await setupAdmin(t.app);
  await call(t.app, 'PUT', '/api/settings/downloader', { url: qbit.url, username: 'admin', password: 'adminadmin' }, cookie);
  const source = t.db
    .insert(schema.sources)
    .values({ name: opts.privateSite ? 'IPTorrents' : 'YTS', url: 'http://p/1/api', private: !!opts.privateSite, createdAt: 0 })
    .returning()
    .get();
  const movie = t.db.insert(schema.movies).values({ tmdbId: 1, title: 'Up', sortTitle: 'up', year: 2009, profile: 'cinema', addedAt: 0, refreshedAt: 0 }).returning().get();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-seed-'));
  dirs.push(root);
  const lib = path.join(root, 'Up (2009)/Up (2009).mkv');
  if (opts.libraryFile !== false) {
    fs.mkdirSync(path.dirname(lib), { recursive: true });
    fs.writeFileSync(lib, 'x');
  }
  const row = t.db
    .insert(schema.downloads)
    .values({ kind: 'movie', movieId: movie.id, title: 'Up.2009.1080p', infoHash: 'h1', sourceId: source.id, addedAt: 0, state: 'done', importedAt: 1, importedPaths: JSON.stringify([lib]) })
    .returning()
    .get();
  qbit.list.push(qbitTorrent('h1', { state: 'stalledUP', progress: 1 }));
  const view = async () => {
    clock += 11_000;
    return (await call(t.app, 'GET', '/api/downloads', undefined, cookie)).body as DownloadsView;
  };
  return { ...t, qbit, cookie, source, row, view, torrent: () => qbit.list.find((x) => x.hash === 'h1'), lib };
}

describe('seeding rules', () => {
  it('uses the defaults, keeps sharing on private sites, and a Source’s own rule wins', async () => {
    const pub = await setup();
    expect(seedRule(pub.db, pub.row)).toEqual({ ratio: 2, days: 14, from: 'the default rule' });
    const priv = await setup({ privateSite: true });
    expect(seedRule(priv.db, priv.row)).toEqual({ ratio: 0, days: 0, from: 'IPTorrents is a private site' });
    await call(priv.app, 'PUT', `/api/settings/sources/${priv.source.id}`, { seedRatio: 1.5, seedDays: null }, priv.cookie);
    expect(seedRule(priv.db, priv.row)).toEqual({ ratio: 1.5, days: 0, from: 'IPTorrents’s own rule' });
    await call(priv.app, 'PUT', '/api/settings/downloader', { privateKeepSharing: false }, priv.cookie);
    await call(priv.app, 'PUT', `/api/settings/sources/${priv.source.id}`, { seedRatio: null }, priv.cookie);
    expect(seedRule(priv.db, priv.row).from).toBe('the default rule');
  });

  it('counts whichever comes first, and never when there are no limits', () => {
    const rule = { ratio: 2, days: 14, from: '' };
    expect(sharedEnough(rule, 1.9, 13 * DAY)).toBe(false);
    expect(sharedEnough(rule, 2, 0)).toBe(true);
    expect(sharedEnough(rule, 0.1, 14 * DAY)).toBe(true);
    expect(sharedEnough({ ratio: 0, days: 0, from: '' }, 99, 999 * DAY)).toBe(false);
    expect(sharingProgress(rule, 0.84, 3.5 * DAY)).toBe('ratio 0.8 of 2.0 · 3 of 14 days');
    expect(sharingProgress({ ratio: 0, days: 7, from: '' }, 1, DAY)).toBe('1 of 7 days');
  });
});

describe('done sharing', () => {
  it('shows progress, then "done sharing", and leaves it in qBittorrent by default', async () => {
    const t = await setup();
    Object.assign(t.torrent()!, { ratio: 0.8, seedingSeconds: 3 * DAY });
    let v = (await t.view()).items[0]!;
    expect(v.status).toMatchObject({ label: 'In your library · sharing', detail: 'Sharing until ratio 0.8 of 2.0 or 3 of 14 days, whichever comes first (the default rule).' });
    expect(v.canRemoveShared).toBe(true);
    t.torrent()!.ratio = 2.1;
    v = (await t.view()).items[0]!;
    expect(v.status.label).toBe('In your library · done sharing');
    expect(t.qbit.actions).toEqual([]);
  });

  it('removes it from qBittorrent when that’s turned on, keeping the library file', async () => {
    const t = await setup();
    await call(t.app, 'PUT', '/api/settings/downloader', { removeWhenShared: true }, t.cookie);
    t.torrent()!.seedingSeconds = 15 * DAY;
    const v = (await t.view()).items[0]!;
    expect(v).toMatchObject({ state: 'removed', canRemoveShared: false });
    expect(v.message).toMatch(/^Done sharing \(ratio 0\.0 of 2\.0 · 15 of 14 days\)\. Removed from qBittorrent with the download’s files; the library file stays\.$/);
    expect(t.qbit.actions).toEqual(['remove h1 with files']);
    expect(fs.existsSync(t.lib)).toBe(true);
  });

  it('keeps the download’s files if the library file has gone missing', async () => {
    const t = await setup({ libraryFile: false });
    await call(t.app, 'PUT', '/api/settings/downloader', { removeWhenShared: true }, t.cookie);
    t.torrent()!.ratio = 5;
    expect((await t.view()).items[0]!.message).toMatch(/files were kept because Marquee couldn’t find the library file/);
    expect(t.qbit.actions).toEqual(['remove h1']);
  });

  it('keeps sharing on a private site with no rule of its own', async () => {
    const t = await setup({ privateSite: true });
    await call(t.app, 'PUT', '/api/settings/downloader', { removeWhenShared: true }, t.cookie);
    Object.assign(t.torrent()!, { ratio: 9, seedingSeconds: 100 * DAY });
    const v = (await t.view()).items[0]!;
    expect(v.status.detail).toBe('qBittorrent keeps sharing it until you remove it (IPTorrents is a private site).');
    expect(t.qbit.actions).toEqual([]);
  });

  it('Remove takes it out of qBittorrent, and a download removed in qBittorrent is noted', async () => {
    const t = await setup();
    const rm = await call(t.app, 'POST', `/api/downloads/${t.row.id}/remove`, { deleteFiles: true }, t.cookie);
    expect(rm.body.message).toBe('Removed from qBittorrent with the download’s files. The library file stays.');
    const u = await setup();
    u.qbit.list = [];
    expect((await u.view()).items[0]).toMatchObject({ state: 'removed', message: 'Removed from qBittorrent. The library file stays.' });
  });

  it('checks the numbers', async () => {
    const t = await setup();
    expect((await call(t.app, 'PUT', '/api/settings/downloader', { minSeeders: 4 }, t.cookie)).body.minSeeders).toBe(4);
    expect((await call(t.app, 'PUT', '/api/settings/downloader', { minSeeders: 0 }, t.cookie)).status).toBe(400);
    expect((await call(t.app, 'PUT', '/api/settings/downloader', { seedRatio: -1 }, t.cookie)).body.message).toMatch(/0 \(no limit\) or more/);
    expect((await call(t.app, 'PUT', `/api/settings/sources/${t.source.id}`, { seedDays: -3 }, t.cookie)).status).toBe(400);
  });
});
