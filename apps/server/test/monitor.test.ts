import { describe, expect, it } from 'vitest';
import type { CopiesResult, DownloadsView } from '@marquee/shared';
import { schema } from '../src/db/index.js';
import { QbitError } from '../src/downloads/qbittorrent.js';
import { fakeReason } from '../src/downloads/monitor.js';
import { FakeQbit, fakeFetchTorrent } from './fakes/qbittorrent.js';
import { FakeSites, release } from './fakes/sources.js';
import { call, makeApp, setupAdmin } from './helpers.js';

const GB = 1024 ** 3;
const HOUR = 3_600_000;
const BEST = 'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX';
const NEXT = 'Dune.Part.Two.2024.2160p.MA.WEB-DL.DDP5.1.HDR.H.265-HONE';

async function setup(releases = [release(BEST, { size: 25 * GB }), release(NEXT, { size: 20 * GB })]) {
  const sites = new FakeSites();
  sites.feed('http://tpb.test/api', { releases });
  const qbit = new FakeQbit();
  let clock = Date.parse('2026-11-18T12:00:00Z');
  const t = makeApp({ now: () => clock, clients: { torznab: sites.torznab, qbittorrent: (u, n, p) => qbit.as(u, n, p), fetchTorrent: fakeFetchTorrent() } });
  const cookie = await setupAdmin(t.app);
  await call(t.app, 'POST', '/api/settings/sources', { name: 'TPB', url: 'http://tpb.test/api', apiKey: 'good' }, cookie);
  await call(t.app, 'PUT', '/api/settings/downloader', { url: qbit.url, username: 'admin', password: 'adminadmin' }, cookie);
  const movie = t.db
    .insert(schema.movies)
    .values({ tmdbId: 693134, imdbId: 'tt15239678', title: 'Dune: Part Two', sortTitle: 'dune part two', year: 2024, runtime: 166, profile: 'cinema', addedAt: 0, refreshedAt: 0 })
    .returning()
    .get();
  const s = (await call(t.app, 'POST', `/api/movies/${movie.id}/search`, {}, cookie)).body as CopiesResult;
  const sent = await call(t.app, 'POST', '/api/downloads', { searchId: s.searchId, copyId: '0' }, cookie);
  expect(sent.status).toBe(201);
  const hash = sent.body.download.infoHash as string;
  const torrent = () => qbit.list.find((x) => x.hash === hash);
  const later = (ms: number) => (clock += ms);
  // Each view after time passes checks qBittorrent again.
  const view = async () => {
    later(11_000);
    return (await call(t.app, 'GET', '/api/downloads', undefined, cookie)).body as DownloadsView;
  };
  return { ...t, qbit, cookie, movie, hash, torrent, later, view, id: sent.body.download.id as number };
}

