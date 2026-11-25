import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BackupView, BackupsView, HealthView, LogsView } from '@marquee/shared';
import { getSetting, migrations, openDb, schema, setSetting } from '../src/db/index.js';
import { writeDownloader } from '../src/downloads/service.js';
import { writeMediaServer } from '../src/library/mediaServers.js';
import { Jobs, every } from '../src/system/jobs.js';
import { LogBook, captureConsole, scrub, secretsIn, watchSecrets } from '../src/system/logs.js';
import { backUp, backUpBeforeUpdate, listBackups, nightlyBackup, pruneBackups } from '../src/system/backups.js';
import { noRoomReason, readDiskSettings } from '../src/system/disk.js';
import { checkHealth } from '../src/notify/health.js';
import { FakeMediaServer } from './fakes/mediaServers.js';
import { FakeQbit } from './fakes/qbittorrent.js';
import { FakeTmdb } from './fakes/tmdb.js';
import { call, makeApp, setupAdmin } from './helpers.js';

const GB = 1024 ** 3;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const START = Date.parse('2026-11-22T12:00:00Z');

const dirs: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'marquee-system-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function admin(opts: Parameters<typeof makeApp>[0] = {}) {
  const dataDir = tempDir();
  let clock = START;
  const t = makeApp({ now: () => clock, ...opts, config: { dataDir, ...opts.config } });
  const cookie = await setupAdmin(t.app);
  await call(t.app, 'POST', '/api/users', { username: 'sam', displayName: 'Sam', role: 'member', password: 'a lovely password' }, cookie);
  const member = (await call(t.app, 'POST', '/api/auth/login', { username: 'sam', password: 'a lovely password' })).cookie!;
  return { ...t, dataDir, cookie, member, later: (ms: number) => (clock += ms), now: () => clock };
}

// ---------------- Jobs ----------------

