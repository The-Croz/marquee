import { describe, expect, it } from 'vitest';
import type { CopiesResult, ProfileDetail, ProfilesView } from '@marquee/shared';
import { schema } from '../src/db/index.js';
import { FakeSites, release } from './fakes/sources.js';
import { call, makeApp, setupAdmin } from './helpers.js';

const GB = 1024 ** 3;

async function setup(feeds: Record<string, ReturnType<typeof release>[]>) {
  const sites = new FakeSites();
  for (const url of Object.keys(feeds)) sites.feed(url, { releases: feeds[url] });
  const t = makeApp({ clients: { torznab: sites.torznab } });
  const cookie = await setupAdmin(t.app);
  for (const url of Object.keys(feeds)) {
    const res = await call(t.app, 'POST', '/api/settings/sources', { name: new URL(url).host, url, apiKey: 'good' }, cookie);
    expect(res.status).toBe(201);
  }
  const movie = t.db
    .insert(schema.movies)
    .values({ tmdbId: 693134, imdbId: 'tt15239678', title: 'Dune: Part Two', sortTitle: 'dune part two', year: 2024, runtime: 166, profile: 'cinema', addedAt: 0, refreshedAt: 0 })
    .returning()
    .get();
  const show = t.db.insert(schema.series).values({ tmdbId: 136315, tvdbId: 403245, title: 'The Bear', sortTitle: 'bear', year: 2022, profile: 'cinema', addedAt: 0, refreshedAt: 0 }).returning().get();
  return { ...t, sites, cookie, movie, show };
}

describe('Copies we found', () => {
  it('searches every Source, merges duplicates, and ranks with reasons, without leaking download links', async () => {
    const best = 'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX';
    const t = await setup({
      'http://tpb.test/api': [release(best, { size: 25 * GB, infoHash: 'AAA', seeders: 90 }), release('Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.H.264-FLUX', { size: 10 * GB })],
      'http://knaben.test/api': [release(best, { size: 25 * GB, infoHash: 'aaa', seeders: 40 }), release('Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.HEVC.TrueHD-FGT', { size: 70 * GB })],
    });
    const res = await call(t.app, 'POST', `/api/movies/${t.movie.id}/search`, {}, t.cookie);
    expect(res.status).toBe(200);
    const body = res.body as CopiesResult;
    expect(body.profile.name).toBe('4K Quality');
    expect(body.sources.map((s) => s.status)).toEqual(['searched', 'searched']);
    expect(body.copies).toHaveLength(3);
    expect(body.copies[0]).toMatchObject({ title: best, accepted: true, seeders: 90, qualityLabel: '4K web download' });
    expect(body.copies[0]!.sources).toHaveLength(2);
    expect(body.copies[0]!.details).toMatchObject({ resolution: 2160, group: 'FLUX', atmos: true });
    const remux = body.copies.find((c) => c.title.includes('REMUX'))!;
    expect(remux.accepted).toBe(false);
    expect(remux.rejections[0]!.message).toMatch(/isn't one of the qualities 4K Quality takes/);
    expect(JSON.stringify(body)).not.toMatch(/apikey|SECRET|download\?/);
    // Searched by ID.
    expect(t.sites.feeds.get('http://tpb.test/api')!.searches!.at(-1)).toMatchObject({ kind: 'movie', tmdbId: 693134 });
  });

  it('uses the title’s own profile', async () => {
    const t = await setup({ 'http://tpb.test/api': [release('Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.H.265-FLUX', { size: 25 * GB })] });
    await call(t.app, 'PUT', `/api/movies/${t.movie.id}/profile`, { profile: 'everyday-hd' }, t.cookie);
    const body = (await call(t.app, 'POST', `/api/movies/${t.movie.id}/search`, {}, t.cookie)).body as CopiesResult;
    expect(body.profile.name).toBe('Everyday HD');
    expect(body.copies[0]!.accepted).toBe(false);
  });

  it('searches a show by season and episode', async () => {
    const t = await setup({ 'http://eztv.test/api': [release('The.Bear.S03E02.1080p.WEB.h264-ETHEL', { size: 1.5 * GB }), release('The.Bear.S03E03.1080p.WEB.h264-ETHEL')] });
    const res = await call(t.app, 'POST', `/api/shows/${t.show.id}/search`, { season: 3, episode: 2 }, t.cookie);
    const body = res.body as CopiesResult;
    expect(body.copies.map((c) => c.accepted)).toEqual([true, false]);
    expect(t.sites.feeds.get('http://eztv.test/api')!.searches!.at(-1)).toMatchObject({ kind: 'tv', tvdbId: 403245, season: 3, episode: 2 });
    expect((await call(t.app, 'POST', `/api/shows/${t.show.id}/search`, {}, t.cookie)).status).toBe(400);
  });

  it('says what to do when there are no Sources, and is admin only', async () => {
    const t = await setup({});
    const res = await call(t.app, 'POST', `/api/movies/${t.movie.id}/search`, {}, t.cookie);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/Add some in Settings → Sources/);
    expect((await call(t.app, 'POST', `/api/movies/${t.movie.id}/search`, {})).status).toBe(401);
    expect((await call(t.app, 'POST', '/api/movies/999/search', {}, t.cookie)).status).toBe(404);
  });
});

describe('new profile from a TRaSH profile', () => {
  it('lists TRaSH’s profiles and starts a new one from any of them', async () => {
    const t = makeApp();
    const cookie = await setupAdmin(t.app);
    const view = (await call(t.app, 'GET', '/api/settings/profiles', undefined, cookie)).body as ProfilesView;
    expect(view.starters.filter((p) => p.database === 'trash').map((p) => `${p.kind}:${p.name}`).sort()).toEqual(['movie:HD Bluray + WEB', 'movie:UHD Bluray + WEB', 'tv:WEB-1080p', 'tv:WEB-2160p']);
    expect(view.starters.filter((p) => p.database === 'dictionarry' && p.kind === 'movie').map((p) => p.name)).toContain('2160p Efficient');
    const res = await call(t.app, 'POST', '/api/settings/profiles', { kind: 'tv', name: 'Plain 4K', fromTrash: 'WEB-2160p' }, cookie);
    expect(res.status).toBe(201);
    const p = res.body as ProfileDetail;
    expect(p).toMatchObject({ cutoff: 'WEB 2160p', preset: null, database: 'trash', preferRepacks: true });
    expect(p.tiers.filter((x) => x.allowed).map((x) => x.name)).toEqual(['WEB 2160p']);
    expect((await call(t.app, 'POST', '/api/settings/profiles', { kind: 'movie', name: 'X', fromTrash: 'WEB-2160p' }, cookie)).body.message).toMatch(/no movie profile called/);
  });
});
