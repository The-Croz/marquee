/**
 * qBittorrent Web API v2 client. It reads versions, preferences, connection
 * status, free space, categories and torrents, and adds torrents under
 * Marquee's category. It never touches torrents in other categories.
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

/** A torrent as qBittorrent lists it (only the fields Marquee uses). */
export interface QbitTorrent {
  hash: string;
  name: string;
  category: string;
  /** qBittorrent's state word, e.g. "downloading", "stalledDL". Never shown as-is. */
  state: string;
  /** 0 to 1. */
  progress: number;
  size: number;
  savePath: string;
  /** Bytes a second. */
  downloadSpeed: number;
  /** Seconds left; qBittorrent says 8640000 for "unknown". */
  eta: number;
  /** People sharing the whole copy that we're connected to, and how many the trackers know of. */
  seedsConnected: number;
  seedsKnown: number;
  /** Where the download is, as qBittorrent sees it. */
  contentPath: string;
  /** Uploaded ÷ downloaded. */
  ratio: number;
  /** Seconds spent sharing the whole copy. */
  seedingSeconds: number;
  /** Bytes a second going out. */
  uploadSpeed?: number;
  /** People connected who don't have the whole copy yet, and how many the trackers know of. */
  peersConnected?: number;
  peersKnown?: number;
  /** Bytes fetched and shared so far. */
  downloaded?: number;
  uploaded?: number;
  /** When qBittorrent added it and finished it (ms); null when not finished. */
  addedOn?: number | null;
  completedOn?: number | null;
  /** The tracker it's talking to right now (its address, which may carry a key: never sent to the browser as-is). */
  tracker?: string;
  tags?: string[];
  /** Seconds it has been running. */
  activeSeconds?: number;
}

export interface QbitFile {
  name: string;
  size: number;
  /** 0 to 1, when qBittorrent says. */
  progress?: number;
}

/** What to add: the .torrent file's bytes, or a magnet link. */
export type TorrentPayload = { kind: 'file'; bytes: Uint8Array; name: string } | { kind: 'magnet'; uri: string };

export interface QbitApi {
  /** Signs in if needed and reads everything the health check needs. Throws QbitError. */
  status(): Promise<QbitStatus>;
  /** Just qBittorrent's view of its internet connection (one light call). Throws QbitError. */
  connection(): Promise<QbitConnection>;
  /** Torrents with these info-hashes (lowercase hex), in any category. */
  torrents(hashes: string[]): Promise<QbitTorrent[]>;
  /** Makes a category if it doesn't exist yet. */
  ensureCategory(name: string): Promise<void>;
  add(payload: TorrentPayload, opts: { category: string; tags: string[] }): Promise<void>;
  /** The files inside a torrent (empty until it has fetched its file list). */
  files(hash: string): Promise<QbitFile[]>;
  pause(hash: string): Promise<void>;
  resume(hash: string): Promise<void>;
  /** Removes a torrent from qBittorrent, and its files when asked. */
  remove(hash: string, deleteFiles: boolean): Promise<void>;
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
    // Older versions answer 200 "Fails."; 5.2+ may answer 401.
    if (res.status === 401 || text === 'Fails.') throw new QbitError('password_refused', 'qBittorrent turned down the username or password.');
    if (!res.ok) throw new QbitError('error', `qBittorrent answered ${res.status} when signing in.`);
    // Success is 200 "Ok." before qBittorrent 5.2, and 204 with no body from 5.2 on.
    if (text !== 'Ok.' && res.status !== 204 && text !== '') throw new QbitError('not_qbittorrent', `${this.base} answers, but not like qBittorrent does.`);
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

  /** A form POST that signs in on the first 403, like `get`. */
  private async post(path: string, body: FormData | URLSearchParams): Promise<Response> {
    let res = await this.send(path, { method: 'POST', body });
    if (res.status === 403) {
      await this.login();
      res = await this.send(path, { method: 'POST', body });
      if (res.status === 403) throw new QbitError('password_refused', 'qBittorrent turned down the username or password.');
    }
    if (res.status === 404) throw new QbitError('not_qbittorrent', `${this.base} answers, but it isn't qBittorrent's web page.`);
    return res;
  }

