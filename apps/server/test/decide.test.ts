import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { decide, normalizeTitle, type Wanted } from '../src/releases/decide.js';
import { ProfileService, seedProfiles, type FullProfile, type Kind } from '../src/releases/profiles.js';
import type { FoundRelease } from '../src/sources/service.js';
import corpus from './fixtures/releases/corpus.json' with { type: 'json' };

const GB = 1024 ** 3;
let n = 0;
function copy(title: string, extra: Partial<FoundRelease> = {}): FoundRelease {
  n++;
  return {
    title,
    size: 8 * GB,
    seeders: 50,
    leechers: 5,
    grabs: null,
    publishedAt: null,
    downloadUrl: `magnet:?xt=${n}`,
    infoUrl: null,
    guid: `guid-${n}`,
    infoHash: `hash${n}`,
    categories: [2000],
    imdbId: null,
    tmdbId: null,
    tvdbId: null,
    freeleech: false,
    sourceId: 1,
    sourceName: 'The Pirate Bay',
    sourcePriority: 25,
    ...extra,
  };
}

const svc = (() => {
  const db = openDb(':memory:');
  seedProfiles(db, 0);
  return new ProfileService(db, () => 0);
})();
const profile = (kind: Kind, key: string): FullProfile => svc.forTitle(kind, key);

const dune: Wanted = { kind: 'movie', title: 'Dune: Part Two', year: 2024, tmdbId: 693134, imdbId: 'tt15239678', runtime: 166 };
const bear: Wanted = { kind: 'tv', title: 'The Bear', year: 2022, season: 3, episode: 2, runtime: 35 };

const codes = (d: { rejections: { code: string }[] }) => d.rejections.map((r) => r.code);