describe('background jobs', () => {
  it('runs each job when it’s due, and says when it runs next', async () => {
    const t = await admin();
    let clock = START;
    const jobs = new Jobs(t.db, () => clock);
    let runs = 0;
    jobs.add({ id: 'tick', label: 'Tick', description: 'Counts.', everyMs: 5 * MIN, firstAfterMs: MIN, run: async () => `ran ${++runs}` });
    jobs.add({ id: 'hand', label: 'By hand', description: 'Only when asked.', everyMs: null, run: async () => 'done' });

    await jobs.tick();
    expect(runs).toBe(0);
    expect(jobs.list()[0]).toMatchObject({ id: 'tick', every: 'Every 5 minutes', tone: 'ok', lastStartedAt: null, nextAt: START + MIN });
    expect(jobs.list()[1]).toMatchObject({ every: 'Only when you ask', nextAt: null });

    clock += MIN;
    await jobs.tick();
    expect(runs).toBe(1);
    expect(jobs.list()[0]).toMatchObject({ lastStartedAt: START + MIN, lastOk: true, lastMessage: 'ran 1', nextAt: START + 6 * MIN });

    // Not due again yet; the by-hand job never runs by itself.
    clock += MIN;
    await jobs.tick();
    expect(runs).toBe(1);
    expect(jobs.list()[1]!.lastStartedAt).toBeNull();
  });

  it('never runs a job twice at once: Run now joins the run already going', async () => {
    const t = await admin();
    const jobs = new Jobs(t.db, () => START);
    let release!: () => void;
    let starts = 0;
    jobs.add({ id: 'slow', label: 'Slow', description: '', everyMs: MIN, run: () => (starts++, new Promise<string>((r) => (release = () => r('finished')))) });
    const a = jobs.run('slow');
    const b = jobs.run('slow');
    expect(starts).toBe(1);
    expect(jobs.list()[0]).toMatchObject({ running: true, tone: 'busy' });
    release();
    expect(await a).toEqual(await b);
    expect(jobs.list()[0]).toMatchObject({ running: false, lastOk: true, lastMessage: 'finished' });
  });

  it('keeps a failed run’s plain message, with secrets taken out, and remembers it after a restart', async () => {
    const t = await admin();
    const jobs = new Jobs(t.db, () => START);
    jobs.add({ id: 'broken', label: 'Broken', description: '', everyMs: MIN, run: async () => Promise.reject(new Error('Prowlarr said no to http://prowlarr:9696/api?apikey=abc123secret')) });
    const quiet = captureConsole(new LogBook());
    try {
      expect(await jobs.run('broken')).toMatchObject({ ok: false, message: 'Prowlarr said no to http://prowlarr:9696/api?apikey=…' });
    } finally {
      quiet();
    }
    expect(jobs.list()[0]).toMatchObject({ tone: 'problem', lastOk: false });

    const after = new Jobs(t.db, () => START + DAY);
    after.add({ id: 'broken', label: 'Broken', description: '', everyMs: MIN, run: async () => {} });
    expect(after.list()[0]).toMatchObject({ lastOk: false, lastMessage: 'Prowlarr said no to http://prowlarr:9696/api?apikey=…', nextAt: START + DAY + MIN });
  });

  it('skips a job that’s off and says how to turn it on', async () => {
    const t = await admin();
    let on = false;
    let runs = 0;
    let clock = START;
    const jobs = new Jobs(t.db, () => clock);
    jobs.add({ id: 'sync', label: 'Sync', description: '', everyMs: MIN, off: () => (on ? null : 'Turn it on in Settings → Watched sync.'), run: async () => void runs++ });
    await jobs.tick();
    expect(runs).toBe(0);
    expect(jobs.list()[0]).toMatchObject({ tone: 'off', off: 'Turn it on in Settings → Watched sync.', nextAt: null });
    on = true;
    clock += MIN;
    await jobs.tick();
    expect(runs).toBe(1);
  });

  it('says a run that never finished was cut short', async () => {
    const t = await admin();
    setSetting(t.db, 'job.cut', JSON.stringify({ startedAt: START, finishedAt: null, ok: null, message: null }));
    const jobs = new Jobs(t.db, () => START).add({ id: 'cut', label: 'Cut', description: '', everyMs: MIN, run: async () => {} });
    expect(jobs.list()[0]!.lastMessage).toBe('Marquee stopped before it finished.');
  });

  it('says how often in plain words', () => {
    expect([30_000, MIN, 10 * MIN, 60 * MIN, 6 * 60 * MIN, DAY, 2 * DAY].map(every)).toEqual(['Every 30 seconds', 'Every minute', 'Every 10 minutes', 'Every hour', 'Every 6 hours', 'Every day', 'Every 2 days']);
  });
});

// ---------------- Health page ----------------

