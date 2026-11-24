import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NameCheckView, OwnRulesView, ProfileDetail, ProfilesView, RuleUpdatesView } from '@marquee/shared';
import { getSetting, openDb, schema, setSetting } from '../src/db/index.js';
import { DICTIONARRY_SHIPPED } from '../src/releases/catalog.js';
import { buildDictionarry, downloadDictionarry, untar } from '../src/releases/dictionarry.js';
import { dictExplain } from '../src/releases/dictWords.js';
import { decide, type Wanted } from '../src/releases/decide.js';
import { compile, matches, unsupported } from '../src/releases/formats.js';
import { parseRelease } from '../src/releases/parse.js';
import { DICT_NOTICE, PRESET_BASES, ProfileService, seedProfiles, type FullProfile, type Kind } from '../src/releases/profiles.js';
import type { FoundRelease } from '../src/sources/service.js';
import { FakeDictionarry, OPS_V1, OPS_V2, SCHEMA_SQL, tarball } from './fakes/dictionarry.js';
import { call, makeApp, setupAdmin } from './helpers.js';

const GB = 1024 ** 3;
let n = 0;
function copy(title: string, extra: Partial<FoundRelease> = {}): FoundRelease {
  n++;
  return {
    title, size: null, seeders: 50, leechers: 5, grabs: null, publishedAt: null, downloadUrl: `magnet:?xt=${n}`, infoUrl: null, guid: `g${n}`, infoHash: `h${n}`,
    categories: [], imdbId: null, tmdbId: null, tvdbId: null, freeleech: false, sourceId: 1, sourceName: 'Knaben', sourcePriority: 25, ...extra,
  };
}
const schemaOps: [string, string][] = [['0.schema.sql', SCHEMA_SQL]];
const meta = { commit: 'abc', fetchedAt: '2026-11-23' };

