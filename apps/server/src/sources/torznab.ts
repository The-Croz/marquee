import { XMLParser } from 'fast-xml-parser';

/**
 * A Torznab feed: one torrent site as served by Prowlarr or Jackett
 * (e.g. http://prowlarr:9696/12/api). Read-only: Marquee asks for search
 * results and never changes anything on the other end.
 *
 * Spec: https://torznab.github.io/spec-1.3-draft/torznab/Specification-v1.3.html
 */

/** Torznab categories we search. 2000 = Movies, 5000 = TV; their subcategories are 2xxx / 5xxx. */
export const MOVIE_CATEGORY = 2000;
export const TV_CATEGORY = 5000;

export interface TorznabCaps {
  /** Whether the feed can search by these IDs (better than searching by name). */
  movieSearch: { available: boolean; tmdbId: boolean; imdbId: boolean };
  tvSearch: { available: boolean; tvdbId: boolean; tmdbId: boolean; imdbId: boolean; season: boolean; episode: boolean };
  /** Category IDs the feed offers, including subcategories. */
  categories: number[];
}

/** One search result: a copy of a title someone is sharing. */
export interface Release {
  title: string;
  /** Bytes; null when the feed doesn't say. */
  size: number | null;
  seeders: number | null;
  leechers: number | null;
  grabs: number | null;
  publishedAt: number | null;
  /** The torrent or magnet link. Carries the feed's API key: server-side only, never sent to the browser or logged. */
  downloadUrl: string;
  /** The site's page for this copy, if any. Safe to show. */
  infoUrl: string | null;
  guid: string;
  infoHash: string | null;
  categories: number[];
  imdbId: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
  /** True when downloading it doesn't count against your ratio (private sites). */
  freeleech: boolean;
}

export type SearchQuery =
  | { kind: 'movie'; title: string; year: number | null; tmdbId?: number | null; imdbId?: string | null }
  | { kind: 'tv'; title: string; tvdbId?: number | null; tmdbId?: number | null; imdbId?: string | null; season?: number; episode?: number }
  /** Newest copies with no search terms, used to check a feed works. */
  | { kind: 'recent' };

/** Why a call failed, in a form the UI can turn into a plain sentence and a fix. */
export type TorznabProblem = 'unreachable' | 'key_refused' | 'slowed_down' | 'blocked' | 'not_a_feed' | 'error';

export class TorznabError extends Error {
  constructor(
    readonly problem: TorznabProblem,
    message: string,
    /** Seconds the feed asked us to wait, if it said. */
    readonly retryAfter: number | null = null,
  ) {
    super(message);
  }
}

export interface TorznabApi {
  caps(): Promise<TorznabCaps>;
  search(query: SearchQuery, caps: TorznabCaps | null): Promise<Release[]>;
}