describe('Health page', () => {
  it('is for admins only', async () => {
    const t = await admin();
    expect((await call(t.app, 'GET', '/api/system/health')).status).toBe(401);
    for (const p of ['/api/system/health', '/api/system/backups', '/api/system/logs', '/api/system/logs/download']) {
      expect((await call(t.app, 'GET', p, undefined, t.member)).status).toBe(403);
    }
    expect((await call(t.app, 'POST', '/api/system/backups', {}, t.member)).status).toBe(403);
    expect((await call(t.app, 'POST', '/api/system/jobs/scan/run', {}, t.member)).status).toBe(403);
    expect((await call(t.app, 'PUT', '/api/system/disk', { minFreeGb: 5 }, t.member)).status).toBe(403);
  });

  it('shows every connection with its state and what to do, plus free space and jobs', async () => {
    const qbit = new FakeQbit();
    const plex = new FakeMediaServer('plex');
    plex.fail = 'Plex didn’t answer.';
    const disk = async (p: string) => (p === '/data/torrents' ? { free: 5 * GB, total: 4000 * GB } : p === '/data/media/tv' ? null : { free: 900 * GB, total: 4000 * GB });
    const t = await admin({ clients: { qbittorrent: (u, n, p) => qbit.as(u, n, p), plexServer: (u, k) => plex.as(u, k), tmdb: (k) => new FakeTmdb(k), disk } });
    writeDownloader(t.db, { url: qbit.url, username: 'admin', password: 'adminadmin' });
    writeMediaServer(t.db, 'plex', { url: 'http://plex:32400', secret: 'plex-token' });
    setSetting(t.db, 'services.tmdb_api_key', 'good-key');
    t.db.insert(schema.sources).values({ name: 'IPTorrents', url: 'http://ipt.test', apiKey: 'k', state: 'key_refused', stateMessage: 'Turned down the key.', failures: 4, createdAt: 0 }).run();
    t.db.insert(schema.sources).values({ name: 'Knaben', url: 'http://knaben.test', state: 'working', createdAt: 0 }).run();

    const res = await call(t.app, 'GET', '/api/system/health', undefined, t.cookie);
    expect(res.status).toBe(200);
    const h = res.body as HealthView;
    const by = (name: string) => h.connections.find((c) => c.name === name)!;
    expect(by('IPTorrents')).toMatchObject({ group: 'Sources', tone: 'problem', state: 'Key turned down', fix: expect.stringMatching(/API key again/), to: '/settings/sources' });
    expect(by('Knaben')).toMatchObject({ tone: 'ok', state: 'Working', fix: null });
    expect(by('qBittorrent')).toMatchObject({ group: 'Downloader', tone: 'ok', state: 'Working' });
    expect(by('Plex')).toMatchObject({ tone: 'problem', state: 'Not answering', detail: 'Plex didn’t answer.', fix: expect.stringMatching(/tries again by itself/) });
    expect(by('Jellyfin')).toMatchObject({ tone: 'off', state: 'Not set up' });
    expect(by('TMDB')).toMatchObject({ tone: 'ok', state: 'Working' });
    expect(by('Bot-check solver')).toMatchObject({ tone: 'off', state: 'Off' });
    expect(h.disks).toEqual([
      expect.objectContaining({ key: 'downloads', path: '/data/torrents', free: 5 * GB, tone: 'problem', state: 'Nearly full · 5.0 GB free', fix: expect.stringMatching(/holding off on sending new downloads/) }),
      expect.objectContaining({ key: 'movies', tone: 'ok', state: '900.0 GB free' }),
      expect.objectContaining({ key: 'tv', free: null, tone: 'problem', state: 'Can’t see this folder' }),
    ]);
    expect(h.disk).toEqual({ downloadsFolder: '/data/torrents', downloadsFolderSet: false, minFreeGb: 20, defaultMinFreeGb: 20 });
    expect(h.jobs.map((j) => j.id)).toContain('scan');
    expect(h.problems).toBe(4); // IPTorrents, Plex, two disks
    expect(JSON.stringify(h)).not.toMatch(/adminadmin|plex-token|good-key/);
  });

  it('says what to do when nothing is set up yet', async () => {
    const t = await admin({ clients: { disk: async () => ({ free: 100 * GB, total: 200 * GB }) } });
    const h = (await call(t.app, 'GET', '/api/system/health', undefined, t.cookie)).body as HealthView;
    expect(h.connections.find((c) => c.key === 'sources')).toMatchObject({ tone: 'problem', state: 'None yet', fix: expect.stringMatching(/Add a Source/) });
    expect(h.connections.find((c) => c.key === 'downloader')).toMatchObject({ tone: 'problem', state: 'Not set up' });
    expect(h.connections.find((c) => c.key === 'tmdb')).toMatchObject({ tone: 'problem', state: 'No key yet' });
  });

  it('runs a job now, and refuses unknown or switched-off jobs plainly', async () => {
    const t = await admin();
    const res0 = await call(t.app, 'POST', '/api/system/jobs/nope/run', {}, t.cookie);
    expect(res0).toMatchObject({ status: 404, body: { error: 'no_such_job' } });
    // The library scan needs a TMDB key first.
    const off = await call(t.app, 'POST', '/api/system/jobs/scan/run', {}, t.cookie);
    expect(off).toMatchObject({ status: 409, body: { error: 'job_off', message: 'This job is off. Add your TMDB API key in Settings → Services first.' } });
  });

  it('runs the library scan from Run now', async () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'movies', 'Up (2009)'), { recursive: true });
    fs.writeFileSync(path.join(root, 'movies', 'Up (2009)', 'Up.2009.1080p.BluRay.x264.mkv'), 'x');
    fs.mkdirSync(path.join(root, 'tv'));
    const t = await admin({ clients: { tmdb: (k) => new FakeTmdb(k) } });
    setSetting(t.db, 'services.tmdb_api_key', 'good-key');
    setSetting(t.db, 'library.movies_root', path.join(root, 'movies'));
    setSetting(t.db, 'library.tv_root', path.join(root, 'tv'));
    const res = await call(t.app, 'POST', '/api/system/jobs/scan/run', {}, t.cookie);
    expect(res.status).toBe(200);
    expect(res.body.job).toMatchObject({ id: 'scan', lastOk: true, lastMessage: '1 matched, 0 need a match' });
  });

  it('saves the disk settings under For experts, with plain checks', async () => {
    const t = await admin();
    expect((await call(t.app, 'PUT', '/api/system/disk', { minFreeGb: -1 }, t.cookie)).body.message).toBe('The minimum can’t be below 0.');
    expect((await call(t.app, 'PUT', '/api/system/disk', { downloadsFolder: 'torrents' }, t.cookie)).body.message).toBe('Folders are full paths, like /data/torrents.');
    const saved = await call(t.app, 'PUT', '/api/system/disk', { downloadsFolder: '/mnt/downloads/', minFreeGb: 50 }, t.cookie);
    expect(saved.body).toEqual({ downloadsFolder: '/mnt/downloads', downloadsFolderSet: true, minFreeGb: 50, defaultMinFreeGb: 20 });
    const back = await call(t.app, 'PUT', '/api/system/disk', { downloadsFolder: null, minFreeGb: null }, t.cookie);
    expect(back.body).toMatchObject({ downloadsFolder: '/data/torrents', downloadsFolderSet: false, minFreeGb: 20 });
    // With no folder of its own, the downloads folder follows the downloader's folder pair.
    writeDownloader(t.db, { folderPairs: [{ from: '/downloads', to: '/data/qbit' }] });
    expect(readDiskSettings(t.db).downloadsFolder).toBe('/data/qbit');
    // 0 is a real choice: no minimum.
    await call(t.app, 'PUT', '/api/system/disk', { minFreeGb: 0 }, t.cookie);
    expect(readDiskSettings(t.db).minFreeGb).toBe(0);
  });
});

