import { describe, expect, it } from 'vitest';
import { keepListening, type SocketLike } from '../src/activity/socket.js';
import { JellyfinClient, PlexServerClient, type NowPlayingItem } from '../src/library/mediaServers.js';
import { notificationChannels, streams } from '../src/db/schema.js';
import { FakeMediaServer } from './fakes/mediaServers.js';
import { call, makeApp, setupAdmin } from './helpers.js';

const item = (o: Partial<NowPlayingItem> = {}): NowPlayingItem => ({
  sessionId: 's1', platform: 'Plex for Roku', resolution: '1080', kind: 'movie', title: 'Dune', show: null, season: null, episode: null, year: 2021, tmdbId: 438631,
  user: 'ana', device: 'Living room TV', state: 'playing', progress: 0.1, transcoding: false, ...o,
});

async function setup(events = ['stream_started', 'stream_stopped', 'stream_paused', 'stream_resumed', 'stream_transcoding']) {
  const plex = new FakeMediaServer('plex');
  const pushed: string[] = [];
  let clock = Date.parse('2026-11-18T20:00:00Z');
  const t = makeApp({ now: () => clock, clients: { plexServer: (u, k) => plex.as(u, k), push: { send: async (_c, m) => void pushed.push(m.title) } } });
  const admin = await setupAdmin(t.app);
  await call(t.app, 'PUT', '/api/settings/services', { plexUrl: 'http://plex:32400', plexToken: 'plex-token' }, admin);
  t.db.insert(notificationChannels).values({ kind: 'ntfy', name: 'Phone', config: '{"topic":"t"}', events: JSON.stringify(events), createdAt: 1 }).run();
  const look = async () => (await call(t.app, 'GET', '/api/activity/now', undefined, admin)).body;
  const rows = () => t.db.select().from(streams).all();
  return { ...t, plex, admin, pushed, look, rows, minutes: (m: number) => (clock += m * 60_000), seconds: (s: number) => (clock += s * 1000) };
}

describe('following streams', () => {
  it('records a stream from start to finish, counts only the time it played, and tells you', async () => {
    const { plex, look, rows, seconds, pushed } = await setup();
    // Marquee looks every few seconds; step the clock the way real checks would.
    const run = async (state: 'playing' | 'paused', minutes: number, progress: number) => {
      for (let i = 0; i < minutes * 2; i++) {
        seconds(30);
        plex.playing = [item({ state, progress })];
        await look();
      }
    };
    plex.playing = [item()];
    expect((await look()).sessions).toHaveLength(1);
    expect(pushed).toEqual(['ana started Dune']);
    await run('playing', 5, 0.3);
    await run('paused', 20, 0.5);
    await run('playing', 1, 0.5);
    plex.playing = [];
    expect((await look()).sessions).toHaveLength(0);
    const [s] = rows();
    expect(s).toMatchObject({ userName: 'ana', title: 'Dune', device: 'Living room TV', resolution: '1080', transcoding: false });
    // 5 minutes playing, the half minute before the pause was noticed, and the minute after resuming: the 20 paused minutes don't count.
    expect(s!.watchedMs).toBeGreaterThanOrEqual(5.5 * 60_000);
    expect(s!.watchedMs).toBeLessThanOrEqual(6.6 * 60_000);
    expect(s!.endedAt).not.toBeNull();
    expect(s!.progress).toBe(0.5);
    expect(pushed).toEqual(['ana started Dune', 'ana paused Dune', 'ana resumed Dune', 'ana finished watching Dune']);
  });

  it('does not announce a stop for a stream under 30 seconds', async () => {
    const { plex, look, seconds, pushed } = await setup();
    plex.playing = [item()];
    await look();
    seconds(10);
    plex.playing = [];
    await look();
    expect(pushed).toEqual(['ana started Dune']);
  });

  it('keeps chatty events off unless the channel asks for them', async () => {
    const { plex, look, minutes, pushed } = await setup(['stream_started']);
    plex.playing = [item()];
    await look();
    minutes(1);
    plex.playing = [item({ state: 'paused' })];
    await look();
    plex.playing = [];
    minutes(1);
    await look();
    expect(pushed).toEqual(['ana started Dune']);
  });

  it('tells you once when a stream is being converted', async () => {
    const { plex, look, minutes, pushed } = await setup();
    plex.playing = [item({ transcoding: true })];
    await look();
    minutes(1);
    await look();
    expect(pushed.filter((p) => p.includes('converted'))).toHaveLength(1);
  });

  it('counts the next episode of an autoplay as its own stream', async () => {
    const { plex, look, rows, minutes } = await setup();
    const ep = (n: number) => item({ kind: 'episode', title: `Ep ${n}`, show: 'Severance', season: 1, episode: n, tmdbId: null });
    plex.playing = [ep(1)];
    await look();
    minutes(40);
    plex.playing = [ep(2)];
    await look();
    expect(rows().map((r) => r.title)).toEqual(['Ep 1', 'Ep 2']);
    expect(rows()[0]!.endedAt).not.toBeNull();
    expect(rows()[1]!.endedAt).toBeNull();
  });

  it('keeps streams through a short outage, then closes them', async () => {
    const { plex, look, rows, minutes } = await setup();
    plex.playing = [item()];
    await look();
    plex.fail = "Couldn't reach Plex.";
    minutes(1);
    let r = await look();
    expect(r.sessions).toHaveLength(1);
    expect(r.problems[0]).toMatch(/Plex/);
    minutes(3);
    r = await look();
    expect(r.sessions).toHaveLength(0);
    expect(rows()[0]!.endedAt).not.toBeNull();
  });

  it('looks at once when the server says something changed', async () => {
    const { plex, activity, pushed } = await setup();
    activity.start();
    expect(plex.watchers).toBe(1);
    plex.playing = [item()];
    plex.hint();
    plex.hint();
    await new Promise((r) => setTimeout(r, 450));
    expect(pushed).toEqual(['ana started Dune']);
    expect(activity.status()).toEqual([{ server: 'plex', live: true }]);
    activity.stopWatching();
    expect(plex.watchers).toBe(0);
  });

  it('closes streams left open by a restart', async () => {
    const { db, activity, rows } = await setup();
    db.insert(streams).values({ server: 'plex', sessionId: 'x', userName: 'a', kind: 'movie', title: 'T', device: 'd', platform: 'p', startedAt: 1000, lastSeenAt: 5000 }).run();
    activity.start();
    activity.stopWatching();
    expect(rows()[0]!.endedAt).toBe(5000);
  });
});

