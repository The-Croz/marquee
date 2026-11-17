import { describe, expect, it } from 'vitest';
import type { CompareView, ComparisonView } from '@marquee/shared';
import { schema, setSetting } from '../src/db/index.js';
import { PER_RUN } from '../src/compare/service.js';
import { FakeSites, release } from './fakes/sources.js';
import { FakeRadarr, grab, radarrRelease } from './fakes/radarr.js';
import { call, makeApp, setupAdmin } from './helpers.js';

const GB = 1024 ** 3;
const DAY = 86400_000;
const NOW = Date.parse('2026-11-17T00:00:00Z');
const FLUX = 'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX';
const REMUX = 'Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.DV.HDR.HEVC.TrueHD.7.1.Atmos-FGT';
const HD = 'Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.Atmos.H.264-FLUX';

async function setup(opts: { feed?: ReturnType<typeof release>[]; radarr?: boolean } = {}) {
  const sites = new FakeSites().feed('http://tpb.test/api', { releases: opts.feed ?? [release(FLUX, { size: 25 * GB, infoHash: 'a' }), release(HD, { size: 8 * GB, infoHash: 'b' })] });
  const radarr = new FakeRadarr();
  const t = makeApp({ clients: { torznab: sites.torznab, radarrHistory: () => radarr }, now: () => NOW });
  const cookie = await setupAdmin(t.app);
  await call(t.app, 'POST', '/api/settings/sources', { name: 'TPB', url: 'http://tpb.test/api', apiKey: 'good' }, cookie);
  if (opts.radarr !== false) {
    setSetting(t.db, 'services.radarr_url', 'http://radarr:7878');
    setSetting(t.db, 'services.radarr_api_key', 'key');
  }
  const movie = t.db
    .insert(schema.movies)
    .values({ tmdbId: 693134, imdbId: 'tt15239678', title: 'Dune: Part Two', sortTitle: 'dune part two', year: 2024, runtime: 166, profile: 'cinema', addedAt: 0, refreshedAt: 0 })
    .returning()
    .get();
  const req = (method: string, path: string, body?: unknown) => call(t.app, method, `/api/compare${path}`, body, cookie);
  return { ...t, sites, radarr, cookie, movie, req };
}

const byTitle = (v: CompareView, title: string) => v.items.find((i) => i.radarrTitle === title)!;

