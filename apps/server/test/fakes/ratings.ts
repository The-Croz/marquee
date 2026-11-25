import { RatingsError, type OutsideRatings, type RatingsApi } from '../../src/library/mdblist.js';

/** MDBList with made-up but steady scores for every TMDB id. Key "good-mdblist-key" works. */
export class FakeRatings {
  calls: string[] = [];
  as(key: string): RatingsApi {
    const check = () => {
      if (key !== 'good-mdblist-key') throw new RatingsError('MDBList turned the key down. Check it in Settings → Services.');
    };
    return {
      ping: async () => {
        check();
        return { used: 12, perDay: 1000 };
      },
      ratings: async (kind, tmdbId): Promise<OutsideRatings> => {
        check();
        this.calls.push(`${kind}:${tmdbId}`);
        const n = tmdbId || 1;
        return { imdb: { score: 6 + (n % 30) / 10, votes: 1000 + (n % 900) * 100 }, rottenTomatoes: 60 + (n % 40), metacritic: 50 + (n % 45) };
      },
    };
  }
}
