import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { IssueView, NotificationInboxItem, RequestAllowance, RequestView, UserSummary } from '@marquee/shared';
import { schema } from '../src/db/index.js';
import { HttpPushClient } from '../src/notify/push.js';
import { searchesSettled } from '../src/requests/service.js';
import { toIcal } from '../src/library/ical.js';
import { FakeTmdb } from './fakes/tmdb.js';
import { call, makeApp, setupAdmin } from './helpers.js';

const NOW = Date.parse('2026-11-23T12:00:00Z');
const DAY = 86_400_000;

async function setup() {
  let clock = NOW;
  const pushed: { kind: string; title: string; event?: string }[] = [];
  const t = makeApp({ now: () => clock, clients: { tmdb: () => new FakeTmdb(), push: { send: async (ch, m) => void pushed.push({ kind: ch.kind, title: m.title, event: m.event }) } } });
  const admin = await setupAdmin(t.app);
  await call(t.app, 'PUT', '/api/settings/services', { tmdbApiKey: 'good-key' }, admin);
  const person = async (username: string, role: 'member' | 'kid') => {
    const made = await call(t.app, 'POST', '/api/users', { username, displayName: username[0]!.toUpperCase() + username.slice(1), role, password: `${username} password` }, admin);
    const cookie = (await call(t.app, 'POST', '/api/auth/login', { username, password: `${username} password` })).cookie!;
    return { cookie, id: made.body.user.id as number };
  };
  const inbox = async (cookie: string) => ((await call(t.app, 'GET', '/api/notifications', undefined, cookie)).body as { items: NotificationInboxItem[] }).items;
  return { ...t, admin, person, inbox, pushed, later: (ms: number) => (clock += ms) };
}

describe('Requests skip approval (per person)', () => {
  it('a member with the switch on gets requests straight through; kids only ever for kids’ titles', async () => {
    const t = await setup();
    const jessie = await t.person('jessie', 'member');
    const kid = await t.person('kiddo', 'kid');
    const res = await call(t.app, 'PATCH', `/api/users/${jessie.id}`, { skipApproval: true, weeklyLimit: 3 }, t.admin);
    expect((res.body.user as UserSummary)).toMatchObject({ skipApproval: true, weeklyLimit: 3 });
    await call(t.app, 'PATCH', `/api/users/${kid.id}`, { skipApproval: true }, t.admin);
    const r = (await call(t.app, 'POST', '/api/requests', { kind: 'movie', tmdbId: 14160 }, jessie.cookie)).body as RequestView;
    expect(r.state).not.toBe('pending');
    const k = (await call(t.app, 'POST', '/api/requests', { kind: 'movie', tmdbId: 1022789 }, kid.cookie)).body as RequestView;
    expect(k.state).not.toBe('pending');
    expect((await call(t.app, 'POST', '/api/requests', { kind: 'movie', tmdbId: 603 }, kid.cookie)).status).toBe(403);
    await searchesSettled();
    expect(t.db.select().from(schema.movies).all().map((m) => [m.title, m.monitored])).toEqual([
      ['Up', true],
      ['Inside Out 2', true],
    ]);
  });
});

describe('Weekly limits', () => {
  it('shows what’s left before asking, stops at the limit and says when the next one frees up', async () => {
    const t = await setup();
    const sam = await t.person('sam', 'member');
    await call(t.app, 'PATCH', `/api/users/${sam.id}`, { weeklyLimit: 2 }, t.admin);
    const left = async () => (await call(t.app, 'GET', '/api/requests/allowance', undefined, sam.cookie)).body as RequestAllowance;
    expect(await left()).toEqual({ limit: 2, used: 0, left: 2, nextAt: null, skipApproval: false });
    await call(t.app, 'POST', '/api/requests', { kind: 'movie', tmdbId: 603 }, sam.cookie);
    t.later(DAY);
    const second = (await call(t.app, 'POST', '/api/requests', { kind: 'movie', tmdbId: 604 }, sam.cookie)).body as RequestView;
    expect(await left()).toMatchObject({ used: 2, left: 0, nextAt: NOW + 7 * DAY });
    const third = await call(t.app, 'POST', '/api/requests', { kind: 'movie', tmdbId: 78 }, sam.cookie);
    expect(third.status).toBe(429);
    expect(third.body.message).toMatch(/You’ve used all 2 of your requests this week\. The next one frees up Monday, Nov 30\./);
    // A turned-down request doesn't count.
    await call(t.app, 'POST', `/api/requests/${second.id}/decline`, { reason: 'No' }, t.admin);
    expect((await left()).left).toBe(1);
    // A week later the first one stops counting; admins have no limit.
    t.later(7 * DAY);
    expect((await left()).left).toBe(2);
    expect(((await call(t.app, 'GET', '/api/requests/allowance', undefined, t.admin)).body as RequestAllowance)).toMatchObject({ limit: 0, left: null, skipApproval: true });
  });
});

