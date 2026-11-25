import { describe, expect, it } from 'vitest';
import type { DiscoverTitle, PersonDetail } from '@marquee/shared';
import { FakeTmdb } from './fakes/tmdb.js';
import { FakeRatings } from './fakes/ratings.js';
import { call, makeApp, setupAdmin } from './helpers.js';
import { cleanProviders } from '../src/library/tmdb.js';
import { MdbListClient, readMdbList } from '../src/library/mdblist.js';
import { openDb } from '../src/db/index.js';
import { movieHomeDate, movieStage } from '../src/library/availability.js';

async function setup(mdblistKey: string | null = 'good-mdblist-key') {
  const ratings = new FakeRatings();
  const t = makeApp({ clients: { tmdb: () => new FakeTmdb(), mdblist: (k) => ratings.as(k) } });
  const admin = await setupAdmin(t.app);
  await call(t.app, 'PUT', '/api/settings/services', { tmdbApiKey: 'good-key', ...(mdblistKey ? { mdblistKey } : {}) }, admin);
  return { ...t, admin, ratings };
}

describe('Title page scores', () => {
  it('shows TMDB’s score, and IMDb, Rotten Tomatoes and Metacritic with an MDBList key', async () => {
    const t = await setup();
    const page = (await call(t.app, 'GET', '/api/discover/title/movie/693134', undefined, t.admin)).body as DiscoverTitle;
    expect(page.ratings.tmdb).toEqual({ score: 8.1, votes: 1200 });
    expect(page.ratings.imdbId).toBe('tt0693134');
    expect(page.ratings.imdb?.score).toBeGreaterThan(0);
    expect(page.ratings.rottenTomatoes).toBeGreaterThan(0);
    expect(page.ratings.metacritic).toBeGreaterThan(0);
    expect(t.ratings.calls).toEqual(['movie:693134']);
  });

  it('without a key (or with a bad one) shows TMDB only, and the page still loads', async () => {
    for (const key of [null, 'bad-key']) {
      const t = await setup(key);
      const res = await call(t.app, 'GET', '/api/discover/title/movie/693134', undefined, t.admin);
      expect(res.status).toBe(200);
      expect((res.body as DiscoverTitle).ratings).toMatchObject({ imdb: null, rottenTomatoes: null, metacritic: null });
    }
  });

  it('the key can be tested from Settings → Services and is never sent back', async () => {
    const t = await setup();
    expect((await call(t.app, 'POST', '/api/settings/services/test', { service: 'mdblist' }, t.admin)).body).toEqual({
      ok: true,
      message: 'Connected to MDBList. 12 of 1,000 lookups a day used. The Shawshank Redemption: IMDb 6.8, Rotten Tomatoes 98%, Metacritic 58.',
    });
    expect((await call(t.app, 'POST', '/api/settings/services/test', { service: 'mdblist', apiKey: 'nope' }, t.admin)).body).toMatchObject({ ok: false, message: 'MDBList turned the key down. Check it in Settings → Services.' });
    const view = (await call(t.app, 'GET', '/api/settings/services', undefined, t.admin)).body;
    expect(view).toMatchObject({ mdblist: { configured: true } });
    expect(JSON.stringify(view)).not.toContain('good-mdblist-key');
  });

  it('reads MDBList’s answer: IMDb out of 10, the others out of 100, missing ones as nothing', () => {
    const body = {
      ratings: [
        { source: 'imdb', value: 7.8, score: 78, votes: 1234567 },
        { source: 'metacritic', value: 80, score: 80, votes: 40 },
        { source: 'tomatoes', value: 93, score: 93, votes: 300 },
        { source: 'popcorn', value: 88, score: 88, votes: 5000 },
        { source: 'letterboxd', value: 3.9, score: 78, votes: 9 },
      ],
    };
    expect(readMdbList(body)).toEqual({ imdb: { score: 7.8, votes: 1234567 }, rottenTomatoes: 93, metacritic: 80 });
    expect(readMdbList({ ratings: [{ source: 'imdb', value: null, score: null }, { source: 'tomatoes', value: null, score: 0 }] })).toEqual({ imdb: null, rottenTomatoes: null, metacritic: null });
    // Only MDBList's 0–100 score: IMDb comes back out of 10.
    expect(readMdbList({ ratings: [{ source: 'imdb', score: 81, votes: 5 }] }).imdb).toEqual({ score: 8.1, votes: 5 });
    expect(readMdbList(null)).toEqual({ imdb: null, rottenTomatoes: null, metacritic: null });
  });

  it('asks MDBList by TMDB id, keeps scores 3 days, and asks again after 6 hours when it had none', async () => {
    let at = 0;
    const asked: string[] = [];
    let body: unknown = { ratings: [] };
    let status = 200;
    const f = (async (u: string | URL) => {
      asked.push(String(u));
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    const api = new MdbListClient('k', openDb(':memory:'), () => at, f);
    await api.ratings('series', 95396);
    expect(asked[0]).toBe('https://api.mdblist.com/tmdb/show/95396?apikey=k');
    at += 7 * 3_600_000;
    body = { ratings: [{ source: 'tomatoes', value: 91 }] };
    expect((await api.ratings('series', 95396)).rottenTomatoes).toBe(91);
    at += 2 * 86_400_000;
    await api.ratings('series', 95396);
    expect(asked).toHaveLength(2);
    // A title MDBList doesn't have is no scores, not an error; a bad key and the daily limit say so plainly.
    status = 404;
    expect(await api.ratings('movie', 1)).toEqual({ imdb: null, rottenTomatoes: null, metacritic: null });
    status = 401;
    await expect(api.ratings('movie', 2)).rejects.toThrow('MDBList turned the key down. Check it in Settings → Services.');
    status = 429;
    body = { error: 'Daily API limit exceeded!' };
    await expect(api.ratings('movie', 3)).rejects.toThrow(/daily limit is used up/);
  });
});

describe('Cast and people', () => {
  it('cast comes with photos and opens a page of what they’ve been in', async () => {
    const t = await setup();
    const page = (await call(t.app, 'GET', '/api/discover/title/movie/693134', undefined, t.admin)).body as DiscoverTitle;
    expect(page.cast[0]).toEqual({ id: 501, name: 'A. Actor', character: 'Lead', profilePath: '/actor.jpg' });
    const person = (await call(t.app, 'GET', '/api/discover/person/501', undefined, t.admin)).body as PersonDetail;
    expect(person).toMatchObject({ name: 'A. Actor', knownFor: 'Acting' });
    expect(person.credits.length).toBeGreaterThan(3);
    expect(person.credits[0]).toMatchObject({ role: 'Lead', state: 'none' });
    expect((await call(t.app, 'GET', '/api/discover/person/999', undefined, t.admin)).status).toBe(404);
  });
});

describe('Where to watch', () => {
  it('folds add-on channels and ad plans into the service', () => {
    const names = cleanProviders(['HBO Max Amazon Channel', 'Cinemax Amazon Channel', 'HBO Max', 'Cinemax Apple TV Channel', 'Netflix Standard with Ads', 'Netflix'].map((name) => ({ name }))).map((p) => p.name);
    expect(names).toEqual(['HBO Max', 'Cinemax', 'Netflix']);
  });

  it('shows Paramount+ once, whatever plan or channel TMDB lists, with its own logo', () => {
    const list = ['Paramount+ Amazon Channel', 'Paramount Plus', 'Paramount Plus Apple TV Channel', 'Paramount+ with Showtime', 'Paramount Plus Essential', 'Paramount+ Roku Premium Channel', 'Paramount+', 'Hulu'];
    const out = cleanProviders(list.map((name, i) => ({ name, logoPath: `/${i}.png` })));
    expect(out).toEqual([
      { name: 'Paramount+', logoPath: '/6.png' },
      { name: 'Hulu', logoPath: '/7.png' },
    ]);
  });

  it('never shows an add-on channel\'s badged logo: the service\'s standard one, or none', () => {
    const list = [
      { name: 'HBO Max Amazon Channel', logoPath: '/hbo-amazon.png' },
      { name: 'Cinemax Amazon Channel', logoPath: '/cinemax-amazon.png' },
      { name: 'Hulu', logoPath: '/hulu.png' },
    ];
    expect(cleanProviders(list, new Map([['hbo max', '/hbo.png']]))).toEqual([
      { name: 'HBO Max', logoPath: '/hbo.png' },
      { name: 'Cinemax', logoPath: null },
      { name: 'Hulu', logoPath: '/hulu.png' },
    ]);
    expect(cleanProviders(list)[0]).toEqual({ name: 'HBO Max', logoPath: null });
  });

  it('shows Peacock once, whether it’s Premium or Premium Plus', () => {
    const out = cleanProviders(['Peacock Premium', 'Peacock Premium Plus', 'Peacock Premium Amazon Channel'].map((name) => ({ name }))).map((p) => p.name);
    expect(out).toEqual(['Peacock']);
  });
});

describe('When a movie is out', () => {
  it('in cinemas isn’t out; the digital date is, or 90 days after the cinema date', () => {
    expect(movieStage({ releaseDate: '2026-11-01', cinemaRelease: '2026-11-01', digitalRelease: '2026-12-15' }, '2026-11-21')).toBe('cinemas');
    expect(movieStage({ releaseDate: '2026-11-01', cinemaRelease: '2026-11-01', digitalRelease: '2026-11-20' }, '2026-11-21')).toBe('out');
    expect(movieStage({ releaseDate: '2027-01-10', cinemaRelease: '2027-01-10' }, '2026-11-21')).toBe('announced');
    expect(movieHomeDate({ releaseDate: '2026-11-01', cinemaRelease: '2026-11-01' })).toEqual({ date: '2027-01-30', known: false });
    expect(movieStage({ releaseDate: null }, '2026-11-21')).toBe('out');
  });
});
