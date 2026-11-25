import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { HistoryView, ReconcileView } from '@marquee/shared';
import { schema } from '../src/db/index.js';
import { QbitError } from '../src/downloads/qbittorrent.js';
import { FakeQbit, qbitTorrent } from './fakes/qbittorrent.js';
import { FakeTmdb } from './fakes/tmdb.js';
import { call, makeApp, setupAdmin } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const H = (c: string) => c.repeat(40);
const DAY = 86_400;
const NOW = Date.parse('2026-11-24T12:00:00Z');

/** A library and a torrents folder on disk, a fake qBittorrent with one torrent of each kind. */
async function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-rec-'));
  dirs.push(root);
  const qbit = new FakeQbit();
  const t = makeApp({ now: () => NOW, clients: { tmdb: () => new FakeTmdb(), qbittorrent: (u, n, p) => qbit.as(u, n, p) } });
  const admin = await setupAdmin(t.app);
  const api = (method: string, url: string, body?: unknown) => call(t.app, method, url, body, admin);
  await api('PUT', '/api/settings/services', { tmdbApiKey: 'good-key', moviesRoot: `${root}/media/movies`, tvRoot: `${root}/media/tv` });
  await api('PUT', '/api/system/disk', { downloadsFolder: `${root}/torrents` });
  const tor = `${root}/torrents`;
  const write = (rel: string, bytes = 1000) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(bytes, 7));
    return p;
  };
  const link = (from: string, rel: string) => {
    const to = path.join(root, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.linkSync(from, to);
  };
  // In the library: The Matrix (shared plenty) and Up (just started sharing), both hardlinked from torrents.
  link(write('torrents/radarr/The.Matrix.1999.1080p/matrix.mkv', 800), 'media/movies/The Matrix (1999) {tmdb-603}/The Matrix (1999).mkv');
  link(write('torrents/radarr/Up.2009.1080p/up.mkv', 600), 'media/movies/Up (2009) {tmdb-14160}/Up (2009).mkv');
  write('torrents/radarr/Old.Movie.2001.720p/old.mkv', 500);
  write('torrents/marquee/Half.Done.2024/half.mkv', 100);
  write('torrents/tv-sonarr/Stuck.Show.S01E01/stuck.mkv', 10);
  write('torrents/tv-sonarr/Broken.Show.S01E01/broken.mkv', 10);
  await api('POST', '/api/library/scan', {});
  await t.scanner.wait();
  await api('PUT', '/api/settings/downloader', { url: qbit.url, username: 'admin', password: 'adminadmin' });
  const at = (cat: string, name: string) => ({ savePath: `${tor}/${cat}`, contentPath: `${tor}/${cat}/${name}`, name, category: cat });
  const file = (hash: string, name: string, f: string, size: number) => qbit.fileLists.set(hash, [{ name: `${name}/${f}`, size }]);
  qbit.list = [
    qbitTorrent(H('a'), { ...at('radarr', 'The.Matrix.1999.1080p'), state: 'stalledUP', progress: 1, size: 800, ratio: 3, seedingSeconds: 20 * DAY }),
    qbitTorrent(H('b'), { ...at('radarr', 'Up.2009.1080p'), state: 'uploading', progress: 1, size: 600, ratio: 0.2, seedingSeconds: DAY }),
    qbitTorrent(H('c'), { ...at('radarr', 'Old.Movie.2001.720p'), state: 'stalledUP', progress: 1, size: 500, ratio: 1 }),
    qbitTorrent(H('d'), { ...at('marquee', 'Half.Done.2024'), state: 'downloading', progress: 0.5, size: 200, addedOn: NOW - 3_600_000 }),
    qbitTorrent(H('e'), { ...at('tv-sonarr', 'Stuck.Show.S01E01'), state: 'stalledDL', progress: 0.1, size: 100, addedOn: NOW - 3 * DAY * 1000 }),
    qbitTorrent(H('f'), { ...at('tv-sonarr', 'Broken.Show.S01E01'), state: 'error', progress: 0.1, size: 100 }),
    qbitTorrent(H('9'), { ...at('radarr', 'Gone.Movie.2010'), state: 'missingFiles', progress: 1, size: 700 }),
  ];
  file(H('a'), 'The.Matrix.1999.1080p', 'matrix.mkv', 800);
  file(H('b'), 'Up.2009.1080p', 'up.mkv', 600);
  file(H('c'), 'Old.Movie.2001.720p', 'old.mkv', 500);
  file(H('d'), 'Half.Done.2024', 'half.mkv', 100);
  file(H('e'), 'Stuck.Show.S01E01', 'stuck.mkv', 10);
  file(H('f'), 'Broken.Show.S01E01', 'broken.mkv', 10);
  // Marquee sent the half-done one.
  t.db.insert(schema.downloads).values({ kind: 'movie', title: 'Half.Done.2024', infoHash: H('d'), addedAt: NOW, state: 'downloading', progress: 0.5 }).run();
  return { ...t, root, tor, qbit, api, admin };
}

const groupsOf = (v: ReconcileView) => Object.fromEntries(v.groups.map((g) => [g.key, g.items.map((i) => i.name)]));

