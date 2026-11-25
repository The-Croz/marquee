import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { CleanupDownloadsView, CopyGroup, HistoryView, SetAsideView, UntrackedFile } from '@marquee/shared';
import { schema } from '../src/db/index.js';
import { QbitError } from '../src/downloads/qbittorrent.js';
import { FakeMediaServer } from './fakes/mediaServers.js';
import { FakeQbit, qbitTorrent } from './fakes/qbittorrent.js';
import { FakeTmdb } from './fakes/tmdb.js';
import { call, makeApp, setupAdmin } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A library and downloads folder on disk in a temp folder, Plex watching it, a fake qBittorrent. */
async function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-cleanup-'));
  dirs.push(root);
  const qbit = new FakeQbit();
  const plex = new FakeMediaServer('plex', [
    { id: '1', name: 'Movies', kind: 'movie', locations: [`${root}/media/movies`] },
    { id: '2', name: 'TV Shows', kind: 'tv', locations: [`${root}/media/tv`] },
  ]);
  const t = makeApp({ clients: { tmdb: () => new FakeTmdb(), qbittorrent: (u, n, p) => qbit.as(u, n, p), plexServer: (u, k) => plex.as(u, k) } });
  const admin = await setupAdmin(t.app);
  await call(t.app, 'PUT', '/api/settings/services', { tmdbApiKey: 'good-key', moviesRoot: `${root}/media/movies`, tvRoot: `${root}/media/tv`, plexUrl: 'http://plex:32400', plexToken: 'plex-token' }, admin);
  await call(t.app, 'PUT', '/api/system/disk', { downloadsFolder: `${root}/torrents` }, admin);
  const write = (rel: string, bytes = 1000) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(bytes, 7));
    return p;
  };
  const scan = async () => {
    await call(t.app, 'POST', '/api/library/scan', {}, admin);
    await t.scanner.wait();
  };
  const api = (method: string, url: string, body?: unknown) => call(t.app, method, url, body, admin);
  const connect = () => api('PUT', '/api/settings/downloader', { url: qbit.url, username: 'admin', password: 'adminadmin' });
  return { ...t, root, admin, qbit, plex, write, scan, api, connect };
}

describe('two copies of one title', () => {
  it('finds a movie and an episode with two files, and marks the best one to keep', async () => {
    const w = await world();
    w.write('media/movies/The Matrix (1999) {tmdb-603}/The.Matrix.1999.720p.WEB-DL.x264-OLD.mkv', 700);
    w.write('media/movies/The Matrix (1999) {tmdb-603}/The.Matrix.1999.2160p.UHD.BluRay.x265.HDR-NEW.mkv', 2000);
    w.write('media/movies/Up (2009) {tmdb-14160}/Up.2009.1080p.BluRay.x264-GRP.mkv', 900);
    w.write('media/tv/Severance (2022)/Season 01/Severance.S01E01.720p.WEB-DL.x264-OLD.mkv', 300);
    w.write('media/tv/Severance (2022)/Season 01/Severance.S01E01.1080p.WEB-DL.x264-NEW.mkv', 500);
    w.write('media/tv/Severance (2022)/Season 01/Severance.S01E02.1080p.WEB-DL.x264-NEW.mkv', 500);
    await w.scan();
    const groups = ((await w.api('GET', '/api/cleanup/copies')).body as { groups: CopyGroup[] }).groups;
    expect(groups.map((g) => [g.title, g.files.length])).toEqual([
      ['Severance · S01E01', 2],
      ['The Matrix (1999)', 2],
    ]);
    const matrix = groups.find((g) => g.kind === 'movie')!;
    expect(matrix.files.find((f) => f.best)!.name).toMatch(/2160p/);
    expect(matrix.files.every((f) => !f.shared && f.folder === 'The Matrix (1999) {tmdb-603}')).toBe(true);
    expect(groups[0]!.files.find((f) => f.best)!.name).toMatch(/1080p/);
  });

  it('sets the other copy aside (never deletes), keeps at least one, and says so in the History', async () => {
    const w = await world();
    const old = w.write('media/movies/The Matrix (1999) {tmdb-603}/The.Matrix.1999.720p.WEB-DL.x264-OLD.mkv', 700);
    w.write('media/movies/The Matrix (1999) {tmdb-603}/The.Matrix.1999.720p.WEB-DL.x264-OLD.en.srt', 10);
    const keep = w.write('media/movies/The Matrix (1999) {tmdb-603}/The.Matrix.1999.2160p.UHD.BluRay.x265.HDR-NEW.mkv', 2000);
    await w.scan();
    // Both copies at once would leave nothing.
    const both = await w.api('POST', '/api/cleanup/set-aside', { paths: [old, keep] });
    expect(both.status).toBe(409);
    expect(both.body.message).toMatch(/leave The Matrix with no copy/);
    expect(fs.existsSync(old)).toBe(true);
    const res = await w.api('POST', '/api/cleanup/set-aside', { paths: [old] });
    expect(res.body).toMatchObject({ done: 1, problems: [] });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(`${w.root}/media/movies/.marquee-replaced/The Matrix (1999) {tmdb-603}/The.Matrix.1999.720p.WEB-DL.x264-OLD.mkv`)).toBe(true);
    // Its subtitle went with it.
    expect(fs.existsSync(`${w.root}/media/movies/.marquee-replaced/The Matrix (1999) {tmdb-603}/The.Matrix.1999.720p.WEB-DL.x264-OLD.en.srt`)).toBe(true);
    expect(t2(w).files()).toEqual([keep]);
    expect(((await w.api('GET', '/api/cleanup/copies')).body as { groups: CopyGroup[] }).groups).toEqual([]);
    // Plex was told to look at the folder again.
    expect(w.plex.scans.some((s) => s.folder.includes('The Matrix (1999)'))).toBe(true);
    const h = (await w.api('GET', '/api/history?event=set_aside')).body as HistoryView;
    expect(h.items.map((i) => [i.label, i.titleName])).toEqual([['Set aside by hand', 'The Matrix (1999)']]);
    // The last copy can't go this way either.
    expect((await w.api('POST', '/api/cleanup/set-aside', { paths: [keep] })).status).toBe(409);
  });

  it('only moves what it would list: nothing outside the library, in a hidden folder, or made up', async () => {
    const w = await world();
    const elsewhere = w.write('other/secret.mkv');
    const binned = w.write('media/movies/.marquee-replaced/Old/old.mkv');
    for (const p of [elsewhere, binned, `${w.root}/media/movies/../../other/secret.mkv`, `${w.root}/media/movies/Nope/nope.mkv`]) {
      expect((await w.api('POST', '/api/cleanup/set-aside', { paths: [p] })).status).toBe(400);
    }
    expect(fs.existsSync(elsewhere) && fs.existsSync(binned)).toBe(true);
    expect((await w.api('POST', '/api/cleanup/set-aside', { paths: [] })).status).toBe(400);
  });
});

