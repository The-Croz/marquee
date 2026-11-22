import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { CopiesResult, DownloadsView, HealthView, HistoryView } from '@marquee/shared';
import { schema, setSetting } from '../src/db/index.js';
import { UNPACK_FOLDER, sharedMonitor } from '../src/downloads/monitor.js';
import { UnpackError, needsUnpacking, parseSevenZipList, rarSets, sevenZip, sevenZipProblem, unpackText } from '../src/downloads/unpack.js';
import { FakeQbit, fakeFetchTorrent } from './fakes/qbittorrent.js';
import { FakeSites, release } from './fakes/sources.js';
import { FakeUnpacker, fakeRar } from './fakes/unpack.js';
import { FIXTURE_VIDEO, rar4, rar5 } from './fakes/rar.js';
import { call, makeApp, setupAdmin } from './helpers.js';

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const MIN = 60_000;
const SCENE = 'Dune.Part.Two.2024.1080p.BluRay.x264-SCENE';
const NEXT = 'Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.H.264-FLUX';

describe('finding .rar sets', () => {
  it('reads both ways of naming the parts, and leaves subtitles and samples alone', () => {
    const sets = rarSets([
      { name: `${SCENE}/scene.rar`, size: 50 * MB },
      { name: `${SCENE}/scene.r00`, size: 50 * MB },
      { name: `${SCENE}/scene.r01`, size: 20 * MB },
      { name: `${SCENE}/Subs/scene.subs.rar`, size: 1 * MB },
      { name: `${SCENE}/Sample/scene-sample.mkv`, size: 30 * MB },
      { name: `${SCENE}/scene.nfo`, size: 1000 },
      { name: 'Other/other.part01.rar', size: 10 },
      { name: 'Other/other.part02.rar', size: 10 },
    ]);
    expect(sets).toEqual([
      { first: `${SCENE}/scene.rar`, parts: [`${SCENE}/scene.r00`, `${SCENE}/scene.r01`, `${SCENE}/scene.rar`], size: 120 * MB },
      { first: 'Other/other.part01.rar', parts: ['Other/other.part01.rar', 'Other/other.part02.rar'], size: 20 },
    ]);
  });

  it('finds one set per episode in a whole season, and notices a missing first part', () => {
    const sets = rarSets([
      { name: 'Show.S01/show.s01e01/show.s01e01.rar', size: 1 },
      { name: 'Show.S01/show.s01e01/show.s01e01.r00', size: 1 },
      { name: 'Show.S01/show.s01e02/show.s01e02.part1.rar', size: 1 },
      { name: 'Show.S01/show.s01e03/show.s01e03.r00', size: 1 },
    ]);
    expect(sets.map((s) => s.first)).toEqual(['Show.S01/show.s01e01/show.s01e01.rar', 'Show.S01/show.s01e02/show.s01e02.part1.rar', null]);
  });

  it('only unpacks when there’s no video outside the archives', () => {
    const rars = [{ name: 'x/x.rar', size: 1 }];
    expect(needsUnpacking(rars, [])).toBe(true);
    expect(needsUnpacking(rars, [{ name: 'x/x.mkv', size: 1 }])).toBe(false);
    expect(needsUnpacking([{ name: 'x/x.r00', size: 1 }], [])).toBe(false);
  });
});

