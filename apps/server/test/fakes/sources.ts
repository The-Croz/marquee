import type { ProwlarrApi, ProwlarrSite } from '../../src/sources/prowlarr.js';
import { ProwlarrError } from '../../src/sources/prowlarr.js';
import { TorznabError, type Release, type SearchQuery, type TorznabApi, type TorznabCaps } from '../../src/sources/torznab.js';

/** Fake Prowlarr and Torznab feeds for tests and demo mode. No network. */

export const FULL_CAPS: TorznabCaps = {
  movieSearch: { available: true, tmdbId: true, imdbId: true },
  tvSearch: { available: true, tvdbId: true, tmdbId: true, imdbId: true, season: true, episode: true },
  categories: [2000, 2040, 2045, 5000, 5040],
};

export function release(title: string, extra: Partial<Release> = {}): Release {
  return {
    title,
    size: 10 * 1024 ** 3,
    seeders: 50,
    leechers: 5,
    grabs: 100,
    publishedAt: Date.parse('2024-05-01T00:00:00Z'),
    downloadUrl: `http://prowlarr:9696/1/download?apikey=SECRET&file=${encodeURIComponent(title)}`,
    infoUrl: null,
    guid: title,
    infoHash: null,
    categories: [2000],
    imdbId: null,
    tmdbId: null,
    tvdbId: null,
    freeleech: false,
    ...extra,
  };
}

export interface FakeFeed {
  caps?: TorznabCaps;
  releases?: Release[];
  /** Fail every call with this problem. */
  fail?: TorznabError;
  /** Remembers each search. */
  searches?: SearchQuery[];
  /** Searches wait for this before answering (a slow site). */
  gate?: Promise<void>;
}

/** A set of fake feeds keyed by URL, plus a Prowlarr that lists them. */
export class FakeSites {
  feeds = new Map<string, FakeFeed>();
  prowlarrSites: ProwlarrSite[] = [];
  prowlarrKey = 'prowlarr-key';
  prowlarrVersion = '2.0.5';

  feed(url: string, feed: FakeFeed): this {
    this.feeds.set(url, { searches: [], ...feed });
    return this;
  }

  torznab = (url: string, apiKey: string): TorznabApi => {
    const feed = () => {
      const f = this.feeds.get(url);
      if (!f) throw new TorznabError('unreachable', `Couldn't reach ${new URL(url).host} (ECONNREFUSED).`);
      if (apiKey !== 'good' && apiKey !== this.prowlarrKey) throw new TorznabError('key_refused', 'The API key was not accepted.');
      if (f.fail) throw f.fail;
      return f;
    };
    return {
      caps: async () => feed().caps ?? FULL_CAPS,
      search: async (query) => {
        const f = feed();
        f.searches!.push(query);
        if (f.gate) await f.gate;
        return f.releases ?? [];
      },
    };
  };

  prowlarr = (url: string, apiKey: string): ProwlarrApi => {
    const check = () => {
      if (!url.includes('prowlarr')) throw new ProwlarrError(`Couldn't reach Prowlarr at ${url} (ECONNREFUSED).`);
      if (apiKey !== this.prowlarrKey) throw new ProwlarrError('Prowlarr turned down the API key. Copy it again from Prowlarr → Settings → General.');
    };
    return {
      ping: async () => {
        check();
        return { version: this.prowlarrVersion };
      },
      sites: async () => {
        check();
        return this.prowlarrSites;
      },
    };
  };
}

export function site(id: number, name: string, extra: Partial<ProwlarrSite> = {}): ProwlarrSite {
  return { id, name, enabled: true, protocol: 'torrent', privacy: 'public', priority: 25, categories: [2000, 2040, 5000, 5040], definitionName: null, settings: {}, ...extra };
}