describe('Webhook channel', () => {
  it('sends one JSON POST per message, with the event, wording, facts and an optional secret', async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const client = new HttpPushClient((async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response('ok', { status: url.includes('bad') ? 500 : 200 });
    }) as typeof fetch);
    await client.send({ kind: 'webhook', config: { url: 'https://hooks.test/marquee', secret: 's3cret-value' } }, { title: 'Ready to watch', body: 'Up is in the library.', link: 'https://m.test/x', event: 'request_ready', vars: { title: 'Up' } });
    const body = JSON.parse(String(sent[0]!.init.body));
    expect(body).toMatchObject({ event: 'request_ready', title: 'Ready to watch', body: 'Up is in the library.', link: 'https://m.test/x', vars: { title: 'Up' } });
    expect((sent[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer s3cret-value');
    await expect(client.send({ kind: 'webhook', config: { url: 'https://bad.test/' } }, { title: 'x', body: 'y' })).rejects.toThrow(/The webhook answered 500/);
  });

  it('is a channel like the others: made in Settings → Notifications, its secret never shown', async () => {
    const t = await setup();
    expect((await call(t.app, 'POST', '/api/settings/notifications', { kind: 'webhook', name: 'Home Assistant', url: 'ftp://nope' }, t.admin)).status).toBe(400);
    const made = await call(t.app, 'POST', '/api/settings/notifications', { kind: 'webhook', name: 'Home Assistant', url: 'https://ha.test/api/webhook/abc', secret: 'very-secret' }, t.admin);
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ kind: 'webhook', detail: 'https://ha.test/…' });
    expect(JSON.stringify(made.body)).not.toMatch(/very-secret|webhook\/abc/);
    const test = await call(t.app, 'POST', `/api/settings/notifications/${made.body.id}/test`, {}, t.admin);
    expect(test.body.ok).toBe(true);
    expect(t.pushed.at(-1)).toMatchObject({ kind: 'webhook', event: 'test' });
  });
});

describe('Private calendar link (iCal)', () => {
  it('makes a secret link a calendar app can read without signing in; kids get kids’ titles only', async () => {
    const t = await setup();
    const kid = await t.person('kiddo', 'kid');
    const show = (title: string, cert: string) => t.db.insert(schema.series).values({ tmdbId: title.length, title, sortTitle: title, profile: 'cinema', addedAt: 0, refreshedAt: 0, certification: cert }).returning().get();
    const sev = show('Severance', 'TV-MA');
    const bluey = show('Bluey', 'TV-Y');
    t.db.insert(schema.episodes).values([{ seriesId: sev.id, season: 2, episode: 3, title: 'Who Is Alive?', airDate: '2026-11-25' }, { seriesId: bluey.id, season: 3, episode: 1, title: 'Dance, Mode', airDate: '2026-11-26' }]).run();
    expect((await call(t.app, 'GET', '/api/calendar/link', undefined, t.admin)).body.path).toBeNull();
    const link = (await call(t.app, 'POST', '/api/calendar/link', {}, t.admin)).body.path as string;
    expect(link).toMatch(/^\/api\/calendar\/ical\/[A-Za-z0-9_-]{32}\.ics$/);
    const feed = await t.app.request(link);
    expect(feed.headers.get('content-type')).toMatch(/text\/calendar/);
    const text = await feed.text();
    expect(text).toContain('SUMMARY:Severance S02E03 · Who Is Alive?');
    expect(text).toContain('SUMMARY:Bluey S03E01 · Dance\\, Mode');
    expect(text).toContain('DTSTART;VALUE=DATE:20261125');
    const kidLink = (await call(t.app, 'POST', '/api/calendar/link', {}, kid.cookie)).body.path as string;
    const kidText = await (await t.app.request(kidLink)).text();
    expect(kidText).toContain('Bluey');
    expect(kidText).not.toContain('Severance');
    // A new link replaces the old one; removing it stops the feed.
    const fresh = (await call(t.app, 'POST', '/api/calendar/link', {}, t.admin)).body.path as string;
    expect((await t.app.request(link)).status).toBe(404);
    await call(t.app, 'DELETE', '/api/calendar/link', undefined, t.admin);
    expect((await t.app.request(fresh)).status).toBe(404);
  });

  it('folds long lines and escapes text as calendar apps expect', () => {
    const ics = toIcal([{ kind: 'movie', seriesId: null, movieId: 1, show: 'A very long movie title that goes on and on, with commas; and semicolons', posterPath: null, season: 0, episode: 0, title: 'Out to stream or buy', airDate: '2026-12-01', state: 'coming', note: 'Wanted.' }], NOW);
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    expect(ics.replace(/\r\n /g, '')).toContain('with commas\\; and');
  });
});