/** Library files Marquee knows of, by path. */
const t2 = (w: Awaited<ReturnType<typeof world>>) => ({ files: () => w.db.select().from(schema.mediaFiles).all().map((f) => f.path).sort() });

describe('the recycle bin (set-aside files)', () => {
  it('lists each file with its title and what deleting it frees, puts one back, and deletes for good only when confirmed', async () => {
    const w = await world();
    const first = w.write('media/movies/The Matrix (1999) {tmdb-603}/The.Matrix.1999.2160p.UHD.BluRay.x265.HDR-NEW.mkv', 2000);
    await w.scan();
    const a = w.write('media/movies/.marquee-replaced/The Matrix (1999) {tmdb-603}/The.Matrix.1999.720p.WEB-DL.x264-OLD.mkv', 700);
    const shared = w.write('media/tv/.marquee-replaced/Severance (2022)/Season 01/ep.mkv', 500);
    fs.mkdirSync(`${w.root}/torrents`, { recursive: true });
    fs.linkSync(shared, `${w.root}/torrents/ep.mkv`);
    const v = (await w.api('GET', '/api/cleanup/set-aside')).body as SetAsideView;
    expect(v).toMatchObject({ bytes: 1200, freedBytes: 700 });
    const item = v.items.find((i) => i.path === a)!;
    expect(item).toMatchObject({ root: 'movies', rootLabel: 'Movies', name: 'The.Matrix.1999.720p.WEB-DL.x264-OLD.mkv', originalFolder: 'The Matrix (1999) {tmdb-603}', freedBytes: 700, canPutBack: true, title: { name: 'The Matrix (1999)' } });
    expect(v.items.find((i) => i.path === shared)).toMatchObject({ freedBytes: 0, title: null });

    // Put back: it's where it was, and a scan counts it again.
    const back = await w.api('POST', '/api/cleanup/put-back', { paths: [a] });
    expect(back.body).toMatchObject({ done: 1, problems: [] });
    await w.scanner.wait();
    expect(t2(w).files()).toEqual([`${w.root}/media/movies/The Matrix (1999) {tmdb-603}/The.Matrix.1999.720p.WEB-DL.x264-OLD.mkv`, first].sort());
    expect(fs.existsSync(`${w.root}/media/movies/.marquee-replaced/The Matrix (1999) {tmdb-603}`)).toBe(false);

    // Delete for good: confirm first; only files in a set-aside folder.
    expect((await w.api('POST', '/api/cleanup/delete', { paths: [shared] })).status).toBe(400);
    expect((await w.api('POST', '/api/cleanup/delete', { paths: [first], confirm: true })).status).toBe(400);
    const gone = await w.api('POST', '/api/cleanup/delete', { paths: [shared], confirm: true });
    expect(gone.body).toMatchObject({ done: 1, problems: [] });
    expect(fs.existsSync(shared)).toBe(false);
    expect(fs.existsSync(`${w.root}/torrents/ep.mkv`)).toBe(true);
    expect(((await w.api('GET', '/api/cleanup/set-aside')).body as SetAsideView).items).toEqual([]);
    const h = (await w.api('GET', '/api/history?event=put_back,deleted')).body as HistoryView;
    expect(h.items.map((i) => i.label)).toEqual(['Put back']);
  });

  it('won’t put a file back over one that’s there now', async () => {
    const w = await world();
    const now = w.write('media/movies/Up (2009) {tmdb-14160}/up.mkv', 10);
    const binned = w.write('media/movies/.marquee-replaced/Up (2009) {tmdb-14160}/up.mkv', 20);
    expect(((await w.api('GET', '/api/cleanup/set-aside')).body as SetAsideView).items[0]!.canPutBack).toBe(false);
    const r = await w.api('POST', '/api/cleanup/put-back', { paths: [binned] });
    expect(r.body).toMatchObject({ done: 0, problems: ['up.mkv: there’s already a file where it was.'] });
    expect(fs.statSync(now).size).toBe(10);
  });
});

