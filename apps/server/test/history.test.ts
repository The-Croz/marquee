import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { CopiesResult, HistoryView, NeverPickView } from '@marquee/shared';
import { migrations, openDb, schema, setSetting } from '../src/db/index.js';
import { FakeQbit, fakeFetchTorrent } from './fakes/qbittorrent.js';
import { FakeSites, release } from './fakes/sources.js';
import { call, makeApp, setupAdmin } from './helpers.js';

const GB = 1024 ** 3;
const BEST = 'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX';
const NEXT = 'Dune.Part.Two.2024.2160p.MA.WEB-DL.DDP5.1.HDR.H.265-HONE';
const START = Date.parse('2026-11-20T12:00:00Z');
const DAY = 86_400_000;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-history-'));
  dirs.push(root);
  const sites = new FakeSites();
  sites.feed('http://tpb.test/api', { releases: [release(BEST, { size: 25 * GB }), release(NEXT, { size: 20 * GB })] });
  const qbit = new FakeQbit();
  qbit.state.savePath = path.join(root, 'torrents');
  let clock = START;
  const t = makeApp({ now: () => clock, clients: { torznab: sites.torznab, qbittorrent: (u, n, p) => qbit.as(u, n, p), fetchTorrent: fakeFetchTorrent(), disk: async () => ({ free: 900 * GB, total: 1000 * GB }) } });
  setSetting(t.db, 'library.movies_root', path.join(root, 'media/movies'));
  setSetting(t.db, 'library.tv_root', path.join(root, 'media/tv'));
  const cookie = await setupAdmin(t.app);
  await call(t.app, 'POST', '/api/settings/sources', { name: 'TPB', url: 'http://tpb.test/api', apiKey: 'good' }, cookie);
  await call(t.app, 'PUT', '/api/settings/downloader', { url: qbit.url, username: 'admin', password: 'adminadmin' }, cookie);
  const movie = t.db
    .insert(schema.movies)
    .values({ tmdbId: 693134, imdbId: 'tt15239678', title: 'Dune: Part Two', sortTitle: 'dune part two', year: 2024, runtime: 166, profile: 'cinema', addedAt: 0, refreshedAt: 0 })
    .returning()
    .get();
  const show = t.db.insert(schema.series).values({ tmdbId: 95396, title: 'Severance', sortTitle: 'severance', year: 2022, profile: 'cinema', addedAt: 0, refreshedAt: 0 }).returning().get();
  const later = (ms: number) => (clock += ms);
  /** Sends the copy at `index` in the movie's search results. */
  const send = async (title: string) => {
    const s = (await call(t.app, 'POST', `/api/movies/${movie.id}/search`, {}, cookie)).body as CopiesResult;
    const sent = await call(t.app, 'POST', '/api/downloads', { searchId: s.searchId, copyId: String(s.copies.findIndex((c) => c.title === title)), anyway: true }, cookie);
    expect(sent.status).toBe(201);
    return sent.body.download as { id: number; infoHash: string };
  };
  /** Finishes a download as one .mkv on disk and checks on it. */
  const finish = async (d: { infoHash: string }, name: string) => {
    const p = path.join(root, 'torrents', name, `${name}.mkv`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(5000, 1));
    qbit.fileLists.set(d.infoHash, [{ name: `${name}/${name}.mkv`, size: 5000 }]);
    Object.assign(qbit.list.find((x) => x.hash === d.infoHash)!, { state: 'stalledUP', progress: 1, savePath: qbit.state.savePath });
    later(11_000);
    await call(t.app, 'GET', '/api/downloads', undefined, cookie);
  };
  const history = async (qs = '') => (await call(t.app, 'GET', `/api/history${qs}`, undefined, cookie)).body as HistoryView;
  return { ...t, root, qbit, cookie, movie, show, later, send, finish, history };
}