describe('Something wrong?', () => {
  it('a report reaches admins; replies go both ways; fixing it tells the person', async () => {
    const t = await setup();
    const jessie = await t.person('jessie', 'member');
    const sam = await t.person('sam', 'member');
    const movie = t.db.insert(schema.movies).values({ tmdbId: 603, title: 'The Matrix', sortTitle: 'matrix', year: 1999, profile: 'cinema', addedAt: 0, refreshedAt: 0 }).returning().get();
    const show = t.db.insert(schema.series).values({ tmdbId: 95396, title: 'Severance', sortTitle: 'severance', year: 2022, profile: 'cinema', addedAt: 0, refreshedAt: 0 }).returning().get();
    expect((await call(t.app, 'POST', '/api/issues', { kind: 'movie', id: movie.id, problem: 'other', message: '' }, jessie.cookie)).body.message).toMatch(/Say what’s wrong/);
    const made = await call(t.app, 'POST', '/api/issues', { kind: 'movie', id: movie.id, problem: 'sound', message: 'Out of sync from 20 minutes.' }, jessie.cookie);
    expect(made.status).toBe(201);
    const issue = made.body as IssueView;
    expect(issue).toMatchObject({ title: 'The Matrix (1999)', problemText: 'Sound problem', status: 'open', by: 'Jessie', href: `/movies/${movie.id}` });
    expect((await t.inbox(t.admin))[0]).toMatchObject({ title: 'Something’s wrong with The Matrix (1999)', body: 'Jessie: Sound problem. “Out of sync from 20 minutes.”' });
    const ep = (await call(t.app, 'POST', '/api/issues', { kind: 'series', id: show.id, season: 2, episode: 3, problem: 'subtitles', message: '' }, sam.cookie)).body as IssueView;
    expect(ep.where).toBe('S02E03');

    // Each person sees only their own; admins see all.
    expect(((await call(t.app, 'GET', '/api/issues', undefined, jessie.cookie)).body.items as IssueView[]).map((i) => i.id)).toEqual([issue.id]);
    expect((await call(t.app, 'GET', `/api/issues/${ep.id}`, undefined, jessie.cookie)).status).toBe(404);
    expect(((await call(t.app, 'GET', '/api/issues', undefined, t.admin)).body.items as IssueView[]).length).toBe(2);

    await call(t.app, 'POST', `/api/issues/${issue.id}/replies`, { body: 'Which device?' }, t.admin);
    expect((await t.inbox(jessie.cookie))[0]).toMatchObject({ title: 'About The Matrix (1999)', body: 'Josh: Which device?' });
    await call(t.app, 'POST', `/api/issues/${issue.id}/replies`, { body: 'The living room TV.' }, jessie.cookie);
    expect((await t.inbox(t.admin))[0]).toMatchObject({ title: 'Jessie replied about The Matrix (1999)' });
    expect((await call(t.app, 'POST', `/api/issues/${issue.id}/fixed`, { message: 'x' }, jessie.cookie)).status).toBe(403);
    const fixed = (await call(t.app, 'POST', `/api/issues/${issue.id}/fixed`, { message: 'Swapped in a better copy.' }, t.admin)).body as IssueView;
    expect(fixed).toMatchObject({ status: 'fixed' });
    expect(fixed.comments.map((c) => [c.by, c.body])).toEqual([
      ['Josh', 'Which device?'],
      ['Jessie', 'The living room TV.'],
      ['Josh', 'Swapped in a better copy.'],
    ]);
    expect((await t.inbox(jessie.cookie))[0]).toMatchObject({ title: 'The Matrix (1999) is fixed', body: 'Josh fixed it: Swapped in a better copy.' });
    expect(((await call(t.app, 'GET', '/api/issues?status=open', undefined, t.admin)).body.items as IssueView[]).map((i) => i.id)).toEqual([ep.id]);
    expect(((await call(t.app, 'GET', `/api/issues/title/series/${show.id}`, undefined, t.admin)).body.items as IssueView[]).length).toBe(1);
    expect(t.db.select().from(schema.issues).where(eq(schema.issues.id, issue.id)).get()!.fixedBy).not.toBeNull();
  });
});