describe('reading 7-Zip', () => {
  const listing = [
    '7-Zip (z) 26.06 (x64) : Copyright (c) 1999-2026 Igor Pavlov',
    '',
    'Listing archive: /data/torrents/x/scene.rar',
    '',
    '--',
    'Path = /data/torrents/x/scene.rar',
    'Type = Rar5',
    'Physical Size = 52428800',
    'Multivolume = +',
    'Volumes = 3',
    '',
    '----------',
    'Path = Dune.Part.Two.2024.1080p.BluRay.x264-SCENE.mkv',
    'Folder = -',
    'Size = 8000000000',
    'Packed Size = 8000000000',
    'Attributes = A',
    'Encrypted = -',
    'Method = m0:22',
    '',
    'Path = Extras',
    'Folder = +',
    'Size = 0',
    'Attributes = D',
    'Encrypted = -',
    '',
    'Path = Extras\\notes.txt',
    'Folder = -',
    'Size = 12',
    'Encrypted = +',
    '',
  ].join('\n');

  it('lists what’s inside', () => {
    expect(parseSevenZipList(listing)).toEqual([
      { name: 'Dune.Part.Two.2024.1080p.BluRay.x264-SCENE.mkv', size: 8000000000, encrypted: false, folder: false },
      { name: 'Extras', size: 0, encrypted: false, folder: true },
      { name: 'Extras/notes.txt', size: 12, encrypted: true, folder: false },
    ]);
  });

  it('turns its complaints into plain problems', () => {
    expect(sevenZipProblem('ERROR: Wrong password : movie.mkv')).toMatchObject({ kind: 'password' });
    expect(sevenZipProblem('ERROR: x.rar\nCan not open encrypted archive. Wrong password?')).toMatchObject({ kind: 'password' });
    expect(sevenZipProblem('ERROR: Missing volume : /data/torrents/x/scene.r01')).toMatchObject({ kind: 'missing_part', message: expect.stringMatching(/scene\.r01 isn’t there.*Force recheck.*Try another copy/) });
    expect(sevenZipProblem('ERROR: Unexpected end of archive')).toMatchObject({ kind: 'missing_part' });
    expect(sevenZipProblem('ERROR: CRC Failed : movie.mkv')).toMatchObject({ kind: 'broken', message: expect.stringMatching(/damaged \(a check failed\)/) });
    expect(sevenZipProblem('ERROR: x.rar\nCannot open the file as archive')).toMatchObject({ kind: 'broken' });
    expect(sevenZipProblem('ERROR: E_FAIL')).toMatchObject({ kind: 'failed', message: expect.stringMatching(/tries again every 15 minutes/) });
  });

  it('says plainly when 7-Zip isn’t installed', async () => {
    const missing = sevenZip('/nowhere/7zz-not-here');
    expect(await missing.check()).toEqual({ ok: false, message: unpackText('no_tool') });
    await expect(missing.list('/tmp/x.rar')).rejects.toMatchObject({ kind: 'no_tool' });
  });
});

