import { QbitError, type QbitApi, type QbitStatus } from '../../src/downloads/qbittorrent.js';

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
    categories: { 'radarr': '/data/torrents/movies', 'tv-sonarr': '/data/torrents/tv' },
  };
  /** Set to make every call fail this way. */
  fail: QbitError | null = null;
  /** Each address Marquee tried, with the password it sent. */
  calls: { url: string; password: string }[] = [];

  as(url: string, username: string, password: string): QbitApi {
    return {
      status: async () => {
        this.calls.push({ url, password });
        if (this.fail) throw this.fail;
        if (url !== this.url) throw new QbitError('unreachable', `Couldn't reach qBittorrent at ${url} (ENOTFOUND).`);
        if (username !== this.username || password !== this.password) throw new QbitError('password_refused', 'qBittorrent turned down the username or password.');
        return structuredClone(this.state);
      },
    };
  }
}