describe('the History page', () => {
  it('records sent, in the library, upgraded and removed, newest first, each linked to its title', async () => {
    const t = await setup();
    const first = await t.send(NEXT);
    t.later(DAY);
    await t.finish(first, NEXT);
    t.later(DAY);
    const second = await t.send(BEST);
    t.later(DAY);
    await t.finish(second, BEST);
    t.later(DAY);
    const removed = await call(t.app, 'POST', `/api/downloads/${first.id}/remove`, { deleteFiles: false }, t.cookie);
    expect(removed.status).toBe(200);

    const h = await t.history();
    expect(h.items.map((i) => [i.event, i.label, i.copy])).toEqual([
      ['removed', 'Removed from qBittorrent', NEXT],
      ['upgraded', 'Upgraded', BEST],
      ['sent', 'Sent to qBittorrent', BEST],
      ['in_library', 'In your library', NEXT],
      ['sent', 'Sent to qBittorrent', NEXT],
    ]);
    expect(h.items[0]).toMatchObject({ titleName: 'Dune: Part Two (2024)', titleLink: `/movies/${t.movie.id}`, who: 'Josh', tone: 'quiet', detail: expect.stringMatching(/still in the download folder/) });
    expect(h.items[1]).toMatchObject({ tone: 'good', detail: expect.stringMatching(/The file it replaced \(.*\) is kept in the library’s \.marquee-replaced folder\./) });
    expect(h.items[2]).toMatchObject({ who: 'Josh', source: 'TPB', quality: expect.any(String), size: 25 * GB });
    expect(h.next).toBeNull();
  });

  it('records replaced copies with the reason, and filters by what happened, words and days', async () => {
    const t = await setup();
    const d = await t.send(BEST);
    t.later(2 * DAY);
    const r = await call(t.app, 'POST', `/api/downloads/${d.id}/try-another`, {}, t.cookie);
    expect(r.status).toBe(200);

    const replaced = await t.history('?event=replaced');
    expect(replaced.items).toEqual([expect.objectContaining({ event: 'replaced', label: 'Replaced', tone: 'bad', copy: BEST, detail: 'You asked for another copy.', who: 'Josh' })]);
    expect((await t.history('?event=sent,replaced')).items).toHaveLength(3);
    expect((await t.history('?q=hone')).items.map((i) => i.copy)).toEqual([NEXT]);
    expect((await t.history('?q=dune')).items).toHaveLength(3);
    expect((await t.history('?q=100%25')).items).toHaveLength(0);
    expect((await t.history('?from=2026-11-21')).items.map((i) => i.event)).toEqual(['sent', 'replaced']);
    expect((await t.history('?to=2026-11-20')).items.map((i) => i.copy)).toEqual([BEST]);
    expect((await t.history(`?movieId=${t.movie.id}`)).items).toHaveLength(3);
    expect((await t.history(`?seriesId=${t.show.id}`)).items).toHaveLength(0);
  });

  it('pages through older rows', async () => {
    const t = await setup();
    const d = await t.send(BEST);
    await call(t.app, 'POST', `/api/downloads/${d.id}/try-another`, {}, t.cookie); // replaced, and the next one sent: three rows at the same moment
    const page1 = await t.history('?limit=2');
    expect(page1.items).toHaveLength(2);
    expect(page1.next).toEqual(expect.any(String));
    const page2 = await t.history(`?limit=2&before=${page1.next}`);
    expect(page2.items).toHaveLength(1);
    expect(new Set([...page1.items, ...page2.items].map((i) => i.id)).size).toBe(3);
    expect(page2.next).toBeNull();
  });

  it('is for admins, and turns down bad filters plainly', async () => {
    const t = await setup();
    const bad = await call(t.app, 'GET', '/api/history?event=grabbed', undefined, t.cookie);
    expect(bad).toMatchObject({ status: 400, body: { message: expect.stringMatching(/“grabbed” isn’t something the History records/) } });
    expect((await call(t.app, 'GET', '/api/history?from=yesterday', undefined, t.cookie)).body.message).toMatch(/Dates look like 2026-11-22/);
    await call(t.app, 'POST', '/api/users', { username: 'ana', password: 'a long enough password', displayName: 'Ana', role: 'member' }, t.cookie);
    const ana = await call(t.app, 'POST', '/api/auth/login', { username: 'ana', password: 'a long enough password' });
    expect((await call(t.app, 'GET', '/api/history', undefined, ana.cookie)).status).toBe(403);
    expect((await call(t.app, 'GET', '/api/never-pick', undefined, ana.cookie)).status).toBe(403);
  });

  it('keeps a title’s rows when the title leaves the library', async () => {
    const t = await setup();
    await t.send(BEST);
    t.db.delete(schema.movies).run();
    const h = await t.history();
    expect(h.items[0]).toMatchObject({ titleName: 'Dune: Part Two (2024)', titleLink: null, movieId: null });
  });
});