describe('comparison mode', () => {
  it('needs Radarr connected, and says how', async () => {
    const t = await setup({ radarr: false });
    const res = await t.req('POST', '/run', {});
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/Connect Radarr in Settings → Services/);
    expect(((await t.req('GET', '')).body as CompareView).radarrConnected).toBe(false);
  });

  it('compares each Radarr download with what Marquee would pick, with a verdict and plain summary', async () => {
    const t = await setup();
    t.radarr.history = [
      grab(1, FLUX, { date: NOW - DAY }),
      grab(2, REMUX, { date: NOW - 2 * DAY, quality: 'Remux-2160p' }),
      grab(3, 'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.H.265-OTHER', { date: NOW - 3 * DAY }),
      grab(4, HD, { date: NOW - 4 * DAY, quality: 'WEBDL-1080p' }),
      grab(5, 'Unknown.Movie.2020.1080p.WEB-DL-GRP', { tmdbId: 42, radarrMovieId: 7, movieTitle: 'Unknown Movie', date: NOW - 5 * DAY }),
    ];
    const res = await t.req('POST', '/run', {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ added: 5, compared: 5, waiting: 0 });
    // The first run looks back 30 days.
    expect(t.radarr.asked[0]).toBe(NOW - 30 * DAY);
    const v = res.body.view as CompareView;

    expect(byTitle(v, FLUX)).toMatchObject({ status: 'done', verdict: 'same', summary: 'Both picked the same copy.', mode: 'own_search', profileName: 'Cinema' });
    const remux = byTitle(v, REMUX);
    expect(remux.verdict).toBe('lower');
    expect(remux.summary).toMatch(/^Marquee picks 4K web download; Radarr took 4K Blu-ray remux\. Cinema would turn Radarr’s down: 4K Blu-ray remux isn't one of the qualities/);
    expect(remux.marqueeCopy!.title).toBe(FLUX);
    expect(remux.radarrCopy!.accepted).toBe(false);
    expect(byTitle(v, 'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.H.265-OTHER').verdict).toBe('same_quality');
    expect(byTitle(v, HD).verdict).toBe('higher');
    const missing = byTitle(v, 'Unknown.Movie.2020.1080p.WEB-DL-GRP');
    expect(missing).toMatchObject({ status: 'failed', verdict: null });
    expect(missing.summary).toMatch(/isn’t in Marquee’s library yet/);

    expect(v.counts).toEqual({ same: 1, same_quality: 1, higher: 1, lower: 1, nothing: 0 });
    expect(v.total).toBe(4);
    expect(v.agreement).toBe(50);
    expect(JSON.stringify(v)).not.toMatch(/apikey|SECRET/);
  });

  it('says when Marquee would take nothing', async () => {
    const t = await setup({ feed: [release(REMUX, { size: 70 * GB })] });
    t.radarr.history = [grab(1, REMUX, { date: NOW - DAY, quality: 'Remux-2160p' })];
    const v = (await t.req('POST', '/run', {})).body.view as CompareView;
    expect(v.items[0]).toMatchObject({ verdict: 'nothing' });
    expect(v.items[0]!.summary).toMatch(/^Marquee would take none of the copies it found\./);
  });

  it('compares only a few per run, newest first, and only brings in new downloads next time', async () => {
    const t = await setup();
    t.radarr.history = Array.from({ length: PER_RUN + 3 }, (_, i) => grab(i + 1, FLUX, { date: NOW - (i + 1) * DAY }));
    const first = (await t.req('POST', '/run', {})).body;
    expect(first).toMatchObject({ added: PER_RUN + 3, compared: PER_RUN, waiting: 3 });
    const v = first.view as CompareView;
    expect(v.items.slice(0, PER_RUN).every((i) => i.status === 'done')).toBe(true);
    expect(v.items.at(-1)!.summary).toMatch(/Waiting to be compared/);
    const second = (await t.req('POST', '/run', {})).body;
    expect(second).toMatchObject({ added: 0, compared: 3, waiting: 0 });
    expect(t.radarr.asked[1]).toBe(NOW);
  });

  it('“Compare on Radarr’s list” judges the exact copies Radarr saw', async () => {
    const t = await setup({ feed: [] });
    t.radarr.history = [grab(1, REMUX, { date: NOW - DAY, quality: 'Remux-2160p' })];
    t.radarr.lists.set(1, [radarrRelease(REMUX, { size: 70 * GB }), radarrRelease(FLUX, { size: 25 * GB }), radarrRelease('Dune.2021.2160p.WEB-DL.H.265-X', { mappedMovieId: 99 })]);
    const v = (await t.req('POST', '/run', {})).body.view as CompareView;
    expect(v.items[0]).toMatchObject({ verdict: 'nothing', mode: 'own_search' });
    const res = await t.req('POST', `/${v.items[0]!.id}/explain`, {});
    expect(res.status).toBe(200);
    expect(res.body as ComparisonView).toMatchObject({ mode: 'same_list', verdict: 'lower' });
    expect((res.body as ComparisonView).marqueeCopy!.title).toBe(FLUX);
  });

  it('reports Radarr failures in plain words', async () => {
    const t = await setup();
    t.radarr.fail = 'Radarr rejected the API key.';
    const res = await t.req('POST', '/run', {});
    expect(res.status).toBe(502);
    expect(res.body.message).toBe('Radarr rejected the API key.');
  });

  it('can be switched on and cleared, and is for admins only', async () => {
    const t = await setup();
    expect(((await t.req('PUT', '/settings', { enabled: true })).body as CompareView).enabled).toBe(true);
    t.radarr.history = [grab(1, FLUX, { date: NOW - DAY })];
    await t.req('POST', '/run', {});
    expect((await t.req('DELETE', '')).status).toBe(200);
    expect(((await t.req('GET', '')).body as CompareView).items).toEqual([]);
    expect((await call(t.app, 'GET', '/api/compare')).status).toBe(401);
    expect((await t.req('GET', '/999')).status).toBe(404);
  });
});