describe('stopping a stream', () => {
  it('stops it on the server with your message, for admins only', async () => {
    const { app, plex, admin, look } = await setup();
    plex.playing = [item({ sessionId: 'abc' })];
    await look();
    const res = await call(app, 'POST', '/api/activity/stop', { server: 'plex', sessionId: 'abc', message: 'Bedtime!' }, admin);
    expect(res.status).toBe(200);
    expect(plex.stopped).toEqual([{ sessionId: 'abc', message: 'Bedtime!' }]);
    expect((await look()).sessions).toHaveLength(0);

    await call(app, 'POST', '/api/users', { username: 'partner', displayName: 'P', role: 'member', password: 'a lovely password' }, admin);
    const member = (await call(app, 'POST', '/api/auth/login', { username: 'partner', password: 'a lovely password' })).cookie!;
    expect((await call(app, 'POST', '/api/activity/stop', { server: 'plex', sessionId: 'abc', message: '' }, member)).status).toBe(403);
  });

  it('says what to do when the server refuses', async () => {
    const { app, plex, admin } = await setup();
    plex.failStop = 'Plex answered 403.';
    const res = await call(app, 'POST', '/api/activity/stop', { server: 'plex', sessionId: 'abc', message: '' }, admin);
    expect(res.status).toBe(502);
    expect(res.body.message).toMatch(/Plex Pass/);
  });
});

describe('the live page feed', () => {
  it('sends the list as soon as you connect, and again when it changes', async () => {
    const { app, plex, admin, look } = await setup();
    plex.playing = [item()];
    const res = await app.request('/api/activity/live', { headers: { cookie: admin } });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const first = dec.decode((await reader.read()).value);
    expect(first).toContain('event: sessions');
    expect(first).toContain('"title":"Dune"');
    plex.playing = [];
    void look();
    const second = dec.decode((await reader.read()).value);
    expect(second).toContain('"sessions":[]');
    await reader.cancel();
  });

  it('is for admins only', async () => {
    const { app } = await setup();
    expect((await app.request('/api/activity/live')).status).toBe(401);
  });
});

describe('stats from streams', () => {
  it('adds up watch time, stream types, platforms and the busiest moment', async () => {
    const { db, app, admin } = await setup();
    const at = Date.parse('2026-11-18T20:00:00Z');
    const base = { server: 'plex' as const, kind: 'movie' as const, title: 'Dune', device: 'TV', platform: 'Roku', userName: 'josh' };
    db.insert(streams).values([
      { ...base, sessionId: '1', startedAt: at - 3_600_000, lastSeenAt: at, endedAt: at - 600_000, watchedMs: 3_000_000, resolution: '4k' },
      { ...base, sessionId: '2', startedAt: at - 3_000_000, lastSeenAt: at, endedAt: at - 1_000_000, watchedMs: 1_800_000, resolution: '1080', transcoding: true, platform: 'Web' },
      { ...base, sessionId: '3', startedAt: at - 3_000_000, lastSeenAt: at, endedAt: at - 2_990_000, watchedMs: 5_000 },
    ]).run();
    const s = (await call(app, 'GET', '/api/activity/stats', undefined, admin)).body.live;
    expect(s).toMatchObject({ streams: 2, watchHours: 1.3, peakStreams: 2, direct: 1, converted: 1 });
    expect(s.watchTime).toEqual([{ name: 'Josh', hours: 1.3 }]);
    expect(s.platforms.map((p: { name: string }) => p.name).sort()).toEqual(['Roku', 'Web']);
  });

  it('lists people and one person\'s page', async () => {
    const { db, app, admin } = await setup();
    db.insert(streams).values({ server: 'plex', sessionId: '1', userName: 'ana', kind: 'movie', title: 'Dune', device: 'TV', platform: 'Roku', startedAt: 5000, lastSeenAt: 6000, endedAt: 6000, watchedMs: 3_600_000 }).run();
    const list = (await call(app, 'GET', '/api/activity/people', undefined, admin)).body.people;
    expect(list).toEqual([{ name: 'ana', plays: 0, hours: 1, last: 5000, devices: ['TV'] }]);
    const one = (await call(app, 'GET', '/api/activity/people/Ana', undefined, admin)).body;
    expect(one.streams[0]).toMatchObject({ title: 'Dune', device: 'TV', going: false });
    expect((await call(app, 'GET', '/api/activity/people/nobody', undefined, admin)).status).toBe(404);
  });
});

