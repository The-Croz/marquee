import { ArrError, type ArrApi } from '../../src/library/arr.js';

/** A fake Radarr or Sonarr for tests and demo mode: its titles and queue. No network. */
export class FakeRadarr implements ArrApi {
  fail: string | null = null;
  /** Downloads still on the way. */
  queue = 0;
  /** Its titles, for the monitored count. */
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
}
