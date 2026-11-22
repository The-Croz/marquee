import { OmdbError, type OmdbApi, type OutsideRatings } from '../../src/library/omdb.js';

/** OMDb with made-up but steady scores for every IMDb id. Key "good-omdb-key" works. */
export class FakeOmdb {
  calls: string[] = [];
  as(key: string): OmdbApi {
    const check = () => {
      if (key !== 'good-omdb-key') throw new OmdbError('OMDb turned the key down. Check it in Settings → Services.');
    };
    return {
      ping: async () => check(),
      ratings: async (imdbId: string): Promise<OutsideRatings> => {
        check();
        this.calls.push(imdbId);
        const n = Number(imdbId.replace(/\D/g, '')) || 1;
        return { imdb: { score: 6 + (n % 30) / 10, votes: 1000 + (n % 900) * 100 }, rottenTomatoes: 60 + (n % 40), metacritic: 50 + (n % 45) };
      },
    };
  }
}
