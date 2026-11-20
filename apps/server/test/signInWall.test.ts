import { describe, expect, it, beforeEach } from 'vitest';
import type { SignInWall } from '@marquee/shared';
import { setSetting } from '../src/db/index.js';
import { forgetWall } from '../src/routes/auth.js';
import { FakeTmdb } from './fakes/tmdb.js';
import { call, makeApp } from './helpers.js';

describe('sign-in poster wall', () => {
  beforeEach(forgetWall);

  it('is empty without a TMDB key, and needs no sign-in', async () => {
    const t = makeApp();
    const r = await call(t.app, 'GET', '/api/auth/wall');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ posters: [] });
  });

  it('mixes popular movies and shows, and asks TMDB once in six hours', async () => {
    let at = 0;
    const tmdb = new FakeTmdb();
    const t = makeApp({ clients: { tmdb: () => tmdb }, now: () => at });
    setSetting(t.db, 'services.tmdb_api_key', 'good-key');
    const first = (await call(t.app, 'GET', '/api/auth/wall')).body as SignInWall;
    expect(first.posters.length).toBeGreaterThan(2);
    expect(first.posters.every((p) => p.startsWith('/'))).toBe(true);
    await call(t.app, 'GET', '/api/auth/wall');
    expect(tmdb.calls.filter((c) => c.startsWith('list:'))).toHaveLength(2);
    at = 7 * 60 * 60 * 1000;
    await call(t.app, 'GET', '/api/auth/wall');
    expect(tmdb.calls.filter((c) => c.startsWith('list:'))).toHaveLength(4);
  });

  it('stays empty, not broken, when TMDB fails', async () => {
    const t = makeApp({ clients: { tmdb: () => new FakeTmdb('bad-key') } });
    setSetting(t.db, 'services.tmdb_api_key', 'bad-key');
    expect((await call(t.app, 'GET', '/api/auth/wall')).body).toEqual({ posters: [] });
  });
});
