import { describe, expect, it } from 'vitest';
import type { DiscoverPage, DiscoverTitle, NotificationInboxItem, RequestView, ServiceTop } from '@marquee/shared';
import { schema } from '../src/db/index.js';
import { FakeQbit, fakeFetchTorrent } from './fakes/qbittorrent.js';
import { FakeSites, release } from './fakes/sources.js';
import { FakeTmdb } from './fakes/tmdb.js';
import { FakeStreamingTop } from './fakes/streamingTop.js';
import { call, makeApp, setupAdmin } from './helpers.js';
import { searchesSettled } from '../src/requests/service.js';

const GB = 1024 ** 3;
const DUNE = 'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX';
const BLUEY = 'Bluey.2018.S01E01.720p.WEB-DL.AAC2.0.H.264-GRP';

async function setup() {
  const sites = new FakeSites();
  sites.feed('http://tpb.test/api', { releases: [release(DUNE, { size: 25 * GB }), release(BLUEY, { size: 1 * GB })] });
  const qbit = new FakeQbit();
  const pushed: { kind: string; title: string; body: string }[] = [];
  const top = new FakeStreamingTop();
  const t = makeApp({
    clients: {
      streamingTop: (key) => top.as(key),
      torznab: sites.torznab,
      qbittorrent: (u, n, p) => qbit.as(u, n, p),
      fetchTorrent: fakeFetchTorrent(),
      tmdb: () => new FakeTmdb(),
      push: { send: async (ch, m) => void pushed.push({ kind: ch.kind, title: m.title, body: m.body }) },
    },
  });
  const admin = await setupAdmin(t.app);
  await call(t.app, 'PUT', '/api/settings/services', { tmdbApiKey: 'good-key' }, admin);
  await call(t.app, 'POST', '/api/settings/sources', { name: 'TPB', url: 'http://tpb.test/api', apiKey: 'good' }, admin);
  await call(t.app, 'PUT', '/api/settings/downloader', { url: qbit.url, username: 'admin', password: 'adminadmin' }, admin);
  const person = async (username: string, role: 'member' | 'kid') => {
    await call(t.app, 'POST', '/api/users', { username, displayName: username[0]!.toUpperCase() + username.slice(1), role, password: `${username} password` }, admin);
    return (await call(t.app, 'POST', '/api/auth/login', { username, password: `${username} password` })).cookie!;
  };
  const jessie = await person('jessie', 'member');
  const kiddo = await person('kiddo', 'kid');
  const sam = await person('sam', 'member');
  const ask = (cookie: string, body: object) => call(t.app, 'POST', '/api/requests', body, cookie);
  const inbox = async (cookie: string) => (await call(t.app, 'GET', '/api/notifications', undefined, cookie)).body as { items: NotificationInboxItem[]; unread: number };
  return { ...t, admin, jessie, kiddo, sam, qbit, pushed, ask, inbox, top, sites };
}

