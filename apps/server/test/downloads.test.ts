import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CopiesResult, SendResult } from '@marquee/shared';
import { schema } from '../src/db/index.js';
import { QbitClient, QbitError } from '../src/downloads/qbittorrent.js';
import { TorrentFetchError, fetchTorrent, magnetInfoHash, torrentInfoHash } from '../src/downloads/torrent.js';
import { FakeQbit, fakeFetchTorrent, qbitTorrent } from './fakes/qbittorrent.js';
import { FakeSites, release } from './fakes/sources.js';
import { call, makeApp, setupAdmin } from './helpers.js';

const GB = 1024 ** 3;
const enc = (s: string) => new TextEncoder().encode(s);

/** A tiny but real .torrent: d8:announce…4:infod…ee */
const INFO = 'd6:lengthi1024e4:name8:test.mkv12:piece lengthi16384e6:pieces20:aaaaaaaaaaaaaaaaaaaae';
const TORRENT = enc(`d8:announce18:http://tracker/ann13:creation datei1700000000e4:info${INFO}e`);
const INFO_HASH = createHash('sha1').update(INFO).digest('hex');

describe('torrents and magnets', () => {
  it('finds the info-hash in a .torrent, exactly over the info dictionary', () => {
    expect(torrentInfoHash(TORRENT)).toBe(INFO_HASH);
    expect(torrentInfoHash(enc('<html>not a torrent</html>'))).toBeNull();
    expect(torrentInfoHash(enc('d8:announce3:abce'))).toBeNull();
    expect(torrentInfoHash(enc('d4:infod4:name'))).toBeNull();
  });

  it('reads magnet hashes in hex and base32', () => {
    expect(magnetInfoHash('magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01&dn=x')).toBe('abcdef0123456789abcdef0123456789abcdef01');
    // Base32 of the same 20 bytes.
    const b32 = 'VPG66AJDIVTYTK6N54ASGRLHRGV433YB';
    expect(magnetInfoHash(`magnet:?dn=x&xt=urn:btih:${b32}`)).toBe('abcdef0123456789abcdef0123456789abcdef01');
    expect(magnetInfoHash('magnet:?dn=nothing')).toBeNull();
  });

  it('fetches a .torrent, follows redirects, and takes a redirect to a magnet', async () => {
    const asked: string[] = [];
    const f = (async (u: string | URL) => {
      asked.push(String(u));
      if (String(u).includes('/one')) return new Response(null, { status: 302, headers: { location: '/two' } });
      if (String(u).includes('/two')) return new Response(TORRENT.slice());
      return new Response(null, { status: 301, headers: { location: 'magnet:?xt=urn:btih:abcdef0123456789abcdef0123456789abcdef01' } });
    }) as typeof fetch;
    const file = await fetchTorrent('http://p/one?apikey=K', f);
    expect(file.infoHash).toBe(INFO_HASH);
    expect(file.payload.kind).toBe('file');
    expect(asked).toEqual(['http://p/one?apikey=K', 'http://p/two']);
    const mag = await fetchTorrent('http://p/magnet?apikey=K', f);
    expect(mag).toMatchObject({ infoHash: 'abcdef0123456789abcdef0123456789abcdef01', payload: { kind: 'magnet' } });
  });

  it('explains failures without showing the key', async () => {
    const answer = (res: Response | Error) => (async () => (res instanceof Error ? Promise.reject(res) : res)) as unknown as typeof fetch;
    const fail = (r: Response | Error) => fetchTorrent('http://p/x?apikey=SECRET', answer(r)).then(() => new Error('no error'), (e: Error) => e);
    for (const [r, text] of [
      [new Response('', { status: 401 }), /turned down the download/],
      [new Response('', { status: 429 }), /slow down/],
      [new Response('', { status: 500 }), /answered 500/],
      [new Response('<html>'), /isn't a torrent/],
      [Object.assign(new TypeError('x'), { cause: { code: 'ECONNRESET' } }), /ECONNRESET/],
    ] as const) {
      const e = await fail(r);
      expect(e).toBeInstanceOf(TorrentFetchError);
      expect(e.message).toMatch(text);
      expect(e.message).not.toContain('SECRET');
    }
  });
});

describe('qBittorrent client: adding', () => {
  it('lists by hash, makes the category only when missing, and adds with category and tags', async () => {
    const seen: { path: string; body: unknown }[] = [];
    const cats: Record<string, { name: string }> = { radarr: { name: 'radarr' } };
    const f = (async (input: string | URL, init: RequestInit = {}) => {
      const u = new URL(String(input));
      seen.push({ path: u.pathname + u.search, body: init.body });
      const p = u.pathname.replace('/api/v2', '');
      if (p === '/torrents/info') return Response.json([{ hash: 'ABC', name: 'x', category: 'radarr', state: 'uploading', progress: 1, size: 5, save_path: '/data/torrents/movies' }]);
      if (p === '/torrents/categories') return Response.json(cats);
      if (p === '/torrents/createCategory') {
        const name = (init.body as URLSearchParams).get('category')!;
        cats[name] = { name };
        return new Response('');
      }
      if (p === '/torrents/add') return new Response('Ok.');
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const q = new QbitClient('http://q:8080', 'admin', 'pw', f);
    expect(await q.torrents(['ABC'])).toEqual([{ hash: 'abc', name: 'x', category: 'radarr', state: 'uploading', progress: 1, size: 5, savePath: '/data/torrents/movies', downloadSpeed: 0, eta: 8640000, seedsConnected: 0, seedsKnown: 0, contentPath: '/data/torrents/movies', ratio: 0, seedingSeconds: 0, uploadSpeed: 0, peersConnected: 0, peersKnown: 0, downloaded: 0, uploaded: 0, addedOn: null, completedOn: null, tracker: '', tags: [], activeSeconds: 0 }]);
    expect(seen[0]!.path).toBe('/api/v2/torrents/info?hashes=abc');
    await q.ensureCategory('marquee');
    await q.ensureCategory('marquee');
    expect(seen.filter((s) => s.path.includes('createCategory'))).toHaveLength(1);
    await q.add({ kind: 'file', bytes: TORRENT, name: 'a.torrent' }, { category: 'marquee', tags: ['marquee'] });
    const form = seen.at(-1)!.body as FormData;
    expect(form.get('category')).toBe('marquee');
    expect(form.get('tags')).toBe('marquee');
    expect(form.get('torrents')).toBeInstanceOf(Blob);
    await q.add({ kind: 'magnet', uri: 'magnet:?xt=urn:btih:abc' }, { category: 'marquee', tags: [] });
    expect((seen.at(-1)!.body as FormData).get('urls')).toBe('magnet:?xt=urn:btih:abc');
  });

  it('says so when qBittorrent turns a torrent down', async () => {
    const f = (async () => new Response('Fails.')) as unknown as typeof fetch;
    const e = await new QbitClient('http://q:8080', 'a', 'b', f).add({ kind: 'magnet', uri: 'magnet:?' }, { category: 'm', tags: [] }).catch((x) => x);
    expect(e).toBeInstanceOf(QbitError);
    expect(e.message).toMatch(/turned the torrent down/);
  });
});

// ---------------------------------------------------------------- Download this

const BEST = 'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX';
const HD = 'Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.H.264-FLUX';
const REMUX = 'Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.HEVC.TrueHD-FGT';

async function setup(opts: { connect?: boolean; file?: string } = {}) {
  const sites = new FakeSites();
  sites.feed('http://tpb.test/api', { releases: [release(BEST, { size: 25 * GB }), release(HD, { size: 10 * GB }), release(REMUX, { size: 70 * GB })] });
  const qbit = new FakeQbit();
  const fetched: string[] = [];
  const t = makeApp({ clients: { torznab: sites.torznab, qbittorrent: (u, n, p) => qbit.as(u, n, p), fetchTorrent: fakeFetchTorrent(fetched) } });
  const cookie = await setupAdmin(t.app);
  await call(t.app, 'POST', '/api/settings/sources', { name: 'TPB', url: 'http://tpb.test/api', apiKey: 'good' }, cookie);
  if (opts.connect !== false) await call(t.app, 'PUT', '/api/settings/downloader', { url: qbit.url, username: 'admin', password: 'adminadmin' }, cookie);
  const movie = t.db
    .insert(schema.movies)
    .values({ tmdbId: 693134, imdbId: 'tt15239678', title: 'Dune: Part Two', sortTitle: 'dune part two', year: 2024, runtime: 166, profile: 'cinema', addedAt: 0, refreshedAt: 0 })
    .returning()
    .get();
  if (opts.file) t.db.insert(schema.mediaFiles).values({ path: `/data/media/movies/Dune Part Two (2024)/${opts.file}`, movieId: movie.id, size: GB, mtime: 0, addedAt: 0, seenAt: 0 }).run();
  const search = async () => (await call(t.app, 'POST', `/api/movies/${movie.id}/search`, {}, cookie)).body as CopiesResult;
  const send = (body: object) => call(t.app, 'POST', '/api/downloads', body, cookie);
  return { ...t, qbit, fetched, cookie, movie, search, send };
}

describe('Download this', () => {
  it('fetches the torrent on the server and adds it under Marquee’s category', async () => {
    const t = await setup();
    const s = await t.search();
    expect(s.searchId).toBeTruthy();
    expect(s.yours).toBeNull();
    const best = s.copies[0]!;
    expect(best).toMatchObject({ title: BEST, id: '0', vsYours: null });
    const res = await t.send({ searchId: s.searchId, copyId: best.id });
    expect(res.status).toBe(201);
    const body = res.body as SendResult;
    expect(body.message).toMatch(/Sent to qBittorrent.*“marquee”/);
    expect(body.download).toMatchObject({ kind: 'movie', movieId: t.movie.id, title: BEST, state: 'sent', adopted: false, sourceName: 'TPB', quality: 'WEBDL-2160p' });
    expect(t.fetched[0]).toContain('apikey=');
    expect(t.qbit.added).toHaveLength(1);
    expect(t.qbit.added[0]).toMatchObject({ category: 'marquee', tags: ['marquee'], hash: body.download.infoHash });
    expect(t.qbit.state.categories).toHaveProperty('marquee');
    expect(JSON.stringify(body)).not.toMatch(/apikey|SECRET/);
    const list = await call(t.app, 'GET', '/api/downloads', undefined, t.cookie);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ titleName: 'Dune: Part Two (2024)', titleLink: `/movies/${t.movie.id}`, canControl: true });
  });

  it('asks first before sending a copy Marquee would turn down', async () => {
    const t = await setup();
    const s = await t.search();
    const remux = s.copies.find((c) => c.title === REMUX)!;
    const first = await t.send({ searchId: s.searchId, copyId: remux.id });
    expect(first.status).toBe(409);
    expect(first.body).toMatchObject({ error: 'needs_confirm' });
    expect(first.body.message).toMatch(/wouldn’t pick this one: .*Download it anyway\?/);
    expect(t.qbit.added).toHaveLength(0);
    expect((await t.send({ searchId: s.searchId, copyId: remux.id, anyway: true })).status).toBe(201);
  });

  it('compares with the file you have, and asks before a copy that isn’t better', async () => {
    const t = await setup({ file: 'Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.H.264-FLUX.mkv' });
    const s = await t.search();
    expect(s.yours).toMatchObject({ qualityLabel: '1080p web download' });
    const best = s.copies.find((c) => c.title === BEST)!;
    const hd = s.copies.find((c) => c.title === HD)!;
    expect(best.vsYours).toEqual({ better: true, message: 'Better than your 1080p web download.' });
    expect(hd.vsYours?.better).toBe(false);
    const res = await t.send({ searchId: s.searchId, copyId: hd.id });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/About the same as your 1080p web download\. Download it anyway\?/);
    expect((await t.send({ searchId: s.searchId, copyId: best.id })).status).toBe(201);
  });

  it('adopts a torrent qBittorrent already has instead of adding it twice', async () => {
    const t = await setup();
    const s = await t.search();
    const hash = (await fakeFetchTorrent()(`http://prowlarr:9696/1/download?apikey=SECRET&file=${encodeURIComponent(BEST)}`)).infoHash;
    t.qbit.list.push(qbitTorrent(hash, { name: BEST, category: 'radarr', progress: 0.4, size: 25 * GB, savePath: '/data/torrents/movies' }));
    const res = await t.send({ searchId: s.searchId, copyId: '0' });
    expect(res.status).toBe(201);
    expect(res.body.message).toMatch(/already had this copy \(in the “radarr” category\)/);
    expect(res.body.download).toMatchObject({ adopted: true, state: 'downloading', progress: 0.4 });
    expect(t.qbit.added).toHaveLength(0);
  });

  it('won’t send a second download for a movie that has one on the way', async () => {
    const t = await setup();
    const s = await t.search();
    await t.send({ searchId: s.searchId, copyId: '0' });
    const again = await t.send({ searchId: s.searchId, copyId: s.copies.find((c) => c.title === HD)!.id });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: 'already_downloading' });
    expect(again.body.message).toContain(BEST);
  });

  it('says what to do when something is missing or fails', async () => {
    const t = await setup({ connect: false });
    const s = await t.search();
    expect((await t.send({ searchId: s.searchId, copyId: '0' })).body).toMatchObject({ error: 'no_downloader', message: expect.stringMatching(/Settings → Downloader/) });
    expect((await t.send({ searchId: 'nope', copyId: '0' })).body).toMatchObject({ error: 'search_expired' });
    expect((await t.send({ searchId: s.searchId, copyId: '99' })).body).toMatchObject({ error: 'no_such_copy' });
    await call(t.app, 'PUT', '/api/settings/downloader', { url: t.qbit.url, username: 'admin', password: 'adminadmin' }, t.cookie);
    t.qbit.fail = new QbitError('unreachable', "Couldn't reach qBittorrent at http://qbittorrent:8080 (ECONNREFUSED).");
    const down = await t.send({ searchId: s.searchId, copyId: '0' });
    expect(down.status).toBe(502);
    expect(down.body.message).toMatch(/^Can't reach it: /);
    expect(t.db.select().from(schema.downloads).all()).toHaveLength(0);
  });

  it('is for admins only', async () => {
    const t = await setup();
    expect((await call(t.app, 'POST', '/api/downloads', { searchId: 'x', copyId: '0' })).status).toBe(401);
  });
});