describe('Never pick', () => {
  it('lists copies turned down, per title and all together, and Remove from list lets searches pick it again', async () => {
    const t = await setup();
    const d = await t.send(BEST);
    t.later(DAY);
    await call(t.app, 'POST', `/api/downloads/${d.id}/try-another`, {}, t.cookie);

    const forTitle = (await call(t.app, 'GET', `/api/never-pick?movieId=${t.movie.id}`, undefined, t.cookie)).body as NeverPickView;
    expect(forTitle.items).toEqual([{ id: expect.any(Number), at: START + DAY, kind: 'movie', titleName: 'Dune: Part Two (2024)', titleLink: `/movies/${t.movie.id}`, copy: BEST, reason: 'You asked for another copy.' }]);
    expect(((await call(t.app, 'GET', `/api/never-pick?seriesId=${t.show.id}`, undefined, t.cookie)).body as NeverPickView).items).toEqual([]);
    expect(((await call(t.app, 'GET', '/api/never-pick', undefined, t.cookie)).body as NeverPickView).items).toHaveLength(1);

    const before = (await call(t.app, 'POST', `/api/movies/${t.movie.id}/search`, {}, t.cookie)).body as CopiesResult;
    expect(before.copies.find((c) => c.title === BEST)!.rejections.at(-1)!.message).toMatch(/^Never pick: You asked/);

    const id = forTitle.items[0]!.id;
    const del = await call(t.app, 'DELETE', `/api/never-pick/${id}`, undefined, t.cookie);
    expect(del).toMatchObject({ status: 200, body: { message: `Taken off Never pick. Searches can pick ${BEST} again.` } });
    expect((await call(t.app, 'DELETE', `/api/never-pick/${id}`, undefined, t.cookie)).status).toBe(404);
    const after = (await call(t.app, 'POST', `/api/movies/${t.movie.id}/search`, {}, t.cookie)).body as CopiesResult;
    expect(after.copies.find((c) => c.title === BEST)!.rejections.map((r) => r.message).join(' ')).not.toMatch(/Never pick/);

    const h = await t.history('?event=allowed_again');
    expect(h.items).toEqual([expect.objectContaining({ label: 'Taken off Never pick', copy: BEST, who: 'Josh', detail: 'It was turned down because: You asked for another copy.' })]);
  });
});

describe('the History of downloads from before it was kept', () => {
  it('is filled in from the downloads already there when Marquee updates', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-migrate-'));
    dirs.push(dir);
    const file = path.join(dir, 'old.sqlite');
    const old = new Database(file);
    old.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
    migrations.slice(0, 24).forEach((sql, i) => {
      old.exec(sql);
      old.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, 0)').run(i + 1);
    });
    old.exec(`INSERT INTO movies (id, tmdb_id, title, sort_title, year, profile, added_at, refreshed_at) VALUES (1, 1, 'Up', 'up', 2009, 'cinema', 0, 0)`);
    old.exec(`INSERT INTO series (id, tmdb_id, title, sort_title, year, profile, added_at, refreshed_at) VALUES (1, 2, 'Bluey', 'bluey', 2018, 'kids', 0, 0)`);
    const ins = old.prepare(`INSERT INTO downloads (kind, movie_id, series_id, season, episodes, title, info_hash, source_name, added_at, state, adopted, checked_at, imported_at, import_copied, message, import_error, import_tried_at)
      VALUES (@kind, @movie, @series, @season, @eps, @title, @hash, 'TPB', @added, @state, @adopted, @checked, @imported, @copied, @message, @error, @tried)`);
    const base = { kind: 'movie', movie: 1, series: null, season: null, eps: null, adopted: 0, checked: null, imported: null, copied: 0, message: null, error: null, tried: null };
    ins.run({ ...base, title: 'Up.2009.1080p', hash: 'a', added: 100, state: 'done', imported: 200, copied: 1 });
    ins.run({ ...base, title: 'Up.2009.720p', hash: 'b', added: 50, state: 'failed', checked: 60, message: 'No progress for 24 hours.' });
    ins.run({ ...base, kind: 'tv', movie: null, series: 1, season: 1, eps: '[2]', title: 'Bluey.S01E02', hash: 'c', added: 300, state: 'done', error: 'The disk is full.', tried: 310 });
    ins.run({ ...base, title: 'Up.other.app', hash: 'd', added: 400, state: 'done', adopted: 1 });
    old.close();

    const db = openDb(file);
    const rows = db.select().from(schema.history).all().sort((a, b) => a.at - b.at || a.id - b.id);
    expect(rows.map((r) => [r.at, r.event, r.title, r.copy])).toEqual([
      [50, 'sent', 'Up (2009)', 'Up.2009.720p'],
      [60, 'replaced', 'Up (2009)', 'Up.2009.720p'],
      [100, 'sent', 'Up (2009)', 'Up.2009.1080p'],
      [200, 'in_library', 'Up (2009)', 'Up.2009.1080p'],
      [300, 'sent', 'Bluey', 'Bluey.S01E02'],
      [310, 'import_failed', 'Bluey', 'Bluey.S01E02'],
    ]);
    expect(rows.find((r) => r.event === 'in_library')!.detail).toMatch(/different disks/);
    expect(rows.find((r) => r.event === 'replaced')!.detail).toBe('No progress for 24 hours.');
    db.$client.close();
  });
});