describe('Requests', () => {
  it('an admin’s request goes straight through: added, wanted and searched at once', async () => {
    const t = await setup();
    const r = await t.ask(t.admin, { kind: 'movie', tmdbId: 693134 });
    expect(r.status).toBe(201);
    const view = r.body as RequestView;
    expect(view.state).toBe('downloading');
    expect(view.href).toMatch(/^\/movies\/\d+$/);
    const movie = t.db.select().from(schema.movies).all()[0]!;
    expect(movie.monitored).toBe(true);
    expect(t.db.select().from(schema.downloads).all().map((d) => d.title)).toEqual([DUNE]);
  });

  it('a slow first search answers “searching” at once, then moves on by itself', async () => {
    const t = await setup();
    let open!: () => void;
    t.sites.feeds.get('http://tpb.test/api')!.gate = new Promise<void>((r) => (open = r));
    const r = (await t.ask(t.admin, { kind: 'movie', tmdbId: 693134 })).body as RequestView;
    expect(r).toMatchObject({ state: 'searching', stateText: 'Approved. Marquee is searching for a copy now.' });
    const card = ((await call(t.app, 'GET', '/api/discover/title/movie/693134', undefined, t.admin)).body as DiscoverTitle).request;
    expect(card?.state).toBe('searching');
    open();
    await searchesSettled();
    const [after] = ((await call(t.app, 'GET', '/api/requests', undefined, t.admin)).body as { items: RequestView[] }).items;
    expect(after).toMatchObject({ state: 'downloading', stateText: 'Found a copy. The download is starting.' });
  });

  it('says why nothing was picked when copies were found but none is good enough', async () => {
    const t = await setup();
    t.sites.feed('http://tpb.test/api', {
      releases: [release('Dune.Part.Two.2024.HDCAM.x264-GRP', { size: 2 * GB }), release('Dune.Part.Two.2024.TELESYNC.x264-GRP', { size: 2 * GB })],
    });
    const r = (await t.ask(t.admin, { kind: 'movie', tmdbId: 693134 })).body as RequestView;
    expect(r.state).toBe('looking');
    expect(r.stateText).toBe('Approved. Copies are out there, but none is good enough yet. Marquee looks again once automatic searching is on.');
    expect(r.searchNote?.text).toMatch(/^2 copies, none good enough for .+: 2 not a quality it takes\.$/);
    // Nothing found at all says so too.
    t.sites.feed('http://tpb.test/api', { releases: [] });
    const movie = t.db.select().from(schema.movies).all()[0]!;
    await call(t.app, 'POST', `/api/movies/${movie.id}/search`, {}, t.admin);
    const [after] = ((await call(t.app, 'GET', '/api/requests', undefined, t.admin)).body as { items: RequestView[] }).items;
    expect(after!.stateText).toBe('Approved. No copy on your sites yet. Marquee looks again once automatic searching is on.');
    expect(after!.searchNote?.text).toBe('No Source had a copy.');
  });

  it('a member’s request waits, tells the admins, and nothing is downloaded', async () => {
    const t = await setup();
    const r = await t.ask(t.jessie, { kind: 'movie', tmdbId: 693134 });
    expect((r.body as RequestView).state).toBe('pending');
    expect(t.db.select().from(schema.movies).all()).toEqual([]);
    expect(t.db.select().from(schema.downloads).all()).toEqual([]);
    const adminInbox = await t.inbox(t.admin);
    expect(adminInbox.items[0]).toMatchObject({ event: 'request_pending', body: 'Jessie asked for Dune: Part Two (2024).', link: '/requests' });
    expect(((await call(t.app, 'GET', '/api/requests/summary', undefined, t.admin)).body as { pending: number }).pending).toBe(1);
    expect(((await call(t.app, 'GET', '/api/requests/summary', undefined, t.jessie)).body as { pending: number }).pending).toBe(0);
  });

  it('approving adds it, picks the profile you choose, searches, and tells the person', async () => {
    const t = await setup();
    const asked = (await t.ask(t.jessie, { kind: 'movie', tmdbId: 693134 })).body as RequestView;
    const ok = await call(t.app, 'POST', `/api/requests/${asked.id}/approve`, { profile: 'everyday-hd' }, t.admin);
    expect(ok.status).toBe(200);
    expect((ok.body as RequestView).profile).toBe('Everyday HD');
    expect(t.db.select().from(schema.movies).all()[0]).toMatchObject({ profile: 'everyday-hd', profileByHand: true, monitored: true });
    expect((await t.inbox(t.jessie)).items[0]).toMatchObject({ event: 'request_approved' });
    expect(((await call(t.app, 'POST', `/api/requests/${asked.id}/approve`, {}, t.admin)).body as { error: string }).error).toBe('already_decided');
  });

  it('declining carries a reason the person can read, and can be put back', async () => {
    const t = await setup();
    const asked = (await t.ask(t.jessie, { kind: 'movie', tmdbId: 603 })).body as RequestView;
    const no = await call(t.app, 'POST', `/api/requests/${asked.id}/decline`, { reason: 'We have it on disc.' }, t.admin);
    expect(no.body).toMatchObject({ state: 'declined', reason: 'We have it on disc.', stateText: 'Turned down: We have it on disc.' });
    const mine = ((await call(t.app, 'GET', '/api/requests', undefined, t.jessie)).body as { items: RequestView[] }).items;
    expect(mine[0]).toMatchObject({ state: 'declined', reason: 'We have it on disc.' });
    expect((await t.inbox(t.jessie)).items[0]!.body).toBe('The Matrix was turned down: We have it on disc.');
    const back = await call(t.app, 'POST', `/api/requests/${asked.id}/reopen`, {}, t.admin);
    expect((back.body as RequestView).state).toBe('pending');
  });

  it('only admins decide, and people only see their own requests', async () => {
    const t = await setup();
    const asked = (await t.ask(t.jessie, { kind: 'movie', tmdbId: 603 })).body as RequestView;
    expect((await call(t.app, 'POST', `/api/requests/${asked.id}/approve`, {}, t.jessie)).status).toBe(403);
    expect((await call(t.app, 'POST', `/api/requests/${asked.id}/decline`, {}, t.kiddo)).status).toBe(403);
    expect(((await call(t.app, 'GET', '/api/requests?scope=all', undefined, t.kiddo)).body as { items: unknown[] }).items).toEqual([]);
    expect(((await call(t.app, 'GET', '/api/requests?scope=all', undefined, t.admin)).body as { items: unknown[] }).items).toHaveLength(1);
  });

  it('says "already here" for a title you have and "already asked for" for one someone asked for', async () => {
    const t = await setup();
    await t.ask(t.admin, { kind: 'movie', tmdbId: 693134 });
    const movie = t.db.select().from(schema.movies).all()[0]!;
    t.db.insert(schema.mediaFiles).values({ path: '/m/dune.mkv', movieId: movie.id, size: GB, mtime: 0, addedAt: 0, seenAt: 0 }).run();
    const here = await t.ask(t.jessie, { kind: 'movie', tmdbId: 693134 });
    expect([here.status, (here.body as { error: string }).error]).toEqual([409, 'already_here']);
    await t.ask(t.jessie, { kind: 'movie', tmdbId: 603 });
    const dup = await t.ask(t.sam, { kind: 'movie', tmdbId: 603 });
    expect([dup.status, (dup.body as { error: string }).error]).toEqual([409, 'already_requested']);
  });

  it('kids can only ask for kid-safe titles', async () => {
    const t = await setup();
    const no = await t.ask(t.kiddo, { kind: 'movie', tmdbId: 693134 });
    expect([no.status, (no.body as { error: string }).error]).toEqual([403, 'not_for_kids']);
    const yes = await t.ask(t.kiddo, { kind: 'movie', tmdbId: 14160 });
    expect(yes.status).toBe(201);
    expect((yes.body as RequestView).state).toBe('pending');
  });

  it('a show can be asked for by season, only those seasons become wanted, and more can be added later', async () => {
    const t = await setup();
    const asked = (await t.ask(t.jessie, { kind: 'series', tmdbId: 95396, seasons: [2] })).body as RequestView;
    expect(asked.seasons).toEqual([2]);
    expect(((await t.ask(t.sam, { kind: 'series', tmdbId: 95396, seasons: [2] })).body as { error: string }).error).toBe('already_requested');
    expect((await t.ask(t.jessie, { kind: 'series', tmdbId: 95396, seasons: [9] })).status).toBe(400);
    await call(t.app, 'POST', `/api/requests/${asked.id}/approve`, {}, t.admin);
    const show = t.db.select().from(schema.series).all()[0]!;
    expect(show.monitored).toBe(true);
    const eps = t.db.select().from(schema.episodes).all();
    expect(eps.filter((e) => e.monitored).map((e) => e.season)).toEqual([2, 2]);
    expect(eps.filter((e) => !e.monitored).map((e) => e.season)).toEqual([1, 1]);
    // Season 1 can still be asked for.
    expect((await t.ask(t.jessie, { kind: 'series', tmdbId: 95396, seasons: [1] })).status).toBe(201);
  });

  it('people can take back a waiting request; admins can remove any', async () => {
    const t = await setup();
    const a = (await t.ask(t.jessie, { kind: 'movie', tmdbId: 603 })).body as RequestView;
    const b = (await t.ask(t.jessie, { kind: 'movie', tmdbId: 78 })).body as RequestView;
    expect((await call(t.app, 'DELETE', `/api/requests/${a.id}`, undefined, t.kiddo)).status).toBe(403);
    expect((await call(t.app, 'DELETE', `/api/requests/${a.id}`, undefined, t.jessie)).status).toBe(200);
    await call(t.app, 'POST', `/api/requests/${b.id}/decline`, {}, t.admin);
    expect((await call(t.app, 'DELETE', `/api/requests/${b.id}`, undefined, t.jessie)).status).toBe(409);
    expect((await call(t.app, 'DELETE', `/api/requests/${b.id}`, undefined, t.admin)).status).toBe(200);
  });

  it('tells the person once when it reaches the library', async () => {
    const t = await setup();
    const asked = (await t.ask(t.jessie, { kind: 'movie', tmdbId: 693134 })).body as RequestView;
    await call(t.app, 'POST', `/api/requests/${asked.id}/approve`, {}, t.admin);
    const { markReady } = await import('../src/requests/service.js');
    const deps = { db: t.db, notify: { db: t.db, push: { send: async () => {} }, now: Date.now }, now: Date.now };
    expect(markReady(deps)).toBe(0);
    const movie = t.db.select().from(schema.movies).all()[0]!;
    t.db.insert(schema.mediaFiles).values({ path: '/m/dune.mkv', movieId: movie.id, size: GB, mtime: 0, addedAt: 0, seenAt: 0 }).run();
    expect(markReady(deps)).toBe(1);
    expect(markReady(deps)).toBe(0);
    const items = (await t.inbox(t.jessie)).items.map((i) => i.event);
    expect(items).toContain('request_ready');
    const list = ((await call(t.app, 'GET', '/api/requests', undefined, t.jessie)).body as { items: RequestView[] }).items;
    expect(list[0]!.state).toBe('ready');
  });

  it('a person can turn an event off and then isn’t told', async () => {
    const t = await setup();
    await call(t.app, 'PUT', '/api/notifications/muted', { muted: ['request_declined'] }, t.jessie);
    const asked = (await t.ask(t.jessie, { kind: 'movie', tmdbId: 603 })).body as RequestView;
    await call(t.app, 'POST', `/api/requests/${asked.id}/decline`, { reason: 'No.' }, t.admin);
    expect((await t.inbox(t.jessie)).items).toEqual([]);
  });
});

