import { describe, expect, it } from 'vitest';
import type { DiscoverTitle, PersonDetail } from '@marquee/shared';
import { FakeTmdb } from './fakes/tmdb.js';
import { FakeOmdb } from './fakes/omdb.js';
import { call, makeApp, setupAdmin } from './helpers.js';
import { cleanProviders } from '../src/library/tmdb.js';
import { readOmdb } from '../src/library/omdb.js';
import { movieHomeDate, movieStage } from '../src/library/availability.js';

async function setup(omdbKey: string | null = 'good-omdb-key') {
  const omdb = new FakeOmdb();
  const t = makeApp({ clients: { tmdb: () => new FakeTmdb(), omdb: (k) => omdb.as(k) } });
  const admin = await setupAdmin(t.app);
  await call(t.app, 'PUT', '/api/settings/services', { tmdbApiKey: 'good-key', ...(omdbKey ? { omdbKey } : {}) }, admin);
  return { ...t, admin, omdb };
}

describe('Title page scores', () => {
  it('shows TMDB’s score, and IMDb and Rotten Tomatoes with an OMDb key', async () => {
    const t = await setup();
    const page = (await call(t.app, 'GET', '/api/discover/title/movie/693134', undefined, t.admin)).body as DiscoverTitle;
    expect(page.ratings.tmdb).toEqual({ score: 8.1, votes: 1200 });
    expect(page.ratings.imdbId).toBe('tt0693134');
    expect(page.ratings.imdb?.score).toBeGreaterThan(0);
    expect(page.ratings.rottenTomatoes).toBeGreaterThan(0);
    expect(t.omdb.calls).toEqual(['tt0693134']);
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
    expect((await call(t.app, 'POST', '/api/settings/services/test', { service: 'omdb' }, t.admin)).body).toMatchObject({ ok: true });
    expect((await call(t.app, 'POST', '/api/settings/services/test', { service: 'omdb', apiKey: 'nope' }, t.admin)).body).toMatchObject({ ok: false, message: 'OMDb turned the key down. Check it in Settings → Services.' });
    const view = (await call(t.app, 'GET', '/api/settings/services', undefined, t.admin)).body;
    expect(view).toMatchObject({ omdb: { configured: true } });
    expect(JSON.stringify(view)).not.toContain('good-omdb-key');
  });

  it('reads OMDb’s answer, with N/A as nothing', () => {
    expect(readOmdb({ imdbRating: '7.8', imdbVotes: '1,234,567', Ratings: [{ Source: 'Rotten Tomatoes', Value: '93%' }, { Source: 'Metacritic', Value: '80/100' }] })).toEqual({ imdb: { score: 7.8, votes: 1234567 }, rottenTomatoes: 93, metacritic: 80 });
    expect(readOmdb({ imdbRating: 'N/A', Metascore: 'N/A' })).toEqual({ imdb: null, rottenTomatoes: null, metacritic: null });
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
