import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { searchesSettled } from '../src/requests/service.js';
import { schema } from '../src/db/index.js';
import { FakeQbit, fakeFetchTorrent, qbitTorrent } from './fakes/qbittorrent.js';
import { FakeSites, release } from './fakes/sources.js';
import { FakeTmdb } from './fakes/tmdb.js';
import { call, makeApp, setupAdmin } from './helpers.js';

// Real answers from the server, saved as files. The iPhone app's tests decode
// every one of them, so if the server's shape drifts from the app's models the
// app's tests fail. Run `pnpm --filter @marquee/server fixtures:ios` after a
// change on purpose, and commit the files.

const DIR = path.resolve(import.meta.dirname, '../../ios/Packages/MarqueeKit/Tests/MarqueeKitTests/Fixtures');
const GB = 1024 ** 3;
const DUNE = 'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX';
const UP = 'Up.2009.1080p.BluRay.x265-GRP';
const PHONE = { id: 'phone-aaaa-1111', name: "Josh's iPhone", kind: 'ios' as const };
const STALE = 'The iPhone fixtures are out of date. Run pnpm --filter @marquee/server fixtures:ios and commit them.';

/** Pretty JSON with the token swapped out, since it's different every time. */
function clean(body: unknown, tokens: string[]): string {
  let text = JSON.stringify(body, null, 2);
  for (const t of tokens) text = text.split(t).join('<token>');
  return text + '\n';
}

describe('fixtures for the iPhone app', () => {
  it('match what the server sends', async () => {
    const sites = new FakeSites();
    sites.feed('http://tpb.test/api', { releases: [release(DUNE, { size: 25 * GB }), release(UP, { size: 4 * GB })] });
    const qbit = new FakeQbit();
    const clock = Date.parse('2026-11-25T12:00:00Z');
    const t = makeApp({
      now: () => clock,
      clients: { torznab: sites.torznab, qbittorrent: (u, n, p) => qbit.as(u, n, p), fetchTorrent: fakeFetchTorrent(), tmdb: () => new FakeTmdb() },
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

    // Dune: a member asks, an admin approves, it downloads. Up: an admin asks and it gets stuck.
    const ask = await call(t.app, 'POST', '/api/requests', { kind: 'movie', tmdbId: 693134 }, jessie);
    const approved = await call(t.app, 'POST', `/api/requests/${ask.body.id}/approve`, {}, admin);
    await call(t.app, 'POST', '/api/requests', { kind: 'movie', tmdbId: 14160 }, admin);
    await searchesSettled();
    // A kid is waiting on one, and a member's was turned down.
    await call(t.app, 'POST', '/api/requests', { kind: 'movie', tmdbId: 1022789 }, kiddo);
    const anora = await call(t.app, 'POST', '/api/requests', { kind: 'movie', tmdbId: 1064213 }, jessie);
    const declined = await call(t.app, 'POST', `/api/requests/${anora.body.id}/decline`, { reason: 'We have it on disc.' }, admin);
    // Up's copy was sent a while ago and has gone quiet.
    t.db.insert(schema.downloads).values({ kind: 'movie', movieId: 2, title: UP, infoHash: 'b'.repeat(40), addedAt: clock - 5 * 3_600_000, state: 'downloading', progress: 0.1 }).run();
    qbit.list.push(qbitTorrent('b'.repeat(40), { name: UP, state: 'stalledDL', progress: 0.1 }));
    qbit.list[0]!.progress = 0.42;
    qbit.list[0]!.state = 'downloading';
    qbit.list[0]!.downloadSpeed = 4.2 * 1024 ** 2;
    qbit.list[0]!.eta = 720;

    const login = await call(t.app, 'POST', '/api/auth/login', { username: 'josh', password: 'correct horse battery', device: PHONE });
    const bearer = { authorization: `Bearer ${login.body.token}` };
    const tokens = [login.body.token as string];
    const get = (p: string, who: string | undefined = admin) => call(t.app, 'GET', p, undefined, who);
    const asPhone = (p: string) => call(t.app, 'GET', p, undefined, undefined, bearer);
    const bad = await call(t.app, 'POST', '/api/auth/login', { username: 'josh', password: 'wrong password', device: PHONE });
    const signedOut = await call(t.app, 'GET', '/api/auth/status');

    const answers: [string, { status: number; body: unknown }, number?][] = [
      ['health', await get('/api/health')],
      ['auth-status', await asPhone('/api/auth/status')],
      ['auth-status-signed-out', signedOut],
      ['app-sign-in', login],
      ['error-bad-credentials', bad, 401],
      ['me', await asPhone('/api/me')],
      ['devices', await asPhone('/api/me/devices')],
      ['home-admin', await get('/api/home')],
      ['home-member', await get('/api/home', jessie)],
      ['home-kid', await get('/api/home', kiddo)],
      ['downloads', await get('/api/downloads')],
      ['downloads-summary', await get('/api/downloads/summary')],
      ['requests-admin', await get('/api/requests?scope=all')],
      ['requests-member', await get('/api/requests', jessie)],
      ['requests-summary', await get('/api/requests/summary')],
      ['request-approved', approved],
      ['request-declined', declined],
    ];

    fs.mkdirSync(DIR, { recursive: true });
    for (const [name, res, status = 200] of answers) {
      expect(res.status, `${name} answered ${res.status}`).toBe(status);
      const text = clean(res.body, tokens);
      const file = path.join(DIR, `${name}.json`);
      if (process.env.WRITE_FIXTURES) fs.writeFileSync(file, text);
      else {
        expect(fs.existsSync(file), `${name}.json is missing. ${STALE}`).toBe(true);
        expect(JSON.parse(text), `${name}.json. ${STALE}`).toEqual(JSON.parse(fs.readFileSync(file, 'utf8')));
      }
    }
  });
});
