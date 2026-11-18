import { load } from 'cheerio';
import { TorznabError, type Release, type SearchQuery, type TorznabCaps } from '../../torznab.js';
import { parseCookieHeader } from '../http.js';
import { fromTimeAgo, parseBytes, parseCount } from '../text.js';
import type { BuiltinSite } from './types.js';

/**
 * IPTorrents, ported from Prowlarr (GPL-3.0). Signs in with your browser's
 * cookie and user agent; searches /t and reads the results table by its
 * column headings.
 */

const MOVIES: Record<string, number> = { 72: 2000, 87: 2060, 77: 2030, 101: 2045, 89: 2040, 90: 2030, 96: 2030, 6: 2070, 48: 2050, 54: 2000, 62: 2030, 38: 2010, 68: 2000, 20: 2080, 7: 2030, 100: 2000 };
const TV: Record<string, number> = { 73: 5000, 26: 5080, 55: 5060, 78: 5030, 23: 5040, 24: 5030, 25: 5030, 66: 5030, 82: 5020, 65: 5000, 83: 5020, 79: 5030, 22: 5010, 5: 5040, 99: 5040, 4: 5030 };
const ALL: Record<string, number> = { ...MOVIES, ...TV };

function cleanTitle(t: string): string {
  return t
    .replace(/[\u0000-\u0008\u000A-\u001FĀ-￿]/g, '')
    .replace(/[([{]REQ(UEST(ED)?)?[)\]}]/gi, '')
    .replace(/^\[[a-z0-9 ._-]+\][-._ ](.*-[a-z0-9]+)$/i, '$1')
    .replace(/^[\s\-:]+|[\s\-:]+$/g, '');
}