describe('Push channels', () => {
  it('sends admin events to the channels that have them on, records failures, and never sends secrets back', async () => {
    const t = await setup();
    const made = await call(t.app, 'POST', '/api/settings/notifications', { kind: 'pushover', name: 'My phone', appToken: 'apptoken', userKey: 'userkey', events: ['request_pending'] }, t.admin);
    expect(made.status).toBe(201);
    expect(JSON.stringify(made.body)).not.toMatch(/apptoken|userkey/);
    await call(t.app, 'POST', '/api/settings/notifications', { kind: 'ntfy', name: 'ntfy', topic: 'marquee', events: ['imported'] }, t.admin);
    await t.ask(t.jessie, { kind: 'movie', tmdbId: 603 });
    expect(t.pushed).toEqual([{ kind: 'pushover', title: 'New request', body: 'Jessie asked for The Matrix (1999).' }]);
    const list = (await call(t.app, 'GET', '/api/settings/notifications', undefined, t.admin)).body as { items: { name: string; detail: string; lastOkAt: number | null }[] };
    expect(list.items.map((i) => [i.name, i.detail, i.lastOkAt !== null])).toEqual([['My phone', 'Pushover', true], ['ntfy', 'https://ntfy.sh/marquee', false]]);
  });

  it('a channel that fails says why and the rest still work; Test says how it went', async () => {
    const t = await setup();
    const app = makeApp({ clients: { tmdb: () => new FakeTmdb(), push: { send: async () => { throw new Error('Pushover turned the token or user key down.'); } } } });
    const admin = await setupAdmin(app.app);
    const ch = (await call(app.app, 'POST', '/api/settings/notifications', { kind: 'pushover', name: 'p', appToken: 'a', userKey: 'u' }, admin)).body as { id: number };
    const test = await call(app.app, 'POST', `/api/settings/notifications/${ch.id}/test`, {}, admin);
    expect(test.body).toMatchObject({ ok: false, message: 'Pushover turned the token or user key down.' });
    const list = (await call(app.app, 'GET', '/api/settings/notifications', undefined, admin)).body as { items: { lastError: string }[] };
    expect(list.items[0]!.lastError).toMatch(/turned the token/);
    expect((await call(t.app, 'GET', '/api/settings/notifications', undefined, t.jessie)).status).toBe(403);
  });
});

