import { TorznabError } from '../torznab.js';

/**
 * How Marquee talks to a site: one request at a time, following redirects
 * itself so it keeps every cookie the site sets, with the site's session
 * (cookies and browser name) kept between searches. When a bot check is in
 * the way it hands the request to the solver (FlareSolverr or compatible),
 * keeps the cookies it returns, and carries on.
 */

export interface SiteRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  /** Form or JSON body for POST. */
  body?: string;
}

export interface SiteResponse {
  status: number;
  /** Where the request ended up after redirects. */
  url: string;
  headers: Record<string, string>;
  setCookies: string[];
  body: string;
}

/** One HTTP request, no redirects followed. Tests swap this for a fake site. */
export type SiteFetch = (req: SiteRequest & { timeoutMs: number }) => Promise<SiteResponse>;

export const realSiteFetch: SiteFetch = async (req) => {
  let res: Response;
  try {
    res = await fetch(req.url, { method: req.method ?? 'GET', headers: req.headers, body: req.body, redirect: 'manual', signal: AbortSignal.timeout(req.timeoutMs) });
  } catch (err) {
    if ((err as Error).name === 'TimeoutError') throw new TorznabError('unreachable', `The site didn’t answer within ${Math.round(req.timeoutMs / 1000)} seconds.`);
    const code = (err as { cause?: { code?: string } }).cause?.code;
    throw new TorznabError('unreachable', `Couldn’t reach ${new URL(req.url).host}${code ? ` (${code})` : ''}.`);
  }
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  return { status: res.status, url: req.url, headers, setCookies: res.headers.getSetCookie(), body: await res.text() };
};

/** What the solver hands back after getting past a bot check. */
export interface SolvedPage {
  status: number;
  url: string;
  body: string;
  cookies: Record<string, string>;
  userAgent: string | null;
}

export interface SolverApi {
  /** Answers with the solver's version, or throws. */
  ping(): Promise<string>;
  solve(req: { url: string; method: 'GET' | 'POST'; body?: string; cookies: Record<string, string> }): Promise<SolvedPage>;
}

/** A site's sign-in, kept between searches (and saved with the Source). */
export interface SiteSession {
  cookies: Record<string, string>;
  userAgent: string | null;
}

export const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function parseCookieHeader(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    if (name) out[name] = part.slice(i + 1).trim();
  }
  return out;
}

/** True when the page is a bot check (Cloudflare, DDoS-Guard) rather than the site. */
export function isBotCheck(r: Pick<SiteResponse, 'status' | 'headers' | 'body'>): boolean {
  if (![403, 429, 503].includes(r.status)) return false;
  const server = (r.headers.server ?? '').toLowerCase();
  const b = r.body.slice(0, 20_000);
  return (
    /cloudflare|ddos-guard/.test(server) &&
    /Just a moment|challenge-platform|cf-browser-verification|cf_chl_|Checking your browser|ddos-guard|Attention Required/i.test(b)
  ) || /<title>\s*Just a moment\.\.\.\s*<\/title>/i.test(b);
}

export interface SiteHttpOptions {
  fetch: SiteFetch;
  session: SiteSession;
  /** Called when cookies or the browser name change, to save them. */
  saveSession: (s: SiteSession) => void;
  /** The solver to use, or null when bot-check solving is off. */
  solver: () => Promise<SolverApi | null>;
  timeoutMs: number;
}

export class SiteHttp {
  constructor(private readonly o: SiteHttpOptions) {}

  get session(): SiteSession {
    return this.o.session;
  }

  setCookies(cookies: Record<string, string>, replace = false): void {
    this.o.session.cookies = replace ? { ...cookies } : { ...this.o.session.cookies, ...cookies };
    this.o.saveSession(this.o.session);
  }

  clearCookies(): void {
    this.setCookies({}, true);
  }

  private cookieHeader(): string {
    return Object.entries(this.o.session.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  private keep(setCookies: string[]): void {
    if (!setCookies.length) return;
    const jar = { ...this.o.session.cookies };
    for (const c of setCookies) {
      const first = c.split(';')[0]!;
      const i = first.indexOf('=');
      if (i <= 0) continue;
      const name = first.slice(0, i).trim();
      const value = first.slice(i + 1).trim();
      // An expired or emptied cookie means the site wants it gone.
      if (!value || /expires=Thu, 01 Jan 1970/i.test(c) || /max-age=0\b/i.test(c)) delete jar[name];
      else jar[name] = value;
    }
    this.setCookies(jar, true);
  }

  /**
   * Sends a request, following up to 5 redirects. `redirects` lists where it
   * was sent along the way. Bot checks go to the solver when it's on.
   */
  async request(req: SiteRequest, follow = true): Promise<SiteResponse & { redirects: string[] }> {
    let current: SiteRequest = req;
    const redirects: string[] = [];
    for (let hop = 0; hop < 6; hop++) {
      const headers: Record<string, string> = { 'User-Agent': this.o.session.userAgent ?? DEFAULT_USER_AGENT, Accept: 'text/html,application/json;q=0.9,*/*;q=0.8', ...current.headers };
      const cookie = this.cookieHeader();
      if (cookie) headers.Cookie = headers.Cookie ? `${headers.Cookie}; ${cookie}` : cookie;
      let res = await this.o.fetch({ ...current, headers, timeoutMs: this.o.timeoutMs });
      this.keep(res.setCookies);
      if (isBotCheck(res)) res = await this.solve(current);
      const location = res.headers.location;
      if (follow && res.status >= 300 && res.status < 400 && location) {
        const next = new URL(location, current.url).toString();
        redirects.push(next);
        // After a POST, browsers fetch the next page with GET.
        current = { url: next, method: 'GET', headers: req.headers };
        continue;
      }
      return { ...res, url: current.url, redirects };
    }
    throw new TorznabError('error', 'The site sent Marquee round in circles (too many redirects).');
  }

  private async solve(req: SiteRequest): Promise<SiteResponse> {
    const solver = await this.o.solver();
    if (!solver) throw new TorznabError('blocked', 'The site put a bot check in front of its pages. Turn on bot-check solving in Settings → Sources.');
    let page: SolvedPage;
    try {
      page = await solver.solve({ url: req.url, method: req.method ?? 'GET', body: req.body, cookies: this.o.session.cookies });
    } catch (err) {
      throw new TorznabError('blocked', `The bot-check solver couldn’t get past it: ${(err as Error).message}`);
    }
    this.o.session.userAgent = page.userAgent ?? this.o.session.userAgent;
    this.setCookies(page.cookies);
    if (isBotCheck({ status: page.status, headers: {}, body: page.body })) throw new TorznabError('blocked', 'The bot-check solver got the bot check again. It may need an update, or try another solver under For experts.');
    // The solver shows JSON wrapped in a page; unwrap it.
    const pre = /^\s*<html[^>]*>\s*<head>.*?<\/head>\s*<body>\s*<pre[^>]*>([\s\S]*)<\/pre>\s*<\/body>\s*<\/html>\s*$/i.exec(page.body);
    return { status: page.status, url: page.url, headers: {}, setCookies: [], body: pre ? pre[1]!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : page.body };
  }
}
