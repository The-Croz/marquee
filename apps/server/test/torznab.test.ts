import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TorznabClient, TorznabError, redactUrl, searchParams, type TorznabCaps } from '../src/sources/torznab.js';

const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures/torznab', name), 'utf8');

/** A fetch that answers with a fixed body and remembers what was asked. */
function fakeFetch(body: string | (() => never), status = 200, headers: Record<string, string> = {}) {
  const calls: URL[] = [];
  const impl = (async (input: URL | string) => {
    calls.push(new URL(String(input)));
    if (typeof body === 'function') body();
    return new Response(body as string, { status, headers });
  }) as typeof fetch;
  return { impl, calls };
}

const client = (f: ReturnType<typeof fakeFetch>) => new TorznabClient('http://prowlarr:9696/3/api', 'SECRETKEY', 5000, f.impl);

describe('Torznab caps', () => {
  it('reads which searches and categories a feed supports', async () => {
    const f = fakeFetch(fixture('caps.xml'));
    const caps = await client(f).caps();
    expect(f.calls[0]!.searchParams.get('t')).toBe('caps');
    expect(f.calls[0]!.searchParams.get('apikey')).toBe('SECRETKEY');
    expect(caps.movieSearch).toEqual({ available: true, tmdbId: true, imdbId: true });
    expect(caps.tvSearch).toEqual({ available: true, tvdbId: true, tmdbId: true, imdbId: true, season: true, episode: true });
    expect(caps.categories).toEqual([2000, 2040, 2045, 5000, 5040, 100001]);
  });

  it('handles feeds that only search by name', async () => {
    const caps = await client(fakeFetch(fixture('caps-name-only.xml'))).caps();
    expect(caps.movieSearch.available).toBe(false);
    expect(caps.tvSearch.available).toBe(false);
  });
});

describe('Torznab search results', () => {
  it('turns feed items into releases', async () => {
    const releases = await client(fakeFetch(fixture('search.xml'))).search({ kind: 'movie', title: 'Dune: Part Two', year: 2024, tmdbId: 693134 }, null);
    expect(releases).toHaveLength(2); // the item with no title is dropped
    expect(releases[0]).toEqual({
      title: 'Dune.Part.Two.2024.2160p.UHD.BluRay.x265.10bit.HDR.DDP5.1.Atmos-GROUP',
      size: 18253611008,
      seeders: 412,
      leechers: 38,
      grabs: 9001,
      publishedAt: Date.parse('2024-05-14T10:00:00Z'),
      downloadUrl: 'http://prowlarr:9696/3/download?apikey=SECRETKEY&link=abc',
      infoUrl: 'https://example.site/torrent/1001',
      guid: 'https://example.site/torrent/1001',
      infoHash: 'abcdef0123456789abcdef0123456789abcdef01',
      categories: [2000, 2045],
      imdbId: 'tt15239678',
      tmdbId: 693134,
      tvdbId: null,
      freeleech: false,
    });
    expect(releases[1]).toMatchObject({ seeders: 0, leechers: 3, freeleech: true, infoUrl: null, downloadUrl: expect.stringMatching(/^magnet:/) });
  });

  it('returns nothing for an empty feed', async () => {
    expect(await client(fakeFetch(fixture('empty.xml'))).search({ kind: 'recent' }, null)).toEqual([]);
  });

  it('asks for extended attributes and up to 100 results', async () => {
    const f = fakeFetch(fixture('empty.xml'));
    await client(f).search({ kind: 'recent' }, null);
    expect(f.calls[0]!.searchParams.get('extended')).toBe('1');
    expect(f.calls[0]!.searchParams.get('limit')).toBe('100');
  });
});

