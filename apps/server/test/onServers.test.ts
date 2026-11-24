import { describe, expect, it } from 'vitest';
import type { ServicesView, WatchLink } from '@marquee/shared';
import { schema } from '../src/db/index.js';
import { labelRequested } from '../src/library/onServers.js';
import { FakeMediaServer } from './fakes/mediaServers.js';
import { call, makeApp, setupAdmin } from './helpers.js';

async function setup() {
  const plex = new FakeMediaServer('plex');
  const jf = new FakeMediaServer('jellyfin');
  const t = makeApp({ clients: { plexServer: (u, k) => plex.as(u, k), jellyfin: (u, k) => jf.as(u, k) } });
  const admin = await setupAdmin(t.app);
  await call(t.app, 'PUT', '/api/settings/services', { plexUrl: 'http://plex:32400', plexToken: 'plex-token', jellyfinUrl: 'http://jf:8096', jellyfinApiKey: 'jellyfin-key' }, admin);
  const movie = t.db
    .insert(schema.movies)
    .values({ tmdbId: 603, imdbId: 'tt0133093', title: 'The Matrix', sortTitle: 'matrix', year: 1999, certification: 'R', profile: 'cinema', addedAt: 0, refreshedAt: 0 })
    .returning()
    .get();
  const show = t.db.insert(schema.series).values({ tmdbId: 82728, tvdbId: 353546, title: 'Bluey', sortTitle: 'bluey', year: 2018, certification: 'TV-Y', profile: 'kids', addedAt: 0, refreshedAt: 0 }).returning().get();
  await call(t.app, 'POST', '/api/users', { username: 'jessie', displayName: 'Jessie', role: 'member', password: 'jessie password' }, admin);
  await call(t.app, 'POST', '/api/users', { username: 'kiddo', displayName: 'Kiddo', role: 'kid', password: 'kiddo password' }, admin);
  const login = async (u: string) => (await call(t.app, 'POST', '/api/auth/login', { username: u, password: `${u} password` })).cookie!;
  return { ...t, plex, jf, admin, movie, show, kid: await login('kiddo'), jessie: await login('jessie') };
}

describe('Watch in Plex or Jellyfin', () => {
  it('links to the title on each server that has it, and remembers where it is', async () => {
    const t = await setup();
    t.plex.titleList.push({ kind: 'movie', ref: '501', keys: ['imdb:tt0133093', 'tmdb:603'], libraryId: '1', labels: [] });
    t.jf.titleList.push({ kind: 'movie', ref: 'jf-matrix', keys: ['tmdb:603'] });
    await call(t.app, 'PUT', '/api/settings/services', { jellyfinPublicUrl: 'https://jellyfin.example.com/' }, t.admin);
    const res = await call(t.app, 'GET', `/api/movies/${t.movie.id}/watch`, undefined, t.jessie);
    expect(res.status).toBe(200);
    expect((res.body as { links: WatchLink[] }).links).toEqual([
      { server: 'Plex', url: 'https://app.plex.tv/desktop/#!/server/fake-machine/details?key=%2Flibrary%2Fmetadata%2F501' },
      { server: 'Jellyfin', url: 'https://jellyfin.example.com/web/#/details?id=jf-matrix&serverId=fake-server' },
    ]);
    expect(((await call(t.app, 'GET', '/api/settings/services', undefined, t.admin)).body as ServicesView).jellyfin.publicUrl).toBe('https://jellyfin.example.com');
    // The second time, the ids Marquee remembered are used: no reading the whole list again.
    const reads = t.plex.titleReads;
    await call(t.app, 'GET', `/api/movies/${t.movie.id}/watch`, undefined, t.jessie);
    expect(t.plex.titleReads).toBe(reads);
    // Plex re-added it under a new id: found again.
    t.plex.titleList[0]!.ref = '777';
    const again = (await call(t.app, 'GET', `/api/movies/${t.movie.id}/watch`, undefined, t.jessie)).body as { links: WatchLink[] };
    expect(again.links[0]!.url).toMatch(/metadata%2F777$/);
  });

  it('leaves out servers that don’t have it or don’t answer, and keeps kids to their titles', async () => {
    const t = await setup();
    t.jf.titleList.push({ kind: 'tv', ref: 'jf-bluey', keys: ['tvdb:353546'] });
    t.plex.fail = 'Couldn’t reach Plex.';
    const res = (await call(t.app, 'GET', `/api/shows/${t.show.id}/watch`, undefined, t.kid)).body as { links: WatchLink[] };
    expect(res.links).toEqual([{ server: 'Jellyfin', url: 'http://jf:8096/web/#/details?id=jf-bluey&serverId=fake-server' }]);
    expect((await call(t.app, 'GET', `/api/movies/${t.movie.id}/watch`, undefined, t.kid)).status).toBe(404);
  });
});

describe('Plex labels on requested titles', () => {
  it('labels requested titles once they’re in Plex, keeps the labels already there, and adds each once', async () => {
    const t = await setup();
    const deps = { db: t.db, clients: { plexServer: (u: string, k: string) => t.plex.as(u, k), jellyfin: (u: string, k: string) => t.jf.as(u, k) } };
    const jessieId = t.db.select().from(schema.users).all().find((u) => u.username === 'jessie')!.id;
    t.db.insert(schema.requests).values({ kind: 'movie', tmdbId: 603, title: 'The Matrix', status: 'approved', titleId: t.movie.id, requestedBy: jessieId, createdAt: 0 }).run();
    expect(await labelRequested(deps)).toBe('Off');

    const saved = await call(t.app, 'PUT', '/api/settings/services', { plexLabels: { on: true, requester: true } }, t.admin);
    expect(saved.status).toBe(200);
    expect(((await call(t.app, 'GET', '/api/settings/services', undefined, t.admin)).body as ServicesView).plex.labels).toEqual({ on: true, text: 'Requested', requester: true });
    // Not in the library yet: nothing to label.
    expect(await labelRequested(deps)).toBe('Nothing new to label');
    t.db.insert(schema.mediaFiles).values({ path: '/data/media/movies/The Matrix (1999)/The Matrix (1999).mkv', movieId: t.movie.id, size: 1, mtime: 0, addedAt: 0, seenAt: 0 }).run();
    // In the library, but Plex hasn't added it yet.
    expect(await labelRequested(deps)).toBe('Nothing new to label; 1 not in Plex yet');
    t.plex.titleList.push({ kind: 'movie', ref: '501', keys: ['tmdb:603'], libraryId: '1', labels: ['Favourites'] });
    expect(await labelRequested(deps)).toBe('Labelled 1 title');
    expect(t.plex.labelSets).toEqual([{ ref: '501', labels: ['Favourites', 'Requested', 'Jessie'] }]);
    // Nothing more to do, even after someone removes the label in Plex by hand.
    t.plex.titleList[0]!.labels = ['Favourites'];
    expect(await labelRequested(deps)).toBe('Nothing new to label');
    expect(t.plex.labelSets).toHaveLength(1);
    // A new label text is added on the next run.
    await call(t.app, 'PUT', '/api/settings/services', { plexLabels: { text: 'Asked for' } }, t.admin);
    expect(await labelRequested(deps)).toBe('Labelled 1 title');
    expect(t.plex.labelSets.at(-1)).toEqual({ ref: '501', labels: ['Favourites', 'Asked for'] });
    expect((await call(t.app, 'PUT', '/api/settings/services', { plexLabels: { text: '  ' } }, t.admin)).status).toBe(400);
  });
});
