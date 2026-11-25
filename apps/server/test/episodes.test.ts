import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { EpisodeDetailView, HistoryView } from '@marquee/shared';
import { schema } from '../src/db/index.js';
import { FakeMediaServer } from './fakes/mediaServers.js';
import { FakeQbit, qbitTorrent } from './fakes/qbittorrent.js';
import { FakeTmdb } from './fakes/tmdb.js';
import { call, makeApp, setupAdmin } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const SONARR = 'a'.repeat(40);
const OTHER_SEASON = 'b'.repeat(40);
const UNRELATED = 'c'.repeat(40);

/** Severance S01E01 in the library, hardlinked to a torrent Sonarr sent; two other torrents that aren't it. */
async function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-ep-'));
  dirs.push(root);
  const qbit = new FakeQbit();
  const plex = new FakeMediaServer('plex', [{ id: '2', name: 'TV Shows', kind: 'tv', locations: [`${root}/media/tv`] }]);
  const t = makeApp({ clients: { tmdb: () => new FakeTmdb(), qbittorrent: (u, n, p) => qbit.as(u, n, p), plexServer: (u, k) => plex.as(u, k) } });
  const admin = await setupAdmin(t.app);
  const api = (method: string, url: string, body?: unknown) => call(t.app, method, url, body, admin);
  await api('PUT', '/api/settings/services', { tmdbApiKey: 'good-key', moviesRoot: `${root}/media/movies`, tvRoot: `${root}/media/tv`, plexUrl: 'http://plex:32400', plexToken: 'plex-token' });
  await api('PUT', '/api/system/disk', { downloadsFolder: `${root}/torrents` });
  const write = (rel: string, bytes = 1000) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(bytes, 7));
    return p;
  };
  const dl = write('torrents/tv-sonarr/Severance.S01E01.1080p.WEB-DL-NTb/Severance.S01E01.1080p.WEB-DL-NTb.mkv', 500);
  const lib = `${root}/media/tv/Severance (2022)/Season 01/Severance - S01E01 [WEBDL-1080p].mkv`;
  fs.mkdirSync(path.dirname(lib), { recursive: true });
  fs.linkSync(dl, lib);
  write('torrents/tv-sonarr/Severance.S01.720p-OLD/Severance.S01E01.720p.mkv', 300);
  write('media/tv/Severance (2022)/Season 01/Severance - S01E02 [WEBDL-1080p].mkv', 500);
  await api('POST', '/api/library/scan', {});
  await t.scanner.wait();
  await api('PUT', '/api/settings/downloader', { url: qbit.url, username: 'admin', password: 'adminadmin' });
  const save = `${root}/torrents/tv-sonarr`;
  qbit.list = [
    qbitTorrent(SONARR, { name: 'Severance.S01E01.1080p.WEB-DL-NTb', category: 'tv-sonarr', savePath: save, contentPath: `${save}/Severance.S01E01.1080p.WEB-DL-NTb` }),
    qbitTorrent(OTHER_SEASON, { name: 'Severance.S01.720p-OLD', category: 'tv-sonarr', savePath: save }),
    qbitTorrent(UNRELATED, { name: 'Some.Other.Show.S01E01', category: 'tv-sonarr', savePath: save }),
  ];
  qbit.fileLists.set(OTHER_SEASON, [{ name: 'Severance.S01.720p-OLD/Severance.S01E01.720p.mkv', size: 300 }]);
  const show = t.db.select().from(schema.series).where(eq(schema.series.tmdbId, 95396)).get()!;
  return { ...t, root, qbit, plex, api, show, lib, dl };
}

