import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { call, makeApp, setupAdmin } from './helpers.js';
import { FakeSites, release, site } from './fakes/sources.js';
import { TorznabError } from '../src/sources/torznab.js';
import { backoff } from '../src/sources/service.js';
import { schema } from '../src/db/index.js';

const PROWLARR = 'http://prowlarr:9696';

/** An app with fake sites and a clock we can move. */
async function setup(configure: (s: FakeSites) => void = () => {}) {
  const sites = new FakeSites();
  configure(sites);
  let time = Date.parse('2026-11-16T12:00:00Z');
  const clock = {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
  const t = makeApp({ clients: { torznab: sites.torznab, prowlarr: sites.prowlarr }, now: clock.now });
  const cookie = await setupAdmin(t.app);
  const req = (method: string, path: string, body?: unknown) => call(t.app, method, `/api/settings/sources${path === "/" ? "" : path}`, body, cookie);
  return { ...t, sites, clock, cookie, req };
}

describe('adding a Source by hand', () => {
  it('saves it and checks it straight away', async () => {
    const { req } = await setup((s) => s.feed('http://jackett:9117/api/v2.0/indexers/yts/results/torznab', { releases: [release('A'), release('B')] }));
    const res = await req('POST', '/', { name: 'YTS', url: 'http://jackett:9117/api/v2.0/indexers/yts/results/torznab/', apiKey: 'good' });
    expect(res.status).toBe(201);
    expect(res.body.check).toEqual({ ok: true, state: 'working', message: expect.stringContaining('2 recent copies') });
    expect(res.body.check.message).toContain('Searches by TMDB, IMDb and TVDB ID');
    expect(res.body.source).toMatchObject({ name: 'YTS', url: 'http://jackett:9117/api/v2.0/indexers/yts/results/torznab', hasKey: true, state: 'working', stateLabel: 'Working' });
  });

  it('never sends the key back', async () => {
    const { req } = await setup((s) => s.feed('http://jackett:9117/feed', {}));
    await req('POST', '/', { name: 'X', url: 'http://jackett:9117/feed', apiKey: 'good' });
    const list = await req('GET', '/');
    expect(JSON.stringify(list.body)).not.toContain('good');
    expect(list.body.sources[0].hasKey).toBe(true);
  });

  it('keeps a failing Source and says what to do', async () => {
    const { req } = await setup((s) => s.feed('http://jackett:9117/feed', {}));
    const res = await req('POST', '/', { name: 'X', url: 'http://jackett:9117/feed', apiKey: 'wrong' });
    expect(res.status).toBe(201);
    expect(res.body.check).toMatchObject({ ok: false, state: 'key_refused', message: 'Key turned down. The API key was not accepted.' });
    expect(res.body.source.fix).toContain('Copy the API key again');
  });

  it('turns down an address that is not a web address', async () => {
    const { req } = await setup();
    const res = await req('POST', '/', { name: 'X', url: 'prowlarr:9696' });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('http://');
  });

  it('is admin only', async () => {
    const { app } = await setup();
    expect((await call(app, 'GET', '/api/settings/sources')).status).toBe(401);
  });
});

describe('changing and removing Sources', () => {
  it('pauses and resumes', async () => {
    const { req } = await setup((s) => s.feed('http://j/feed', {}));
    const { body } = await req('POST', '/', { name: 'X', url: 'http://j/feed', apiKey: 'good' });
    await req('PUT', `/${body.source.id}`, { enabled: false });
    expect((await req('GET', '/')).body.sources[0]).toMatchObject({ state: 'paused', stateLabel: 'Paused', fix: 'Press Resume to search it again.' });
    await req('PUT', `/${body.source.id}`, { enabled: true });
    expect((await req('GET', '/')).body.sources[0].state).toBe('working');
  });

  it('keeps the saved key when the key field is left blank', async () => {
    const { req, db } = await setup((s) => s.feed('http://j/feed', {}));
    const { body } = await req('POST', '/', { name: 'X', url: 'http://j/feed', apiKey: 'good' });
    await req('PUT', `/${body.source.id}`, { name: 'Renamed', apiKey: '' });
    expect(db.select().from(schema.sources).get()).toMatchObject({ name: 'Renamed', apiKey: 'good' });
  });

  it('checks limits in plain words', async () => {
    const { req } = await setup((s) => s.feed('http://j/feed', {}));
    const { body } = await req('POST', '/', { name: 'X', url: 'http://j/feed', apiKey: 'good' });
    const res = await req('PUT', `/${body.source.id}`, { priority: 99 });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Priority is 1 to 50.');
  });

  it('removes a Source added by hand', async () => {
    const { req } = await setup((s) => s.feed('http://j/feed', {}));
    const { body } = await req('POST', '/', { name: 'X', url: 'http://j/feed', apiKey: 'good' });
    expect((await req('DELETE', `/${body.source.id}`)).status).toBe(200);
    expect((await req('GET', '/')).body.sources).toEqual([]);
  });
});

describe('Prowlarr', () => {
  const sites = (s: FakeSites) => {
    s.prowlarrSites = [
      site(1, 'YTS', { categories: [2000, 2040] }),
      site(2, 'EZTV', { categories: [5000, 5040] }),
      site(3, 'IPTorrents', { privacy: 'private', priority: 10 }),
      site(4, 'MyAnonamouse', { privacy: 'private', categories: [7000, 3030] }),
      site(5, 'Old site', { enabled: false }),
      site(6, 'A Usenet site', { protocol: 'usenet' }),
    ];
    for (const id of [1, 2, 3]) s.feed(`${PROWLARR}/${id}/api`, {});
  };

  it('tests the connection and counts usable sites', async () => {
    const { req } = await setup(sites);
    expect((await req('POST', '/prowlarr/test', { url: PROWLARR, apiKey: 'prowlarr-key' })).body).toEqual({
      ok: true,
      message: 'Connected to Prowlarr 2.0.5. 6 sites, 3 with movies or TV.',
    });
    expect((await req('POST', '/prowlarr/test', { url: PROWLARR, apiKey: 'nope' })).body.message).toContain('turned down the API key');
  });

  it('links and brings in each usable site as a Source, saying why others were left out', async () => {
    const { req } = await setup(sites);
    const res = await req('PUT', '/prowlarr', { url: `${PROWLARR}/`, apiKey: 'prowlarr-key' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, added: ['YTS', 'EZTV', 'IPTorrents'], message: 'Synced with Prowlarr: 3 added, 3 left out.' });
    expect(res.body.skipped).toEqual([
      { name: 'MyAnonamouse', reason: 'Has no movies or TV.' },
      { name: 'Old site', reason: 'Turned off in Prowlarr.' },
      { name: 'A Usenet site', reason: 'Usenet. Marquee only uses torrents.' },
    ]);

    const list = (await req('GET', '/')).body;
    expect(list.prowlarr).toMatchObject({ url: PROWLARR, linked: true, syncMessage: res.body.message });
    const byName = Object.fromEntries(list.sources.map((s: any) => [s.name, s]));
    expect(byName.YTS).toMatchObject({ url: `${PROWLARR}/1/api`, fromProwlarr: true, forMovies: true, forTv: false, private: false, dailyLimit: 0 });
    expect(byName.EZTV).toMatchObject({ forMovies: false, forTv: true });
    expect(byName.IPTorrents).toMatchObject({ private: true, priority: 10, dailyLimit: 100, minGapMs: 5000 });
    expect(JSON.stringify(list)).not.toContain('prowlarr-key');
  });

  it('refuses to link when Prowlarr turns the key down', async () => {
    const { req } = await setup(sites);
    const res = await req('PUT', '/prowlarr', { url: PROWLARR, apiKey: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('turned down the API key');
  });

  it('syncs again: keeps your changes, adds new sites, removes deleted ones', async () => {
    const { req, sites: s } = await setup(sites);
    await req('PUT', '/prowlarr', { url: PROWLARR, apiKey: 'prowlarr-key' });
    const yts = (await req('GET', '/')).body.sources.find((x: any) => x.name === 'YTS');
    await req('PUT', `/${yts.id}`, { name: 'YTS (movies)', priority: 5, enabled: false, dailyLimit: 20 });

    s.prowlarrSites = s.prowlarrSites.filter((x) => x.name !== 'EZTV').concat(site(7, 'Knaben'));
    const res = await req('POST', '/prowlarr/sync', {});
    expect(res.body).toMatchObject({ added: ['Knaben'], removed: ['EZTV'], updated: ['YTS (movies)', 'IPTorrents'] });
    expect((await req('GET', '/')).body.sources.find((x: any) => x.id === yts.id)).toMatchObject({ name: 'YTS (movies)', priority: 5, enabled: false, dailyLimit: 20 });
  });

  it("won't change the address of, or remove, a Source that comes from Prowlarr", async () => {
    const { req } = await setup(sites);
    await req('PUT', '/prowlarr', { url: PROWLARR, apiKey: 'prowlarr-key' });
    const id = (await req('GET', '/')).body.sources[0].id;
    expect((await req('PUT', `/${id}`, { url: 'http://elsewhere/api' })).status).toBe(409);
    const del = await req('DELETE', `/${id}`);
    expect(del.status).toBe(409);
    expect(del.body.message).toContain('Pause it here');
  });

  it('unlinks, keeping or removing its Sources', async () => {
    const { req } = await setup(sites);
    await req('PUT', '/prowlarr', { url: PROWLARR, apiKey: 'prowlarr-key' });
    await req('POST', '/prowlarr/unlink', { removeSources: false });
    let list = (await req('GET', '/')).body;
    expect(list.prowlarr.linked).toBe(false);
    expect(list.sources.every((s: any) => !s.fromProwlarr)).toBe(true);

    await req('PUT', '/prowlarr', { url: PROWLARR, apiKey: 'prowlarr-key' });
    await req('POST', '/prowlarr/unlink', { removeSources: true });
    list = (await req('GET', '/')).body;
    expect(list.sources.map((s: any) => s.name).sort()).toEqual(['EZTV', 'IPTorrents', 'YTS']); // the kept copies from the first unlink
  });
});

describe('searching every Source', () => {
  const dune = { kind: 'movie' as const, title: 'Dune: Part Two', year: 2024, tmdbId: 693134 };

  async function three(configure: (s: FakeSites) => void = () => {}) {
    const t = await setup((s) => {
      s.feed('http://a/api', { releases: [release('Dune.Part.Two.2024.2160p-A', { seeders: 10 }), release('Dune.Part.Two.2024.720p-DEAD', { seeders: 0 })] });
      s.feed('http://b/api', { releases: [release('Dune.Part.Two.2024.1080p-B')] });
      s.feed('http://c/api', { fail: new TorznabError('unreachable', "Couldn't reach c (ECONNREFUSED).") });
      configure(s);
    });
    for (const [name, url] of [
      ['A', 'http://a/api'],
      ['B', 'http://b/api'],
      ['C', 'http://c/api'],
    ]) {
      t.sources.add({ name: name!, url: url!, apiKey: 'good' });
    }
    return t;
  }

  it('collects copies from all Sources, and one failure does not stop the rest', async () => {
    const { sources } = await three();
    const out = await sources.search(dune);
    expect(out.releases.map((r) => [r.title, r.sourceName])).toEqual([
      ['Dune.Part.Two.2024.2160p-A', 'A'],
      ['Dune.Part.Two.2024.1080p-B', 'B'],
    ]);
    expect(out.sources.map((s) => [s.name, s.status])).toEqual([
      ['A', 'searched'],
      ['B', 'searched'],
      ['C', 'failed'],
    ]);
    expect(out.sources[2]!.message).toBe("Can't reach it. Couldn't reach c (ECONNREFUSED).");
  });

  it('drops copies nobody is sharing', async () => {
    const { sources } = await three();
    expect((await sources.search(dune)).releases.some((r) => r.title.includes('DEAD'))).toBe(false);
  });

  it('never returns download links with keys in the outcome messages', async () => {
    const { sources } = await three();
    const out = await sources.search(dune);
    expect(JSON.stringify(out.sources)).not.toContain('apikey=');
  });

  it('waits after a failure, doubling each time, then tries again by itself', async () => {
    const { sources, clock, req } = await three();
    await sources.search(dune);
    let c = (await req('GET', '/')).body.sources.find((s: any) => s.name === 'C');
    expect(c).toMatchObject({ state: 'unreachable', stateLabel: "Can't reach it", retryAt: clock.now() + 60_000 });

    let out = await sources.search(dune);
    expect(out.sources[2]).toMatchObject({ status: 'skipped', message: "Can't reach it. Trying again in 1 minute." });

    clock.advance(61_000);
    out = await sources.search(dune);
    expect(out.sources[2]!.status).toBe('failed');
    c = (await req('GET', '/')).body.sources.find((s: any) => s.name === 'C');
    expect(c.retryAt).toBe(clock.now() + 120_000);
  });

  it('"Try now" checks at once and clears the wait when it works', async () => {
    const { sources, sites, req } = await three();
    await sources.search(dune);
    sites.feeds.get('http://c/api')!.fail = undefined;
    const c = (await req('GET', '/')).body.sources.find((s: any) => s.name === 'C');
    expect((await req('POST', `/${c.id}/check`, {})).body.ok).toBe(true);
    expect((await sources.search(dune)).sources[2]!.status).toBe('searched');
  });

  it('honours the wait a site asks for', async () => {
    const { sources, sites, req, clock } = await three((s) => {
      s.feed('http://c/api', { fail: new TorznabError('slowed_down', 'The site asked us to slow down.', 600) });
    });
    await sources.search(dune);
    const c = (await req('GET', '/')).body.sources.find((s: any) => s.name === 'C');
    expect(c).toMatchObject({ state: 'slowed_down', retryAt: clock.now() + 600_000 });
    void sites;
  });

  it('stops at the daily limit', async () => {
    const { sources, db } = await three();
    const a = db.select().from(schema.sources).where(eq(schema.sources.name, 'A')).get()!;
    sources.update(a.id, { dailyLimit: 2 });
    await sources.search(dune);
    await sources.search(dune);
    const out = await sources.search(dune);
    expect(out.sources[0]).toMatchObject({ name: 'A', status: 'skipped', message: 'Reached its limit of 2 searches a day.' });
  });

  it('only asks Sources used for that kind of title', async () => {
    const { sources, sites, db } = await three();
    const b = db.select().from(schema.sources).where(eq(schema.sources.name, 'B')).get()!;
    sources.update(b.id, { forMovies: false });
    const out = await sources.search(dune);
    expect(out.sources[1]).toMatchObject({ status: 'skipped', message: 'Not used for movies.' });
    expect(sites.feeds.get('http://b/api')!.searches).toEqual([]);
  });

  it('records each call for the health numbers', async () => {
    const { sources, req } = await three();
    await sources.search(dune);
    const a = (await req('GET', '/')).body.sources.find((s: any) => s.name === 'A');
    expect(a.week).toMatchObject({ calls: 1, failures: 0, searchesToday: 1 });
    const c = (await req('GET', '/')).body.sources.find((s: any) => s.name === 'C');
    expect(c.week).toMatchObject({ calls: 1, failures: 1 });
  });
});

describe('backoff', () => {
  it('starts at 1 minute, doubles, and stops at 6 hours', () => {
    expect([1, 2, 3, 4].map(backoff)).toEqual([60_000, 120_000, 240_000, 480_000]);
    expect(backoff(30)).toBe(6 * 60 * 60_000);
  });
});