describe('live lines to the servers', () => {
  class Sock implements SocketLike {
    sent: string[] = [];
    closed = false;
    onopen: SocketLike['onopen'] = null;
    onmessage: SocketLike['onmessage'] = null;
    onclose: SocketLike['onclose'] = null;
    onerror: SocketLike['onerror'] = null;
    constructor(public url: string) {}
    send(d: string) {
      this.sent.push(d);
    }
    close() {
      this.closed = true;
    }
  }

  it('Plex: opens the notifications line with the token and nudges on playing events only', () => {
    const socks: Sock[] = [];
    const hints: number[] = [];
    const stop = new PlexServerClient('https://plex.example:32400/', 'TOK', fetch, (u) => (socks.push(new Sock(u)), socks.at(-1)!)).watch(() => hints.push(1));
    expect(socks[0]!.url).toBe('wss://plex.example:32400/:/websockets/notifications?X-Plex-Token=TOK');
    socks[0]!.onmessage!({ data: JSON.stringify({ NotificationContainer: { type: 'playing' } }) });
    socks[0]!.onmessage!({ data: JSON.stringify({ NotificationContainer: { type: 'timeline' } }) });
    socks[0]!.onmessage!({ data: 'not json' });
    expect(hints).toHaveLength(1);
    stop();
    expect(socks[0]!.closed).toBe(true);
  });

  it('Jellyfin: asks for session updates once open, and nudges on each', () => {
    const socks: Sock[] = [];
    const hints: number[] = [];
    new JellyfinClient('http://jf:8096', 'KEY', fetch, (u) => (socks.push(new Sock(u)), socks.at(-1)!)).watch(() => hints.push(1));
    expect(socks[0]!.url).toBe('ws://jf:8096/socket?api_key=KEY&deviceId=marquee');
    socks[0]!.onopen!({});
    expect(JSON.parse(socks[0]!.sent[0]!)).toEqual({ MessageType: 'SessionsStart', Data: '0,5000' });
    socks[0]!.onmessage!({ data: JSON.stringify({ MessageType: 'Sessions', Data: [] }) });
    socks[0]!.onmessage!({ data: JSON.stringify({ MessageType: 'KeepAlive' }) });
    expect(hints).toHaveLength(1);
  });

  it('reconnects with a longer wait each time, and stops when told', () => {
    const socks: Sock[] = [];
    const waits: { fn: () => void; ms: number }[] = [];
    const states: boolean[] = [];
    const stop = keepListening({ url: 'ws://x', onMessage: () => {} }, (c) => states.push(c), (u) => (socks.push(new Sock(u)), socks.at(-1)!), (fn, ms) => void waits.push({ fn, ms }));
    socks[0]!.onopen!({});
    socks[0]!.onclose!({});
    expect(waits[0]!.ms).toBe(5000);
    waits[0]!.fn();
    socks[1]!.onclose!({});
    expect(waits[1]!.ms).toBe(10_000);
    waits[1]!.fn();
    socks[2]!.onopen!({});
    socks[2]!.onclose!({});
    expect(waits[2]!.ms).toBe(5000); // a good connection resets the wait
    stop();
    waits[2]!.fn();
    expect(socks).toHaveLength(3);
    expect(states[0]).toBe(true);
  });

  it('Plex and Jellyfin stop calls', async () => {
    const calls: { url: string; method?: string; body?: string }[] = [];
    const f = (async (url: string, init: RequestInit = {}) => (calls.push({ url, method: init.method, body: init.body as string | undefined }), new Response('', { status: 200 }))) as unknown as typeof fetch;
    await new PlexServerClient('http://plex:32400', 'T', f).stop('77', 'Bedtime');
    expect(calls[0]!.url).toBe('http://plex:32400/status/sessions/terminate?sessionId=77&reason=Bedtime');
    await new JellyfinClient('http://jf:8096', 'K', f).stop('abc', 'Bedtime');
    expect(calls.map((c) => `${c.method ?? 'GET'} ${c.url}`)).toEqual([
      'GET http://plex:32400/status/sessions/terminate?sessionId=77&reason=Bedtime',
      'POST http://jf:8096/Sessions/abc/Message',
      'POST http://jf:8096/Sessions/abc/Playing/Stop',
    ]);
  });
});
