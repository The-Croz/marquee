import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRelease, type ParsedRelease } from '../src/releases/parse.js';
import { normalizeTitle } from '../src/library/parse.js';

/**
 * Hand-checked names, mostly real ones from Prowlarr searches (2026-11-16).
 * Each row checks only the fields it lists.
 */
const CASES: [string, Partial<ParsedRelease>][] = [
  // ---- scene style
  ['Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX', { title: 'Dune Part Two', year: 2024, quality: 'WEBDL-2160p', codec: 'h265', hdr: ['DV', 'HDR'], audio: 'DD+', atmos: true, channels: '5.1', group: 'FLUX' }],
  ['Inside.Out.2.2024.1080p.WEB.h264-ETHEL[TGx]', { title: 'Inside Out 2', year: 2024, quality: 'WEBDL-1080p', codec: 'h264', group: 'ETHEL' }],
  ['The.Matrix.1999.720p.BluRay.x264-NeZu', { title: 'The Matrix', year: 1999, quality: 'Bluray-720p', group: 'NeZu' }],
  ['Blade.Runner.2049.2017.2160p.BluRay.x265.10bit.SDR.DTS-HD.MA.TrueHD.7.1.Atmos-SW', { title: 'Blade Runner 2049', year: 2017, quality: 'Bluray-2160p', tenBit: true, hdr: ['SDR'], audio: 'TrueHD', atmos: true, channels: '7.1', group: 'SW' }],
  ['Blade.Runner.2049.2017.PROPER.2160p.US.BluRay.REMUX.HEVC.DTS-HD.MA.TrueHD.7.1.At', { title: 'Blade Runner 2049', quality: 'Remux-2160p', proper: true }],
  ['Blade.Runner.2049.2017.720p.CAM.x264-NoGRP', { quality: 'CAM', resolution: 720 }],
  ['Oppenheimer.2023.IMAX.2160p.BluRay.x265.10bit.DTS-HD.MA.5.1-WiKi', { title: 'Oppenheimer', year: 2023, editions: ['IMAX'], quality: 'Bluray-2160p', audio: 'DTS-HD MA', channels: '5.1', group: 'WiKi' }],
  ['Oppenheimer.2023.2160p.UHDRemux.Hybrid.HDR.DV-TheEqualizer', { quality: 'Remux-2160p', hybrid: true, hdr: ['DV', 'HDR'], group: 'TheEqualizer' }],
  ['The.Matrix.1999.DVD-R.NORDIC.PAL', { title: 'The Matrix', year: 1999, quality: 'DVD', languages: ['Nordic'] }],
  ['Spider-Man.Across.the.Spider-Verse.2023.1080p.WEBRip.AAC5.1.10bits.x265-Rapta', { title: 'Spider-Man Across the Spider-Verse', year: 2023, quality: 'WEBRip-1080p', audio: 'AAC', channels: '5.1', tenBit: true, group: 'Rapta' }],
  ['Spider-Man.Across.the.Spider-Verse.2023.1080p.HD-TC-C1NEM4', { title: 'Spider-Man Across the Spider-Verse', quality: 'TELECINE' }],
  ['Spider-Man.Across.The.Spider-Verse.2023.720p.V2.HDCAM-C1NEM4', { quality: 'CAM', version: 2 }],
  ['Up.2009.2160p.UHD.BluRay.X265.10bit.HDR.TrueHD.7.1.Atmos-PiXAR', { title: 'Up', year: 2009, quality: 'Bluray-2160p', hdr: ['HDR'], group: 'PiXAR' }],
  ['Shogun.2024.S01E01.WEB.x264-TORRENTGALAXY', { title: 'Shogun', year: 2024, season: 1, episodes: [1], quality: 'WEBDL-480p' }],
  ['Shogun.S01E01.2024.1080p.WEBRip.x265.HEVC-kkolev33', { title: 'Shogun', season: 1, episodes: [1], quality: 'WEBRip-1080p' }],
  ['Shogun.s01e01e02.1080p.WEB-DL.H.264.Dual.YG⭐', { title: 'Shogun', season: 1, episodes: [1, 2], languages: ['Multi'] }],
  ['The.Last.of.Us.S01.COMPLETE.720p.HMAX.WEBRip.x264-GalaxyTV', { title: 'The Last of Us', season: 1, fullSeason: true, episodes: [], service: 'HMAX', quality: 'WEBRip-720p' }],
  ['Bluey.Minisodes.S02E10.1080p.WEB.h264-DOLORES', { title: 'Bluey Minisodes', season: 2, episodes: [10] }],
  ['The.Matrix.1999.35mm.1080p.Cinema.DTS.v2.0', { title: 'The Matrix', year: 1999, audio: 'DTS' }],

  // ---- "spaced" names (Knaben, LimeTorrents, IPTorrents)
  ['Dune Part Two 2024 REPACK 1080p AMZN WEB-DL DDP5 1 Atmos H 264-FLUX', { title: 'Dune Part Two', quality: 'WEBDL-1080p', service: 'AMZN', repack: 1, channels: '5.1', atmos: true, codec: 'h264', group: 'FLUX' }],
  ['Dune Part Two 2024 Eng Fre Ger Ita Spa Cze Pol Jpn 2160p BluRay Hybrid Remux DV HDR HEVC Atmos-SGF', { quality: 'Remux-2160p', hybrid: true, group: 'SGF', languages: ['English', 'Italian', 'French', 'German', 'Spanish', 'Japanese', 'Polish', 'Czech'] }],
  ['Dune Part Two 2024 2160p UHD BluRay TrueHD 7 1 DoVi HDR10 x265-W4NK3R', { quality: 'Bluray-2160p', hdr: ['DV', 'HDR10'], audio: 'TrueHD', channels: '7.1', group: 'W4NK3R' }],
  ['Dune Part Two 2024 Hybrid 2160p UHD BluRay DV HDR10+ DDP Atmos 7 1 x265-BiTOR', { hdr: ['DV', 'HDR10+'], audio: 'DD+', atmos: true, channels: '7.1', hybrid: true }],
  ['Dune Part Two 2024 1080p WEB-DL DDP5 1 Atmos H 264-OTHER', { quality: 'WEBDL-1080p', group: 'OTHER' }],
  ['Dune Part Two 2024 2160p WEB AAC 2 0-R&H', { quality: 'WEBDL-2160p', audio: 'AAC', channels: '2.0', group: 'R&H' }],
  ['Dune Part Two 2024 REPACK 2160p UPSCALE WEB HEVC 10Bit AAC 2 0-R&H', { upscaled: true, repack: 1 }],
  ['Dune Part Two 2024 bluray sdr 1080p av1 5 1 opus subs Dust', { quality: 'Bluray-1080p', codec: 'av1', hdr: ['SDR'], audio: 'Opus' }],
  ['Dune Part Two 2024 1080p HD-TS X264-EMIN3M[TGx]', { quality: 'TELESYNC', group: 'EMIN3M' }],
  ['The Matrix 1999 1080p UHD BluRay DD 5 1 Atmos DV HDR x265-SQS', { resolution: 1080, quality: 'Bluray-1080p', hdr: ['DV', 'HDR'], audio: 'DD', atmos: true }],
  ['The Matrix 1999 UHD BluRay 2160p TrueHD Atmos 7 1 DV HEVC REMUX-FraMeSToR', { quality: 'Remux-2160p', group: 'FraMeSToR' }],
  ['The Matrix 1999 Remaster BluRay 1080p TrueHD Atmos 7 1 AVC REMUX-FraMeSToR', { quality: 'Remux-1080p', editions: ['Remastered'], codec: 'h264' }],
  ['The Matrix 1999 Open Matte Web-DL 1080p DD Atmos 5 1 H 264-SM737', { editions: ['Open Matte'], quality: 'WEBDL-1080p' }],
  ['The Matrix 1999 2160p 10bit HDR BluRay 8CH x265 HEVC-PSA', { channels: '7.1', group: 'PSA' }],
  ['The Matrix 1999 1080p 10bit BluRay 6CH x265 HEVC-PSA', { channels: '5.1' }],
  ['The Matrix 1999 2160p iTunes WEB-DL DDP5 1 Atmos DV H 265-HHWEB', { service: 'iT', quality: 'WEBDL-2160p' }],
  ['The Matrix 1999 1080p MAX WEB-DL DDP5 1 Atmos H 264-TURG', { service: 'MAX' }],
  ['The Matrix 3D 1999 Half-SBS x 12xMultiAudio JFC 1080p hevc', { title: 'The Matrix', year: 1999, is3d: true, languages: ['Multi'] }],
  ['The Matrix Complete 5 Movie Collection Sci-Fi 1999-2021 Eng 1080 ...', { collection: true }],
  ['The Matrix Collection 1999 2021 2160p UHD BDRIP x265 AC3 AOC', { quality: 'Bluray-2160p', collection: true }],
  ['Inside Out 2 2024 2160p DSNP WEB-DL DDP5 1 Atmos DV HDR H 265-MGHW', { title: 'Inside Out 2', service: 'DSNP', quality: 'WEBDL-2160p' }],
  ['Inside Out 2 2024 2160p DSNP WEB-DL DDPA 5 1 DV H 265-PiRaTeS', { atmos: true, audio: 'DD+', channels: '5.1' }],
  ['Inside Out 2 2024 iNTERNAL UHD BluRay 2160p TrueHD Atmos 7 1 HDR10 HEVC REMUX-seedpool', { internal: true, quality: 'Remux-2160p', hdr: ['HDR10'] }],
  ['Inside Out 2 2024 BluRay 2160p UHD REMUX HEVC 10bit HDR Atmos DTS-HD MA 7 1-Aisha@RFX', { quality: 'Remux-2160p', audio: 'DTS-HD MA', channels: '7.1', group: 'Aisha@RFX' }],
  ['Inside Out 2 2024 2160p WEB DL DV P5 ENG LATINO ITALIAN FRENCH DDP5 1 Atmos H265 MP4 BEN THE MEN', { quality: 'WEBDL-2160p', hdr: ['DV'], languages: ['English', 'Italian', 'French', 'Spanish'] }],
  ['Oppenheimer 2023 2160p UHD BluRay DV HDR10DDP 5 1 x265-BiTOR', { hdr: ['DV', 'HDR10'] }],
  ['Oppenheimer 2023 Eng Fre Ger Ita Spa Cze Pol 1080p BluRay Remux AVC DTS HD MA SGF', { quality: 'Remux-1080p', audio: 'DTS-HD MA' }],
  ['Oppenheimer 2023 1080p Blu-ray AVC DTS-HD MA 5.1-ESiR', { quality: 'BR-DISK', group: 'ESiR' }],
  ['Oppenheimer.(2023).Hindi.1080p.HDCAM.NO.ADS.DUAL.AUDIO.X264-RAMA', { quality: 'CAM', languages: ['Multi', 'Hindi'] }],
  ['Oppenheimer (2023) NEW 1080p TELESYNC', { quality: 'TELESYNC' }],
  ['Oppenheimer 2023 720p MA WEB DL DUAL DD 5 1 H 264 TheBiscuitMan', { service: 'MA', quality: 'WEBDL-720p' }],
  ['Oppenheimer 2023 Bluray 2160p AV1 HDR10 EN/FR/ES OPUS 5.1-UH', { codec: 'av1', audio: 'Opus', channels: '5.1' }],
  ['Alien Romulus 2024 AMZN WEBRip SDR 10Bit 1440p DDP5 1 Atmos HEVC-3Li', { resolution: 1440, quality: 'WEBRip-1080p', service: 'AMZN' }],
  ['Alien Romulus 2024 2160p PLAY WEB-DL TrueHD 7 1 Atmos VP9-DRX', { service: 'PLAY', codec: 'vp9' }],
  ['Alien Romulus 2024 PROPER UHD BluRay 1080p DD Atmos 5 1 DoVi HDR10x265-SM73', { proper: true, hdr: ['DV', 'HDR10'], resolution: 1080 }],
  ['Blade Runner 2049 (2017) English - CAMScr - x264 -AAC', { quality: 'CAM' }],
  ['Up 3D 2009 BluRay 1080p Re-Encoded AVC DTS-HD MA5 1-TruHD', { quality: 'Bluray-1080p', is3d: true }],
  ['OPPENHEIMER.2023.2160p.4K.UHD.COMPLETE.BLURAY-MassModz', { quality: 'BR-DISK' }],
  ['The.Matrix.1999.1080p.BluRay.VC-1.TrueHD.5.1-HTPG', { quality: 'BR-DISK', codec: 'vc1' }],
  ['Up 2009 BONUS COMPLETE BLURAY-REFRACTiON', { quality: 'BR-DISK', group: 'REFRACTiON' }],
  ['Up 2009 720p BluRay DTS-ES 5 1 x264-CtrlHD', { audio: 'DTS-ES', channels: '5.1' }],
  ['Up (2009) Ultra HD BluRay HDR10 10Bit 2160p Dts-HDMa7 1 H265-d3g', { audio: 'DTS-HD MA', channels: '7.1' }],
  ['Up 2009 1080p H264 DTS 5 1 Will1869', { quality: 'HDTV-1080p' }],
  ['Up 2009 720p BluRay RoDubbed DD 5 1 x264-SPHD', { languages: ['Russian'] }],
  ['Up 3D (2009) HSBS BrRip x264 - 1.5GB -YIFY', { title: 'Up', year: 2009, is3d: true, quality: 'Bluray-1080p', group: 'YIFY' }],

  // ---- YTS
  ['Dune Part Two (2024) 1080p BRRip 5.1 x264 -YTS', { title: 'Dune Part Two', year: 2024, quality: 'Bluray-1080p', channels: '5.1', group: 'YTS' }],
  ['Dune Part Two (2024) 2160p WEBRip 5.1 10Bit x265 -YTS', { quality: 'WEBRip-2160p', tenBit: true, group: 'YTS' }],
  ['Dune Part Two (2024) [1080p] [WEBRip] 88', { title: 'Dune Part Two', quality: 'WEBRip-1080p' }],
  ['Dune Part Two (2024) [REPACK] [1080p] [WEBRip] [5.1]', { repack: 1, channels: '5.1' }],
  ['Blade Runner 2049 (2017) 1080p BRRip x264 -YTS', { title: 'Blade Runner 2049', year: 2017 }],

  // ---- TV
  ['Severance S02E03 Who Is Alive 1080p ATVP WEB-DL DDP5 1 H 264-NTb', { title: 'Severance', season: 2, episodes: [3], service: 'ATVP', quality: 'WEBDL-1080p', group: 'NTb' }],
  ['Severance S02E03 1080p x265 ELiTE EZTV', { title: 'Severance', season: 2, episodes: [3], quality: 'HDTV-1080p' }],
  ['Severance S02E03 1080p WEB h264 ETHEL[TGx]', { quality: 'WEBDL-1080p' }],
  ['Severance.S02E03.1080p.x265-ELiTE', { title: 'Severance', group: 'ELiTE' }],
  ['The Bear S03E01 Tomorrow 2160p HULU WEB-DL DDP5 1 H 265-FLUX', { title: 'The Bear', season: 3, episodes: [1], service: 'HULU' }],
  ['Lioness 2023 S03E03 The Bear Is Infected 2160p PMTP WEB-DL DDP5 1 DV H 265-NTb', { title: 'Lioness', year: 2023, season: 3, episodes: [3], service: 'PMTP' }],
  ['Bluey S02E20 1080p DSNP WEB DL DDP5 1 H 264 DUAL BiOMA', { title: 'Bluey', season: 2, episodes: [20], languages: ['Multi'] }],
  ['Bluey 2018 S02E07 Favourite Thing 1080p HEVC x265-MeGusta', { title: 'Bluey', year: 2018, season: 2, episodes: [7], group: 'MeGusta' }],
  ['Bluey 2018 S02E10 Rug Island XviD-AFG', { quality: 'SDTV', codec: 'xvid', group: 'AFG' }],
  ['Bluey S03E45  TV Shop', { title: 'Bluey', season: 3, episodes: [45], quality: 'Unknown' }],
  ['Shogun 2024 S01e01-03 [1080p Ita Eng Spa h265 10bit SubS] byMe7alh [MIRCrew]', { title: 'Shogun', season: 1, episodes: [1, 2, 3] }],
  ['Shogun 2024 S01e01-10 [720p Ita Eng Spa SubS] byMe7alh [MIRCrew] ...', { episodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }],
  ['Shogun 2024 S01E01 Anjin 720p DSNP WEB-DL DD+5 1 H 264-playWEB', { audio: 'DD+', channels: '5.1', group: 'playWEB' }],
  ['Shogun 2024 S01E01 Anjin REPACK 1080p DSNP WEB DL DDP5 1 H 264 FLUX[TGx]', { repack: 1, quality: 'WEBDL-1080p' }],
  ['The Last of Us (2023) S01E04 [BluRayRip 2160p] [10 bit x265 HEVC HDR10] [TrueHD 7 1 Atmos] [AC 3] [SBinK]', { title: 'The Last of Us', year: 2023, season: 1, episodes: [4], quality: 'Bluray-2160p', hdr: ['HDR10'] }],
  ['The Last of Us S01E05 Endure and Survive 1080p TrueHD Atmos 7 1 AVC REMUX-F', { quality: 'Remux-1080p' }],
  ['The Last of Us S01E06 2160p HMAX WEBRip DDP5 1 HDR DoVi H 265-HODL mp4', { quality: 'WEBRip-2160p', hdr: ['DV', 'HDR'], group: 'HODL' }],
  ['The Last of Us S02 1080p x265-ELiTE', { season: 2, fullSeason: true, episodes: [] }],
  ['The Last of Us S01-S02 1080p BluRay x265', { season: 1, seasons: [1, 2], fullSeason: true }],
  ['Bluey Season 2 1080p WEB-DL', { title: 'Bluey', season: 2, fullSeason: true }],
  ['Bluey Seasons 1-3 Complete 1080p', { seasons: [1, 2, 3], fullSeason: true }],
  ['Severance 1x02 720p HDTV x264', { season: 1, episodes: [2], quality: 'HDTV-720p' }],

  // ---- edge cases
  ['Blade Runner 2049 2017 1080p BluRay 3D x264 AC3', { title: 'Blade Runner 2049', year: 2017, is3d: true }],
  ['1917.2019.1080p.BluRay.x264-SPARKS', { title: '1917', year: 2019 }],
  ['2001.A.Space.Odyssey.1968.2160p.UHD.BluRay.x265-TERMiNAL', { title: '2001 A Space Odyssey', year: 1968 }],
  ['Dune: Part Two (2024) 2160p', { title: 'Dune: Part Two', year: 2024, quality: 'HDTV-2160p' }],
  ["The.Lord.of.the.Rings.The.Fellowship.of.the.Ring.2001.EXTENDED.2160p.UHD.BluRay.x265-SURCODE", { title: 'The Lord of the Rings The Fellowship of the Ring', editions: ['Extended'] }],
  ["Apocalypse.Now.1979.Final.Cut.2160p.UHD.BluRay.x265-B0MBARDiERS", { editions: ['Final Cut'] }],
  ["Blade.Runner.1982.The.Final.Cut.1080p.BluRay.x264", { year: 1982, editions: ['Final Cut'] }],
  ['Aliens.1986.Directors.Cut.1080p.BluRay.x264-AMIABLE', { title: 'Aliens', editions: ["Director's Cut"] }],
  ['Some.Movie.2020.1080p.BluRay.x264-GROUP-sample.mkv', { sample: true }],
  ['Some.Movie.2020.1080p.WEB-DL.DD5.1.H.264-GROUP.mkv', { group: 'GROUP', channels: '5.1' }],
  ['Some Movie 2020 HC 1080p WEBRip x264', { hardsubs: true }],
  ['Movie.2020.1080p.BluRay.REPACK2.x264-GRP', { repack: 2 }],
];