describe('free space', () => {
  it('lets a copy through only when the minimum stays free, and doesn’t stand in the way when it can’t tell', async () => {
    const t = await admin();
    const probe = (free: number) => async () => ({ free, total: 1000 * GB });
    expect(await noRoomReason(t.db, 'downloads', 10 * GB, probe(40 * GB))).toBeNull();
    expect(await noRoomReason(t.db, 'downloads', 10 * GB, probe(25 * GB))).toBe(
      'Not enough room on the downloads disk (/data/torrents): 25.0 GB free, this needs 10.0 GB, and Marquee keeps 20 GB spare. Free up some space, or lower the minimum in Settings → Health → For experts.',
    );
    expect(await noRoomReason(t.db, 'tv', 1 * GB, async () => null)).toBeNull();
  });

  it('tells admins once when a disk goes under the minimum, and again after it clears', async () => {
    const t = await admin();
    let free = 5 * GB;
    const disk = async (p: string) => (p === '/data/media/movies' ? { free, total: 1000 * GB } : { free: 500 * GB, total: 1000 * GB });
    const sent: string[] = [];
    const push = { send: async (_c: unknown, m: { title: string }) => void sent.push(m.title) };
    const run = () => checkHealth({ db: t.db, push: push as never, clients: { qbittorrent: () => new FakeQbit().as('', '', ''), disk }, now: t.now, baseUrl: () => null });
    await run();
    await run();
    const bell = () => t.db.select().from(schema.notifications).all().filter((n) => n.event === 'disk_low');
    expect(bell()).toHaveLength(1);
    expect(bell()[0]).toMatchObject({ title: 'Movies disk is nearly full', body: '5.0 GB free on /data/media/movies; Marquee keeps 20 GB spare, so it’s waiting. Free up some space and it carries on by itself.' });
    free = 50 * GB;
    await run();
    free = 1 * GB;
    await run();
    expect(bell()).toHaveLength(2);
  });
});

