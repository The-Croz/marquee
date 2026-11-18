import { TorznabError, type Release, type SearchQuery, type TorznabCaps } from '../../torznab.js';
import type { BuiltinSite } from './types.js';

/**
 * Knaben, ported from Prowlarr (GPL-3.0): a public search across many
 * sites, asked through its JSON search service.
 */

const API = 'https://api.knaben.org/v1';
const MOVIES: Record<number, number> = { 3000000: 2000, 3001000: 2040, 3002000: 2030, 3003000: 2045, 3004000: 2070, 3005000: 2010, 3006000: 2010, 3007000: 2060, 3008000: 2020 };
const TV: Record<number, number> = { 2000000: 5000, 2001000: 5040, 2002000: 5030, 2003000: 5045, 2004000: 5080, 2005000: 5020, 2006000: 5060, 2007000: 5050, 2008000: 5050 };
const ALL: Record<number, number> = { ...MOVIES, ...TV };

interface Hit {
  title?: string;
  categoryId?: number[];
  hash?: string;
  details?: string;
  link?: string;
  magnetUrl?: string;
  bytes?: number;
  seeders?: number;
  peers?: number;
  date?: string;
}

export const knaben: BuiltinSite = {
  summary: { id: 'knaben', name: 'Knaben', description: 'Knaben searches many public torrent sites at once.', type: 'public', language: 'en-US', origin: 'builtin', movies: true, tv: true, unsupported: null },
  links: ['https://knaben.org/'],
  fields: [],
  create({ http }) {
    return {
      async caps(): Promise<TorznabCaps> {
        return {
          movieSearch: { available: true, tmdbId: false, imdbId: false },
          tvSearch: { available: true, tvdbId: false, tmdbId: false, imdbId: false, season: true, episode: true },
          categories: [...new Set(Object.values(ALL))],
        };
      },
      async search(query: SearchQuery): Promise<Release[]> {
        const kind = query.kind === 'recent' ? (query.for ?? 'movie') : query.kind;
        const body: Record<string, unknown> = { order_by: 'date', order_direction: 'desc', from: 0, size: 100, hide_unsafe: true, categories: Object.keys(kind === 'movie' ? MOVIES : TV).map(Number) };
        if (query.kind !== 'recent') {
          let term = query.title;
          if (query.kind === 'movie' && query.year) term += ` ${query.year}`;
          if (query.kind === 'tv' && query.season !== undefined) term += ` S${String(query.season).padStart(2, '0')}${query.episode !== undefined ? `E${String(query.episode).padStart(2, '0')}` : ''}`;
          Object.assign(body, { search_type: '100%', search_field: 'title', query: term });
        }
        const res = await http.request({ url: API, method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
        if (res.status === 429) throw new TorznabError('slowed_down', 'Knaben asked Marquee to slow down.');
        if (res.status !== 200) throw new TorznabError(res.status >= 500 ? 'unreachable' : 'error', `Knaben answered ${res.status}.`);
        let hits: Hit[];
        try {
          hits = (JSON.parse(res.body) as { hits?: Hit[] }).hits ?? [];
        } catch {
          throw new TorznabError('error', 'Knaben answered with something Marquee couldn’t read.');
        }
        return hits
          .filter((h) => (h.seeders ?? 0) > 0 && h.title && (h.link || h.magnetUrl))
          .map((h): Release => {
            const date = h.date && !/[+-]\d{2}:\d{2}$|Z$/.test(h.date) ? `${h.date}+01:00` : h.date;
            const published = date ? Date.parse(date) : NaN;
            return {
              title: h.title!,
              size: h.bytes ?? null,
              seeders: h.seeders ?? null,
              leechers: h.peers ?? null,
              grabs: null,
              publishedAt: Number.isNaN(published) ? null : published,
              downloadUrl: (h.magnetUrl || h.link)!,
              infoUrl: h.details ?? null,
              guid: h.details ?? h.hash ?? h.title!,
              infoHash: h.hash?.toLowerCase() ?? null,
              categories: [...new Set((h.categoryId ?? []).map((c) => ALL[c]).filter((c): c is number => c !== undefined))],
              imdbId: null,
              tmdbId: null,
              tvdbId: null,
              freeleech: true,
            };
          });
      },
    };
  },
};
