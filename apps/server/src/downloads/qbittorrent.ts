/**
 * qBittorrent Web API v2 client. Read-only for now (Milestone 3, PR 1):
 * it signs in and reads versions, preferences, connection status, free
 * space and categories so Settings → Downloader can say whether it works.
 *
 * The password is only ever sent to the address it was saved with, and is
 * never put in an error message.
 */

export type QbitFailure = 'unreachable' | 'password_refused' | 'banned' | 'not_qbittorrent' | 'error';

export class QbitError extends Error {
  constructor(
    readonly kind: QbitFailure,
    message: string,
  ) {
    super(message);
  }
}

/** qBittorrent's own view of its internet connection. */
export type QbitConnection = 'connected' | 'firewalled' | 'disconnected';

export interface QbitStatus {
  /** e.g. "5.0.4" */
  version: string;
  /** Web API version, e.g. "2.11.2" */
  apiVersion: string;
  connection: QbitConnection;
  /** Bytes free where qBittorrent saves, or null if it didn't say. */
  freeSpace: number | null;
  /** qBittorrent's default save folder, as qBittorrent sees it. */
  savePath: string;
  /** Category name → its save folder ("" means the default). */
  categories: Record<string, string>;
}

export interface QbitApi {
  /** Signs in if needed and reads everything the health check needs. Throws QbitError. */
  status(): Promise<QbitStatus>;
}

export class QbitClient implements QbitApi {
  private cookie: string | null = null;
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly username: string,
    private readonly password: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  private async send(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    // qBittorrent's CSRF check wants a Referer or Origin from its own address.
    headers.set('Referer', `${this.base}/`);
    if (this.cookie) headers.set('Cookie', this.cookie);
    try {
      return await this.fetchImpl(`${this.base}/api/v2${path}`, { ...init, headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      const e = err as { name?: string; cause?: { code?: string } };
      const why = e.name === 'TimeoutError' ? 'no answer in time' : e.cause?.code;
      throw new QbitError('unreachable', `Couldn't reach qBittorrent at ${this.base}${why ? ` (${why})` : ''}.`);
    }
  }

  private async login(): Promise<void> {
    const body = new URLSearchParams({ username: this.username, password: this.password });
    const res = await this.send('/auth/login', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    if (res.status === 403) throw new QbitError('banned', 'qBittorrent has blocked Marquee for a while after too many wrong passwords.');
    if (res.status === 404) throw new QbitError('not_qbittorrent', `${this.base} answers, but it isn't qBittorrent's web page.`);
    const text = (await res.text()).trim();
    if (!res.ok) throw new QbitError('error', `qBittorrent answered ${res.status} when signing in.`);
    if (text !== 'Ok.') throw new QbitError('password_refused', 'qBittorrent turned down the username or password.');
    const set = res.headers.get('set-cookie');
    // The cookie is SID, or QBT_SID_<port> on newer versions; keep whichever came.
    this.cookie = set ? set.split(';')[0]! : null;
  }

  /** A GET that signs in on the first 403 (or never, if qBittorrent lets this address in without one). */
  private async get(path: string): Promise<Response> {
    let res = await this.send(path);
    if (res.status === 403) {
      await this.login();
      res = await this.send(path);
      if (res.status === 403) throw new QbitError('password_refused', 'qBittorrent turned down the username or password.');
    }
    if (res.status === 404) throw new QbitError('not_qbittorrent', `${this.base} answers, but it isn't qBittorrent's web page.`);
    if (!res.ok) throw new QbitError('error', `qBittorrent answered ${res.status}.`);
    return res;
  }

  private async json<T>(path: string): Promise<T> {
    const res = await this.get(path);
    try {
      return (await res.json()) as T;
    } catch {
      throw new QbitError('not_qbittorrent', `${this.base} answers, but not like qBittorrent does.`);
    }
  }

  async status(): Promise<QbitStatus> {
    const version = (await (await this.get('/app/version')).text()).trim();
    if (!/^v?\d+\.\d+/.test(version)) throw new QbitError('not_qbittorrent', `${this.base} answers, but not like qBittorrent does.`);
    const apiVersion = (await (await this.get('/app/webapiVersion')).text()).trim();
    const prefs = await this.json<{ save_path?: string }>('/app/preferences');
    const transfer = await this.json<{ connection_status?: string }>('/transfer/info');
    const main = await this.json<{ server_state?: { free_space_on_disk?: number } }>('/sync/maindata?rid=0');
    const cats = await this.json<Record<string, { name: string; savePath?: string }>>('/torrents/categories');
    const conn = transfer.connection_status;
    return {
      version: version.replace(/^v/, ''),
      apiVersion,
      connection: conn === 'connected' || conn === 'firewalled' ? conn : 'disconnected',
      freeSpace: typeof main.server_state?.free_space_on_disk === 'number' ? main.server_state.free_space_on_disk : null,
      savePath: (prefs.save_path ?? '').replace(/\/+$/, '') || '/',
      categories: Object.fromEntries(Object.values(cats).map((c) => [c.name, c.savePath ?? ''])),
    };
  }
}

/** Is a Web API version at least 2.8 (qBittorrent 4.5)? */
export function apiAtLeast(version: string, major = 2, minor = 8): boolean {
  const [a = 0, b = 0] = version.split('.').map((n) => Number(n) || 0);
  return a > major || (a === major && b >= minor);
}
