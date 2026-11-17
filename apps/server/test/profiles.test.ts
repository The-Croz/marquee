import { describe, expect, it } from 'vitest';
import type { ProfileDetail, ProfilesView } from '@marquee/shared';
import { schema } from '../src/db/index.js';
import { PRESETS, ProfileService, appQuality, knownQualities, qualityLabel, seedProfiles } from '../src/releases/profiles.js';
import { call, makeApp, setupAdmin } from './helpers.js';

async function admin() {
  const ctx = makeApp();
  const cookie = await setupAdmin(ctx.app);
  return { ...ctx, cookie };
}

function addMovie(db: ReturnType<typeof makeApp>['db'], profile: string, tmdbId = 1) {
  return db.insert(schema.movies).values({ tmdbId, title: `Movie ${tmdbId}`, sortTitle: `movie ${tmdbId}`, profile, addedAt: 0, refreshedAt: 0 }).returning().get();
}

describe('profile presets', () => {
  it('seeds Cinema, Everyday HD and Kids & Cartoons for movies and for TV, once', async () => {
    const { app, cookie, db } = await admin();
    const res = await call(app, 'GET', '/api/settings/profiles', undefined, cookie);
    expect(res.status).toBe(200);
    const view = res.body as ProfilesView;
    expect(view.profiles.map((p) => `${p.kind}:${p.name}`)).toEqual([
      'movie:Cinema',
      'movie:Everyday HD',
      'movie:Kids & Cartoons',
      'tv:Cinema',
      'tv:Everyday HD',
      'tv:Kids & Cartoons',
    ]);
    expect(view.defaults).toEqual({ movie: 'cinema', tv: 'cinema', kids: 'kids' });
    expect(view.profiles.find((p) => p.kind === 'movie' && p.key === 'cinema')!.defaultFor).toEqual(['movie']);
    expect(view.profiles.find((p) => p.kind === 'tv' && p.key === 'kids')!.defaultFor).toEqual(['kids']);
    // Running again doesn't add them twice, or bring back a deleted one.
    const kidsTv = view.profiles.find((p) => p.kind === 'tv' && p.key === 'everyday-hd')!;
    expect((await call(app, 'DELETE', `/api/settings/profiles/${kidsTv.id}`, undefined, cookie)).status).toBe(200);
    seedProfiles(db, 0);
    expect(db.select().from(schema.profiles).all()).toHaveLength(5);
  });

  it('builds each preset from TRaSH: valid tiers, an allowed "good enough", and TRaSH’s points', () => {
    for (const p of PRESETS) {
      const v = p.build();
      const qualities = v.tiers.flatMap((t) => t.qualities).sort();
      expect(qualities).toEqual(knownQualities(p.kind).sort());
      expect(v.tiers.find((t) => t.name === v.cutoff)?.allowed).toBe(true);
      expect(v.rules.filter((r) => r.enabled).length).toBeGreaterThan(30);
      expect(v.rules.some((r) => !r.enabled)).toBe(true);
    }
    const cinema = PRESETS.find((p) => p.kind === 'movie' && p.key === 'cinema')!.build();
    expect(cinema.tiers.filter((t) => t.allowed).map((t) => t.name)).toEqual(['Bluray-2160p', 'WEB 2160p', 'Bluray-1080p', 'WEB 1080p']);
    const kids = PRESETS.find((p) => p.kind === 'movie' && p.key === 'kids')!.build();
    expect(kids.tiers.filter((t) => t.allowed).map((t) => t.name)).toEqual(['Bluray-720p', 'WEB 720p', 'WEB 1080p']);
    expect(kids.sizes['WEBDL-1080p']!.max).toBe(40);
  });

  it('names qualities in each app’s words, and in plain English', () => {
    expect(appQuality('tv', 'Remux-2160p')).toBe('Bluray-2160p Remux');
    expect(appQuality('tv', 'CAM')).toBe('Unknown');
    expect(appQuality('movie', 'Remux-2160p')).toBe('Remux-2160p');
    expect(qualityLabel('WEBDL-1080p')).toBe('1080p web download');
    expect(qualityLabel('Bluray-2160p Remux')).toBe('4K Blu-ray remux');
    expect(qualityLabel('CAM')).toBe('Filmed in a cinema');
  });
});