describe('decide: picking the best copy', () => {
  it('picks 4K HDR over 1080p for Cinema, and explains the points', () => {
    const out = decide(
      dune,
      [
        copy('Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.H.264-FLUX', { size: 10 * GB }),
        copy('Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX', { size: 25 * GB }),
      ],
      profile('movie', 'cinema'),
    );
    expect(out.map((d) => d.accepted)).toEqual([true, true]);
    expect(out[0]!.quality).toBe('WEBDL-2160p');
    expect(out[0]!.tier).toBe('WEB 2160p');
    expect(out[0]!.qualityLabel).toBe('4K web download');
    expect(out[0]!.score).toBeGreaterThan(0);
    // Every point is accounted for by a named rule with plain words.
    expect(out[0]!.rules.reduce((a, r) => a + r.points, 0)).toBe(out[0]!.score);
    for (const r of out[0]!.rules) expect(r.label.length).toBeGreaterThan(0);
    expect(out[0]!.rules.map((r) => r.name)).toContain('HDR');
  });

  it('within the same quality, more points wins', () => {
    const out = decide(
      dune,
      [copy('Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.H.265-GRP', { size: 20 * GB }), copy('Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX', { size: 20 * GB })],
      profile('movie', 'cinema'),
    );
    expect(out[0]!.copy.title).toContain('FLUX');
    expect(out[0]!.score).toBeGreaterThan(out[1]!.score);
  });

  it('Everyday HD refuses 4K, and Cinema refuses remuxes and full discs', () => {
    const uhd = copy('Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX', { size: 25 * GB });
    expect(codes(decide(dune, [uhd], profile('movie', 'everyday-hd'))[0]!)).toContain('quality');
    const remux = decide(dune, [copy('Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.DV.HDR.HEVC.TrueHD.7.1.Atmos-FGT', { size: 70 * GB })], profile('movie', 'cinema'))[0]!;
    expect(remux.accepted).toBe(false);
    expect(remux.rejections.find((r) => r.code === 'quality')!.message).toMatch(/4K Blu-ray remux isn't one of the qualities 4K Quality takes/);
    const disc = decide(dune, [copy('Dune.Part.Two.2024.COMPLETE.UHD.BLURAY-SURCODE', { size: 80 * GB })], profile('movie', 'cinema'))[0]!;
    expect(disc.accepted).toBe(false);
  });

  it('never picks low-quality groups, upscales or 3D, and says why', () => {
    const out = decide(
      dune,
      [copy('Dune.Part.Two.2024.2160p.Upscaled.WEB-DL.H.265-GROUP', { size: 20 * GB }), copy('Dune Part Two 2024 3D 1080p BluRay Half-SBS x264-GROUP', { size: 12 * GB })],
      profile('movie', 'cinema'),
    );
    for (const d of out) {
      expect(d.accepted).toBe(false);
      expect(codes(d)).toContain('never');
    }
    const msg = out.flatMap((d) => d.rejections.filter((r) => r.code === 'never').map((r) => r.message)).join(' ');
    expect(msg).toMatch(/never picks these/);
  });

  it('Kids & Cartoons prefers 720p and only takes a small 1080p', () => {
    const up: Wanted = { kind: 'movie', title: 'Up', year: 2009, runtime: 96 };
    const kids = profile('movie', 'kids');
    const out = decide(
      up,
      [
        copy('Up.2009.1080p.BluRay.x264-GROUP', { size: 9 * GB }),
        copy('Up.2009.1080p.WEB-DL.DDP5.1.H.264-GROUP', { size: 3 * GB }),
        copy('Up.2009.720p.BluRay.x264-GROUP', { size: 4 * GB }),
        copy('Up.2009.1080p.WEB-DL.DDP5.1.H.264-OTHER', { size: 6 * GB }),
      ],
      kids,
    );
    expect(out[0]!.copy.title).toBe('Up.2009.720p.BluRay.x264-GROUP');
    expect(out[1]!.copy.title).toContain('WEB-DL.DDP5.1.H.264-GROUP');
    expect(out[1]!.accepted).toBe(true);
    const big = out.find((d) => d.copy.title.endsWith('OTHER'))!;
    expect(codes(big)).toEqual(['too_big']);
    expect(big.rejections[0]!.message).toMatch(/bigger than Kids & Cartoons allows/);
    expect(codes(out.find((d) => d.copy.title.includes('1080p.BluRay'))!)).toContain('quality');
  });

  it('turns down copies too small for their quality', () => {
    const d = decide(dune, [copy('Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.H.265-GROUP', { size: 2 * GB })], profile('movie', 'cinema'))[0]!;
    expect(codes(d)).toEqual(['too_small']);
    expect(d.rejections[0]!.message).toMatch(/2\.1 GB is too small/);
  });

  it('skips size checks when the runtime is unknown', () => {
    const d = decide({ ...dune, runtime: null }, [copy('Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.H.265-GROUP', { size: 2 * GB })], profile('movie', 'cinema'))[0]!;
    expect(d.accepted).toBe(true);
  });

  it('turns down copies nobody is sharing', () => {
    const d = decide(dune, [copy('Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.H.265-GROUP', { size: 20 * GB, seeders: 0 })], profile('movie', 'cinema'))[0]!;
    expect(codes(d)).toEqual(['no_seeders']);
  });

  it('turns down copies scoring under the minimum', () => {
    const p = { ...profile('movie', 'cinema'), minScore: 1_000_000 };
    const d = decide(dune, [copy('Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.H.265-GROUP', { size: 20 * GB })], p)[0]!;
    expect(codes(d)).toEqual(['low_score']);
    expect(d.rejections[0]!.message).toMatch(/needs at least 1000000/);
  });

  it('ignores rules switched off in the profile', () => {
    const p = profile('movie', 'cinema');
    const title = 'Dune.Part.Two.2024.2160p.Upscaled.WEB-DL.H.265-GROUP';
    const on = decide(dune, [copy(title, { size: 20 * GB })], p)[0]!;
    const upscaled = on.rules.find((r) => r.name === 'Upscaled')!;
    const off = { ...p, rules: p.rules.map((r) => (r.trashId === upscaled.trashId ? { ...r, enabled: false } : r)) };
    expect(decide(dune, [copy(title, { size: 20 * GB })], off)[0]!.rules.map((r) => r.name)).not.toContain('Upscaled');
  });
});

describe('decide: right title, right episode', () => {
  it('turns down other titles and years, unless the Source says it is this one by ID', () => {
    const out = decide(
      dune,
      [
        copy('Dune.2021.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX', { size: 20 * GB }),
        copy('Dune.Part.Two.2019.2160p.WEB-DL.H.265-GROUP', { size: 20 * GB }),
        copy('Some.Other.Name.2024.2160p.WEB-DL.H.265-GROUP', { size: 20 * GB, tmdbId: 693134 }),
        copy('Dune.Part.Two.2024.2160p.WEB-DL.H.265-GROUP', { size: 20 * GB, imdbId: 'tt0000001' }),
      ],
      profile('movie', 'cinema'),
    );
    const by = (t: string) => out.find((d) => d.copy.title.startsWith(t))!;
    expect(codes(by('Dune.2021'))).toContain('wrong_title');
    expect(codes(by('Dune.Part.Two.2019'))).toEqual(['wrong_year']);
    expect(by('Some.Other').accepted).toBe(true);
    expect(codes(by('Dune.Part.Two.2024'))).toEqual(['wrong_title']);
  });

  it('matches titles regardless of punctuation, "the" and accents', () => {
    expect(normalizeTitle('Spider-Man: Across the Spider-Verse')).toBe(normalizeTitle('Spider Man Across The Spider Verse'));
    expect(normalizeTitle('Amélie')).toBe(normalizeTitle('Amelie'));
    expect(normalizeTitle('Fast & Furious')).toBe(normalizeTitle('Fast and Furious'));
  });

  it('turns down a TV episode when looking for a movie', () => {
    const d = decide({ kind: 'movie', title: 'The Bear', year: 2022, runtime: 100 }, [copy('The.Bear.S03E02.1080p.WEB.h264-ETHEL')], profile('movie', 'cinema'))[0]!;
    expect(codes(d)).toContain('not_a_movie');
  });

  it('for one episode: wrong episodes and season packs are turned down', () => {
    const out = decide(
      bear,
      [
        copy('The.Bear.S03E02.1080p.WEB.h264-ETHEL', { size: 1.5 * GB }),
        copy('The.Bear.S03E03.1080p.WEB.h264-ETHEL', { size: 1.5 * GB }),
        copy('The.Bear.S02E02.1080p.WEB.h264-ETHEL', { size: 1.5 * GB }),
        copy('The.Bear.S03.1080p.WEB.h264-ETHEL', { size: 15 * GB }),
        copy('The.Bear.1080p.WEB.h264-ETHEL', { size: 1.5 * GB }),
      ],
      profile('tv', 'cinema'),
    );
    const by = (t: string) => out.find((d) => d.copy.title === t)!;
    expect(by('The.Bear.S03E02.1080p.WEB.h264-ETHEL').accepted).toBe(true);
    expect(codes(by('The.Bear.S03E03.1080p.WEB.h264-ETHEL'))).toEqual(['wrong_episode']);
    expect(by('The.Bear.S03E03.1080p.WEB.h264-ETHEL').rejections[0]!.message).toBe("It's season 3, episode 3; you asked for episode 2.");
    expect(codes(by('The.Bear.S02E02.1080p.WEB.h264-ETHEL'))).toEqual(['wrong_episode']);
    expect(codes(by('The.Bear.S03.1080p.WEB.h264-ETHEL'))).toEqual(['season_pack']);
    expect(codes(by('The.Bear.1080p.WEB.h264-ETHEL'))).toContain('no_episode');
    expect(out[0]!.copy.title).toBe('The.Bear.S03E02.1080p.WEB.h264-ETHEL');
  });

  it('for a whole season: takes packs and that season’s episodes, and sizes a pack by its episodes', () => {
    const season = { ...bear, episode: undefined, seasonEpisodes: 10 };
    const out = decide(season, [copy('The.Bear.S03.1080p.WEB.h264-ETHEL', { size: 15 * GB }), copy('The.Bear.S03.1080p.WEB.h264-TINY', { size: 1 * GB })], profile('tv', 'cinema'));
    expect(out[0]!.accepted).toBe(true);
    expect(codes(out[1]!)).toEqual(['too_small']);
  });

  it('turns down samples', () => {
    const d = decide(dune, [copy('Dune.Part.Two.2024.2160p.WEB-DL.H.265-GROUP.sample.mkv', { size: 20 * GB })], profile('movie', 'cinema'))[0]!;
    expect(codes(d)).toContain('sample');
  });
});

describe('decide: merging and ranking', () => {
  it('merges the same torrent from several Sources, keeping the most people sharing', () => {
    const title = 'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX';
    const out = decide(
      dune,
      [
        copy(title, { size: 25 * GB, infoHash: 'ABCDEF', seeders: 40, sourceId: 2, sourceName: 'Knaben', sourcePriority: 30 }),
        copy(title, { size: 25 * GB, infoHash: 'abcdef', seeders: 90, sourceId: 1, sourceName: 'The Pirate Bay', sourcePriority: 25 }),
        copy(title, { size: 25 * GB, infoHash: 'other' }),
      ],
      profile('movie', 'cinema'),
    );
    expect(out).toHaveLength(2);
    const merged = out.find((d) => d.sources.length === 2)!;
    expect(merged.sources.map((s) => s.name)).toEqual(['The Pirate Bay', 'Knaben']);
    expect(merged.seeders).toBe(90);
    expect(merged.copy.sourceId).toBe(1);
  });

  it('ranks like Radarr: quality, then points, then Source priority, then people sharing, then size', () => {
    const p = profile('movie', 'everyday-hd');
    const t = 'Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.H.264-GRP';
    const ranked = (copies: FoundRelease[]) => decide(dune, copies, p).map((d) => d.copy.guid);
    // Source priority beats people sharing.
    const a = copy(t, { sourcePriority: 10, seeders: 5 });
    const b = copy(t, { sourcePriority: 40, seeders: 5000 });
    expect(ranked([b, a])).toEqual([a.guid, b.guid]);
    // People sharing compares on a log scale: 120 vs 130 is a tie, so size decides (bigger is closer to TRaSH's preferred size).
    const c = copy(t, { seeders: 120, size: 6 * GB });
    const d = copy(t, { seeders: 130, size: 12 * GB });
    expect(ranked([c, d])).toEqual([d.guid, c.guid]);
    const e = copy(t, { seeders: 10, size: 12 * GB });
    const f = copy(t, { seeders: 1000, size: 6 * GB });
    expect(ranked([e, f])).toEqual([f.guid, e.guid]);
    // A repack beats the first release of the same quality, before points.
    const g = copy('Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.H.264-FLUX');
    const h = copy('Dune.Part.Two.2024.REPACK.1080p.WEB-DL.DDP5.1.H.264-GRP');
    expect(ranked([g, h])).toEqual([h.guid, g.guid]);
    // Accepted copies always come before turned-down ones.
    const bad = copy('Dune.Part.Two.2024.2160p.WEB-DL.H.265-FLUX');
    expect(ranked([bad, a])[0]).toBe(a.guid);
  });

  it('lists near misses before copies of other titles', () => {
    const out = decide(
      dune,
      [copy('Severance.S02E01.2160p.ATVP.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX', { size: 6 * GB, seeders: 900 }), copy('Dune.Part.Two.2024.2160p.WEB-DL.H.265-GRP', { size: 2 * GB })],
      profile('movie', 'cinema'),
    );
    expect(out.map((d) => d.rejections[0]!.code)).toEqual(['too_small', 'wrong_title']);
  });

  it('won’t judge a show with a movie profile', () => {
    expect(() => decide(bear, [], profile('movie', 'cinema'))).toThrow();
  });
});

describe('decide: real copies (corpus)', () => {
  const data = corpus as Record<string, string[]>;
  const cases: [string, Wanted, string][] = [
    ['movie:The Matrix', { kind: 'movie', title: 'The Matrix', year: 1999, runtime: 136 }, 'cinema'],
    ['movie:Inside Out 2', { kind: 'movie', title: 'Inside Out 2', year: 2024, runtime: 96 }, 'kids'],
    ['movie:Oppenheimer', { kind: 'movie', title: 'Oppenheimer', year: 2023, runtime: 180 }, 'everyday-hd'],
    ['tv:The Bear S3', { kind: 'tv', title: 'The Bear', year: 2022, season: 3, runtime: 35, seasonEpisodes: 10 }, 'cinema'],
    ['tv:Bluey S2', { kind: 'tv', title: 'Bluey', year: 2018, season: 2, runtime: 7, seasonEpisodes: 52 }, 'kids'],
    ['tv:Shogun S1E1', { kind: 'tv', title: 'Shōgun', altTitles: ['Shogun'], year: 2024, season: 1, episode: 1, runtime: 60 }, 'everyday-hd'],
  ];

  it.each(cases)('%s: picks an acceptable copy and every turned-down one has a reason', (key, wanted, profileKey) => {
    const names = data[key]!;
    const out = decide(
      wanted,
      names.map((t) => copy(t, { size: null })),
      profile(wanted.kind, profileKey),
    );
    expect(out.length).toBe(names.length);
    expect(out[0]!.accepted).toBe(true);
    for (const d of out) {
      expect(d.accepted).toBe(d.rejections.length === 0);
      for (const r of d.rejections) expect(r.message).toMatch(/^[A-Z0-9“"].*[.]$/);
    }
    const best = out[0]!;
    const tier = profile(wanted.kind, profileKey).tiers.find((t) => t.name === best.tier)!;
    expect(tier.allowed).toBe(true);
  });
});
