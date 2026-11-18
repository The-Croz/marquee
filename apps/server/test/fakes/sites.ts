import { zipSync } from 'fflate';
import type { SiteFetch, SiteRequest, SiteResponse, SolvedPage, SolverApi } from '../../src/sources/sites/http.js';

/** A fake web of torrent sites for tests and demo mode. No network. */
export class FakeWeb {
  private routes: { method: string; match: (url: string) => boolean; handle: (req: SiteRequest) => Partial<SiteResponse> & { body?: string } }[] = [];
  requests: (SiteRequest & { cookie: string })[] = [];

  on(method: 'GET' | 'POST', url: string | RegExp, handle: (req: SiteRequest) => Partial<SiteResponse> & { body?: string }): this {
    const match = typeof url === 'string' ? (u: string) => u.split('?')[0] === url : (u: string) => url.test(u);
    this.routes.unshift({ method, match, handle });
    return this;
  }

  fetch: SiteFetch = async (req) => {
    const method = req.method ?? 'GET';
    this.requests.push({ ...req, method, cookie: req.headers?.Cookie ?? '' });
    const route = this.routes.find((r) => r.method === method && r.match(req.url));
    const out = route ? route.handle(req) : { status: 404, body: 'not found' };
    return { status: out.status ?? 200, url: req.url, headers: out.headers ?? {}, setCookies: out.setCookies ?? [], body: out.body ?? '' };
  };

  /** Requests to an address, without its query. */
  to(url: string): (SiteRequest & { cookie: string })[] {
    return this.requests.filter((r) => r.url.split('?')[0] === url);
  }
}

/** A Cloudflare-style bot check page. */
export const BOT_CHECK: Partial<SiteResponse> = { status: 403, headers: { server: 'cloudflare' }, body: '<html><head><title>Just a moment...</title></head><body>challenge-platform</body></html>' };

/** A FlareSolverr stand-in: gets past the bot check by asking the fake web with the clearance cookie. */
export class FakeSolver implements SolverApi {
  calls: string[] = [];
  fail: string | null = null;
  constructor(private readonly web: FakeWeb) {}
  async ping() {
    if (this.fail) throw new Error(this.fail);
    return '3.5.2';
  }
  async solve(req: { url: string; method: 'GET' | 'POST'; body?: string; cookies: Record<string, string> }): Promise<SolvedPage> {
    if (this.fail) throw new Error(this.fail);
    this.calls.push(req.url);
    const cookies = { ...req.cookies, cf_clearance: 'solved' };
    const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await this.web.fetch({ url: req.url, method: req.method, body: req.body, headers: { Cookie: cookie, 'User-Agent': 'SolverBrowser/1.0' }, timeoutMs: 1000 });
    return { status: res.status, url: req.url, body: res.body, cookies, userAgent: 'SolverBrowser/1.0' };
  }
}

/** A zip of site files, like Prowlarr's catalogue package. */
export function catalogueZip(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, new TextEncoder().encode(text)])));
}