describe('an episode up close', () => {
  it('shows its file and finds the torrent another app sent by the shared file', async () => {
    const w = await world();
    const d = (await w.api('GET', `/api/shows/${w.show.id}/seasons/1/episodes/1`)).body as EpisodeDetailView;
    expect(d).toMatchObject({ season: 1, episode: 1, downloaderNote: null });
    expect(d.files.map((f) => [f.name, f.shared, f.otherEpisodes])).toEqual([['Severance - S01E01 [WEBDL-1080p].mkv', true, []]]);
    // The 720p season pack names the show but isn't the same file, so it isn't this episode's.
    expect(d.torrents).toEqual([{ hash: SONARR, name: 'Severance.S01E01.1080p.WEB-DL-NTb', followed: false, inDownloader: true, wholeSeason: false }]);
  });

  it('removes it: the file goes to the recycle bin, the torrent leaves qBittorrent with its files, and it isn’t looked for again', async () => {
    const w = await world();
    const base = `/api/shows/${w.show.id}/seasons/1/episodes/1`;
    expect((await w.api('POST', `${base}/remove`, { stopWanting: true, torrents: [UNRELATED] })).status).toBe(409);
    expect(fs.existsSync(w.lib)).toBe(true);
    const r = await w.api('POST', `${base}/remove`, { stopWanting: true, torrents: [SONARR] });
    expect(r.status).toBe(200);
    expect(r.body.message).toMatch(/Set its file aside .* Removed its download from qBittorrent with its files\. Marquee won’t look for it again\./);
    expect(w.qbit.actions).toEqual([`remove ${SONARR} with files`]);
    expect(fs.existsSync(w.lib)).toBe(false);
    expect(fs.existsSync(`${w.root}/media/tv/.marquee-replaced/Severance (2022)/Season 01/Severance - S01E01 [WEBDL-1080p].mkv`)).toBe(true);
    const ep = w.db.select().from(schema.episodes).where(and(eq(schema.episodes.seriesId, w.show.id), eq(schema.episodes.season, 1), eq(schema.episodes.episode, 1))).get()!;
    expect(ep.monitored).toBe(false);
    expect(w.db.select().from(schema.mediaFiles).where(eq(schema.mediaFiles.seriesId, w.show.id)).all().map((f) => path.basename(f.path))).toEqual(['Severance - S01E02 [WEBDL-1080p].mkv']);
    expect(w.plex.scans.some((s) => s.folder.includes('Season 01'))).toBe(true);
    const h = (await w.api('GET', '/api/history?event=set_aside')).body as HistoryView;
    expect(h.items.map((i) => i.titleName)).toEqual(['Severance · S01E01']);
  });

  it('can keep it Wanted and leave qBittorrent alone', async () => {
    const w = await world();
    const r = await w.api('POST', `/api/shows/${w.show.id}/seasons/1/episodes/1/remove`, { stopWanting: false, torrents: [] });
    expect(r.body.message).toMatch(/still Wanted, so Marquee will look for it again/);
    expect(w.qbit.actions).toEqual([]);
    expect(fs.existsSync(w.dl)).toBe(true);
  });

  it('says so when qBittorrent can’t answer, and is for admins only', async () => {
    const w = await world();
    w.qbit.fail = new (await import('../src/downloads/qbittorrent.js')).QbitError('unreachable', 'no answer');
    const d = (await w.api('GET', `/api/shows/${w.show.id}/seasons/1/episodes/1`)).body as EpisodeDetailView;
    expect(d.torrents).toEqual([]);
    expect(d.downloaderNote).toMatch(/couldn’t ask qBittorrent/);
    expect((await w.api('GET', `/api/shows/${w.show.id}/seasons/9/episodes/9`)).status).toBe(404);
    await w.api('POST', '/api/users', { username: 'sam', displayName: 'Sam', role: 'member', password: 'sam password!' });
    const cookie = (await call(w.app, 'POST', '/api/auth/login', { username: 'sam', password: 'sam password!' })).cookie!;
    expect((await call(w.app, 'GET', `/api/shows/${w.show.id}/seasons/1/episodes/1`, undefined, cookie)).status).toBe(403);
  });
});