/** Hides API keys in a URL so it can go in a log or an error message. */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:apikey|api_key|passkey|key|token)=)[^&#]*/gi, '$1…');
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => ['item', 'attr', 'category', 'subcat'].includes(name),
});

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const num = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export class TorznabClient implements TorznabApi {
  constructor(
    private readonly url: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 30_000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async get(params: Record<string, string>): Promise<Record<string, any>> {
    const u = new URL(this.url);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    if (this.apiKey) u.searchParams.set('apikey', this.apiKey);

    let res: Response;
    try {
      res = await this.fetchImpl(u, { headers: { Accept: 'application/rss+xml, application/xml, text/xml' }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      if ((err as Error).name === 'TimeoutError') throw new TorznabError('unreachable', `No answer after ${Math.round(this.timeoutMs / 1000)} seconds.`);
      const cause = (err as { cause?: { code?: string } }).cause?.code;
      throw new TorznabError('unreachable', `Couldn't reach ${new URL(this.url).host}${cause ? ` (${cause})` : ''}.`);
    }

    const body = await res.text();
    if (res.status === 401 || res.status === 403) {
      if (/cloudflare|cf-ray|captcha|just a moment/i.test(body)) throw new TorznabError('blocked', 'The site has a bot check in front of it.');
      throw new TorznabError('key_refused', 'The API key was not accepted.');
    }
    if (res.status === 429) {
      const wait = num(res.headers.get('retry-after'));
      throw new TorznabError('slowed_down', 'The site asked us to slow down.', wait);
    }

    let doc: Record<string, any>;
    try {
      doc = xml.parse(body) as Record<string, any>;
    } catch {
      throw new TorznabError('not_a_feed', "The answer isn't a Torznab feed.");
    }

    // Torznab reports problems as <error code="..." description="..."/>, often with HTTP 200.
    if (doc.error) {
      const code = Number(doc.error.code);
      const description = String(doc.error.description ?? '').trim();
      if (code === 100 || code === 101 || /api ?key/i.test(description)) throw new TorznabError('key_refused', 'The API key was not accepted.');
      if (code === 429 || /limit|too many/i.test(description)) throw new TorznabError('slowed_down', description || 'The site asked us to slow down.');
      throw new TorznabError('error', description ? `The feed said: ${description}` : `The feed reported error ${code}.`);
    }
    if (!res.ok) throw new TorznabError('error', `The feed answered ${res.status}.`);
    if (!doc.caps && !doc.rss) throw new TorznabError('not_a_feed', "The answer isn't a Torznab feed. Check the address.");
    return doc;
  }

  async caps(): Promise<TorznabCaps> {
    const doc = await this.get({ t: 'caps' });
    const caps = doc.caps;
    if (!caps) throw new TorznabError('not_a_feed', "The answer isn't a Torznab feed. Check the address.");
    const params = (s: Record<string, string> | undefined) =>
      new Set(
        String(s?.supportedParams ?? '')
          .toLowerCase()
          .split(',')
          .map((p) => p.trim()),
      );
    const movie = caps.searching?.['movie-search'];
    const tv = caps.searching?.['tv-search'];
    const mp = params(movie);
    const tp = params(tv);
    const categories: number[] = [];
    for (const c of asArray<Record<string, any>>(caps.categories?.category)) {
      const id = num(c.id);
      if (id !== null) categories.push(id);
      for (const s of asArray<Record<string, any>>(c.subcat)) {
        const sid = num(s.id);
        if (sid !== null) categories.push(sid);
      }
    }
    return {
      movieSearch: { available: movie?.available === 'yes', tmdbId: mp.has('tmdbid'), imdbId: mp.has('imdbid') },
      tvSearch: {
        available: tv?.available === 'yes',
        tvdbId: tp.has('tvdbid'),
        tmdbId: tp.has('tmdbid'),
        imdbId: tp.has('imdbid'),
        season: tp.has('season'),
        episode: tp.has('ep'),
      },
      categories,
    };
  }

  async search(query: SearchQuery, caps: TorznabCaps | null): Promise<Release[]> {
    const doc = await this.get({ ...searchParams(query, caps), extended: '1', limit: '100' });
    return asArray<Record<string, any>>(doc.rss?.channel?.item).flatMap((item) => {
      const r = toRelease(item);
      return r ? [r] : [];
    });
  }
}

/**
 * Picks the best way to ask: by ID when the feed supports it (exact), else by
 * name. Only movie or TV categories, so ebook and music sites never answer.
 */
export function searchParams(query: SearchQuery, caps: TorznabCaps | null): Record<string, string> {
  if (query.kind === 'recent') return { t: 'search' };

  const offered = (base: number) => (caps?.categories ?? []).filter((c) => Math.floor(c / 1000) * 1000 === base);
  if (query.kind === 'movie') {
    const cat = (offered(MOVIE_CATEGORY).length ? offered(MOVIE_CATEGORY) : [MOVIE_CATEGORY]).join(',');
    const m = caps?.movieSearch;
    if (m?.available && m.tmdbId && query.tmdbId) return { t: 'movie', tmdbid: String(query.tmdbId), cat };
    if (m?.available && m.imdbId && query.imdbId) return { t: 'movie', imdbid: query.imdbId, cat };
    return { t: m?.available ? 'movie' : 'search', q: query.year ? `${query.title} ${query.year}` : query.title, cat };
  }

  const cat = (offered(TV_CATEGORY).length ? offered(TV_CATEGORY) : [TV_CATEGORY]).join(',');
  const tv = caps?.tvSearch;
  const out: Record<string, string> = { t: tv?.available ? 'tvsearch' : 'search', cat };
  if (tv?.available && tv.tvdbId && query.tvdbId) out.tvdbid = String(query.tvdbId);
  else if (tv?.available && tv.tmdbId && query.tmdbId) out.tmdbid = String(query.tmdbId);
  else if (tv?.available && tv.imdbId && query.imdbId) out.imdbid = query.imdbId;
  else out.q = query.title;

  if (tv?.available) {
    if (query.season !== undefined) out.season = String(query.season);
    if (query.episode !== undefined) out.ep = String(query.episode);
  } else if (query.season !== undefined) {
    // Plain search: put the episode in the words, e.g. "Severance S02E03" or "Severance S02".
    const s = `S${String(query.season).padStart(2, '0')}`;
    out.q = `${out.q ?? query.title} ${s}${query.episode !== undefined ? `E${String(query.episode).padStart(2, '0')}` : ''}`;
  }
  return out;
}

function toRelease(item: Record<string, any>): Release | null {
  const attrs = new Map<string, string>();
  const attrCategories: string[] = [];
  for (const a of asArray<Record<string, string>>(item.attr)) {
    if (!a.name) continue;
    if (a.name.toLowerCase() === 'category') attrCategories.push(a.value ?? '');
    else attrs.set(a.name.toLowerCase(), a.value ?? '');
  }

  const title = String(item.title ?? '').trim();
  const enclosure = item.enclosure as Record<string, string> | undefined;
  const downloadUrl = String(enclosure?.url || item.link || attrs.get('magneturl') || '');
  if (!title || !downloadUrl) return null;

  const seeders = num(attrs.get('seeders'));
  const peers = num(attrs.get('peers'));
  const imdb = attrs.get('imdbid') ?? attrs.get('imdb');
  const published = item.pubDate ? Date.parse(String(item.pubDate)) : NaN;
  const comments = typeof item.comments === 'string' ? item.comments : null;
  const guid = typeof item.guid === 'string' ? item.guid : String(item.guid?.['#text'] ?? downloadUrl);

  return {
    title,
    size: num(attrs.get('size')) ?? num(item.size) ?? num(enclosure?.length),
    seeders,
    leechers: peers !== null && seeders !== null ? Math.max(0, peers - seeders) : num(attrs.get('leechers')),
    grabs: num(attrs.get('grabs')),
    publishedAt: Number.isNaN(published) ? null : published,
    downloadUrl,
    infoUrl: comments && /^https?:\/\//i.test(comments) ? comments : null,
    guid,
    infoHash: attrs.get('infohash')?.toLowerCase() ?? null,
    categories: [...new Set([...asArray<string>(item.category), ...attrCategories].map(Number).filter((n) => Number.isFinite(n)))],
    imdbId: imdb ? (imdb.startsWith('tt') ? imdb : `tt${imdb.padStart(7, '0')}`) : null,
    tmdbId: num(attrs.get('tmdbid')) || null,
    tvdbId: num(attrs.get('tvdbid')) || null,
    freeleech: attrs.get('downloadvolumefactor') === '0',
  };
}
