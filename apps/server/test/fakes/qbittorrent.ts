import { createHash } from 'node:crypto';
import { QbitError, type QbitApi, type QbitStatus, type QbitTorrent, type TorrentPayload } from '../../src/downloads/qbittorrent.js';
import { magnetInfoHash, torrentInfoHash, type FetchedTorrent } from '../../src/downloads/torrent.js';

/**
 * A fake qBittorrent for route tests and demo mode. No network. It lives at
 * `url` and lets in `username`/`password`; anything else fails like the real one.
 */
export class FakeQbit {
  url = 'http://qbittorrent:8080';
  username = 'admin';
  password = 'adminadmin';
  state: QbitStatus = {
    version: '5.0.4',
    apiVersion: '2.11.2',
    connection: 'connected',
    freeSpace: 4.2 * 1024 ** 4,
    savePath: '/data/torrents',
    categories: { radarr: '/data/torrents/movies', 'tv-sonarr': '/data/torrents/tv' },
  };
  list: QbitTorrent[] = [];
  /** What was added, with its category and tags. */
  added: { hash: string; payload: TorrentPayload; category: string; tags: string[] }[] = [];
  /** Set to make every call fail this way. */
  fail: QbitError | null = null;
  /** Set to make only adding fail. */
  failAdd: QbitError | null = null;
  /** Each address Marquee tried, with the password it sent. */
  calls: { url: string; password: string }[] = [];

  as(url: string, username: string, password: string): QbitApi {
    const gate = () => {
      this.calls.push({ url, password });
      if (this.fail) throw this.fail;
      if (url !== this.url) throw new QbitError('unreachable', `Couldn't reach qBittorrent at ${url} (ENOTFOUND).`);
      if (username !== this.username || password !== this.password) throw new QbitError('password_refused', 'qBittorrent turned down the username or password.');
    };
    return {
      status: async () => {
        gate();
        return structuredClone(this.state);
      },
      torrents: async (hashes) => {
        gate();
        return this.list.filter((t) => hashes.includes(t.hash)).map((t) => ({ ...t }));
      },
      ensureCategory: async (name) => {
        gate();
        this.state.categories[name] ??= '';
      },
      add: async (payload, opts) => {
        gate();
        if (this.failAdd) throw this.failAdd;
        if (!(opts.category in this.state.categories)) throw new QbitError('error', 'no such category');
        const hash = payload.kind === 'magnet' ? magnetInfoHash(payload.uri)! : torrentInfoHash(payload.bytes)!;
        this.added.push({ hash, payload, ...opts });
        this.list.push({ hash, name: `torrent ${hash.slice(0, 6)}`, category: opts.category, state: 'metaDL', progress: 0, size: 0, savePath: this.state.savePath });
      },
    };
  }
}

/** Turns any download link into a magnet whose hash comes from the link, like a Source would. */
export function fakeFetchTorrent(log: string[] = []) {
  return async (url: string): Promise<FetchedTorrent> => {
    log.push(url);
    const infoHash = createHash('sha1').update(url).digest('hex');
    return { infoHash, payload: { kind: 'magnet', uri: `magnet:?xt=urn:btih:${infoHash}&dn=demo` } };
  };
}