describe('Settings → Quality API', () => {
  it('is for admins only', async () => {
    const { app } = makeApp();
    expect((await call(app, 'GET', '/api/settings/profiles')).status).toBe(401);
  });

  it('shows a profile with every rule in plain English and its sizes', async () => {
    const { app, cookie } = await admin();
    const list = (await call(app, 'GET', '/api/settings/profiles', undefined, cookie)).body as ProfilesView;
    const res = await call(app, 'GET', `/api/settings/profiles/${list.profiles[0]!.id}`, undefined, cookie);
    expect(res.status).toBe(200);
    const p = res.body as ProfileDetail;
    expect(p.name).toBe('Cinema');
    const lq = p.rules.find((r) => r.name === 'LQ')!;
    expect(lq).toMatchObject({ label: 'Low-quality group', enabled: true, score: -10000, trashScore: -10000 });
    expect(lq.group).toMatch(/Unwanted/);
    expect(p.sizes.find((s) => s.quality === 'Bluray-2160p')).toMatchObject({ label: '4K Blu-ray', unlimited: true, changed: false });
    expect(p.qualityLabels['WEBRip-1080p']).toBe('1080p web capture');
    expect(JSON.stringify(p)).not.toMatch(/specifications/);
  });

  it('edits a profile: rename, rules, points, sizes, good enough', async () => {
    const { app, cookie } = await admin();
    const list = (await call(app, 'GET', '/api/settings/profiles', undefined, cookie)).body as ProfilesView;
    const id = list.profiles.find((p) => p.kind === 'movie' && p.key === 'everyday-hd')!.id;
    const before = (await call(app, 'GET', `/api/settings/profiles/${id}`, undefined, cookie)).body as ProfileDetail;
    const rules = before.rules.map((r) => ({ trashId: r.trashId, enabled: r.name === 'LQ' ? false : r.enabled, score: r.name === 'AMZN' ? 50 : r.score }));
    const res = await call(
      app,
      'PATCH',
      `/api/settings/profiles/${id}`,
      { name: 'Family HD', cutoff: 'WEB 1080p', minScore: 10, rules, sizes: { 'WEBDL-1080p': { min: 10, preferred: 30, max: 60 } } },
      cookie,
    );
    expect(res.status).toBe(200);
    const p = res.body as ProfileDetail;
    expect(p).toMatchObject({ name: 'Family HD', key: 'everyday-hd', cutoff: 'WEB 1080p', minScore: 10 });
    expect(p.rules.find((r) => r.name === 'LQ')!.enabled).toBe(false);
    expect(p.rules.find((r) => r.name === 'AMZN')).toMatchObject({ score: 50 });
    expect(p.sizes.find((s) => s.quality === 'WEBDL-1080p')).toMatchObject({ min: 10, max: 60, changed: true, unlimited: false });

    // Reset puts TRaSH's values back but keeps the name.
    const reset = (await call(app, 'POST', `/api/settings/profiles/${id}/reset`, {}, cookie)).body as ProfileDetail;
    expect(reset).toMatchObject({ name: 'Family HD', cutoff: 'Bluray-1080p', minScore: 0 });
    expect(reset.rules.find((r) => r.name === 'LQ')!.enabled).toBe(true);
    expect(reset.sizes.every((s) => !s.changed)).toBe(true);
  });

  it('explains bad edits in plain words', async () => {
    const { app, cookie } = await admin();
    const list = (await call(app, 'GET', '/api/settings/profiles', undefined, cookie)).body as ProfilesView;
    const id = list.profiles[0]!.id;
    const p = (await call(app, 'GET', `/api/settings/profiles/${id}`, undefined, cookie)).body as ProfileDetail;
    const off = p.tiers.map((t) => ({ ...t, allowed: false }));
    const cases: [unknown, RegExp][] = [
      [{ tiers: off }, /Turn on at least one quality/],
      [{ cutoff: "Remux-2160p" }, /Good enough" is set to Remux-2160p, which is turned off/],
      [{ cutoff: 'Nope' }, /Pick which quality is good enough/],
      [{ tiers: p.tiers.slice(1) }, /Every quality needs a place/],
      [{ tiers: [...p.tiers, { name: 'Extra', qualities: ['Bluray-2160p'], allowed: false }] }, /more than one group/],
      [{ sizes: { 'WEBDL-1080p': { min: 50, preferred: 10, max: 60 } } }, /smallest ≤ preferred ≤ largest/],
      [{ rules: [{ trashId: 'nope', enabled: true, score: 1 }] }, /isn't one Marquee knows/],
      [{ name: 'Kids & Cartoons' }, /already a movie profile called "Kids & Cartoons"/],
      [{ name: '' }, /Give it a name/],
      [{ surprise: 1 }, /./],
    ];
    for (const [body, msg] of cases) {
      const res = await call(app, 'PATCH', `/api/settings/profiles/${id}`, body, cookie);
      expect(res.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
      expect(res.body.message, JSON.stringify(body)).toMatch(msg);
    }
  });

  it('creates a profile as a copy, and only deletes one nothing uses', async () => {
    const { app, cookie, db } = await admin();
    const list = (await call(app, 'GET', '/api/settings/profiles', undefined, cookie)).body as ProfilesView;
    const cinema = list.profiles.find((p) => p.kind === 'movie' && p.key === 'cinema')!;
    const res = await call(app, 'POST', '/api/settings/profiles', { kind: 'movie', name: 'Cinema & Friends', copyFrom: cinema.id }, cookie);
    expect(res.status).toBe(201);
    const copy = res.body as ProfileDetail;
    expect(copy).toMatchObject({ key: 'cinema-and-friends', preset: null, cutoff: 'Bluray-2160p' });
    expect(copy.rules.length).toBe(((await call(app, 'GET', `/api/settings/profiles/${cinema.id}`, undefined, cookie)).body as ProfileDetail).rules.length);
    // A copy can't be reset; there's nothing to reset it to.
    expect((await call(app, 'POST', `/api/settings/profiles/${copy.id}/reset`, {}, cookie)).body.message).toMatch(/Only the built-in profiles/);
    // A TV copy of a movie profile isn't allowed.
    expect((await call(app, 'POST', '/api/settings/profiles', { kind: 'tv', name: 'X', copyFrom: cinema.id }, cookie)).status).toBe(400);
    // A blank new one starts from Everyday HD.
    const blank = (await call(app, 'POST', '/api/settings/profiles', { kind: 'tv', name: 'Cinema' }, cookie));
    expect(blank.status).toBe(409);
    const tv = (await call(app, 'POST', '/api/settings/profiles', { kind: 'tv', name: 'Weekend' }, cookie)).body as ProfileDetail;
    expect(tv.cutoff).toBe('WEB 1080p');

    // In use: can't delete.
    const movie = addMovie(db, 'cinema-and-friends');
    const used = await call(app, 'DELETE', `/api/settings/profiles/${copy.id}`, undefined, cookie);
    expect(used.status).toBe(409);
    expect(used.body.message).toBe('1 title uses this profile. Move it to another profile first.');
    expect(((await call(app, 'GET', '/api/settings/profiles', undefined, cookie)).body as ProfilesView).profiles.find((p) => p.id === copy.id)!.titles).toBe(1);
    // Default: can't delete.
    const def = await call(app, 'DELETE', `/api/settings/profiles/${cinema.id}`, undefined, cookie);
    expect(def.body.message).toMatch(/It's the default for new movies/);

    // Move the movie, then delete works.
    expect((await call(app, 'PUT', `/api/movies/${movie.id}/profile`, { profile: 'everyday-hd' }, cookie)).status).toBe(200);
    expect((await call(app, 'DELETE', `/api/settings/profiles/${copy.id}`, undefined, cookie)).status).toBe(200);
    expect((await call(app, 'GET', `/api/settings/profiles/${copy.id}`, undefined, cookie)).status).toBe(404);
  });

  it('sets the defaults and new titles get them', async () => {
    const { app, cookie, db } = await admin();
    const res = await call(app, 'PUT', '/api/settings/profiles/defaults', { movie: 'everyday-hd' }, cookie);
    expect(res.body).toEqual({ movie: 'everyday-hd', tv: 'cinema', kids: 'kids' });
    expect((await call(app, 'PUT', '/api/settings/profiles/defaults', { tv: 'nope' }, cookie)).body.message).toMatch(/no TV profile called "nope"/);
    const svc = new ProfileService(db, () => 0);
    expect(svc.forTitle('movie', 'missing').key).toBe('everyday-hd');
  });

  it('changes a title’s profile, refusing ones that don’t exist', async () => {
    const { app, cookie, db } = await admin();
    const movie = addMovie(db, 'cinema');
    expect((await call(app, 'PUT', `/api/movies/${movie.id}/profile`, { profile: 'nope' }, cookie)).status).toBe(400);
    expect((await call(app, 'PUT', `/api/movies/9999/profile`, { profile: 'kids' }, cookie)).status).toBe(404);
    expect((await call(app, 'PUT', `/api/movies/${movie.id}/profile`, { profile: 'kids' }, cookie)).status).toBe(200);
    expect((await call(app, 'GET', `/api/movies/${movie.id}`, undefined, cookie)).body.profile).toBe('kids');
  });
});