  async torrents(hashes: string[]): Promise<QbitTorrent[]> {
    if (hashes.length === 0) return [];
    type T = {
      hash: string; name: string; category: string; state: string; progress: number; size: number; save_path: string;
      dlspeed?: number; eta?: number; num_seeds?: number; num_complete?: number; content_path?: string; ratio?: number; seeding_time?: number;
      upspeed?: number; num_leechs?: number; num_incomplete?: number; downloaded?: number; uploaded?: number; added_on?: number; completion_on?: number;
      tracker?: string; tags?: string; time_active?: number;
    };
    const rows = await this.json<T[]>(`/torrents/info?hashes=${hashes.map((h) => h.toLowerCase()).join('|')}`);
    return rows.map((r) => ({
      hash: r.hash.toLowerCase(),
      name: r.name,
      category: r.category,
      state: r.state,
      progress: r.progress,
      size: r.size,
      savePath: r.save_path,
      downloadSpeed: r.dlspeed ?? 0,
      eta: r.eta ?? 8640000,
      seedsConnected: r.num_seeds ?? 0,
      seedsKnown: Math.max(r.num_complete ?? 0, 0),
      contentPath: r.content_path ?? r.save_path,
      ratio: r.ratio ?? 0,
      seedingSeconds: r.seeding_time ?? 0,
      uploadSpeed: r.upspeed ?? 0,
      peersConnected: r.num_leechs ?? 0,
      peersKnown: Math.max(r.num_incomplete ?? 0, 0),
      downloaded: r.downloaded ?? 0,
      uploaded: r.uploaded ?? 0,
      addedOn: r.added_on && r.added_on > 0 ? r.added_on * 1000 : null,
      completedOn: r.completion_on && r.completion_on > 0 ? r.completion_on * 1000 : null,
      tracker: r.tracker ?? '',
      tags: (r.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean),
      activeSeconds: r.time_active ?? 0,
    }));
  }

  async files(hash: string): Promise<QbitFile[]> {
    const rows = await this.json<{ name: string; size: number; progress?: number }[]>(`/torrents/files?hash=${hash.toLowerCase()}`);
    return rows.map((f) => ({ name: f.name, size: f.size, progress: f.progress }));
  }

  /** qBittorrent 5 renamed pause/resume to stop/start; try the new name first. */
  private async either(newer: string, older: string, hash: string): Promise<void> {
    const body = () => new URLSearchParams({ hashes: hash.toLowerCase() });
    let res: Response;
    try {
      res = await this.post(newer, body());
    } catch (err) {
      if (!(err instanceof QbitError && err.kind === 'not_qbittorrent')) throw err;
      res = await this.post(older, body());
    }
    if (!res.ok) throw new QbitError('error', `qBittorrent answered ${res.status}.`);
  }

  pause(hash: string): Promise<void> {
    return this.either('/torrents/stop', '/torrents/pause', hash);
  }

  resume(hash: string): Promise<void> {
    return this.either('/torrents/start', '/torrents/resume', hash);
  }

  async remove(hash: string, deleteFiles: boolean): Promise<void> {
    const res = await this.post('/torrents/delete', new URLSearchParams({ hashes: hash.toLowerCase(), deleteFiles: String(deleteFiles) }));
    if (!res.ok) throw new QbitError('error', `qBittorrent answered ${res.status} when removing the torrent.`);
  }

  async ensureCategory(name: string): Promise<void> {
    const cats = await this.json<Record<string, unknown>>('/torrents/categories');
    if (name in cats) return;
    const res = await this.post('/torrents/createCategory', new URLSearchParams({ category: name, savePath: '' }));
    // 409 means it appeared in the meantime, which is fine.
    if (!res.ok && res.status !== 409) throw new QbitError('error', `qBittorrent wouldn't make the "${name}" category (it answered ${res.status}).`);
  }

  async add(payload: TorrentPayload, opts: { category: string; tags: string[] }): Promise<void> {
    const form = new FormData();
    if (payload.kind === 'magnet') form.set('urls', payload.uri);
    else form.set('torrents', new Blob([payload.bytes.slice()], { type: 'application/x-bittorrent' }), payload.name);
    form.set('category', opts.category);
    if (opts.tags.length) form.set('tags', opts.tags.join(','));
    const res = await this.post('/torrents/add', form);
    const text = (await res.text()).trim();
    if (res.status === 415 || text === 'Fails.') throw new QbitError('error', 'qBittorrent turned the torrent down (it may already have it, or the file is broken).');
    if (!res.ok) throw new QbitError('error', `qBittorrent answered ${res.status} when adding the torrent.`);
  }

  async connection(): Promise<QbitConnection> {
    return readConnection((await this.json<{ connection_status?: string }>('/transfer/info')).connection_status);
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
      connection: readConnection(conn),
      freeSpace: typeof main.server_state?.free_space_on_disk === 'number' ? main.server_state.free_space_on_disk : null,
      savePath: (prefs.save_path ?? '').replace(/\/+$/, '') || '/',
      categories: Object.fromEntries(Object.values(cats).map((c) => [c.name, c.savePath ?? ''])),
    };
  }
}

function readConnection(conn: string | undefined): QbitConnection {
  return conn === 'connected' || conn === 'firewalled' ? conn : 'disconnected';
}

/** Is a Web API version at least 2.8 (qBittorrent 4.5)? */
export function apiAtLeast(version: string, major = 2, minor = 8): boolean {
  const [a = 0, b = 0] = version.split('.').map((n) => Number(n) || 0);
  return a > major || (a === major && b >= minor);
}