// ---------------- Backups ----------------

/** Undoes the newest migration, to make a backup "one version behind". Update it with each new migration. */
/** Undoes the newest migration (33, which tidies away OMDb): puts an old OMDb key back, which the upgrade removes. */
const UNDO_NEWEST = {
  sql: ["INSERT OR REPLACE INTO settings (key, value) VALUES ('services.omdb_key', 'old-key')"],
  tables: [] as string[],
};

describe('backups', () => {
  it('backs up before a newer version changes the database, and never for a new one', async () => {
    const dataDir = tempDir();
    const file = path.join(dataDir, 'marquee.sqlite');
    const before = (sqlite: Parameters<typeof backUpBeforeUpdate>[0]) => backUpBeforeUpdate(sqlite, dataDir, START);
    openDb(file, { beforeUpdate: before }).$client.close();
    expect(listBackups(dataDir)).toEqual([]);
    // An older Marquee's database: one migration behind.
    const Database = (await import('better-sqlite3')).default;
    const old = new Database(file);
    old.exec(`DELETE FROM schema_migrations WHERE version = ${migrations.length}`);
    for (const sql of UNDO_NEWEST.sql) old.exec(sql);
    old.close();
    const seen: number[] = [];
    const db = openDb(file, { beforeUpdate: (sqlite, from, to) => (seen.push(from, to), before(sqlite)) });
    expect(seen).toEqual([migrations.length - 1, migrations.length]);
    expect(listBackups(dataDir)).toMatchObject([{ name: 'marquee-20261122-120000-before-update.sqlite', kind: 'before_update' }]);
    expect((db.$client.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v).toBe(migrations.length);
    db.$client.close();
    const kept = new Database(path.join(dataDir, 'backups', 'marquee-20261122-120000-before-update.sqlite'), { readonly: true });
    expect((kept.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v).toBe(migrations.length - 1);
    kept.close();
  });

  it('won’t change the database when the backup before an update fails', async () => {
    const dataDir = tempDir();
    const file = path.join(dataDir, 'marquee.sqlite');
    openDb(file).$client.close();
    const Database = (await import('better-sqlite3')).default;
    const old = new Database(file);
    old.exec(`DELETE FROM schema_migrations WHERE version = ${migrations.length}`);
    for (const sql of UNDO_NEWEST.sql) old.exec(sql);
    old.close();
    fs.writeFileSync(path.join(dataDir, 'backups'), 'a file where the folder should be');
    expect(() => openDb(file, { beforeUpdate: (sqlite) => backUpBeforeUpdate(sqlite, dataDir, START) })).toThrow(/couldn’t back it up first .*Nothing was changed/);
    const after = new Database(file, { readonly: true });
    expect((after.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v).toBe(migrations.length - 1);
    after.close();
  });

  it('backs up now, lists it, and downloads the file', async () => {
    const t = await admin();
    const made = await call(t.app, 'POST', '/api/system/backups', {}, t.cookie);
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ name: 'marquee-20261122-120000-by-hand.sqlite', kind: 'by_hand', createdAt: START });
    const list = (await call(t.app, 'GET', '/api/system/backups', undefined, t.cookie)).body as BackupsView;
    expect(list).toMatchObject({ folder: path.join(t.dataDir, 'backups'), keepDays: 14, lastNightly: null, nextNightly: START });
    expect(list.backups.map((b) => b.name)).toEqual(['marquee-20261122-120000-by-hand.sqlite']);
    // Twice in the same second still makes two.
    expect((await call(t.app, 'POST', '/api/system/backups', {}, t.cookie)).body.name).toBe('marquee-20261122-120001-by-hand.sqlite');

    const res = await t.app.request('/api/system/backups/marquee-20261122-120000-by-hand.sqlite', { headers: { Cookie: t.cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="marquee-20261122-120000-by-hand.sqlite"');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 15).toString()).toBe('SQLite format 3');
  });

  it('only hands out backup files, nothing else from the data folder', async () => {
    const t = await admin();
    fs.writeFileSync(path.join(t.dataDir, 'secret.txt'), 'nope');
    for (const name of ['..%2Fsecret.txt', 'secret.txt', 'marquee-20261122-120000-nightly.sqlite']) {
      expect((await call(t.app, 'GET', `/api/system/backups/${name}`, undefined, t.cookie)).status).toBe(404);
    }
  });

  it('restores a backup only when confirmed, keeping how things were as another backup', async () => {
    const t = await admin();
    setSetting(t.db, 'library.movies_root', '/before');
    const b = (await call(t.app, 'POST', '/api/system/backups', {}, t.cookie)).body as BackupView;
    // Things change after the backup.
    setSetting(t.db, 'library.movies_root', '/after');
    t.db.insert(schema.movies).values({ tmdbId: 1, title: 'Added later', sortTitle: 'added later', year: 2020, profile: 'cinema', addedAt: 0, refreshedAt: 0 }).run();
    t.later(60_000);

    const unconfirmed = await call(t.app, 'POST', `/api/system/backups/${b.name}/restore`, {}, t.cookie);
    expect(unconfirmed).toMatchObject({ status: 400, body: { error: 'needs_confirm' } });
    expect(getSetting(t.db, 'library.movies_root')).toBe('/after');

    const res = await call(t.app, 'POST', `/api/system/backups/${b.name}/restore`, { confirm: true }, t.cookie);
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/^Restored that backup\. .*restore that to undo this\. You may need to sign in again\.$/);
    expect(getSetting(t.db, 'library.movies_root')).toBe('/before');
    expect(t.db.select().from(schema.movies).all()).toEqual([]);
    expect(res.body.safety).toMatchObject({ kind: 'before_restore', name: 'marquee-20261122-120100-before-restore.sqlite' });
    // The same admin session was in the backup, so they're still signed in; foreign keys are back on.
    expect((await call(t.app, 'GET', '/api/system/backups', undefined, t.cookie)).status).toBe(200);
    expect(t.db.$client.pragma('foreign_keys', { simple: true })).toBe(1);

    // Undo: restore the safety backup.
    await call(t.app, 'POST', `/api/system/backups/${res.body.safety.name}/restore`, { confirm: true }, t.cookie);
    expect(getSetting(t.db, 'library.movies_root')).toBe('/after');
    expect(t.db.select().from(schema.movies).all().map((m) => m.title)).toEqual(['Added later']);
    // New rows still get new ids after a restore.
    const next = t.db.insert(schema.movies).values({ tmdbId: 2, title: 'Next', sortTitle: 'next', year: 2021, profile: 'cinema', addedAt: 0, refreshedAt: 0 }).returning().get();
    expect(next.id).toBe(2);
  });

  it('brings an older backup up to this version after restoring it', async () => {
    const t = await admin();
    const b = await backUp(t.db, t.dataDir, 'by_hand', START);
    // Pretend the backup came from a version one migration behind: drop the newest change from it.
    const Database = (await import('better-sqlite3')).default;
    const file = path.join(t.dataDir, 'backups', b.name);
    const old = new Database(file);
    old.exec(`DELETE FROM schema_migrations WHERE version = ${migrations.length}`);
    for (const sql of UNDO_NEWEST.sql) old.exec(sql);
    old.exec(`INSERT INTO history (at, event, kind, title) VALUES (1, 'sent', 'movie', 'Kept through the upgrade')`);
    old.close();
    const res = await call(t.app, 'POST', `/api/system/backups/${b.name}/restore`, { confirm: true }, t.cookie);
    expect(res.status).toBe(200);
    const v = t.db.$client.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number };
    expect(v.v).toBe(migrations.length);
    const tables = (t.db.$client.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((c) => c.name);
    expect(tables).toEqual(expect.arrayContaining([...UNDO_NEWEST.tables, 'history']));
    expect(t.db.$client.prepare("SELECT value FROM settings WHERE key = 'services.omdb_key'").get()).toBeUndefined();
    expect(t.db.select().from(schema.history).all().map((h) => h.title)).toContain('Kept through the upgrade');
  });

  it('won’t restore a backup from a newer Marquee, or a file that isn’t one', async () => {
    const t = await admin();
    const b = await backUp(t.db, t.dataDir, 'by_hand', START);
    const Database = (await import('better-sqlite3')).default;
    const file = path.join(t.dataDir, 'backups', b.name);
    const newer = new Database(file);
    newer.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, 0)').run(migrations.length + 1);
    newer.close();
    setSetting(t.db, 'library.movies_root', '/now');
    const res = await call(t.app, 'POST', `/api/system/backups/${b.name}/restore`, { confirm: true }, t.cookie);
    expect(res).toMatchObject({ status: 409, body: { error: 'backup_too_new', message: 'That backup came from a newer Marquee. Update Marquee first, then restore it.' } });
    expect(getSetting(t.db, 'library.movies_root')).toBe('/now');

    fs.writeFileSync(path.join(t.dataDir, 'backups', 'marquee-20261101-000000-nightly.sqlite'), 'not a database at all, just some words');
    const bad = await call(t.app, 'POST', '/api/system/backups/marquee-20261101-000000-nightly.sqlite/restore', { confirm: true }, t.cookie);
    expect(bad).toMatchObject({ status: 400, body: { error: 'bad_backup' } });
  });

  it('backs up nightly once a day and keeps 14 days, never removing the newest', async () => {
    const t = await admin();
    expect(await nightlyBackup(t.db, t.dataDir, START)).toBe('Backed up (marquee-20261122-120000-nightly.sqlite)');
    expect(await nightlyBackup(t.db, t.dataDir, START + 6 * 60 * MIN)).toBe('Not due yet');
    let at = START;
    for (let i = 1; i <= 16; i++) await nightlyBackup(t.db, t.dataDir, (at += DAY));
    const kept = listBackups(t.dataDir);
    expect(kept).toHaveLength(15); // today and the 14 days before
    expect(kept[0]!.createdAt).toBe(at);
    expect(kept.at(-1)!.createdAt).toBe(at - 14 * DAY);
    // Even a very old lone backup is kept.
    const lone = tempDir();
    await backUp(t.db, lone, 'by_hand', START);
    expect(pruneBackups(lone, START + 100 * DAY)).toBe(0);
    expect(listBackups(lone)).toHaveLength(1);
  });

  it('says plainly when the backup folder can’t be written', async () => {
    const t = await admin();
    fs.writeFileSync(path.join(t.dataDir, 'backups'), 'a file where the folder should be');
    await expect(backUp(t.db, t.dataDir, 'nightly', START)).rejects.toThrow(/Couldn’t write a backup in .*backups/);
  });
});

// ---------------- Logs ----------------

describe('logs', () => {
  it('takes secrets out of lines', () => {
    expect(scrub('GET http://prowlarr:9696/1/api?t=search&apikey=abc123def&q=dune')).toBe('GET http://prowlarr:9696/1/api?t=search&apikey=…&q=dune');
    expect(scrub('http://plex:32400/library?X-Plex-Token=SECRETTOKEN')).toBe('http://plex:32400/library?X-Plex-Token=…');
    expect(scrub('fetching http://admin:hunter2@qbit:8080/api')).toBe('fetching http://admin:…@qbit:8080/api');
    expect(scrub('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload')).toBe('Authorization: …');
    expect(scrub('sent with bearer eyJhbGciOiJIUzI1NiJ9.payload')).toBe('sent with bearer …');
    expect(scrub('{"X-Api-Key":"0123456789abcdef"}')).toBe('{"X-Api-Key":"…"}');
    expect(scrub('cookie: uid=1; pass=xyz')).toBe('cookie: …; pass=xyz');
    expect(scrub('the password is my-saved-password ok', ['my-saved-password'])).toBe('the password is … ok');
  });

  it('knows every saved secret: settings, Source keys, site settings and notification channels', async () => {
    const t = await admin();
    writeDownloader(t.db, { url: 'http://qbit:8080', username: 'admin', password: 'qbit-password' });
    setSetting(t.db, 'services.tmdb_api_key', 'tmdb-key-123');
    setSetting(t.db, 'library.movies_root', '/data/media/movies');
    t.db.insert(schema.sources).values({ name: 'IPT', url: 'http://x', apiKey: 'source-key-1', siteSettings: JSON.stringify({ username: 'josh', password: 'site-pass-9', cookie: 'cf_clearance=zzzzzz' }), createdAt: 0 }).run();
    t.db.insert(schema.notificationChannels).values({ kind: 'pushover', name: 'Phone', config: JSON.stringify({ user: 'u', token: 'pushover-token' }), createdAt: 0, updatedAt: 0 } as never).run();
    const s = secretsIn(t.db);
    expect(s).toEqual(expect.arrayContaining(['qbit-password', 'tmdb-key-123', 'source-key-1', 'site-pass-9', 'cf_clearance=zzzzzz', 'pushover-token']));
    expect(s).not.toContain('/data/media/movies');
    expect(s).not.toContain('josh');

    watchSecrets(t.db, t.now);
    expect(scrub('qBittorrent said no to qbit-password')).toBe('qBittorrent said no to …');
  });

  it('keeps the newest lines, filters by level and words, and reads the part of Marquee each came from', () => {
    let clock = START;
    const book = new LogBook(3, () => clock++);
    book.add('info', '[sources] synced 7 sites');
    book.add('warn', '[downloads] stuck: Dune');
    book.add('error', '[wanted movies] failed: no Sources');
    book.add('debug', 'details');
    expect(book.size).toBe(3);
    expect(book.read().map((l) => l.message)).toEqual(['stuck: Dune', 'failed: no Sources', 'details']);
    expect(book.read({ level: 'warn' }).map((l) => [l.level, l.area])).toEqual([
      ['warn', 'downloads'],
      ['error', 'wanted movies'],
    ]);
    expect(book.read({ search: 'dune' })).toHaveLength(1);
    expect(book.text({ level: 'error' })).toBe(`${new Date(START + 2).toISOString()} ERROR [wanted movies] failed: no Sources`);
  });

  it('copies console lines into the log book, secrets taken out', () => {
    const book = new LogBook();
    const restore = captureConsole(book);
    try {
      console.log('[sources] searching http://x/api?apikey=topsecret', 3);
      console.error(new Error('[downloads] boom'));
    } finally {
      restore();
    }
    expect(book.read().map((l) => [l.level, l.area, l.message.split('\n')[0]])).toEqual([
      ['info', 'sources', 'searching http://x/api?apikey=… 3'],
      ['error', null, 'Error: [downloads] boom'],
    ]);
  });

  it('shows and downloads the kept lines', async () => {
    const logs = new LogBook();
    logs.add('info', '[sources] synced');
    logs.add('error', '[downloads] qBittorrent turned down the password');
    const { app } = makeApp({ logs });
    const cookie = await setupAdmin(app);
    const res = await call(app, 'GET', '/api/system/logs?level=warn', undefined, cookie);
    expect(res.status).toBe(200);
    expect((res.body as LogsView).lines.map((l) => l.message)).toEqual(['qBittorrent turned down the password']);
    expect(res.body).toMatchObject({ kept: 2, keepMax: 5000 });
    expect((await call(app, 'GET', '/api/system/logs?level=loud', undefined, cookie)).status).toBe(400);

    const file = await app.request('/api/system/logs/download', { headers: { Cookie: cookie } });
    expect(file.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(file.headers.get('content-disposition')).toMatch(/^attachment; filename="marquee-log-\d{4}-\d\d-\d\d\.txt"$/);
    const text = await file.text();
    expect(text).toMatch(/INFO  \[sources\] synced\n.*ERROR \[downloads\] qBittorrent turned down the password\n$/);
  });
});