describe('downloads nobody uses', () => {
  it('lists what no torrent points at, in any category, and lists nothing while qBittorrent can’t answer', async () => {
    const w = await world();
    const t = `${w.root}/torrents`;
    w.write('torrents/movies/Up.2009.1080p.BluRay-GRP/Up.mkv', 900);
    w.write('torrents/movies/Old.Movie.2001.720p-X/old.mkv', 600);
    w.write('torrents/tv/Show.S01E01.720p-X.mkv', 300);
    w.write('torrents/marquee/Dune.2021.2160p-Y/dune.mkv', 2000);
    w.write('torrents/.marquee-unpacked/3/x.mkv', 50);
    fs.mkdirSync(`${t}/empty-category`, { recursive: true });
    // In the library too (a hardlink): removing it frees nothing.
    w.write('media/movies/Old (2001)/old.mkv', 1);
    fs.rmSync(`${w.root}/media/movies/Old (2001)/old.mkv`);
    fs.linkSync(`${t}/movies/Old.Movie.2001.720p-X/old.mkv`, `${w.root}/media/movies/Old (2001)/old.mkv`);

    expect((await w.api('GET', '/api/cleanup/downloads')).body).toMatchObject({ ok: false, problem: expect.stringMatching(/Connect qBittorrent first/), items: [] });
    await w.connect();
    w.qbit.state.savePath = t;
    w.qbit.state.categories = { radarr: `${t}/movies`, 'tv-sonarr': `${t}/tv` };
    w.qbit.list = [
      qbitTorrent('a'.repeat(40), { name: 'Up', category: 'radarr', savePath: `${t}/movies`, contentPath: `${t}/movies/Up.2009.1080p.BluRay-GRP` }),
      qbitTorrent('b'.repeat(40), { name: 'Dune', category: 'marquee', savePath: `${t}/marquee`, contentPath: `${t}/marquee/Dune.2021.2160p-Y` }),
    ];
    const v = (await w.api('GET', '/api/cleanup/downloads')).body as CleanupDownloadsView;
    expect(v.ok).toBe(true);
    expect(v.items.map((i) => [path.relative(t, i.path), i.isFolder, i.sizeBytes, i.inLibrary])).toEqual([
      ['movies/Old.Movie.2001.720p-X', true, 600, true],
      // tv is Sonarr's category folder: what's inside is listed, not the folder itself.
      ['tv/Show.S01E01.720p-X.mkv', false, 300, false],
    ]);

    // Folders that don't line up: nothing listed rather than everything.
    w.qbit.list = [qbitTorrent('c'.repeat(40), { contentPath: '/downloads/whatever' })];
    expect((await w.api('GET', '/api/cleanup/downloads')).body).toMatchObject({ ok: false, problem: expect.stringMatching(/folders don’t line up/), items: [] });
    w.qbit.fail = new QbitError('unreachable', 'Couldn’t reach qBittorrent');
    expect((await w.api('GET', '/api/cleanup/downloads')).body).toMatchObject({ ok: false, items: [] });
    expect((await w.api('POST', '/api/cleanup/set-aside', { paths: [`${t}/tv/Show.S01E01.720p-X.mkv`] })).status).toBe(409);
    expect(fs.existsSync(`${t}/tv/Show.S01E01.720p-X.mkv`)).toBe(true);
  });

  it('sets an unused download aside into the downloads folder’s own bin, and never one in use', async () => {
    const w = await world();
    const t = `${w.root}/torrents`;
    w.write('torrents/movies/Up.2009.1080p.BluRay-GRP/Up.mkv', 900);
    w.write('torrents/movies/Old.Movie.2001.720p-X/old.mkv', 600);
    await w.connect();
    w.qbit.list = [qbitTorrent('a'.repeat(40), { savePath: `${t}/movies`, contentPath: `${t}/movies/Up.2009.1080p.BluRay-GRP` })];
    expect((await w.api('POST', '/api/cleanup/set-aside', { paths: [`${t}/movies/Up.2009.1080p.BluRay-GRP`] })).status).toBe(409);
    const r = await w.api('POST', '/api/cleanup/set-aside', { paths: [`${t}/movies/Old.Movie.2001.720p-X`] });
    expect(r.body).toMatchObject({ done: 1 });
    expect(fs.existsSync(`${t}/.marquee-replaced/movies/Old.Movie.2001.720p-X/old.mkv`)).toBe(true);
    const bin = (await w.api('GET', '/api/cleanup/set-aside')).body as SetAsideView;
    expect(bin.items.map((i) => [i.rootLabel, i.originalFolder, i.name])).toEqual([['Downloads', 'movies/Old.Movie.2001.720p-X', 'old.mkv']]);
    // The Health page's Empty covers it too.
    const empty = await w.api('POST', '/api/system/replaced/empty', { confirm: true });
    expect(empty.body.files).toBe(1);
  });
});