describe('Clean up → In qBittorrent', () => {
  it('sorts every torrent by whether it still earns its place', async () => {
    const w = await world();
    const v = (await w.api('GET', '/api/cleanup/downloader')).body as ReconcileView;
    expect(v.ok).toBe(true);
    expect(groupsOf(v)).toEqual({
      missing: ['Gone.Movie.2010'],
      stuck: ['Stuck.Show.S01E01', 'Broken.Show.S01E01'].sort(),
      orphan: ['Old.Movie.2001.720p'],
      done: ['The.Matrix.1999.1080p'],
      sharing: ['Up.2009.1080p'],
      downloading: ['Half.Done.2024'],
    });
    const all = v.groups.flatMap((g) => g.items);
    const by = (n: string) => all.find((i) => i.name === n)!;
    // Hardlinked into the library: feeds its title and frees nothing; the stray one frees its size.
    expect(by('The.Matrix.1999.1080p')).toMatchObject({ sentBy: 'Radarr', feeds: { name: 'The Matrix (1999)' }, freedBytes: 0 });
    expect(by('Old.Movie.2001.720p')).toMatchObject({ feeds: null, freedBytes: 500 });
    expect(by('Half.Done.2024')).toMatchObject({ sentBy: 'Marquee', followed: true });
    expect(by('Stuck.Show.S01E01')).toMatchObject({ sentBy: 'Sonarr', status: 'Waiting · nobody is sharing it' });
    expect(v.groups.find((g) => g.key === 'orphan')!.freedBytes).toBe(500);
  });

  it('a download with nothing on disk yet isn’t “files missing”', async () => {
    const w = await world();
    fs.rmSync(`${w.tor}/tv-sonarr/Stuck.Show.S01E01`, { recursive: true });
    const v = (await w.api('GET', '/api/cleanup/downloader')).body as ReconcileView;
    expect(groupsOf(v).stuck).toContain('Stuck.Show.S01E01');
    expect(groupsOf(v).missing).toEqual(['Gone.Movie.2010']);
  });

  it('lists nothing when qBittorrent can’t answer, or its folders don’t line up', async () => {
    const w = await world();
    w.qbit.list = w.qbit.list.map((t) => ({ ...t, savePath: '/downloads/x', contentPath: `/downloads/x/${t.name}` }));
    expect((await w.api('GET', '/api/cleanup/downloader?fresh=1')).body).toMatchObject({ ok: false, problem: expect.stringMatching(/folders don’t line up/), groups: [] });
    w.qbit.fail = new QbitError('unreachable', 'no answer');
    expect((await w.api('GET', '/api/cleanup/downloader?fresh=1')).body).toMatchObject({ ok: false, groups: [] });
    expect((await w.api('POST', '/api/cleanup/downloader/remove', { hashes: [H('c')], deleteFiles: true, confirm: true })).status).toBe(409);
  });

  it('removes what you pick, only what it lists; the library copy stays', async () => {
    const w = await world();
    await w.api('GET', '/api/cleanup/downloader');
    expect((await w.api('POST', '/api/cleanup/downloader/remove', { hashes: [H('c')], deleteFiles: true })).status).toBe(400);
    expect((await w.api('POST', '/api/cleanup/downloader/remove', { hashes: [H('7')], deleteFiles: true, confirm: true })).status).toBe(409);
    const r = await w.api('POST', '/api/cleanup/downloader/remove', { hashes: [H('a'), H('c')], deleteFiles: true, confirm: true });
    expect(r.body).toMatchObject({ done: 2, problems: [] });
    expect(w.qbit.actions).toEqual([`remove ${H('a')} with files`, `remove ${H('c')} with files`]);
    expect(fs.existsSync(`${w.root}/media/movies/The Matrix (1999) {tmdb-603}/The Matrix (1999).mkv`)).toBe(true);
    // The list is worked out again after removing.
    const v = (await w.api('GET', '/api/cleanup/downloader')).body as ReconcileView;
    expect(v.total).toBe(5);
  });

  it('removes Marquee’s own downloads through its Remove, and records it', async () => {
    const w = await world();
    const r = await w.api('POST', '/api/cleanup/downloader/remove', { hashes: [H('d')], deleteFiles: false, confirm: true });
    expect(r.body).toMatchObject({ done: 1 });
    expect(w.qbit.actions).toEqual([`remove ${H('d')}`]);
    expect(w.db.select().from(schema.downloads).where(eq(schema.downloads.infoHash, H('d'))).get()!.state).toBe('removed');
    const h = (await w.api('GET', '/api/history?event=removed')).body as HistoryView;
    expect(h.items).toHaveLength(1);
  });

  it('never deletes files of a torrent saved inside the library folder, and is for admins only', async () => {
    const w = await world();
    w.qbit.list.push(qbitTorrent(H('8'), { name: 'In.Library', savePath: `${w.root}/media/movies`, contentPath: `${w.root}/media/movies/Up (2009) {tmdb-14160}`, state: 'stalledUP', progress: 1 }));
    const v = (await w.api('GET', '/api/cleanup/downloader?fresh=1')).body as ReconcileView;
    expect(v.groups.flatMap((g) => g.items).find((i) => i.name === 'In.Library')!.inLibraryFolder).toBe(true);
    const r = await w.api('POST', '/api/cleanup/downloader/remove', { hashes: [H('8')], deleteFiles: true, confirm: true });
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/inside your library folder/);
    await w.api('POST', '/api/users', { username: 'sam', displayName: 'Sam', role: 'member', password: 'sam password!' });
    const cookie = (await call(w.app, 'POST', '/api/auth/login', { username: 'sam', password: 'sam password!' })).cookie!;
    expect((await call(w.app, 'GET', '/api/cleanup/downloader', undefined, cookie)).status).toBe(403);
  });
});