describe('reading release names', () => {
  it.each(CASES)('%s', (name, expected) => {
    expect(parseRelease(name)).toMatchObject(expected);
  });
});

// ---------------------------------------------------------------- the whole corpus

/** 2,102 real names from 11 searches through Prowlarr (2026-11-16), keyed by what was searched. */
const corpus = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/releases/corpus.json'), 'utf8')) as Record<string, string[]>;
const all = Object.values(corpus).flat();

/** Several titles in one name with no "collection" word; no single year is right. */
const TRILOGY = ['The Matrix 1999 Reloaded 2003 Revolutions 2003 -threesixtyp'];

describe('the real-name corpus', () => {
  it('has plenty of names', () => {
    expect(all.length).toBeGreaterThan(2000);
  });

  it('reads every name without failing and always finds a title', () => {
    const empty = all.filter((n) => !parseRelease(n).title);
    expect(empty).toEqual([]);
  });

  it('finds the resolution whenever the name states one', () => {
    const missed = all.filter((n) => /(?:^|[^\d])(2160|1080|720|480)p(?:$|[^a-z])/i.test(n) && parseRelease(n).resolution === null);
    expect(missed).toEqual([]);
  });

  it('finds the source whenever the name states one plainly', () => {
    const missed = all.filter((n) => /web-?dl|webrip|blu-?ray|remux|hdtv/i.test(n) && parseRelease(n).source === null);
    expect(missed).toEqual([]);
  });

  /** For names that start with the searched title, the parsed title should be that title. */
  function titleAccuracy(kind: 'movie' | 'tv') {
    let checked = 0;
    const wrong: string[] = [];
    for (const [query, names] of Object.entries(corpus)) {
      if (!query.startsWith(`${kind}:`)) continue;
      const want = normalizeTitle(query.slice(kind.length + 1).replace(/\sS\d+(E\d+)?$/, ''));
      for (const n of names) {
        const p = parseRelease(n);
        // Only names that are this title and nothing more: "<title> <year or SxxEyy> …".
        const rest = normalizeTitle(n).slice(want.length);
        if (!normalizeTitle(n).startsWith(want) || !/^ (?:(?:19|20)\d{2}|s\d{1,2}(?:e\d+)?)\b/.test(rest)) continue;
        if (p.collection) continue;
        checked++;
        if (normalizeTitle(p.title) !== want) wrong.push(`${n} → "${p.title}"`);
      }
    }
    return { checked, wrong };
  }

  it('reads movie titles right (at least 99%)', () => {
    const { checked, wrong } = titleAccuracy('movie');
    expect(checked).toBeGreaterThan(500);
    expect(wrong.length / checked, wrong.join('\n')).toBeLessThan(0.01);
  });

  it('reads show titles right (at least 99%)', () => {
    const { checked, wrong } = titleAccuracy('tv');
    expect(checked).toBeGreaterThan(300);
    expect(wrong.length / checked, wrong.join('\n')).toBeLessThan(0.01);
  });

  it('finds the episode in every SxxEyy name', () => {
    const missed = all.filter((n) => /\bS\d{1,2}E\d{1,3}\b/i.test(n) && parseRelease(n).episodes.length === 0);
    expect(missed).toEqual([]);
  });

  it('reads the year of every "Title Year" movie name', () => {
    let checked = 0;
    const wrong: string[] = [];
    for (const [query, names] of Object.entries(corpus)) {
      const m = query.match(/^movie:(.+)$/);
      if (!m) continue;
      const want = normalizeTitle(m[1]!);
      for (const n of names) {
        const y = normalizeTitle(n).slice(want.length).match(/^ ((?:19|20)\d{2})\b/);
        if (!normalizeTitle(n).startsWith(want) || !y) continue;
        if (parseRelease(n).collection || TRILOGY.includes(n)) continue;
        checked++;
        if (parseRelease(n).year !== Number(y[1])) wrong.push(`${n} → ${parseRelease(n).year}`);
      }
    }
    expect(checked).toBeGreaterThan(500);
    expect(wrong).toEqual([]);
  });
});