describe('library files with no title', () => {
  it('lists video files Marquee doesn’t count, with why', async () => {
    const w = await world();
    w.write('media/movies/The Matrix (1999) {tmdb-603}/The.Matrix.1999.2160p.UHD.BluRay.x265.HDR-NEW.mkv', 2000);
    w.write('media/movies/loose.mkv', 100);
    w.write('media/movies/Zzqx Nothing Like It (2031)/zz.mkv', 100);
    w.write('media/movies/The Matrix (1999) {tmdb-603}/Featurettes/extra.mkv', 100);
    w.write('media/movies/The Matrix (1999) {tmdb-603}/matrix-sample.mkv', 10);
    w.write('media/tv/Severance (2022)/Season 01/Severance.S01E01.mkv', 100);
    await w.scan();
    w.write('media/tv/Severance (2022)/Season 01/behind the scenes.mkv', 100);
    const files = ((await w.api('GET', '/api/cleanup/untracked')).body as { files: UntrackedFile[] }).files;
    expect(files.map((f) => [f.name, f.reason, f.href])).toEqual([
      ['loose.mkv', 'It’s loose in the library folder, not in a title’s own folder, so the scan skips it.', null],
      ['zz.mkv', 'Its folder is waiting for a match.', '/library/unmatched'],
      ['behind the scenes.mkv', expect.stringMatching(/In Severance \(2022\)’s folder, but Marquee can’t tell which episode/), expect.stringMatching(/^\/shows\/\d+$/)],
    ]);
    // Set one aside.
    const loose = files[0]!.path;
    expect((await w.api('POST', '/api/cleanup/set-aside', { paths: [loose] })).body).toMatchObject({ done: 1 });
    expect(fs.existsSync(`${w.root}/media/movies/.marquee-replaced/loose.mkv`)).toBe(true);
  });

  it('is for admins only', async () => {
    const w = await world();
    await w.api('POST', '/api/users', { username: 'kid', displayName: 'Kid', role: 'member', password: 'kid password!' });
    const cookie = (await call(w.app, 'POST', '/api/auth/login', { username: 'kid', password: 'kid password!' })).cookie!;
    for (const u of ['/api/cleanup/copies', '/api/cleanup/set-aside', '/api/cleanup/downloads', '/api/cleanup/untracked']) expect((await call(w.app, 'GET', u, undefined, cookie)).status).toBe(403);
    expect((await call(w.app, 'POST', '/api/cleanup/delete', { paths: ['/x'], confirm: true }, cookie)).status).toBe(403);
    expect(w.db.select().from(schema.users).where(eq(schema.users.username, 'kid')).get()).toBeTruthy();
  });
});