describe('Notification wording', () => {
  it('an admin’s own wording is used for push and the bell, previews say which names are unknown, and it can be put back', async () => {
    const t = await setup();
    await call(t.app, 'POST', '/api/settings/notifications', { kind: 'ntfy', name: 'ntfy', topic: 'marquee', events: ['request_pending'] }, t.admin);
    const mine = { title: '🎬 {{user}} wants {{title}}', body: '{{#year}}From {{year}}.{{/year}}{{^year}}No year.{{/year}} {{nope}}', image: '{{poster}}' };
    const preview = await call(t.app, 'POST', '/api/settings/notifications/templates/preview', { event: 'request_pending', ...mine }, t.admin);
    expect(preview.body).toMatchObject({ title: '🎬 Jessie wants Dune: Part Two', body: 'From 2024.', unknown: ['nope'] });
    expect((preview.body as { image: string }).image).toMatch(/^https:\/\/image\.tmdb\.org\//);
    const saved = await call(t.app, 'PUT', '/api/settings/notifications/templates/request_pending', mine, t.admin);
    expect(saved.body).toMatchObject({ custom: true });
    await t.ask(t.jessie, { kind: 'movie', tmdbId: 603 });
    expect(t.pushed.at(-1)).toEqual({ kind: 'ntfy', title: '🎬 Jessie wants The Matrix', body: 'From 1999.' });
    expect((await t.inbox(t.admin)).items[0]).toMatchObject({ title: '🎬 Jessie wants The Matrix' });

    const list = (await call(t.app, 'GET', '/api/settings/notifications/templates', undefined, t.admin)).body as { items: { event: string; custom: boolean }[] };
    expect(list.items.find((i) => i.event === 'request_pending')!.custom).toBe(true);
    expect((await call(t.app, 'DELETE', '/api/settings/notifications/templates/request_pending', undefined, t.admin)).body).toMatchObject({ custom: false, title: 'New request' });
    await t.ask(t.sam, { kind: 'movie', tmdbId: 693134 });
    expect(t.pushed.at(-1)).toMatchObject({ title: 'New request', body: 'Sam asked for Dune: Part Two (2024).' });

    expect((await call(t.app, 'PUT', '/api/settings/notifications/templates/request_pending', { ...mine, title: '  ' }, t.admin)).status).toBe(400);
    expect((await call(t.app, 'PUT', '/api/settings/notifications/templates/nope', mine, t.admin)).status).toBe(404);
    expect((await call(t.app, 'GET', '/api/settings/notifications/templates', undefined, t.jessie)).status).toBe(403);
  });
});

describe('Each person’s own push channels', () => {
  it('a member can add their own channel for their own events; it’s private to them and respects muting', async () => {
    const t = await setup();
    const made = await call(t.app, 'POST', '/api/notifications/channels', { kind: 'ntfy', name: 'My phone', topic: 'jess', events: ['request_declined', 'request_pending'] }, t.jessie);
    expect(made.status).toBe(201);
    const ch = made.body as { id: number; events: string[] };
    expect(ch.events).toEqual(['request_declined']); // admin-only events are dropped
    expect(((await call(t.app, 'GET', '/api/settings/notifications', undefined, t.admin)).body as { items: unknown[] }).items).toEqual([]);
    expect((await call(t.app, 'PATCH', `/api/notifications/channels/${ch.id}`, { enabled: false }, t.sam)).status).toBe(404);

    const asked = (await t.ask(t.jessie, { kind: 'movie', tmdbId: 603 })).body as RequestView;
    expect(t.pushed).toEqual([]); // request_pending is for admins, and no admin channel is set up
    await call(t.app, 'POST', `/api/requests/${asked.id}/decline`, { reason: 'We have it on Netflix' }, t.admin);
    await new Promise((r) => setTimeout(r, 0));
    expect(t.pushed).toEqual([{ kind: 'ntfy', title: 'Request turned down', body: 'The Matrix was turned down: We have it on Netflix' }]);

    await call(t.app, 'PUT', '/api/notifications/muted', { muted: ['request_declined'] }, t.jessie);
    await call(t.app, 'POST', `/api/requests/${asked.id}/reopen`, {}, t.admin);
    await call(t.app, 'POST', `/api/requests/${asked.id}/decline`, { reason: '' }, t.admin);
    await new Promise((r) => setTimeout(r, 0));
    expect(t.pushed).toHaveLength(1);
  });

  it('tells the person who asked for a show when a new episode arrives, after the first "Ready to watch"', async () => {
    const t = await setup();
    const { tellNewEpisodes } = await import('../src/requests/service.js');
    const show = t.db.insert(schema.series).values({ tmdbId: 95396, title: 'Severance', sortTitle: 'severance', addedAt: 0, refreshedAt: 0, posterPath: '/sev.jpg' } as never).returning().get();
    const ids = t.db.select().from(schema.users).all();
    const jessie = ids.find((u) => u.username === 'jessie')!.id;
    const sam = ids.find((u) => u.username === 'sam')!.id;
    const req = (by: number, seasons: number[] | null, readyAt: number | null) =>
      t.db.insert(schema.requests).values({ kind: 'series', tmdbId: 95396, title: 'Severance', requestedBy: by, status: 'approved', titleId: show.id, seasons: seasons ? JSON.stringify(seasons) : null, readyAt, createdAt: 0 }).run();
    req(jessie, null, 5);
    req(sam, [1], 5); // only asked for season 1
    const deps = { db: t.db, notify: { db: t.db, push: { send: async () => {} }, now: Date.now }, now: Date.now };
    expect(tellNewEpisodes(deps, { kind: 'tv', seriesId: show.id, season: 2, episodes: '[3]' })).toBe(1);
    expect((await t.inbox(t.jessie)).items[0]).toMatchObject({ event: 'new_episode', title: 'New episode of Severance', body: 'S02E03 is ready to watch.', image: 'https://image.tmdb.org/t/p/w500/sev.jpg' });
    expect((await t.inbox(t.sam)).items).toEqual([]);
    expect(tellNewEpisodes(deps, { kind: 'movie', seriesId: null, season: null, episodes: null })).toBe(0);
  });
});

describe('Discover', () => {
  it('builds rows and a banner, marks what you have and what’s asked for, and hides services you don’t want', async () => {
    const t = await setup();
    await t.ask(t.admin, { kind: 'movie', tmdbId: 693134 });
    await t.ask(t.jessie, { kind: 'movie', tmdbId: 1022789 });
    const page = (await call(t.app, 'GET', '/api/discover?type=movie', undefined, t.jessie)).body as DiscoverPage;
    expect(page.hero.length).toBeGreaterThan(0);
    expect(page.hero.every((c) => c.backdropPath && c.overview)).toBe(true);
    const trending = page.rows.find((r) => r.id === 'trending')!;
    const byTitle = Object.fromEntries(trending.items.map((c) => [c.title, c.state]));
    expect(byTitle['Dune: Part Two']).toBe('downloading');
    expect(byTitle['Inside Out 2']).toBe('pending');
    expect(byTitle['The Matrix']).toBe('none');
    expect(page.services.map((s) => s.key)).toContain('netflix');
    await call(t.app, 'PUT', '/api/discover/prefs', { hiddenServices: ['netflix', 'peacock'], trailers: false }, t.jessie);
    const again = (await call(t.app, 'GET', '/api/discover?type=movie', undefined, t.jessie)).body as DiscoverPage;
    expect(again.services.map((s) => s.key)).not.toContain('netflix');
    expect((await call(t.app, 'GET', '/api/discover?type=movie', undefined, t.admin)).body.services.map((s: { key: string }) => s.key)).toContain('netflix');
  });

  it('a service tab shows what’s on that service', async () => {
    const t = await setup();
    const page = (await call(t.app, 'GET', '/api/discover?type=series&service=netflix', undefined, t.admin)).body as DiscoverPage;
    const all = page.rows.flatMap((r) => r.items.map((c) => c.title));
    expect(all).toContain('Stranger Things');
    expect(all).not.toContain('Severance');
    expect((await call(t.app, 'GET', '/api/discover?service=nope', undefined, t.admin)).status).toBe(400);
  });

  it('browsing a genre filters by it', async () => {
    const t = await setup();
    const page = (await call(t.app, 'GET', '/api/discover?type=movie&genre=Animation', undefined, t.admin)).body as DiscoverPage;
    const titles = page.rows.flatMap((r) => r.items.map((c) => c.title));
    expect(titles).toContain('Moana 2');
    expect(titles).not.toContain('Gladiator II');
  });

  it('"Because you…" rows come from your library, requests and suggestions, and leave out what you already have', async () => {
    const t = await setup();
    await t.ask(t.admin, { kind: 'movie', tmdbId: 14160 }); // Up
    await t.ask(t.admin, { kind: 'movie', tmdbId: 1022789 }); // Inside Out 2
    const page = (await call(t.app, 'GET', '/api/discover?type=movie', undefined, t.admin)).body as DiscoverPage;
    const because = page.rows.filter((r) => r.id.startsWith('because-have') || r.id === 'top-picks');
    expect(because.length).toBeGreaterThan(0);
    for (const r of because) for (const c of r.items) expect(['Up', 'Inside Out 2']).not.toContain(c.title);
    expect(because.flatMap((r) => r.items.map((c) => c.title))).toContain('Moana 2');
    expect(because.map((r) => r.title).join(' ')).toMatch(/Because you have/);
  });

  it('"Because you watched…" comes from that person’s own Plex and Jellyfin history', async () => {
    const t = await setup();
    const play = (userName: string, server: 'plex' | 'jellyfin', title: string, tmdbId: number | null, at: number) =>
      t.db.insert(schema.plays).values({ server, serverUserId: userName, userName, itemKey: `${title}${at}`, kind: 'movie', title, tmdbId, playedAt: at }).run();
    play('Jessie', 'plex', 'Up', 14160, 1000);
    play('jessie', 'jellyfin', 'Up', 14160, 2000); // same title on the other server shows once
    play('sam', 'plex', 'Dune: Part Two', 693134, 3000); // someone else's
    play('jessie', 'plex', 'Home video', null, 4000); // no TMDB id and not in the library: skipped
    const page = (await call(t.app, 'GET', '/api/discover?type=movie', undefined, t.jessie)).body as DiscoverPage;
    const watched = page.rows.filter((r) => r.id.startsWith('because-watched'));
    expect(watched.map((r) => r.title)).toEqual(['Because you watched Up']);
    const samPage = (await call(t.app, 'GET', '/api/discover?type=movie', undefined, t.sam)).body as DiscoverPage;
    expect(samPage.rows.filter((r) => r.id.startsWith('because-watched')).map((r) => r.title)).not.toContain('Because you watched Up');
  });

  it('kids only see kid-safe titles everywhere', async () => {
    const t = await setup();
    const page = (await call(t.app, 'GET', '/api/discover', undefined, t.kiddo)).body as DiscoverPage;
    const titles = new Set(page.rows.flatMap((r) => r.items.map((c) => c.title)).concat(page.hero.map((c) => c.title)));
    expect(titles.size).toBeGreaterThan(0);
    for (const bad of ['Dune: Part Two', 'Gladiator II', 'Severance', 'Stranger Things', 'The Bear', 'Anora']) expect(titles).not.toContain(bad);
    expect([...titles].some((x) => ['Moana 2', 'Inside Out 2', 'Bluey', 'Up', 'Sesame Street', 'The Wild Robot'].includes(x))).toBe(true);
    expect((await call(t.app, 'GET', '/api/discover/title/movie/693134', undefined, t.kiddo)).status).toBe(403);
    expect((await call(t.app, 'GET', '/api/discover/title/movie/14160', undefined, t.kiddo)).status).toBe(200);
  });

  it('a title page has the trailer (unless turned off), providers, seasons with where they stand, and whether it can be asked for', async () => {
    const t = await setup();
    await t.ask(t.admin, { kind: 'movie', tmdbId: 693134 });
    const dune = (await call(t.app, 'GET', '/api/discover/title/movie/693134', undefined, t.jessie)).body as DiscoverTitle;
    expect(dune).toMatchObject({ trailerKey: 'duneTrailer', providers: ['HBO Max'], canRequest: false, note: 'Approved. Marquee is looking for it.' });
    await call(t.app, 'PUT', '/api/discover/prefs', { hiddenServices: [], trailers: false }, t.jessie);
    expect(((await call(t.app, 'GET', '/api/discover/title/movie/693134', undefined, t.jessie)).body as DiscoverTitle).trailerKey).toBeNull();
    const sev = (await call(t.app, 'GET', '/api/discover/title/series/95396', undefined, t.jessie)).body as DiscoverTitle;
    expect(sev.canRequest).toBe(true);
    expect(sev.seasons.map((s) => [s.season, s.state])).toEqual([[1, 'none'], [2, 'none']]);
    expect(sev.similar?.items.length).toBeGreaterThan(0);
    await t.ask(t.jessie, { kind: 'series', tmdbId: 95396, seasons: [2] });
    const after = (await call(t.app, 'GET', '/api/discover/title/series/95396', undefined, t.jessie)).body as DiscoverTitle;
    expect(after.seasons.map((s) => [s.season, s.state])).toEqual([[1, 'none'], [2, 'pending']]);
    expect(after.canRequest).toBe(true);
    expect(after.request).toMatchObject({ seasons: [2], state: 'pending' });
  });
});

describe('Not out yet', () => {
  it('an approved request for a movie not out says when, and doesn’t search', async () => {
    const t = await setup();
    const r = (await t.ask(t.admin, { kind: 'movie', tmdbId: 990001 })).body as RequestView;
    expect(r.state).toBe('unreleased');
    expect(r.stateText).toBe('Approved. It comes out in cinemas Jun 1, 2027. Marquee looks for it once it’s out to stream or buy, around Aug 30, 2027.');
    expect(t.db.select().from(schema.downloads).all()).toEqual([]);
    const page = (await call(t.app, 'GET', '/api/discover/title/movie/990001', undefined, t.jessie)).body as DiscoverTitle;
    expect(page.details).toMatchObject({ released: false, releaseDate: '2027-11-24' });
    expect(page.note).toMatch(/Approved\. It comes out/);
  });

  it('a title page carries the details other apps show', async () => {
    const t = await setup();
    const d = ((await call(t.app, 'GET', '/api/discover/title/movie/693134', undefined, t.jessie)).body as DiscoverTitle).details;
    expect(d).toMatchObject({ released: true, directors: ['A. Director'], language: 'English', score: 8.1, budget: 100_000_000 });
    expect(d.releases.map((x) => x.kind)).toEqual(['Theatrical', 'Digital']);
  });
});

describe('Top 10 on a service', () => {
  it('lists the movies and shows on it, with kids kept to kid-safe ones', async () => {
    const t = await setup();
    const top = (await call(t.app, 'GET', '/api/discover/top?service=disney', undefined, t.admin)).body as { movies: { title: string }[]; shows: { title: string }[] };
    expect(top.movies.map((m) => m.title)).toContain('Inside Out 2');
    expect(top.shows.map((m) => m.title)).toContain('Bluey');
    const kid = (await call(t.app, 'GET', '/api/discover/top?service=max', undefined, t.kiddo)).body as { movies: { title: string }[]; shows: { title: string }[] };
    expect(kid.movies).toEqual([]);
    expect(kid.shows.map((m) => m.title)).toEqual(['Sesame Street']);
    expect((await call(t.app, 'GET', '/api/discover/top?service=nope', undefined, t.admin)).status).toBe(400);
  });

  const topOf = async (t: Awaited<ReturnType<typeof setup>>, service: string, cookie: string) => (await call(t.app, 'GET', `/api/discover/top?service=${service}`, undefined, cookie)).body as ServiceTop;

  it('without a Streaming Availability key it isn’t numbered, and admins are told how to get the real one', async () => {
    const t = await setup();
    const admin = await topOf(t, 'disney', t.admin);
    expect(admin.ranked).toBe(false);
    expect(admin.note).toMatch(/Streaming Availability key in Settings → Services/);
    expect((await topOf(t, 'disney', t.jessie)).note).toBeNull();
  });

  it('with a key it is the service’s own Top 10, in its order, kept to kid-safe titles for kids', async () => {
    const t = await setup();
    t.top.lists = { disney: { movie: [1241982, 1022789], series: [82728] }, hbo: { movie: [603], series: [502] } };
    expect((await call(t.app, 'PUT', '/api/settings/services', { streamingTopKey: 'good-top-key' }, t.admin)).status).toBe(200);
    const disney = await topOf(t, 'disney', t.admin);
    expect(disney).toMatchObject({ ranked: true, note: null });
    expect(disney.movies.map((m) => m.title)).toEqual(['Moana 2', 'Inside Out 2']);
    expect(disney.shows.map((m) => m.title)).toEqual(['Bluey']);
    // HBO Max asks Streaming Availability for "hbo"; nothing on its list is for kids.
    const kid = await topOf(t, 'max', t.kiddo);
    expect(kid.ranked).toBe(true);
    expect(kid.movies).toEqual([]);
    expect(t.top.calls).toContain('hbo:movie');
  });

  it('a service with no Top 10 there, or a key turned down, falls back to popular titles and says why', async () => {
    const t = await setup();
    await call(t.app, 'PUT', '/api/settings/services', { streamingTopKey: 'good-top-key' }, t.admin);
    const peacock = await topOf(t, 'peacock', t.admin);
    expect(peacock.ranked).toBe(false);
    expect(peacock.note).toMatch(/Peacock doesn’t share a Top 10/);
    expect(t.top.calls.some((c) => c.startsWith('peacock'))).toBe(false);
    expect(peacock.movies.length).toBeGreaterThan(0);
    await call(t.app, 'PUT', '/api/settings/services', { streamingTopKey: 'wrong' }, t.admin);
    const bad = await topOf(t, 'disney', t.admin);
    expect(bad.ranked).toBe(false);
    expect(bad.note).toMatch(/turned the key down/);
    expect(bad.movies.map((m) => m.title)).toContain('Inside Out 2');
  });

  it('Paramount+ counts every TMDB id it has, not just the old one', async () => {
    const t = await setup();
    const p = await topOf(t, 'paramount', t.admin);
    expect(p.movies.map((m) => m.title)).toContain('Gladiator II');
  });

  it('tests the Streaming Availability key from Settings → Services', async () => {
    const t = await setup();
    const ok = await call(t.app, 'POST', '/api/settings/services/test', { service: 'streamingTop', apiKey: 'good-top-key' }, t.admin);
    expect(ok.body).toMatchObject({ ok: true });
    const bad = await call(t.app, 'POST', '/api/settings/services/test', { service: 'streamingTop', apiKey: 'nope-nope' }, t.admin);
    expect(bad.body).toMatchObject({ ok: false, message: expect.stringMatching(/turned the key down/) });
    const view = (await call(t.app, 'GET', '/api/settings/services', undefined, t.admin)).body as { streamingTop: { configured: boolean } };
    expect(view.streamingTop.configured).toBe(false);
  });
});

describe('Discover search', () => {
  it('finds movies and shows with where they stand, and keeps kids to kid-safe ones', async () => {
    const t = await setup();
    await t.ask(t.admin, { kind: 'movie', tmdbId: 693134 });
    const r = (await call(t.app, 'GET', '/api/discover/search?q=dune', undefined, t.jessie)).body as { results: { title: string; state: string; kind: string }[] };
    expect(r.results.find((x) => x.title === 'Dune: Part Two')).toMatchObject({ kind: 'movie', state: 'downloading' });
    const kid = (await call(t.app, 'GET', '/api/discover/search?q=dune', undefined, t.kiddo)).body as { results: unknown[] };
    expect(kid.results).toEqual([]);
    expect((await call(t.app, 'GET', '/api/discover/search?q=', undefined, t.jessie)).status).toBe(400);
  });
});

describe('Discover row order', () => {
  it('puts the everyday rows first, Latest releases right after Trending, and the “because you…” rows last', async () => {
    const t = await setup();
    await t.ask(t.admin, { kind: 'movie', tmdbId: 693134 });
    await t.ask(t.admin, { kind: 'movie', tmdbId: 1022789 });
    await t.ask(t.admin, { kind: 'series', tmdbId: 95396 });
    const page = (await call(t.app, 'GET', '/api/discover', undefined, t.admin)).body as DiscoverPage;
    const ids = page.rows.map((r) => r.id);
    const personal = ids.map((id, i) => (id.startsWith('because') || id === 'top-picks' ? i : -1)).filter((i) => i >= 0);
    const everyday = ids.map((id, i) => (id.startsWith('because') || id === 'top-picks' ? -1 : i)).filter((i) => i >= 0);
    expect(personal.length).toBeGreaterThan(0);
    expect(Math.min(...personal)).toBeGreaterThan(Math.max(...everyday));
    if (ids.includes('latest')) expect(ids.indexOf('latest')).toBe(ids.indexOf('trending') + 1);
  });
});