describe('reading Dictionarry', () => {
  it('turns its tests into the same tests Radarr and Sonarr run, per app', () => {
    const d = buildDictionarry(schemaOps, OPS_V1, meta);
    const good = d.radarr.formats.find((f) => f.name === 'Good Group')!;
    expect(good.trash_id).toBe('dict:Good Group');
    expect(good.tags).toEqual(['Release Group Tier']);
    expect(good.specifications.map((s) => [s.implementation, s.fields.value, s.required])).toEqual([
      ['ReleaseGroupSpecification', '^(Good|Fine)$', false],
      ['ResolutionSpecification', 1080, true],
      ['SourceSpecification', 9, true],
    ]);
    // Sonarr numbers sources its own way, and has no Radarr-only rules.
    expect(d.sonarr.formats.find((f) => f.name === 'Good Group')!.specifications[2]!.fields.value).toBe(6);
    expect(d.radarr.formats.map((f) => f.name)).toContain('Radarr Remux');
    expect(d.sonarr.formats.map((f) => f.name)).not.toContain('Radarr Remux');
    expect(d.radarr.unmapped).toEqual([]);
  });

  it('reads profiles: qualities in each app’s words, app-specific points, its limits and repack setting', () => {
    const d = buildDictionarry(schemaOps, OPS_V1, meta);
    const small = d.radarr.profiles.find((p) => p.name === 'Small')!;
    expect(small).toMatchObject({ minScore: 100, cutoffScore: 1000, minUpgradeScore: 1, upgrades: true, cutoff: 'Small', description: 'Small **x265** copies' });
    expect(small.tiers).toEqual([
      { name: 'Small', qualities: ['Bluray-1080p', 'WEBDL-1080p'], allowed: true },
      { name: 'Remux-1080p', qualities: ['Remux-1080p'], allowed: false },
      { name: 'CAM', qualities: ['CAM'], allowed: false },
    ]);
    expect(small.scores).toEqual({ 'dict:Good Group': 500, 'dict:x265': 50, 'dict:3D': -999999, 'dict:Radarr Remux': -999999 });
    const tv = d.sonarr.profiles.find((p) => p.name === 'Small')!;
    // Sonarr calls a 1080p remux "Bluray-1080p Remux", and has no CAM.
    expect(tv.tiers.map((t) => t.name)).toEqual(['Small', 'Bluray-1080p Remux']);
    expect(tv.scores['dict:x265']).toBe(20);
    expect(d.radarr.preferRepacks).toBe(false);
    expect(d.sonarr.preferRepacks).toBe(true);
    expect(d.radarr.sizes).toEqual([{ quality: 'Bluray-1080p', min: 0, preferred: 1990, max: 0 }]);
  });

  it('checks a year test, and reports (and never matches) a test it can’t read', () => {
    const d = buildDictionarry(schemaOps, [...OPS_V2, ['2.odd.sql', "INSERT INTO custom_formats (name) VALUES ('Odd'); INSERT INTO custom_format_conditions (custom_format_name, name, type) VALUES ('Odd', 'moon', 'moon_phase');"]], meta);
    const year = d.radarr.formats.find((f) => f.name === 'Year')!;
    const input = (title: string) => ({ app: 'radarr' as const, title, parsed: parseRelease(title), size: null, freeleech: false });
    expect(matches(year, input('Psycho.1960.1080p.BluRay.x264-GRP'))).toBe(true);
    expect(matches(year, input('Psycho.1998.1080p.BluRay.x264-GRP'))).toBe(false);
    expect(d.radarr.unmapped).toEqual(['Odd: a "moon_phase" test']);
    const odd = d.radarr.formats.find((f) => f.name === 'Odd')!;
    expect(matches(odd, input('Anything.2020.1080p.WEB-DL-GRP'))).toBe(false);
    expect(unsupported(odd)).toMatch(/aren't supported/);
  });

  it('says which step broke when one doesn’t apply', () => {
    expect(() => buildDictionarry(schemaOps, [...OPS_V1, ['7.bad.sql', 'INSERT INTO nowhere VALUES (1);']], meta)).toThrow(/step 7\.bad\.sql/);
  });

  it('downloads a commit and the schema version it asks for, from GitHub’s tarballs', async () => {
    const fake = new FakeDictionarry();
    fake.latestSha = 'v2sha';
    const d = await downloadDictionarry(fake, undefined, new Date('2026-11-23T10:00:00Z'));
    expect(fake.calls).toEqual(['latest', 'Dictionarry-Hub/database@v2sha', 'Dictionarry-Hub/schema@1.1.0']);
    expect(d.radarr).toMatchObject({ commit: 'v2sha', fetchedAt: '2026-11-23' });
    expect(d.radarr.formats.map((f) => f.name)).toContain('Year');
    const files = untar(tarball({ 'ops/1.a.sql': 'select 1;', 'README.md': 'skip me', 'pcd.json': '{}' }));
    expect([...files.keys()].sort()).toEqual(['ops/1.a.sql', 'pcd.json']);
  });
});

describe('the pinned copy of Dictionarry', () => {
  for (const app of ['radarr', 'sonarr'] as const) {
    const d = DICTIONARRY_SHIPPED[app];
    it(`${app}: every rule can be checked and has plain words`, () => {
      expect(d.unmapped).toEqual([]);
      expect(d.formats.length).toBeGreaterThan(200);
      expect(d.formats.map((f) => [f.name, unsupported(f)]).filter(([, why]) => why)).toEqual([]);
      for (const f of d.formats) for (const s of f.specifications) if (/Title|Group/.test(s.implementation)) expect(compile(String(s.fields.value)), f.name).not.toBeNull();
      expect(d.formats.filter((f) => !dictExplain(f.name)).map((f) => f.name)).toEqual([]);
    });
    it(`${app}: the presets' Dictionarry profiles are there, scoring only rules that exist`, () => {
      const ids = new Set(d.formats.map((f) => f.trash_id));
      for (const base of Object.values(PRESET_BASES)) {
        const p = d.profiles.find((x) => x.name === base)!;
        expect(p, base).toBeDefined();
        expect(Object.keys(p.scores).filter((id) => !ids.has(id))).toEqual([]);
        expect(p.tiers.find((t) => t.name === p.cutoff)?.allowed).toBe(true);
      }
    });
  }
  it('ships with its licence note', () => {
    expect(fs.readFileSync(path.resolve(import.meta.dirname, '../src/releases/dictionarry/LICENSE'), 'utf8')).toMatch(/MIT/);
  });
});

// ---------------------------------------------------------------- the presets on real-looking names

const svc = (() => {
  const db = openDb(':memory:');
  seedProfiles(db, 0);
  return new ProfileService(db, () => 0);
})();
const preset = (kind: Kind, key: string): FullProfile => svc.forTitle(kind, key);
const dune: Wanted = { kind: 'movie', title: 'Dune: Part Two', altTitles: ['Dune Part Two'], year: 2024, runtime: 166 };
const bear: Wanted = { kind: 'tv', title: 'The Bear', year: 2022, season: 3, episode: 2, runtime: 35 };
const ranked = (w: Wanted, p: FullProfile, names: string[]) => decide(w, names.map((t) => copy(t)), p);
const codes = (d: { rejections: { code: string }[] }) => d.rejections.map((r) => r.code);

describe('the presets, built on Dictionarry', () => {
  it('are Dictionarry’s space-saving profiles, follow them for updates, and rank by points rather than repacks', () => {
    for (const kind of ['movie', 'tv'] as Kind[]) {
      for (const [key, base] of Object.entries(PRESET_BASES)) {
        const p = preset(kind, key);
        expect(p).toMatchObject({ database: 'dictionarry', base, preferRepacks: false, minScore: 200000, cutoffScore: 1000000 });
        expect(p.tiers.filter((t) => t.allowed).map((t) => t.name)).toEqual([base]);
        expect(p.rules.every((r) => p.defs!.has(r.trashId))).toBe(true);
      }
    }
    expect(preset('movie', 'cinema').name).toBe('4K Quality');
    expect(preset('movie', 'kids').description).toMatch(/1080p Compact/);
  });

  it('4K Quality: 4K streaming downloads with Dolby Vision first, then trusted small 1080p encodes, then plain 1080p', () => {
    const out = ranked(dune, preset('movie', 'cinema'), [
      'Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.H.264-FLUX',
      'Dune Part Two (2024) (1080p BluRay x265 10bit HDR Tigole) [QxR]',
      'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.H.265-GROUP',
      'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX',
    ]);
    expect(out.map((d) => d.accepted)).toEqual([true, true, true, true]);
    expect(out.map((d) => d.copy.title)).toEqual([
      'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX',
      'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.H.265-GROUP',
      'Dune Part Two (2024) (1080p BluRay x265 10bit HDR Tigole) [QxR]',
      'Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.H.264-FLUX',
    ]);
    expect(out[0]!.rules.map((r) => r.label)).toEqual(expect.arrayContaining(['4K streaming download', 'Dolby Vision']));
    expect(out[2]!.rules[0]!.label).toBe('1080p efficient Blu-ray group, tier 1');
    for (const d of out) expect(d.rules.reduce((a, r) => a + r.points, 0)).toBe(d.score);
  });

  it('4K Quality never takes remuxes, full discs, upscales, AV1, dubbed-only copies or HEVC below 1080p', () => {
    const out = ranked(dune, preset('movie', 'cinema'), [
      'Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.DV.HDR.HEVC.TrueHD.7.1.Atmos-FGT',
      'Dune.Part.Two.2024.COMPLETE.UHD.BLURAY-SURCODE',
      'Dune.Part.Two.2024.2160p.Upscaled.WEB-DL.H.265-GROUP',
      'Dune.Part.Two.2024.1080p.WEB.AV1-GROUP',
      'Dune.Part.Two.2024.FRENCH.1080p.WEB-DL.H.264-GROUP',
      'Dune.Part.Two.2024.720p.BluRay.x265-GROUP',
    ]);
    for (const d of out) {
      expect(d.accepted, d.copy.title).toBe(false);
      expect(codes(d), d.copy.title).toContain('never');
    }
    expect(out.find((d) => d.copy.title.includes('FRENCH'))!.rejections.find((r) => r.code === 'never')!.message).toBe('Neither original nor English: 4K Quality never picks these.');
  });

  it('turns down copies from groups and kinds Dictionarry doesn’t rank, and says how many points were needed', () => {
    const out = ranked(dune, preset('movie', 'cinema'), ['Dune.Part.Two.2024.1080p.WEBRip.x264-GROUP', 'Dune.Part.Two.2024.720p.HDTV.x264-GROUP']);
    const webrip = out.find((d) => d.copy.title.includes('WEBRip'));
    const hdtv = out.find((d) => d.copy.title.includes('HDTV'));
    expect(codes(webrip!)).toEqual(['low_score']);
    expect(webrip!.rejections[0]!.message).toBe('It scores 0 points; 4K Quality needs at least 200000.');
    expect(codes(hdtv!)).toEqual(['low_score']);
  });

  it('a fixed copy wins only by its few points, never over a better copy', () => {
    const out = ranked(dune, preset('movie', 'cinema'), ['Dune.Part.Two.2024.REPACK.1080p.WEB-DL.DDP5.1.H.264-FLUX', 'Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.H.264-FLUX', 'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.H.265-GROUP']);
    expect(out.map((d) => d.copy.title)).toEqual(['Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.H.265-GROUP', 'Dune.Part.Two.2024.REPACK.1080p.WEB-DL.DDP5.1.H.264-FLUX', 'Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.H.264-FLUX']);
    expect(out[1]!.score - out[2]!.score).toBe(6);
  });

  it('Everyday HD refuses 4K and prefers trusted x265 Blu-ray encodes over plain streaming downloads', () => {
    const out = ranked(dune, preset('movie', 'everyday-hd'), [
      'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX',
      'Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.H.264-FLUX',
      'Dune.Part.Two.2024.1080p.BluRay.DDP5.1.x265-SQS',
    ]);
    expect(out.map((d) => d.copy.title)).toEqual(['Dune.Part.Two.2024.1080p.BluRay.DDP5.1.x265-SQS', 'Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.H.264-FLUX', 'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX']);
    expect(codes(out[2]!)).toContain('quality');
  });

  it('Kids & Cartoons takes compact 1080p encodes, falls back to 720p and DVD, and refuses 4K', () => {
    const up: Wanted = { kind: 'movie', title: 'Up', year: 2009, runtime: 96 };
    const out = ranked(up, preset('movie', 'kids'), ['Up.2009.720p.BluRay.x264-GROUP', 'Up.2009.1080p.BluRay.DD5.1.x265-Ralphy', 'Up.2009.2160p.WEB-DL.DDP5.1.H.265-FLUX', 'Up.2009.DVDRip.x264-GROUP']);
    expect(out[0]!.copy.title).toBe('Up.2009.1080p.BluRay.DD5.1.x265-Ralphy');
    expect(out[0]!.rules[0]!.label).toBe('1080p compact Blu-ray group, tier 1');
    expect(out.find((d) => d.copy.title.includes('720p'))!.accepted).toBe(true);
    expect(out.find((d) => d.copy.title.includes('DVDRip'))!.accepted).toBe(true);
    expect(codes(out.find((d) => d.copy.title.includes('2160p'))!)).toContain('quality');
  });

  it('TV: 4K Quality takes a 4K streaming episode over 1080p, and a whole season gets its own small bonus', () => {
    const out = ranked(bear, preset('tv', 'cinema'), ['The.Bear.S03E02.1080p.HULU.WEB-DL.DDP5.1.H.264-NTb', 'The.Bear.S03E02.2160p.HULU.WEB-DL.DDP5.1.H.265-FLUX', 'The.Bear.S03E02.720p.HDTV.x264-GRP']);
    expect(out.map((d) => [d.copy.title.includes('2160p') ? '4K' : d.copy.title.includes('1080p') ? '1080p' : '720p', d.accepted])).toEqual([
      ['4K', true],
      ['1080p', true],
      ['720p', false],
    ]);
    const season = ranked({ ...bear, episode: undefined, seasonEpisodes: 10 }, preset('tv', 'everyday-hd'), ['The.Bear.S03.1080p.DSNP.WEB-DL.DDP5.1.H.264-FLUX']);
    expect(season[0]!.rules.map((r) => r.name)).toContain('Season Pack');
  });

  it('the whole real corpus: every turned-down copy says why in a sentence', () => {
    const corpus = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures/releases/corpus.json'), 'utf8')) as Record<string, string[]>;
    const out = ranked({ kind: 'movie', title: 'The Matrix', year: 1999, runtime: 136 }, preset('movie', 'cinema'), corpus['movie:The Matrix']!);
    expect(out[0]!.accepted).toBe(true);
    expect(out[0]!.quality).toBe('WEBDL-2160p');
    for (const d of out) {
      expect(d.accepted).toBe(d.rejections.length === 0);
      for (const r of d.rejections) expect(r.message).toMatch(/^[A-Z0-9“"].*[.]$/);
    }
  });
});

// ---------------------------------------------------------------- moving an install's presets over, once

describe('moving built-in profiles from TRaSH to Dictionarry', () => {
  it('moves only the ones you never changed, once, and says so', async () => {
    const db = openDb(':memory:');
    seedProfiles(db, 0);
    // Pretend these were made on TRaSH by an older Marquee, and you'd changed Everyday HD for movies.
    db.update(schema.profiles).set({ database: 'trash', base: null, preferRepacks: true, cutoffScore: 10000 }).run();
    db.update(schema.profiles).set({ updatedAt: 5 }).where(eq(schema.profiles.key, 'everyday-hd')).run();
    db.update(schema.profiles).set({ updatedAt: 0 }).where(eq(schema.profiles.kind, 'tv')).run();
    setSetting(db, 'profiles.dictionarry_rebased', '');
    seedProfiles(db, 10);
    const rows = db.select().from(schema.profiles).all();
    const movieHd = rows.find((r) => r.kind === 'movie' && r.key === 'everyday-hd')!;
    expect(movieHd).toMatchObject({ database: 'trash', cutoffScore: 10000 });
    expect(rows.filter((r) => r.database === 'dictionarry')).toHaveLength(5);
    const notice = JSON.parse(getSetting(db, DICT_NOTICE)!);
    expect(notice.kept).toEqual([{ kind: 'movie', name: 'Everyday HD' }]);
    expect(notice.changed).toHaveLength(5);
    // Only once: a later start leaves things alone.
    db.update(schema.profiles).set({ database: 'trash' }).where(eq(schema.profiles.key, 'kids')).run();
    seedProfiles(db, 20);
    expect(db.select().from(schema.profiles).all().filter((r) => r.key === 'kids').map((r) => r.database)).toEqual(['trash', 'trash']);
  });

  it('a fresh install starts on Dictionarry with nothing to say', async () => {
    const t = makeApp();
    const cookie = await setupAdmin(t.app);
    const view = (await call(t.app, 'GET', '/api/settings/profiles', undefined, cookie)).body as ProfilesView;
    expect(view.notice).toBeNull();
    expect(view.profiles.every((p) => p.database === 'dictionarry')).toBe(true);
  });

  it('shows the note on the Quality page until it’s dismissed; Put back moves a kept one to Dictionarry', async () => {
    const t = makeApp();
    const cookie = await setupAdmin(t.app);
    setSetting(t.db, DICT_NOTICE, JSON.stringify({ changed: [{ kind: 'movie', name: '4K Quality' }], kept: [{ kind: 'tv', name: 'Everyday HD' }] }));
    expect(((await call(t.app, 'GET', '/api/settings/profiles', undefined, cookie)).body as ProfilesView).notice!.kept).toEqual([{ kind: 'tv', name: 'Everyday HD' }]);
    await call(t.app, 'POST', '/api/settings/profiles/notice/dismiss', {}, cookie);
    expect(((await call(t.app, 'GET', '/api/settings/profiles', undefined, cookie)).body as ProfilesView).notice).toBeNull();
    const tvHd = t.db.select().from(schema.profiles).all().find((r) => r.kind === 'tv' && r.key === 'everyday-hd')!;
    t.db.update(schema.profiles).set({ database: 'trash', base: null }).where(eq(schema.profiles.id, tvHd.id)).run();
    const reset = (await call(t.app, 'POST', `/api/settings/profiles/${tvHd.id}/reset`, {}, cookie)).body as ProfileDetail;
    expect(reset).toMatchObject({ database: 'dictionarry', base: '1080p Efficient', preferRepacks: false });
  });
});



// ---------------------------------------------------------------- Settings → Quality: try a name, own rules, rule updates

async function admin() {
  const fake = new FakeDictionarry();
  const t = makeApp({ clients: { dictionarry: fake } });
  const cookie = await setupAdmin(t.app);
  const profiles = ((await call(t.app, 'GET', '/api/settings/profiles', undefined, cookie)).body as ProfilesView).profiles;
  const id = (kind: Kind, key: string) => profiles.find((p) => p.kind === kind && p.key === key)!.id;
  return { ...t, cookie, fake, id };
}

describe('Try a name', () => {
  it('shows each rule’s points and whether the profile would take it', async () => {
    const t = await admin();
    const res = await call(t.app, 'POST', `/api/settings/profiles/${t.id('movie', 'cinema')}/try`, { name: 'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX' }, t.cookie);
    expect(res.status).toBe(200);
    const v = res.body as NameCheckView;
    expect(v).toMatchObject({ quality: 'WEBDL-2160p', qualityLabel: '4K web download', tier: '2160p Efficient', tierAllowed: true, taken: true, reasons: [], minScore: 200000 });
    expect(v.score).toBe(v.rules.reduce((a, r) => a + r.points, 0));
    expect(v.rules[0]).toMatchObject({ label: '4K streaming download', points: 980000 });
    expect(v.details).toMatchObject({ title: 'Dune Part Two', year: 2024, group: 'FLUX', service: null });
  });

  it('says why not, checks sizes when given a runtime, and points out the wrong kind of profile', async () => {
    const t = await admin();
    const no = (await call(t.app, 'POST', `/api/settings/profiles/${t.id('movie', 'everyday-hd')}/try`, { name: 'Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.HEVC-FGT' }, t.cookie)).body as NameCheckView;
    expect(no.taken).toBe(false);
    expect(no.reasons[0]).toMatch(/isn't one of the qualities Everyday HD takes/);
    expect(no.reasons.some((r) => /Untouched Blu-ray copy \(remux\): Everyday HD never picks these/.test(r))).toBe(true);
    const ep = (await call(t.app, 'POST', `/api/settings/profiles/${t.id('movie', 'cinema')}/try`, { name: 'The.Bear.S03E02.2160p.HULU.WEB-DL.DDP5.1.H.265-FLUX' }, t.cookie)).body as NameCheckView;
    expect(ep.reasons[0]).toMatch(/TV episode/);
    const tv = (await call(t.app, 'POST', `/api/settings/profiles/${t.id('tv', 'cinema')}/try`, { name: 'The.Bear.S03E02.2160p.HULU.WEB-DL.DDP5.1.H.265-FLUX' }, t.cookie)).body as NameCheckView;
    expect(tv.taken).toBe(true);
    const trash = (await call(t.app, 'POST', '/api/settings/profiles', { kind: 'movie', name: 'TRaSH 4K', fromTrash: 'UHD Bluray + WEB' }, t.cookie)).body as ProfileDetail;
    const small = (await call(t.app, 'POST', `/api/settings/profiles/${trash.id}/try`, { name: 'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.H.265-GRP', sizeGb: 2, minutes: 166 }, t.cookie)).body as NameCheckView;
    expect(small.reasons[0]).toMatch(/too small/);
    expect((await call(t.app, 'POST', `/api/settings/profiles/${trash.id}/try`, { name: '' }, t.cookie)).status).toBe(400);
  });
});

describe('Your own rules', () => {
  it('adds a words rule with points per profile; it counts in decisions and shows on the profile', async () => {
    const t = await admin();
    const cinema = t.id('movie', 'cinema');
    const res = await call(t.app, 'POST', '/api/settings/profiles/own-rules', { name: 'Prefer English audio', kind: 'movie', match: 'language', value: 'English', points: { [cinema]: 5000 } }, t.cookie);
    expect(res.status).toBe(201);
    const words = await call(t.app, 'POST', '/api/settings/profiles/own-rules', { name: 'No hardcoded subs', kind: 'both', match: 'words', value: 'HC, hardcoded subs', points: { [cinema]: -999999, [t.id('tv', 'cinema')]: -999999 } }, t.cookie);
    const view = words.body as OwnRulesView;
    expect(view.rules.map((r) => [r.name, r.description])).toEqual([
      ['Prefer English audio', 'Has English audio (a copy that names no language counts as English).'],
      ['No hardcoded subs', 'The name has any of: “HC”, “hardcoded subs”.'],
    ]);
    expect(view.rules[1]!.points).toEqual({ [cinema]: -999999, [t.id('tv', 'cinema')]: -999999 });
    const tried = (await call(t.app, 'POST', `/api/settings/profiles/${cinema}/try`, { name: 'Dune.Part.Two.2024.2160p.WEB-DL.HC.Hardcoded.Subs.H.265-GRP' }, t.cookie)).body as NameCheckView;
    expect(tried.rules.map((r) => [r.label, r.points])).toEqual(expect.arrayContaining([['No hardcoded subs', -999999], ['Prefer English audio', 5000]]));
    expect(tried.reasons).toContain('No hardcoded subs: 4K Quality never picks these.');
    const detail = (await call(t.app, 'GET', `/api/settings/profiles/${cinema}`, undefined, t.cookie)).body as ProfileDetail;
    expect(detail.rules.find((r) => r.label === 'Prefer English audio')).toMatchObject({ source: 'own', group: 'Your own rules', score: 5000, enabled: true, databaseScore: null });
    // A profile not given points lists it, off.
    const hd = (await call(t.app, 'GET', `/api/settings/profiles/${t.id('movie', 'everyday-hd')}`, undefined, t.cookie)).body as ProfileDetail;
    expect(hd.rules.find((r) => r.label === 'Prefer English audio')).toMatchObject({ enabled: false, score: 0 });
  });

  it('edits and deletes a rule, and refuses a broken one in plain words', async () => {
    const t = await admin();
    const made = (await call(t.app, 'POST', '/api/settings/profiles/own-rules', { name: 'Groups I like', kind: 'tv', match: 'group', value: 'NTb, FLUX', points: { [t.id('tv', 'cinema')]: 300 } }, t.cookie)).body as OwnRulesView;
    const rule = made.rules[0]!;
    const edited = (await call(t.app, 'PUT', `/api/settings/profiles/own-rules/${rule.id}`, { name: 'Groups I like', kind: 'tv', match: 'group', value: 'NTb', points: { [t.id('tv', 'cinema')]: 400 } }, t.cookie)).body as OwnRulesView;
    expect(edited.rules[0]).toMatchObject({ description: 'Made by NTb.', points: { [t.id('tv', 'cinema')]: 400 } });
    const tried = (await call(t.app, 'POST', `/api/settings/profiles/${t.id('tv', 'cinema')}/try`, { name: 'The.Bear.S03E02.1080p.HULU.WEB-DL.DDP5.1.H.264-NTb' }, t.cookie)).body as NameCheckView;
    expect(tried.rules.find((r) => r.label === 'Groups I like')!.points).toBe(400);
    const bad = await call(t.app, 'POST', '/api/settings/profiles/own-rules', { name: 'Bad', kind: 'movie', match: 'pattern', value: '(unclosed', points: {} }, t.cookie);
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/pattern doesn’t work/);
    expect((await call(t.app, 'POST', '/api/settings/profiles/own-rules', { name: 'Bad', kind: 'movie', match: 'language', value: 'Klingon', points: {} }, t.cookie)).body.message).toMatch(/Pick a language/);
    const gone = (await call(t.app, 'DELETE', `/api/settings/profiles/own-rules/${rule.id}`, undefined, t.cookie)).body as OwnRulesView;
    expect(gone.rules).toEqual([]);
    const detail = (await call(t.app, 'GET', `/api/settings/profiles/${t.id('tv', 'cinema')}`, undefined, t.cookie)).body as ProfileDetail;
    expect(detail.rules.some((r) => r.source === 'own')).toBe(false);
  });

  it('is for admins only', async () => {
    const t = await admin();
    await call(t.app, 'POST', '/api/users', { username: 'kid', password: 'a long password', displayName: 'Kid', role: 'kid' }, t.cookie);
    const kid = (await call(t.app, 'POST', '/api/auth/login', { username: 'kid', password: 'a long password' })).cookie;
    expect((await call(t.app, 'GET', '/api/settings/profiles/own-rules', undefined, kid)).status).toBe(403);
    expect((await call(t.app, 'POST', `/api/settings/profiles/${t.id('movie', 'cinema')}/try`, { name: 'x' }, kid)).status).toBe(403);
  });
});

describe('Rule updates', () => {
  it('checks, shows what changed, applies on a button press, and keeps (and flags) the points you changed', async () => {
    const t = await admin();
    // Start from our own small Dictionarry so every change is known.
    let v = (await call(t.app, 'POST', '/api/settings/profiles/updates/check', {}, t.cookie)).body as RuleUpdatesView;
    expect(v.current.shipped).toBe(true);
    expect(v.pending!.to.commit).toBe('v1sha');
    v = (await call(t.app, 'POST', '/api/settings/profiles/updates/apply', {}, t.cookie)).body as RuleUpdatesView;
    expect(v).toMatchObject({ current: { commit: 'v1sha', shipped: false }, pending: null });
    // A profile on Dictionarry's "Small", with x265's points changed by hand.
    const small = (await call(t.app, 'POST', '/api/settings/profiles', { kind: 'movie', name: 'Small', fromDictionarry: 'Small' }, t.cookie)).body as ProfileDetail;
    expect(small).toMatchObject({ database: 'dictionarry', base: 'Small', minScore: 100, preferRepacks: false });
    const rules = small.rules.map((r) => ({ trashId: r.trashId, enabled: r.enabled, score: r.trashId === 'dict:x265' ? 70 : r.score }));
    await call(t.app, 'PATCH', `/api/settings/profiles/${small.id}`, { rules }, t.cookie);

    t.fake.latestSha = 'v2sha';
    v = (await call(t.app, 'POST', '/api/settings/profiles/updates/check', {}, t.cookie)).body as RuleUpdatesView;
    expect(v.lastCheck!.message).toMatch(/An update is ready/);
    expect(v.pending!.rules.find((r) => r.kind === 'movie')).toEqual({ kind: 'movie', added: ['Year'], removed: [], changed: ['3D'] });
    const impact = v.pending!.profiles.find((p) => p.id === small.id)!;
    expect(impact).toMatchObject({ added: ['Year'], removed: ['Radarr Remux'], conflicts: [{ label: 'x265 below 4K', yours: '70', theirs: '80' }] });
    // Nothing changes until you apply it.
    expect(((await call(t.app, 'GET', `/api/settings/profiles/${small.id}`, undefined, t.cookie)).body as ProfileDetail).rules.map((r) => r.name)).not.toContain('Year');

    await call(t.app, 'POST', '/api/settings/profiles/updates/apply', {}, t.cookie);
    const after = (await call(t.app, 'GET', `/api/settings/profiles/${small.id}`, undefined, t.cookie)).body as ProfileDetail;
    const byName = (n: string) => after.rules.find((r) => r.name === n);
    expect(byName('x265')).toMatchObject({ score: 70, conflict: 80, databaseScore: 80 });
    expect(byName('Year')).toMatchObject({ score: 5, enabled: true, conflict: null });
    expect(byName('Radarr Remux')).toBeUndefined();
    expect(byName('Good Group')).toMatchObject({ score: 500, conflict: null });

    const settled = (await call(t.app, 'POST', `/api/settings/profiles/${small.id}/settle`, { trashId: 'dict:x265', use: 'theirs' }, t.cookie)).body as ProfileDetail;
    expect(settled.rules.find((r) => r.name === 'x265')).toMatchObject({ score: 80, conflict: null });
    expect((await call(t.app, 'POST', `/api/settings/profiles/${small.id}/settle`, { trashId: 'dict:x265', use: 'mine' }, t.cookie)).status).toBe(404);

    v = (await call(t.app, 'POST', '/api/settings/profiles/updates/check', {}, t.cookie)).body as RuleUpdatesView;
    expect(v.lastCheck!.message).toBe('Up to date.');
    expect((await call(t.app, 'POST', '/api/settings/profiles/updates/apply', {}, t.cookie)).status).toBe(409);
  });

  it('an unchanged profile simply takes the new points; a failed check says so and tries again in a day', async () => {
    const t = await admin();
    await call(t.app, 'POST', '/api/settings/profiles/updates/check', {}, t.cookie);
    await call(t.app, 'POST', '/api/settings/profiles/updates/apply', {}, t.cookie);
    const small = (await call(t.app, 'POST', '/api/settings/profiles', { kind: 'movie', name: 'Small', fromDictionarry: 'Small' }, t.cookie)).body as ProfileDetail;
    t.fake.latestSha = 'v2sha';
    const v = (await call(t.app, 'POST', '/api/settings/profiles/updates/check', {}, t.cookie)).body as RuleUpdatesView;
    expect(v.pending!.profiles.find((p) => p.id === small.id)!.newPoints).toEqual([{ label: 'x265 below 4K', from: 50, to: 80 }]);
    await call(t.app, 'POST', '/api/settings/profiles/updates/apply', {}, t.cookie);
    expect(((await call(t.app, 'GET', `/api/settings/profiles/${small.id}`, undefined, t.cookie)).body as ProfileDetail).rules.find((r) => r.name === 'x265')).toMatchObject({ score: 80, conflict: null });

    t.fake.fail = true;
    const failed = (await call(t.app, 'POST', '/api/settings/profiles/updates/check', {}, t.cookie)).body as RuleUpdatesView;
    expect(failed.lastCheck).toMatchObject({ ok: false });
    expect(failed.lastCheck!.message).toMatch(/Couldn’t check Dictionarry: GitHub answered 503\. Marquee tries again tomorrow\./);
  });

  it('the built-in profiles survive an update that drops their Dictionarry profile', async () => {
    const t = await admin();
    await call(t.app, 'POST', '/api/settings/profiles/updates/check', {}, t.cookie);
    await call(t.app, 'POST', '/api/settings/profiles/updates/apply', {}, t.cookie);
    const res = await call(t.app, 'PATCH', `/api/settings/profiles/${t.id('movie', 'cinema')}`, { name: '4K' }, t.cookie);
    expect(res.body.message ?? '').toBe('');
    expect(res.status).toBe(200);
  });
});