describe('choosing how to search', () => {
  const full: TorznabCaps = {
    movieSearch: { available: true, tmdbId: true, imdbId: true },
    tvSearch: { available: true, tvdbId: true, tmdbId: true, imdbId: true, season: true, episode: true },
    categories: [2000, 2040, 2045, 5000, 5040, 7000],
  };
  const imdbOnly: TorznabCaps = { ...full, movieSearch: { available: true, tmdbId: false, imdbId: true } };
  const nameOnly: TorznabCaps = {
    movieSearch: { available: false, tmdbId: false, imdbId: false },
    tvSearch: { available: false, tvdbId: false, tmdbId: false, imdbId: false, season: false, episode: false },
    categories: [2000, 5000],
  };
  const dune = { kind: 'movie' as const, title: 'Dune: Part Two', year: 2024, tmdbId: 693134, imdbId: 'tt15239678' };
  const sev = { kind: 'tv' as const, title: 'Severance', tvdbId: 371980, season: 2, episode: 3 };

  it('searches movies by TMDB ID, then IMDb ID, then name', () => {
    expect(searchParams(dune, full)).toEqual({ t: 'movie', tmdbid: '693134', cat: '2000,2040,2045' });
    expect(searchParams(dune, imdbOnly)).toEqual({ t: 'movie', imdbid: 'tt15239678', cat: '2000,2040,2045' });
    expect(searchParams(dune, nameOnly)).toEqual({ t: 'search', q: 'Dune: Part Two 2024', cat: '2000' });
  });

  it('searches TV by TVDB ID with season and episode', () => {
    expect(searchParams(sev, full)).toEqual({ t: 'tvsearch', tvdbid: '371980', season: '2', ep: '3', cat: '5000,5040' });
  });

  it('puts the episode in the words when the feed only searches by name', () => {
    expect(searchParams(sev, nameOnly)).toEqual({ t: 'search', q: 'Severance S02E03', cat: '5000' });
    expect(searchParams({ ...sev, episode: undefined }, nameOnly)).toEqual({ t: 'search', q: 'Severance S02', cat: '5000' });
  });

  it('never asks for non-video categories', () => {
    expect(searchParams(dune, full).cat).not.toContain('7000');
    expect(searchParams(dune, null).cat).toBe('2000');
  });
});

describe('Torznab problems', () => {
  const problem = async (f: ReturnType<typeof fakeFetch>) => {
    try {
      await client(f).caps();
    } catch (err) {
      return err as TorznabError;
    }
    throw new Error('expected a failure');
  };

  it('recognises a refused key, sent as an error document', async () => {
    expect((await problem(fakeFetch(fixture('error-key.xml')))).problem).toBe('key_refused');
  });

  it('recognises a refused key, sent as 401', async () => {
    expect((await problem(fakeFetch('Unauthorized', 401))).problem).toBe('key_refused');
  });

  it('recognises a bot check', async () => {
    expect((await problem(fakeFetch('<html>Just a moment... cloudflare</html>', 403))).problem).toBe('blocked');
  });

  it('recognises being asked to slow down, with the wait', async () => {
    const err = await problem(fakeFetch('', 429, { 'Retry-After': '120' }));
    expect(err.problem).toBe('slowed_down');
    expect(err.retryAfter).toBe(120);
  });

  it('recognises an address that is not a feed', async () => {
    expect((await problem(fakeFetch('<html><body>Prowlarr</body></html>'))).problem).toBe('not_a_feed');
  });

  it('recognises an unreachable feed, without leaking the key', async () => {
    const err = await problem(
      fakeFetch(() => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      }),
    );
    expect(err.problem).toBe('unreachable');
    expect(err.message).toContain('ECONNREFUSED');
    expect(err.message).not.toContain('SECRETKEY');
  });
});

describe('redactUrl', () => {
  it('hides keys in links', () => {
    expect(redactUrl('http://prowlarr:9696/3/download?apikey=SECRETKEY&link=abc')).toBe('http://prowlarr:9696/3/download?apikey=…&link=abc');
    expect(redactUrl('https://site/rss?passkey=abc123')).toBe('https://site/rss?passkey=…');
  });
});
