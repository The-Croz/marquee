import { describe, expect, it } from 'vitest';
import { normalizeTitle, parseEpisode, parseQuality, parseTitleName, sortTitle } from '../src/library/parse.js';

describe('parseTitleName', () => {
  it.each([
    ['The Matrix (1999)', 'The Matrix', 1999],
    ['Up (2009)', 'Up', 2009],
    ['1917 (2019)', '1917', 2019],
    ['Blade Runner 2049 (2017)', 'Blade Runner 2049', 2017],
    ['Dune Part Two (2024) {tmdb-693134}', 'Dune Part Two', 2024],
    ['Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.DV.HDR.H.265-FLUX', 'Dune Part Two', 2024],
    ['Blade.Runner.2049.2017.1080p.BluRay.x264-SPARKS', 'Blade Runner 2049', 2017],
    ['2001.A.Space.Odyssey.1968.2160p.UHD.BluRay.REMUX', '2001 A Space Odyssey', 1968],
    ['Inside Out 2 (2024) [imdbid-tt22022452]', 'Inside Out 2', 2024],
    ['Severance (2022) {tvdb-371980}', 'Severance', 2022],
    ['Bluey', 'Bluey', null],
    ['Shōgun (2024)', 'Shōgun', 2024],
  ])('%s', (name, title, year) => {
    const p = parseTitleName(name);
    expect(p.title).toBe(title);
    expect(p.year).toBe(year);
  });

  it('reads ID tags in every common style', () => {
    expect(parseTitleName('Dune Part Two (2024) {tmdb-693134}').tmdbId).toBe(693134);
    expect(parseTitleName('Dune Part Two (2024) [tmdbid-693134]').tmdbId).toBe(693134);
    expect(parseTitleName('Severance (2022) {tvdb-371980}').tvdbId).toBe(371980);
    expect(parseTitleName('Severance (2022) [tvdbid=371980]').tvdbId).toBe(371980);
    expect(parseTitleName('Inside Out 2 (2024) {imdb-tt22022452}').imdbId).toBe('tt22022452');
  });
});

describe('parseEpisode', () => {
  it.each([
    ['Severance - S02E07 - Chikhai Bardo WEBDL-2160p.mkv', 2, [7]],
    ['the.bear.s03e04.1080p.web.h264-successfulcrab.mkv', 3, [4]],
    ['Bluey.S01E01-E03.720p.mkv', 1, [1, 2, 3]],
    ['Bluey.S01E01E02.720p.mkv', 1, [1, 2]],
    ['Show 1x05 Title.mp4', 1, [5]],
    ['Show Season 2 Episode 10.mkv', 2, [10]],
  ])('%s', (name, season, eps) => {
    expect(parseEpisode(name)).toEqual({ season, episodes: eps });
  });

  it('returns null for non-episodes', () => {
    expect(parseEpisode('Dune.Part.Two.2024.2160p.mkv')).toBeNull();
    expect(parseEpisode('behind-the-scenes.mkv')).toBeNull();
  });
});

describe('parseQuality', () => {
  it('reads a 4K Dolby Vision WEB-DL', () => {
    expect(parseQuality('Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.DV.HDR.H.265-FLUX.mkv')).toEqual({
      resolution: '2160p',
      source: 'WEB-DL',
      hdr: 'Dolby Vision',
      codec: 'x265',
      group: 'FLUX',
    });
  });

  it('reads a 1080p Blu-ray encode', () => {
    expect(parseQuality('Blade.Runner.2049.2017.1080p.BluRay.x264-SPARKS.mkv')).toMatchObject({ resolution: '1080p', source: 'Blu-ray', hdr: null, codec: 'x264', group: 'SPARKS' });
  });

  it('reads a remux and HDR10', () => {
    expect(parseQuality('Movie.2019.2160p.UHD.BluRay.REMUX.HDR10.HEVC-GRP.mkv')).toMatchObject({ resolution: '2160p', source: 'Remux', hdr: 'HDR10' });
  });

  it('reads Sonarr-style quality names', () => {
    expect(parseQuality('Severance - S02E07 - Chikhai Bardo [WEBDL-2160p][DV HDR10][EAC3 5.1][h265]-NTb.mkv')).toMatchObject({ resolution: '2160p', source: 'WEB-DL', hdr: 'Dolby Vision', codec: 'x265' });
    expect(parseQuality('Bluey - S01E01 - Magic Xylophone [WEBRip-720p].mkv')).toMatchObject({ resolution: '720p', source: 'WEBRip' });
  });

  it("doesn't mistake WEB-DL for a release group", () => {
    expect(parseQuality('Movie.2020.1080p.WEB-DL.mkv').group).toBeNull();
  });
});

describe('title helpers', () => {
  it('normalizes for matching', () => {
    expect(normalizeTitle('The Lord of the Rings: The Return of the King')).toBe('lord of the rings the return of the king');
    expect(normalizeTitle('Shōgun')).toBe('shogun');
    expect(normalizeTitle("Grey's Anatomy")).toBe('greys anatomy');
    expect(normalizeTitle('Mr. & Mrs. Smith')).toBe('mr and mrs smith');
  });

  it('sorts without leading articles', () => {
    expect(sortTitle('The Bear')).toBe('bear');
    expect(sortTitle('A Quiet Place')).toBe('quiet place');
  });
});
