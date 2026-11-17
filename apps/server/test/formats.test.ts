import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRASH, compile, defaultRules, matches, optionalRules, unsupported, type App, type Rule, type RuleInput } from '../src/releases/formats.js';
import { EXPLANATIONS } from '../src/releases/explanations.js';
import { parseRelease } from '../src/releases/parse.js';

const input = (title: string, extra: Partial<RuleInput> = {}): RuleInput => ({ app: 'radarr', title, parsed: parseRelease(title), size: null, freeleech: false, ...extra });
const rule = (app: App, name: string): Rule => {
  const r = TRASH[app].formats.find((f) => f.name === name);
  if (!r) throw new Error(`no rule ${name}`);
  return r;
};
/** Points a copy gets from a TRaSH profile's default rules, and which rules gave them. */
function score(app: App, profile: string, title: string, extra: Partial<RuleInput> = {}) {
  const hits = defaultRules(app, profile).filter((r) => matches(r.rule, input(title, { app, ...extra })));
  return { points: hits.reduce((a, r) => a + r.points, 0), rules: hits.map((r) => r.rule.name).sort() };
}

describe('the vendored TRaSH data', () => {
  it.each(['radarr', 'sonarr'] as const)('%s: has our base profiles, a pinned commit and sizes', (app) => {
    const d = TRASH[app];
    expect(d.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(d.profiles.map((p) => p.name).sort()).toEqual(app === 'radarr' ? ['HD Bluray + WEB', 'UHD Bluray + WEB'] : ['WEB-1080p', 'WEB-2160p']);
    expect(d.sizes.length).toBeGreaterThan(10);
    expect(d.formats.length).toBeGreaterThan(80);
  });

  it('leaves out anime and other-language groups', () => {
    for (const app of ['radarr', 'sonarr'] as const) expect(TRASH[app].groups.filter((g) => /anime|french|german|asian/i.test(g.name))).toEqual([]);
  });

  it.each(['radarr', 'sonarr'] as const)('%s: every rule can be checked by Marquee', (app) => {
    const problems = TRASH[app].formats.map((f) => [f.name, unsupported(f)]).filter(([, why]) => why);
    expect(problems).toEqual([]);
  });

  it('compiles .NET-style patterns', () => {
    expect(compile('(?i)\\bgerman\\b')?.test('GERMAN')).toBe(true);
    expect(compile('^REMUX|(?i)(DVD9|COMPLETE BLURAY)')?.test('Movie COMPLETE BLURAY')).toBe(true); // (?i) mid-pattern, from a Profilarr rule
    expect(compile('^(?!.*(?i:remux)).*x264')?.test('Movie REMUX x264')).toBe(false);
    expect(compile('(?<=\\bS\\d+)\\bB&W\\b')).not.toBeNull();
  });

  it.each(['radarr', 'sonarr'] as const)('%s: every rule has a plain-English explanation', (app) => {
    const missing = TRASH[app].formats.map((f) => f.name).filter((n) => !EXPLANATIONS[n]);
    expect(missing).toEqual([]);
  });

  it('explanations say what a rule means, not whether it is on', () => {
    for (const e of Object.values(EXPLANATIONS)) {
      expect(e.explain).not.toMatch(/never picked|off by default|on by default/i);
      expect(e.label.length).toBeLessThanOrEqual(48);
    }
  });

  it('default rule sets are the size we expect', () => {
    expect(defaultRules('radarr', 'UHD Bluray + WEB').length).toBeGreaterThan(40);
    expect(defaultRules('radarr', 'HD Bluray + WEB').length).toBeGreaterThan(30);
    expect(defaultRules('sonarr', 'WEB-1080p').length).toBeGreaterThan(30);
    // Opt-in rules exist and never overlap the defaults.
    const on = new Set(defaultRules('radarr', 'UHD Bluray + WEB').map((r) => r.rule.trash_id));
    const opt = optionalRules('radarr', 'UHD Bluray + WEB');
    expect(opt.length).toBeGreaterThan(20);
    expect(opt.filter((r) => on.has(r.rule.trash_id))).toEqual([]);
    expect(opt.map((r) => r.rule.name)).toContain('DV Boost');
  });
});

describe('Radarr matching rules', () => {
  const r = (specs: [string, boolean, boolean, unknown][]): Rule => ({
    trash_id: 'x',
    name: 'test',
    specifications: specs.map(([implementation, negate, required, value]) => ({ name: implementation, implementation, negate, required, fields: { value } })),
  });
  const t = input('Movie.2020.2160p.WEB-DL.DV.HDR.H.265-FLUX');

  it('needs every required test of a type to pass', () => {
    expect(matches(r([['ReleaseTitleSpecification', false, true, 'DV'], ['ReleaseTitleSpecification', false, true, 'HDR']]), t)).toBe(true);
    expect(matches(r([['ReleaseTitleSpecification', false, true, 'DV'], ['ReleaseTitleSpecification', false, true, 'Atmos']]), t)).toBe(false);
  });

  it('needs at least one optional test of a type to pass', () => {
    expect(matches(r([['ReleaseTitleSpecification', false, false, 'Atmos'], ['ReleaseTitleSpecification', false, false, 'HDR']]), t)).toBe(true);
    expect(matches(r([['ReleaseTitleSpecification', false, false, 'Atmos'], ['ReleaseTitleSpecification', false, false, 'TrueHD']]), t)).toBe(false);
  });

  it('checks each type of test separately', () => {
    // Title passes, resolution (720) fails → no match, even though "at least one" overall passed.
    expect(matches(r([['ReleaseTitleSpecification', false, false, 'HDR'], ['ResolutionSpecification', false, false, 720]]), t)).toBe(false);
    expect(matches(r([['ReleaseTitleSpecification', false, false, 'HDR'], ['ResolutionSpecification', false, false, 2160]]), t)).toBe(true);
  });

  it('flips a test with negate', () => {
    expect(matches(r([['ReleaseGroupSpecification', true, true, '^FLUX$']]), t)).toBe(false);
    expect(matches(r([['ReleaseGroupSpecification', true, true, '^OTHER$']]), t)).toBe(true);
  });

  it('treats a missing group as not matching a group pattern', () => {
    expect(matches(r([['ReleaseGroupSpecification', false, true, '.*']]), input('Movie 2020 1080p WEB'))).toBe(false);
  });

  it('never claims a match on a test it cannot check', () => {
    expect(matches(r([['YearSpecification', false, false, 2020]]), t)).toBe(false);
    expect(unsupported(r([['YearSpecification', false, false, 2020]]))).toContain("aren't supported");
  });
});

describe('TRaSH rules on real copies', () => {
  it('refuses Dolby Vision without an HDR layer, on WEB, from groups that don’t add one', () => {
    expect(matches(rule('radarr', 'DV (w/o HDR fallback)'), input('Dune Part Two 2024 2160p WEB-DL DV H 265-SOMEONE'))).toBe(true);
    expect(matches(rule('radarr', 'DV (w/o HDR fallback)'), input('Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX'))).toBe(false);
  });

  it('applies the golden rule: no HEVC below 4K', () => {
    expect(matches(rule('radarr', 'x265 (HD)'), input('Up 2009 1080p BluRay x265-YAWNTiC'))).toBe(true);
    expect(matches(rule('radarr', 'x265 (HD)'), input('Up 2009 2160p UHD BluRay x265-AViATOR'))).toBe(false);
  });

  it('knows low-quality groups and full discs', () => {
    expect(matches(rule('radarr', 'LQ'), input('Dune Part Two (2024) 1080p BRRip 5.1 x264 -YTS'))).toBe(true);
    expect(matches(rule('radarr', 'BR-DISK'), input('Inside Out 2 2024 COMPLETE BLURAY-GMA'))).toBe(true);
    expect(matches(rule('radarr', 'BR-DISK'), input('Inside Out 2 2024 2160p UHD BluRay TrueHD Atmos 7 1 DV HDR x265-GanG'))).toBe(false);
  });

  it('uses freeleech from the Source', () => {
    expect(matches(rule('radarr', 'FreeLeech'), input('Up 2009 1080p BluRay x264-OFT', { freeleech: true }))).toBe(true);
    expect(matches(rule('radarr', 'FreeLeech'), input('Up 2009 1080p BluRay x264-OFT'))).toBe(false);
  });

  it('knows a season pack from an episode (TV)', () => {
    expect(matches(rule('sonarr', 'Season Pack'), input('The Last of Us S02 1080p x265-ELiTE', { app: 'sonarr' }))).toBe(true);
    expect(matches(rule('sonarr', 'Season Pack'), input('The Last of Us S02E03 1080p x265-ELiTE', { app: 'sonarr' }))).toBe(false);
  });

  it('refuses dubbed-only copies using the original language', () => {
    const notOriginal = rule('sonarr', 'Language: Not Original');
    expect(matches(notOriginal, input('Shogun 2024 S01E01 1080p WEB-DL', { app: 'sonarr', originalLanguage: 'Japanese' }))).toBe(true);
    expect(matches(notOriginal, input('Shogun 2024 S01E01 1080p WEB-DL JPN ENG', { app: 'sonarr', originalLanguage: 'Japanese' }))).toBe(false);
    expect(matches(notOriginal, input('Severance S02E03 1080p WEB-DL', { app: 'sonarr', originalLanguage: 'English' }))).toBe(false);
    expect(matches(notOriginal, input('Severance S02E03 1080p WEB-DL iTA', { app: 'sonarr', originalLanguage: 'English' }))).toBe(true);
  });

  it('scores whole copies in UHD Bluray + WEB', () => {
    expect(score('radarr', 'UHD Bluray + WEB', 'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX')).toEqual({ points: 5200, rules: ['DD+ ATMOS', 'HDR', 'WEB Tier 01'] });
    expect(score('radarr', 'UHD Bluray + WEB', 'Dune Part Two 2024 REPACK 2160p UPSCALE WEB HEVC 10Bit AAC 2 0-R&H').points).toBeLessThan(-10000);
    expect(score('radarr', 'UHD Bluray + WEB', 'Inside Out 2 2024 COMPLETE BLURAY-GMA').rules).toContain('BR-DISK');
  });
});

describe('every real name', () => {
  const corpus = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/releases/corpus.json'), 'utf8')) as Record<string, string[]>;

  it('scores without errors in all four TRaSH profiles, quickly', () => {
    const started = Date.now();
    let n = 0;
    for (const [query, names] of Object.entries(corpus)) {
      const app = query.startsWith('tv:') ? 'sonarr' : 'radarr';
      for (const profile of TRASH[app].profiles) for (const t of names) {
        score(app, profile.name, t);
        n++;
      }
    }
    expect(n).toBeGreaterThan(4000);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("agrees with the parser about full discs (TRaSH's rule decides)", () => {
    const all = [...new Set(Object.values(corpus).flat())];
    const differ = all.filter((t) => matches(rule('radarr', 'BR-DISK'), input(t)) !== (parseRelease(t).quality === 'BR-DISK'));
    // TRaSH's pattern takes "Re-Encoded AVC" for a disc; it's an encode, and the parser says so.
    expect(differ).toEqual(['Up 3D 2009 BluRay 1080p Re-Encoded AVC DTS-HD MA5 1-TruHD']);
  });
});