describe('following downloads', () => {
  it('turns qBittorrent’s states into plain words', async () => {
    const t = await setup();
    expect((await t.view()).items[0]!.status).toMatchObject({ label: 'Getting ready', tone: 'busy' });
    Object.assign(t.torrent()!, { state: 'downloading', progress: 0.42, downloadSpeed: 4.2 * 1024 ** 2, eta: 720, seedsConnected: 12 });
    const v = (await t.view()).items[0]!;
    expect(v).toMatchObject({ state: 'downloading', progress: 0.42, canControl: true });
    expect(v.status).toMatchObject({ label: 'Downloading · 4.2 MB/s · about 12 min left', detail: '42% done.', tone: 'good' });
    t.torrent()!.state = 'queuedDL';
    expect((await t.view()).items[0]!.status.label).toBe('Waiting its turn');
    t.torrent()!.state = 'stoppedDL';
    expect((await t.view()).items[0]!.status.label).toBe('Paused');
    t.torrent()!.state = 'error';
    expect((await t.view()).items[0]!.status).toMatchObject({ label: 'Problem in qBittorrent', tone: 'bad' });
    Object.assign(t.torrent()!, { state: 'stalledUP', progress: 1 });
    const done = (await t.view()).items[0]!;
    expect(done).toMatchObject({ state: 'done', canControl: false, canImport: true });
    // The fake's files aren't on disk, so putting it in the library says why.
    expect(done.status.label).toBe('Couldn’t put it in your library');
    expect(done.status.detail).toMatch(/can't see the downloaded file at \/data\/torrents\/.*folder pair/);
  });

  it('notices a download removed in qBittorrent', async () => {
    const t = await setup();
    t.qbit.list = [];
    expect((await t.view()).items[0]!.status).toMatchObject({ label: 'Gone from qBittorrent', tone: 'bad' });
  });

  it('says when qBittorrent can’t be checked, and still lists downloads', async () => {
    const t = await setup();
    t.qbit.fail = new QbitError('unreachable', 'down');
    const v = await t.view();
    expect(v.problem).toMatchObject({ label: "Can't reach it" });
    expect(v.items).toHaveLength(1);
  });

  it('calls a download stuck after 6 hours, and tries another copy by itself after 24', async () => {
    const t = await setup();
    Object.assign(t.torrent()!, { state: 'stalledDL', progress: 0.1, seedsConnected: 0, seedsKnown: 0 });
    await t.view();
    t.later(6 * HOUR);
    const stuck = (await t.view()).items[0]!.status;
    expect(stuck).toMatchObject({ label: 'Stuck · nobody is sharing it', tone: 'warn' });
    expect(stuck.nextTryAt).toBeGreaterThan(Date.parse('2026-11-18T12:00:00Z'));
    t.later(18 * HOUR);
    const after = await t.view();
    expect(after.items.map((i) => [i.title, i.state])).toEqual([
      [NEXT, 'sent'],
      [BEST, 'failed'],
    ]);
    expect(after.items[1]!.message).toMatch(/No progress for 2\d hours\. Replaced by .*HONE/);
    expect(t.qbit.actions).toContain(`remove ${t.hash} with files`);
    // That copy is now "Never pick" for this movie.
    const again = (await call(t.app, 'POST', `/api/movies/${t.movie.id}/search`, {}, t.cookie)).body as CopiesResult;
    const old = again.copies.find((c) => c.title === BEST)!;
    expect(old.accepted).toBe(false);
    expect(old.rejections.at(-1)!.message).toMatch(/^Never pick: No progress for/);
  });

  it('doesn’t count paused or queued time as stuck', async () => {
    const t = await setup();
    Object.assign(t.torrent()!, { state: 'stoppedDL', progress: 0.1 });
    await t.view();
    t.later(30 * HOUR);
    const v = (await t.view()).items[0]!;
    expect(v.state).toBe('downloading');
    expect(v.status.label).toBe('Paused');
    t.torrent()!.state = 'stalledDL';
    t.later(HOUR);
    expect((await t.view()).items[0]!.status.label).not.toMatch(/Stuck/);
  });

  it('replaces a fake as soon as its file list shows a program', async () => {
    const t = await setup();
    Object.assign(t.torrent()!, { state: 'downloading', progress: 0.01 });
    t.qbit.fileLists.set(t.hash, [{ name: 'Dune/setup.exe', size: 1000 }, { name: 'Dune/readme.txt', size: 10 }]);
    const v = await t.view();
    expect(v.items[1]).toMatchObject({ state: 'failed', title: BEST });
    expect(v.items[1]!.message).toMatch(/holds a program \(setup\.exe\)/);
    expect(v.items[0]!.title).toBe(NEXT);
  });

  it('leaves stuck downloads alone when trying another copy by itself is off', async () => {
    const t = await setup();
    await call(t.app, 'PUT', '/api/settings/downloader', { tryAnother: false }, t.cookie);
    Object.assign(t.torrent()!, { state: 'stalledDL', progress: 0.1 });
    await t.view();
    t.later(48 * HOUR);
    const v = (await t.view()).items;
    expect(v).toHaveLength(1);
    expect(v[0]!.status).toMatchObject({ label: 'Stuck · nobody is sharing it', nextTryAt: null });
    expect(v[0]!.status.detail).toMatch(/Press Try another copy/);
  });

  it('says so when no other copy suits the profile', async () => {
    const t = await setup([release(BEST, { size: 25 * GB })]);
    const res = await call(t.app, 'POST', `/api/downloads/${t.id}/try-another`, {}, t.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ next: null, message: expect.stringMatching(/No other copy suits 4K Quality right now/) });
  });
});