export const iptorrents: BuiltinSite = {
  summary: { id: 'iptorrents', name: 'IPTorrents', description: 'IPTorrents (IPT) is a private site for general content.', type: 'private', language: 'en-US', origin: 'builtin', movies: true, tv: true, unsupported: null },
  links: ['https://iptorrents.com/', 'https://iptorrents.me/', 'https://nemo.iptorrents.com/', 'https://ipt.getcrazy.me/', 'https://ipt.findnemo.net/', 'https://ipt.beelyrics.net/', 'https://ipt.venom.global/', 'https://ipt.workisboring.net/', 'https://ipt.lol/', 'https://ipt.cool/', 'https://ipt.world/', 'https://ipt.octopus.town/'],
  fields: [
    { name: 'cookie', type: 'password', label: 'Cookie', secret: true, default: null },
    { name: 'info_cookie', type: 'info', label: 'About the cookie', text: 'Sign in to IPTorrents in your browser, open the developer tools (F12) → Network, reload, click the first request and copy the whole “Cookie” line from its request headers.' },
    { name: 'userAgent', type: 'text', label: 'Browser user agent', default: null },
    { name: 'info_ua', type: 'info', label: 'About the user agent', text: 'IPTorrents ties the cookie to your browser. Copy your browser’s user agent (search “what is my user agent”) from the same browser.' },
    { name: 'freeleech', type: 'checkbox', label: 'Only copies that don’t count against your ratio', default: false },
  ],
  create({ settings, baseUrl, http }) {
    const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const ready = () => {
      const cookie = String(settings.cookie ?? '');
      if (!cookie.trim()) throw new TorznabError('sign_in_failed', 'Paste your IPTorrents cookie into its settings.');
      http.setCookies(parseCookieHeader(cookie), true);
      if (settings.userAgent) http.session.userAgent = String(settings.userAgent);
    };
    return {
      async caps(): Promise<TorznabCaps> {
        return {
          movieSearch: { available: true, tmdbId: false, imdbId: true },
          tvSearch: { available: true, tvdbId: false, tmdbId: false, imdbId: true, season: true, episode: true },
          categories: [...new Set(Object.values(ALL))],
        };
      },
      async search(query: SearchQuery): Promise<Release[]> {
        ready();
        const kind = query.kind === 'recent' ? (query.for ?? 'movie') : query.kind;
        const params = new URLSearchParams();
        for (const c of Object.keys(kind === 'movie' ? MOVIES : TV)) params.append(c, '');
        if (settings.freeleech === true || settings.freeleech === 'true') params.append('free', 'on');
        if (query.kind !== 'recent') {
          let term = query.title;
          if (query.kind === 'movie' && query.year) term += ` ${query.year}`;
          if (query.kind === 'tv' && query.season !== undefined) term += ` S${String(query.season).padStart(2, '0')}${query.episode !== undefined ? `E${String(query.episode).padStart(2, '0')}` : ''}`;
          if (query.imdbId) {
            params.append('q', `+(${query.imdbId})`);
            params.append('qf', 'all');
          }
          params.append('q', `+(${term})`);
          params.append('o', 'time');
        }
        const res = await http.request({ url: `${base}t?${params.toString().replace(/=(&|$)/g, '$1')}` });
        if (res.status === 401 || res.status === 403) throw new TorznabError('sign_in_failed', 'IPTorrents turned the cookie down. Copy a fresh one (and the user agent) from your browser.');
        if (res.status >= 400) throw new TorznabError(res.status >= 500 ? 'unreachable' : 'error', `IPTorrents answered ${res.status}.`);
        if (!res.body.includes('lout.php')) throw new TorznabError('sign_in_failed', 'IPTorrents doesn’t see you as signed in with that cookie. Copy a fresh cookie and the user agent from the same browser.');
        const $ = load(res.body);
        const headings = $('table[id="torrents"] > thead > tr > th').toArray().map((th) => $(th).text().trim());
        const col = (name: string, fallback: number) => {
          const i = headings.indexOf(name);
          return i >= 0 ? i : fallback;
        };
        const sizeAt = col('Sort by size', 5);
        const out: Release[] = [];
        for (const tr of $('table[id="torrents"] > tbody > tr').toArray()) {
          const row = $(tr);
          const titleLink = row.find('a.hv').first();
          if (!titleLink.length) continue;
          const cells = row.children().toArray();
          const catLink = row.find('td:nth-of-type(1) a[href^="?"]').first();
          if (!catLink.length) throw new TorznabError('error', 'Set IPTorrents’ “Torrents - Category column” option to “Icons” in your settings on the site, wait a minute, then try again.');
          let at = cells.length === 10 ? 7 : 6;
          const grabsAt = col('Sort by snatches', at++);
          const seedsAt = col('Sort by seeders', at++);
          const leechAt = col('Sort by leechers', at);
          const cell = (i: number) => $(cells[i]!).text();
          const details = new URL(titleLink.attr('href')!.replace(/^\//, ''), base).toString();
          const link = new URL(row.find('a[href^="/download.php/"]').first().attr('href')!.replace(/^\//, ''), base).toString();
          const when = row.find('div.sub').text().split('|').at(-1)!.split(' by ')[0]!;
          const cat = ALL[catLink.attr('href')!.slice(1)];
          const cookieHeader = () => ({
            url: link,
            headers: {
              Cookie: Object.entries(http.session.cookies).map(([k, v]) => `${k}=${v}`).join('; '),
              ...(http.session.userAgent ? { 'User-Agent': http.session.userAgent } : {}),
            },
          });
          out.push({
            title: cleanTitle(titleLink.text()),
            size: parseBytes(cell(sizeAt)),
            seeders: parseCount(cell(seedsAt)),
            leechers: parseCount(cell(leechAt)),
            grabs: parseCount(cell(grabsAt)),
            publishedAt: fromTimeAgo(when, Date.now()),
            downloadUrl: link,
            infoUrl: details,
            guid: details,
            infoHash: null,
            categories: cat ? [cat] : [],
            imdbId: null,
            tmdbId: null,
            tvdbId: null,
            freeleech: row.find('span.free').length > 0,
            resolveDownload: async () => cookieHeader(),
          });
        }
        return out;
      },
    };
  },
};