describe('better than the file you have?', async () => {
  const { ProfileService } = await import('../src/releases/profiles.js');
  const { decide } = await import('../src/releases/decide.js');
  const { compareToYours, judgeFile, worstFile } = await import('../src/releases/upgrade.js');
  const t = makeApp();
  const base = new ProfileService(t.db, Date.now).forTitle('movie', 'cinema');
  const wanted = { kind: 'movie' as const, title: 'Dune: Part Two', year: 2024, runtime: null };
  const copy = (name: string) => decide(wanted, [{ ...release(name), sourceId: 1, sourceName: 'S', sourcePriority: 1 }], base)[0]!;

  it('judges a library file by its name', () => {
    const f = judgeFile(wanted, '/data/media/movies/Dune Part Two (2024)/Dune Part Two (2024) WEBDL-1080p.mkv', base);
    expect(f).toMatchObject({ name: 'Dune Part Two (2024) WEBDL-1080p.mkv', qualityLabel: '1080p web download' });
    const worse = judgeFile(wanted, 'Dune.Part.Two.2024.720p.WEBRip.x264.mkv', base);
    expect(worstFile([f, worse])).toBe(worse);
    expect(worstFile([])).toBeNull();
  });

  it('respects "keep looking for better" and "good enough"', () => {
    const yours1080 = judgeFile(wanted, `${HD}.mkv`, base);
    const yours4k = judgeFile(wanted, `${BEST}.mkv`, base);
    expect(compareToYours(copy(BEST), null, base)).toBeNull();
    expect(compareToYours(copy(BEST), yours1080, base)?.better).toBe(true);
    expect(compareToYours(copy(HD), yours4k, base)).toEqual({ better: false, message: 'Lower quality than your 4K web download.' });
    expect(compareToYours(copy(BEST), yours1080, { ...base, upgrades: false })?.message).toMatch(/doesn't look for better copies/);
    const cutoffAt1080 = { ...base, cutoff: base.tiers.find((x) => x.qualities.includes('WEBDL-1080p'))!.name, cutoffScore: -100000 };
    expect(compareToYours(copy(BEST), yours1080, cutoffAt1080)?.message).toMatch(/already good enough/);
  });
});

describe('comparing with your file', () => {
  it('only compares copies Marquee would take', async () => {
    const t = await setup({ file: 'Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.H.264-FLUX.mkv' });
    const s = await t.search();
    expect(s.copies.find((c) => c.title === REMUX)!.vsYours).toBeNull();
  });
});
