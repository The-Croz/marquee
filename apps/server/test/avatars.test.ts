import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '../src/db/schema.js';
import { refreshPlexAvatars } from '../src/auth/avatars.js';
import { PlexServerClient } from '../src/library/mediaServers.js';
import { FakeMediaServer } from './fakes/mediaServers.js';
import { call, makeApp, setupAdmin } from './helpers.js';

/** Profile pictures: Plex first, then single sign-on (Pocket ID), else the initial. */

const PLEX = 'https://plex.tv/users/abc/avatar?c=1';
const OIDC = 'https://id.example.com/api/users/1/profile-picture.png';

async function setup(images: Record<string, string> = {}) {
  const asked: string[] = [];
  const plex = new FakeMediaServer('plex');
  const t = makeApp({
    config: { oidc: { issuer: 'https://id.example.com', clientId: 'x', clientSecret: 'y', autoCreate: false, name: 'Pocket ID' } } as never,
    clients: {
      plexServer: (u, k) => plex.as(u, k),
      image: async (url) => {
        asked.push(url);
        const body = images[url];
        return body === undefined ? null : { type: 'image/png', body: Buffer.from(body) };
      },
    },
  });
  const admin = await setupAdmin(t.app);
  const set = (v: Partial<typeof users.$inferInsert>) => t.db.update(users).set(v).where(eq(users.username, 'josh')).run();
  const me = async () => (await call(t.app, 'GET', '/api/me', undefined, admin)).body.user as { id: number; avatar: string | null };
  /** `cookie` '' asks without signing in. */
  const picture = async (url: string, cookie: string = admin!) => t.app.request(url, { headers: cookie ? { cookie } : {} });
  return { ...t, admin, plex, asked, set, me, picture };
}

describe('profile pictures', () => {
  it('has none until Plex or single sign-on gives one', async () => {
    const t = await setup();
    expect((await t.me()).avatar).toBeNull();
    expect((await t.picture(`/api/avatars/${(await t.me()).id}`)).status).toBe(404);
  });

  it('serves the Plex picture itself, so no screen has to ask Plex, and fetches it once', async () => {
    const t = await setup({ [PLEX]: 'plex-face', [OIDC]: 'id-face' });
    t.set({ plexAvatar: PLEX, oidcAvatar: OIDC });
    const url = (await t.me()).avatar!;
    expect(url).toMatch(/^\/api\/avatars\/\d+\?v=[0-9a-f]+$/);
    const res = await t.picture(url);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(await res.text()).toBe('plex-face');
    await t.picture(url);
    expect(t.asked).toEqual([PLEX]);
  });

  it('uses the single sign-on picture when there is no Plex one, or it can’t be fetched', async () => {
    const t = await setup({ [OIDC]: 'id-face' });
    t.set({ oidcAvatar: OIDC });
    expect(await (await t.picture((await t.me()).avatar!)).text()).toBe('id-face');
    t.set({ plexAvatar: PLEX });
    expect(await (await t.picture((await t.me()).avatar!)).text()).toBe('id-face');
  });

  it('only ever fetches from Plex or your sign-in provider', async () => {
    const t = await setup({ 'http://192.168.1.1/admin': 'router', 'https://plex.tv.evil.example/a': 'evil' });
    for (const url of ['http://192.168.1.1/admin', 'https://plex.tv.evil.example/a', 'file:///etc/passwd']) {
      t.set({ plexAvatar: url });
      expect((await t.picture(`/api/avatars/${(await t.me()).id}`)).status).toBe(404);
    }
    expect(t.asked).toEqual([]);
  });

  it('is for signed-in people only', async () => {
    const t = await setup({ [PLEX]: 'x' });
    t.set({ plexAvatar: PLEX });
    expect((await t.picture((await t.me()).avatar!, '')).status).toBe(401);
  });

  it('copies pictures from the people on your Plex server to their Marquee accounts', async () => {
    const t = await setup();
    await call(t.app, 'PUT', '/api/settings/services', { plexUrl: 'http://plex:32400', plexToken: 'plex-token' }, t.admin);
    await call(t.app, 'POST', '/api/users', { username: 'ana', displayName: 'Ana', role: 'member', password: 'ana password!' }, t.admin);
    t.set({ plexId: '10' });
    t.plex.people = [
      { id: '10', username: 'someone-else', name: 'J', avatar: PLEX },
      { id: '11', username: 'ANA', name: 'Ana', avatar: 'https://plex.tv/users/ana/avatar' },
      { id: '12', username: 'stranger', name: 'S', avatar: 'https://plex.tv/users/s/avatar' },
    ];
    expect(await refreshPlexAvatars({ db: t.db, clients: { plexServer: (u, k) => t.plex.as(u, k) } })).toBe(2);
    expect(t.db.select().from(users).all().map((u) => u.plexAvatar)).toEqual([PLEX, 'https://plex.tv/users/ana/avatar']);
  });

  it('reads each person’s picture from Plex', async () => {
    const f = (async (url: string) =>
      url.endsWith('/api/v2/user')
        ? new Response(JSON.stringify({ id: 1, username: 'josh', thumb: PLEX }))
        : new Response('<MediaContainer><User id="2" title="Ana" username="ana" thumb="https://plex.tv/users/ana/avatar?c=2&amp;s=1"/></MediaContainer>')) as unknown as typeof fetch;
    expect((await new PlexServerClient('http://plex:32400', 't', f).people()).map((p) => p.avatar)).toEqual([PLEX, 'https://plex.tv/users/ana/avatar?c=2&s=1']);
  });
});