describe('download buttons', () => {
  it('pauses, resumes and removes, with or without files', async () => {
    const t = await setup();
    expect((await call(t.app, 'POST', `/api/downloads/${t.id}/pause`, {}, t.cookie)).body.message).toBe('Paused.');
    expect((await call(t.app, 'POST', `/api/downloads/${t.id}/resume`, {}, t.cookie)).status).toBe(200);
    const rm = await call(t.app, 'POST', `/api/downloads/${t.id}/remove`, { deleteFiles: false }, t.cookie);
    expect(rm.body.message).toMatch(/Its files are still/);
    expect(t.qbit.actions).toEqual([`pause ${t.hash}`, `resume ${t.hash}`, `remove ${t.hash}`]);
    expect((await t.view()).items[0]).toMatchObject({ state: 'removed', canControl: false });
    expect((await call(t.app, 'POST', `/api/downloads/${t.id}/try-another`, {}, t.cookie)).status).toBe(409);
  });

  it('never changes a download another app sent', async () => {
    const t = await setup();
    t.db.update(schema.downloads).set({ adopted: true }).run();
    const res = await call(t.app, 'POST', `/api/downloads/${t.id}/pause`, {}, t.cookie);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/Another app sent this download/);
    const rm = await call(t.app, 'POST', `/api/downloads/${t.id}/remove`, { deleteFiles: true }, t.cookie);
    expect(rm.body.message).toMatch(/still in qBittorrent/);
    expect(t.qbit.actions).toEqual([]);
    // Nor is it replaced when stuck.
    t.db.update(schema.downloads).set({ state: 'downloading' }).run();
    Object.assign(t.torrent()!, { state: 'stalledDL', progress: 0.1 });
    t.later(48 * HOUR);
    await t.view();
    expect(t.qbit.actions).toEqual([]);
  });

  it('checks the stuck times', async () => {
    const t = await setup();
    const bad = await call(t.app, 'PUT', '/api/settings/downloader', { stuckHours: 10, giveUpHours: 5 }, t.cookie);
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/at least as long as Stuck after/);
    expect((await call(t.app, 'PUT', '/api/settings/downloader', { stuckHours: 2, giveUpHours: 12 }, t.cookie)).body).toMatchObject({ stuckHours: 2, giveUpHours: 12 });
  });
});

describe('spotting fakes', () => {
  it('reads file lists', () => {
    expect(fakeReason([])).toBeNull();
    expect(fakeReason([{ name: 'Movie/Movie.mkv', size: 1 }, { name: 'Movie/Sample/sample.mkv', size: 1 }])).toBeNull();
    expect(fakeReason([{ name: 'Movie/Movie.mkv.exe', size: 1 }])).toMatch(/program \(Movie\.mkv\.exe\)/);
    // A .rar set is unpacked when it finishes (and checked then); other archives alone are still a fake.
    expect(fakeReason([{ name: 'a.rar', size: 1 }, { name: 'a.r00', size: 1 }, { name: 'password.txt', size: 1 }])).toBeNull();
    expect(fakeReason([{ name: 'a.part1.rar', size: 1 }, { name: 'a.part2.rar', size: 1 }])).toBeNull();
    expect(fakeReason([{ name: 'a.r00', size: 1 }, { name: 'a.r01', size: 1 }])).toMatch(/only holds archives that aren’t a \.rar set/);
    expect(fakeReason([{ name: 'a.zip', size: 1 }, { name: 'password.txt', size: 1 }])).toMatch(/only holds archives/);
    expect(fakeReason([{ name: 'a.txt', size: 1 }])).toMatch(/no video/);
  });
});

describe('finished downloads go in the library by themselves', () => {
  it('imports when qBittorrent finishes, and Try again retries a failed one', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { setSetting } = await import('../src/db/index.js');
    const t = await setup();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-mon-'));
    try {
      setSetting(t.db, 'library.movies_root', path.join(root, 'movies'));
      const tor = t.torrent()!;
      Object.assign(tor, { name: BEST, savePath: path.join(root, 'torrents'), state: 'stalledUP', progress: 1, size: 4000 });
      // Not on disk yet: it says why and offers Try again.
      let v = (await t.view()).items[0]!;
      expect(v.status.label).toBe('Couldn’t put it in your library');
      expect(v.canImport).toBe(true);
      fs.mkdirSync(path.join(root, 'torrents', BEST), { recursive: true });
      fs.writeFileSync(path.join(root, 'torrents', BEST, `${BEST}.mkv`), Buffer.alloc(4000));
      const again = await call(t.app, 'POST', `/api/downloads/${t.id}/import`, {}, t.cookie);
      expect(again.body.message).toMatch(/^In your library: Dune - Part Two \(2024\) \[WEBDL-2160p\]\[DV HDR\]\.mkv\.$/);
      v = (await t.view()).items[0]!;
      expect(v).toMatchObject({ canImport: false, canRemoveShared: true, status: { label: 'In your library · sharing', tone: 'done' } });
      expect(v.status.detail).toBe('Sharing until ratio 0.0 of 2.0 or 0 of 14 days, whichever comes first (the default rule).');
      expect(v.importedPaths![0]).toContain('{tmdb-693134}');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
