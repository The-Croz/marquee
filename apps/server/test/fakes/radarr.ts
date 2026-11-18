import { ArrError, type ArrApi, type RadarrGrab, type RadarrHistoryApi, type RadarrRelease } from '../../src/library/arr.js';

/** A fake Radarr for tests and demo mode: its downloads and the copies it saw. No network. */
export class FakeRadarr implements RadarrHistoryApi, ArrApi {
  history: RadarrGrab[] = [];
  /** Copies Radarr's own search returns, per Radarr movie id. */
  lists = new Map<number, RadarrRelease[]>();
  /** Each `grabs` call's `since`. */
  asked: number[] = [];
  fail: string | null = null;
  /** Downloads still on the way in Radarr. */
  queue = 0;
  /** Radarr's movies, for the monitored count. */
  movies: { title: string; monitored: boolean }[] = [];

  async queueSize() {
    if (this.fail) throw new ArrError(this.fail);
    return this.queue;
  }

  async ping() {
    return { app: 'Radarr', version: '5.20.0' };
  }
  async titles() {
    return this.movies.map((m) => ({ title: m.title, year: null, path: `/movies/${m.title}`, tmdbId: null, tvdbId: null, imdbId: null, monitored: m.monitored }));
  }
  async grabs(since: number): Promise<RadarrGrab[]> {
    if (this.fail) throw new ArrError(this.fail);
    this.asked.push(since);
    return this.history.filter((g) => g.date >= since);
  }
  async releases(radarrMovieId: number): Promise<RadarrRelease[]> {
    if (this.fail) throw new ArrError(this.fail);
    return this.lists.get(radarrMovieId) ?? [];
  }
}

export function grab(id: number, title: string, extra: Partial<RadarrGrab> = {}): RadarrGrab {
  return { id, radarrMovieId: 1, tmdbId: 693134, movieTitle: 'Dune: Part Two', title, date: Date.parse('2026-11-10T00:00:00Z'), quality: 'WEBDL-2160p', score: 2000, size: 20 * 1024 ** 3, indexer: 'YTS', ...extra };
}

export function radarrRelease(title: string, extra: Partial<RadarrRelease> = {}): RadarrRelease {
  return { title, size: 20 * 1024 ** 3, seeders: 50, leechers: 5, indexer: 'YTS', infoHash: null, infoUrl: null, publishedAt: null, approved: true, rejections: [], score: 0, quality: 'WEBDL-2160p', freeleech: false, mappedMovieId: 1, ...extra };
}