// ---------------------------------------------------------------- unpacking a finished download

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function setup(opts: { unpacker?: FakeUnpacker } = {}) {
  let free = 900 * GB;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-unpack-'));
  dirs.push(root);
  const sites = new FakeSites();
  sites.feed('http://tpb.test/api', { releases: [release(SCENE, { size: 8 * GB, seeders: 900 }), release(NEXT, { size: 6 * GB, seeders: 10 })] });
  const qbit = new FakeQbit();
  qbit.state.savePath = path.join(root, 'torrents');
  const unpacker = opts.unpacker ?? new FakeUnpacker();
  let clock = Date.parse('2026-11-22T12:00:00Z');
  const t = makeApp({
    now: () => clock,
    clients: { torznab: sites.torznab, qbittorrent: (u, n, p) => qbit.as(u, n, p), fetchTorrent: fakeFetchTorrent(), unpacker, disk: async () => ({ free, total: 1000 * GB }) },
  });
  setSetting(t.db, 'library.movies_root', path.join(root, 'media/movies'));
  setSetting(t.db, 'library.tv_root', path.join(root, 'media/tv'));
  const cookie = await setupAdmin(t.app);
  await call(t.app, 'POST', '/api/settings/sources', { name: 'TPB', url: 'http://tpb.test/api', apiKey: 'good' }, cookie);
  await call(t.app, 'PUT', '/api/settings/downloader', { url: qbit.url, username: 'admin', password: 'adminadmin' }, cookie);
  const movie = t.db
    .insert(schema.movies)
    .values({ tmdbId: 693134, imdbId: 'tt15239678', title: 'Dune: Part Two', sortTitle: 'dune part two', year: 2024, runtime: 166, profile: 'everyday-hd', addedAt: 0, refreshedAt: 0 })
    .returning()
    .get();
  const s = (await call(t.app, 'POST', `/api/movies/${movie.id}/search`, {}, cookie)).body as CopiesResult;
  const pick = s.copies.findIndex((c) => c.title === SCENE);
  expect(pick).toBeGreaterThanOrEqual(0);
  const sent = await call(t.app, 'POST', '/api/downloads', { searchId: s.searchId, copyId: String(pick), anyway: true }, cookie);
  expect(sent.status).toBe(201);
  const id = sent.body.download.id as number;
  const hash = sent.body.download.infoHash as string;
  const torrent = () => qbit.list.find((x) => x.hash === hash)!;
  const write = (rel: string, text: string) => {
    const p = path.join(root, 'torrents', rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    return p;
  };
  /** Finishes the download as these files. */
  const finish = (files: Record<string, string>) => {
    for (const [rel, text] of Object.entries(files)) write(rel, text);
    qbit.fileLists.set(hash, Object.entries(files).map(([name, text]) => ({ name, size: Buffer.byteLength(text) })));
    Object.assign(torrent(), { state: 'stalledUP', progress: 1, savePath: qbit.state.savePath });
  };
  const view = async () => {
    clock += 11_000;
    return (await call(t.app, 'GET', '/api/downloads', undefined, cookie)).body as DownloadsView;
  };
  const row = () => t.db.select().from(schema.downloads).where(eq(schema.downloads.id, id)).get()!;
  const monitor = () => sharedMonitor({ db: t.db, clients: {} as never, sources: t.sources, now: () => clock });
  const later = (ms: number) => (clock += ms);
  const setFree = (bytes: number) => (free = bytes);
  return { ...t, root, qbit, unpacker, cookie, movie, id, hash, torrent, finish, view, row, monitor, later, write, setFree };
}

const goodRar = fakeRar([
  { name: `${SCENE}.mkv`, size: 7 * MB },
  { name: `${SCENE}.nfo`, size: 100 },
  { name: 'Sample/sample.mkv', size: 1 * MB },
]);

describe('a copy that comes as .rar files', () => {
  it('unpacks next to the download, moves the video into the library, and tidies up', async () => {
    const t = await setup();
    t.finish({ [`${SCENE}/scene.rar`]: goodRar, [`${SCENE}/scene.r00`]: 'part 2', [`${SCENE}/scene.nfo`]: 'nfo', [`${SCENE}/Sample/scene-sample.mkv`]: 'sample' });
    t.unpacker.delayMs = 50;
    const busy = (await t.view()).items[0]!;
    expect(busy.status).toMatchObject({ label: 'Finished · unpacking', tone: 'busy', detail: expect.stringMatching(/folder of its own next to the download.*keeps sharing/) });
    expect(busy.canTryAnother).toBe(false);
    await t.monitor().unpacksDone();

    expect(t.unpacker.extracted).toEqual([{ archive: path.join(t.root, 'torrents', SCENE, 'scene.rar'), dest: path.join(t.root, 'torrents', UNPACK_FOLDER, String(t.id), SCENE) }]);
    const done = (await t.view()).items[0]!;
    expect(done.status).toMatchObject({ label: 'In your library · sharing · unpacked', tone: 'done', detail: expect.stringMatching(/unpacked it and moved the video into your library: it’s its own file, not a hardlink/) });
    expect(done.unpacked).toBe(true);
    const lib = path.join(t.root, 'media/movies/Dune - Part Two (2024) {tmdb-693134}/Dune - Part Two (2024) [Bluray-1080p].mkv');
    expect(done.importedPaths).toEqual([lib]);
    expect(fs.statSync(lib)).toMatchObject({ size: 7 * MB, nlink: 1 }); // its own file, nothing else points at it
    // The download is exactly as it was, so qBittorrent keeps sharing it; Marquee's unpack folder is gone.
    expect(fs.readFileSync(path.join(t.root, 'torrents', SCENE, 'scene.rar'), 'utf8')).toBe(goodRar);
    expect(fs.existsSync(path.join(t.root, 'torrents', UNPACK_FOLDER))).toBe(false);
    expect(t.row()).toMatchObject({ unpackState: 'unpacked', importUnpacked: true, importError: null });

    const h = (await call(t.app, 'GET', '/api/history', undefined, t.cookie)).body as HistoryView;
    expect(h.items.map((i) => [i.event, i.detail])).toEqual([
      ['in_library', 'Unpacked from .rar files, so the library file is its own file, not a hardlink.'],
      ['sent', null],
    ]);
  });

  it('turns down a copy whose .rar files are locked with a password, and sends the next best', async () => {
    const t = await setup();
    t.finish({ [`${SCENE}/scene.rar`]: fakeRar([{ name: `${SCENE}.mkv`, size: 7 * MB, encrypted: true }]) });
    const v = await t.view();
    expect(v.items.map((i) => [i.title, i.state])).toEqual([
      [NEXT, 'sent'],
      [SCENE, 'failed'],
    ]);
    expect(v.items[1]!.message).toMatch(/^The \.rar files are locked with a password\. Real copies never are.*Replaced by .*FLUX/);
    expect(t.qbit.actions).toContain(`remove ${t.hash} with files`);
    expect(t.unpacker.extracted).toEqual([]);
    const never = (await call(t.app, 'GET', `/api/never-pick?movieId=${t.movie.id}`, undefined, t.cookie)).body;
    expect(never.items).toEqual([expect.objectContaining({ copy: SCENE, reason: expect.stringMatching(/locked with a password/) })]);
  });

  it('turns down archives with no video inside, or files that climb out of their folder', async () => {
    const t = await setup();
    t.finish({ [`${SCENE}/scene.rar`]: fakeRar([{ name: 'setup.txt', size: 100 }, { name: 'Sample/sample.mkv', size: 5 * MB }]) });
    const v = await t.view();
    expect(v.items[1]!.message).toMatch(/^There’s no video inside the \.rar files \(just setup\.txt, sample\.mkv\)/);

    const u = await setup();
    u.finish({ [`${SCENE}/scene.rar`]: fakeRar([{ name: '../../evil.mkv', size: 7 * MB }]) });
    expect((await u.view()).items[1]!.message).toMatch(/outside their own folder/);
  });

  it('says what to do with a fake when replacing is turned off', async () => {
    const t = await setup();
    await call(t.app, 'PUT', '/api/settings/downloader', { tryAnother: false }, t.cookie);
    t.finish({ [`${SCENE}/scene.rar`]: fakeRar([{ name: `${SCENE}.mkv`, size: 7 * MB, encrypted: true }]) });
    const item = (await t.view()).items[0]!;
    expect(item.status).toMatchObject({ label: 'Couldn’t put it in your library', tone: 'bad', detail: expect.stringMatching(/password.*Press Try another copy\./) });
    expect(item.canTryAnother).toBe(true);
    // Try another copy works on a finished copy that never made it into the library.
    const r = await call(t.app, 'POST', `/api/downloads/${t.id}/try-another`, {}, t.cookie);
    expect(r.status).toBe(200);
    expect(r.body.next.title).toBe(NEXT);
  });

  it('waits for you when the .rar files are damaged, and Try again unpacks them again', async () => {
    const t = await setup();
    t.unpacker.failExtract = new UnpackError('broken', unpackText('broken', 'a check failed'));
    t.finish({ [`${SCENE}/scene.rar`]: goodRar });
    await t.view();
    await t.monitor().unpacksDone();
    const item = (await t.view()).items[0]!;
    expect(item.status).toMatchObject({ label: 'Couldn’t unpack it', tone: 'bad', detail: expect.stringMatching(/damaged \(a check failed\)\. In qBittorrent, right-click the download and choose Force recheck/) });
    expect(t.row().unpackState).toBe('broken');
    expect(fs.existsSync(path.join(t.root, 'torrents', UNPACK_FOLDER))).toBe(false);
    // Not tried again by itself (it would read the whole download again for nothing)…
    t.later(20 * MIN);
    await t.view();
    await t.monitor().unpacksDone();
    expect(t.row().unpackState).toBe('broken');
    // …until you press Try again.
    t.unpacker.failExtract = null;
    const r = await call(t.app, 'POST', `/api/downloads/${t.id}/import`, {}, t.cookie);
    expect(r.body.message).toMatch(/packed in \.rar files, so Marquee is unpacking it/);
    await t.monitor().unpacksDone();
    expect(t.row()).toMatchObject({ importUnpacked: true, importError: null });
    // Each new reason is in the History once.
    const h = (await call(t.app, 'GET', '/api/history?event=import_failed', undefined, t.cookie)).body as HistoryView;
    expect(h.items).toHaveLength(1);
  });

  it('holds off when unpacking would leave the downloads disk under the minimum', async () => {
    const t = await setup();
    t.setFree(20 * GB + 3 * MB);
    t.finish({ [`${SCENE}/scene.rar`]: goodRar });
    const item = (await t.view()).items[0]!;
    expect(item.status.label).toBe('Couldn’t unpack it');
    expect(item.status.detail).toMatch(/^Not enough room on the downloads disk .*this needs 8 MB.*keeps 20 GB spare.*Marquee tries again by itself\.$/);
    expect(t.unpacker.extracted).toEqual([]);
    expect(t.row().unpackState).toBe('failed');
  });

  it('says plainly when there’s no unpacking tool, here and on the Health page', async () => {
    const unpacker = new FakeUnpacker();
    unpacker.missing = true;
    const t = await setup({ unpacker });
    t.finish({ [`${SCENE}/scene.rar`]: goodRar });
    expect((await t.view()).items[0]!.status).toMatchObject({ label: 'Couldn’t unpack it', detail: expect.stringMatching(/no unpacking tool.*7-Zip built in.*7zz/) });
    const health = (await call(t.app, 'GET', '/api/system/health', undefined, t.cookie)).body as HealthView;
    expect(health.connections.find((c) => c.key === 'unpacker')).toMatchObject({ tone: 'problem', state: 'Not in this install', fix: expect.stringMatching(/\.rar files can’t go in your library/) });
    // It's tried again by itself once 7-Zip is there.
    unpacker.missing = false;
    t.later(16 * MIN);
    await t.view();
    await t.monitor().unpacksDone();
    expect(t.row().importUnpacked).toBe(true);
  });

  it('shows the unpacking tool as ready on the Health page', async () => {
    const t = await setup();
    const health = (await call(t.app, 'GET', '/api/system/health', undefined, t.cookie)).body as HealthView;
    expect(health.connections.find((c) => c.key === 'unpacker')).toMatchObject({ tone: 'ok', state: 'Ready', detail: '7-Zip 26.06', group: 'Downloader' });
  });

  it('tidies the unpack folder when the download is removed', async () => {
    const t = await setup();
    t.unpacker.failExtract = new UnpackError('failed', unpackText('failed', 'oops'));
    t.finish({ [`${SCENE}/scene.rar`]: goodRar });
    await t.view();
    await t.monitor().unpacksDone();
    fs.mkdirSync(path.join(t.root, 'torrents', UNPACK_FOLDER, String(t.id)), { recursive: true });
    const r = await call(t.app, 'POST', `/api/downloads/${t.id}/remove`, { deleteFiles: false }, t.cookie);
    expect(r.status).toBe(200);
    expect(fs.existsSync(path.join(t.root, 'torrents', UNPACK_FOLDER))).toBe(false);
    expect(fs.existsSync(path.join(t.root, 'torrents', SCENE, 'scene.rar'))).toBe(true);
  });
});

// ---------------------------------------------------------------- the real 7-Zip, when it's installed (CI and the Docker image have it)

const FIXTURES = path.join(import.meta.dirname, 'fixtures/archives');

describe('the .rar sets in test/fixtures (used by the Docker smoke test)', () => {
  it('are what the writer makes', () => {
    const name = 'Movie.2024.1080p.BluRay.x264-GRP.mkv';
    const split = rar5([{ name, data: FIXTURE_VIDEO }], 2);
    expect(fs.readFileSync(path.join(FIXTURES, 'split.part1.rar')).equals(split[0]!)).toBe(true);
    expect(fs.readFileSync(path.join(FIXTURES, 'split.part2.rar')).equals(split[1]!)).toBe(true);
    const old = rar4({ name, data: FIXTURE_VIDEO }, 2);
    expect(fs.readFileSync(path.join(FIXTURES, 'old.rar')).equals(old[0]!)).toBe(true);
    expect(fs.readFileSync(path.join(FIXTURES, 'old.r00')).equals(old[1]!)).toBe(true);
  });
});

const bin = process.env.MARQUEE_UNPACK_BIN || '7zz';
const has7zz = spawnSync(bin, ['i'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!has7zz)('the real 7-Zip', () => {
  const data = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 7) % 251));
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-7z-'));
    dirs.push(d);
    return d;
  };
  const z = sevenZip(bin);

  it('says its version', async () => {
    expect(await z.check()).toMatchObject({ ok: true, version: expect.stringMatching(/^7-Zip \d+\.\d+$/) });
  });

  it('lists and unpacks RAR5, in one file and in .partN.rar parts', async () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'one.rar'), rar5([{ name: 'Movie.2024.1080p.mkv', data }, { name: 'Movie.nfo', data: Buffer.from('nfo') }])[0]!);
    expect(await z.list(path.join(d, 'one.rar'))).toEqual([
      { name: 'Movie.2024.1080p.mkv', size: data.length, encrypted: false, folder: false },
      { name: 'Movie.nfo', size: 3, encrypted: false, folder: false },
    ]);
    await z.extract(path.join(d, 'one.rar'), path.join(d, 'out1'));
    expect(fs.readFileSync(path.join(d, 'out1', 'Movie.2024.1080p.mkv')).equals(data)).toBe(true);

    rar5([{ name: 'Movie.2024.1080p.mkv', data }], 3).forEach((b, i) => fs.writeFileSync(path.join(d, `split.part${i + 1}.rar`), b));
    await z.extract(path.join(d, 'split.part1.rar'), path.join(d, 'out2'));
    expect(fs.readFileSync(path.join(d, 'out2', 'Movie.2024.1080p.mkv')).equals(data)).toBe(true);
    // A missing part says so.
    fs.rmSync(path.join(d, 'split.part3.rar'));
    await expect(z.extract(path.join(d, 'split.part1.rar'), path.join(d, 'out3'))).rejects.toMatchObject({ kind: expect.stringMatching(/missing_part|broken/) });
  });

  it('unpacks RAR 4 split the old way (.rar, .r00, .r01)', async () => {
    const d = tmp();
    const parts = rar4({ name: 'Movie.2024.1080p.mkv', data }, 3);
    parts.forEach((b, i) => fs.writeFileSync(path.join(d, i === 0 ? 'old.rar' : `old.r${String(i - 1).padStart(2, '0')}`), b));
    await z.extract(path.join(d, 'old.rar'), path.join(d, 'out'));
    expect(fs.readFileSync(path.join(d, 'out', 'Movie.2024.1080p.mkv')).equals(data)).toBe(true);
  });

  it('unpacks the fixture sets the Docker smoke test uses', async () => {
    for (const first of ['split.part1.rar', 'old.rar']) {
      const out = tmp();
      await z.extract(path.join(FIXTURES, first), out);
      expect(fs.readFileSync(path.join(out, 'Movie.2024.1080p.BluRay.x264-GRP.mkv')).equals(FIXTURE_VIDEO)).toBe(true);
    }
  });

  it('sees a password-protected file', async () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'locked.rar'), rar5([{ name: 'Movie.mkv', data, encrypted: true }])[0]!);
    const entries = await z.list(path.join(d, 'locked.rar')).catch((e: UnpackError) => e);
    if (entries instanceof UnpackError) expect(entries.kind).toBe('password');
    else expect(entries).toEqual([expect.objectContaining({ name: 'Movie.mkv', encrypted: true })]);
  });
});
