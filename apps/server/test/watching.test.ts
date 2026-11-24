import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { TautulliImportView, UnwatchedView, WatchSyncRun, WatchSyncStatus } from '@marquee/shared';
import { schema } from '../src/db/index.js';
import { users } from '../src/db/schema.js';
import { jellyfinConvertReason, plexConvertReason, type SyncItem } from '../src/library/mediaServers.js';
import { resumeChanges, syncAfterPlays } from '../src/watchsync/sync.js';
import { ActivityMonitor } from '../src/activity/live.js';
import { FakeMediaServer } from './fakes/mediaServers.js';
import { call, makeApp, setupAdmin } from './helpers.js';

const NOW = Date.parse('2026-11-23T12:00:00Z');
const DAY = 86_400_000;
const item = (ref: string, tmdb: number, position: number, lastPlayed: number, watched = false): SyncItem => ({ ref, keys: [`m:tmdb:${tmdb}`], watched, title: `Movie ${tmdb}`, position, lastPlayed });

describe('Why a stream is converting', () => {
  it('Plex: from its decisions; Jellyfin: from its reasons, in plain words', () => {
    expect(plexConvertReason({ videoDecision: 'copy', audioDecision: 'copy' })).toBeNull();
    expect(plexConvertReason({ videoDecision: 'copy', audioDecision: 'transcode', sourceAudioCodec: 'truehd', audioCodec: 'aac', subtitleDecision: 'burn' })).toBe(
      'The subtitles are drawn onto the picture (this device can’t show them itself); the sound is converted from TRUEHD to AAC.',
    );
    expect(plexConvertReason({ videoDecision: 'transcode', sourceVideoCodec: 'hevc', videoCodec: 'h264' })).toBe('The picture is converted from HEVC to H264.');
    expect(jellyfinConvertReason(['ContainerBitrateExceedsLimit', 'AudioCodecNotSupported'])).toBe('The copy is more than the connection or app’s quality setting allows; the device can’t play this sound format.');
    expect(jellyfinConvertReason('SubtitleCodecNotSupported,SomethingNew')).toBe('The subtitles have to be drawn onto the picture; something new.');
    expect(jellyfinConvertReason([])).toBeNull();
  });

  it('shows on Activity with the stream', async () => {
    const plex = new FakeMediaServer('plex');
    const t = makeApp({ clients: { plexServer: (u, k) => plex.as(u, k) } });
    const admin = await setupAdmin(t.app);
    await call(t.app, 'PUT', '/api/settings/services', { plexUrl: 'http://plex:32400', plexToken: 'plex-token' }, admin);
    plex.playing = [{ kind: 'movie', title: 'Up', show: null, season: null, episode: null, year: 2009, tmdbId: 14160, sessionId: 's1', platform: 'Plex for Roku', resolution: '1080', user: 'Ana', device: 'TV', state: 'playing', progress: 0.1, transcoding: true, convertReason: 'The sound is converted.' }];
    const res = await call(t.app, 'GET', '/api/activity/now', undefined, admin);
    expect(res.body.sessions[0]).toMatchObject({ transcoding: true, convertReason: 'The sound is converted.' });
  });
});

describe('Resume points', () => {
  it('the server played more recently passes its place on; close places and watched titles are left alone', () => {
    const plex = [item('p1', 1, 40 * 60_000, NOW), item('p2', 2, 10 * 60_000, NOW - DAY), item('p3', 3, 5 * 60_000, NOW), item('p4', 4, 0, 0, true)];
    const jf = [item('j1', 1, 0, NOW - DAY), item('j2', 2, 30 * 60_000, NOW), item('j3', 3, 5 * 60_000 + 30_000, NOW - DAY), item('j4', 4, 20 * 60_000, NOW)];
    expect(resumeChanges(plex, jf).map((c) => [c.from.ref, c.to.ref, c.from.position])).toEqual([
      ['p1', 'j1', 40 * 60_000],
      ['j2', 'p2', 30 * 60_000],
    ]);
  });

  it('are synced with watched ticks (and can be switched off), and a play stopping syncs soon after', async () => {
    const plex = new FakeMediaServer('plex');
    const jf = new FakeMediaServer('jellyfin');
    const t = makeApp({ now: () => NOW, clients: { plexServer: (u, k) => plex.as(u, k), jellyfin: (u, k) => jf.as(u, k) } });
    const admin = await setupAdmin(t.app);
    await call(t.app, 'PUT', '/api/settings/services', { plexUrl: 'http://plex:32400', plexToken: 'plex-token', jellyfinUrl: 'http://jf:8096', jellyfinApiKey: 'jellyfin-key' }, admin);
    t.db.update(users).set({ plexId: '11', jellyfinId: 'jf' }).where(eq(users.username, 'josh')).run();
    plex.people = [{ id: '11', username: 'josh', name: 'Josh' }];
    jf.people = [{ id: 'jf', username: 'josh', name: 'Josh' }];
    plex.watched.set('11', [item('p1', 603, 42 * 60_000, NOW)]);
    jf.watched.set('jf', [item('j1', 603, 0, 0)]);
    const run = (await call(t.app, 'POST', '/api/watch-sync/run', {}, admin)).body as WatchSyncRun;
    expect(run).toMatchObject({ ticked: 0, resumed: 1, failed: 0 });
    expect(jf.positions).toEqual([{ user: 'jf', ref: 'j1', ms: 42 * 60_000 }]);
    const status = (await call(t.app, 'PUT', '/api/watch-sync/enabled', { resume: false }, admin)).body as WatchSyncStatus;
    expect(status.resume).toBe(false);
    plex.watched.set('11', [item('p1', 603, 50 * 60_000, NOW + 1)]);
    expect(((await call(t.app, 'POST', '/api/watch-sync/run', {}, admin)).body as WatchSyncRun).resumed).toBe(0);

    // W3: a stopped play asks for a sync, once for plays ending close together, only when sync is on.
    vi.useFakeTimers();
    try {
      let on = false;
      const runs: number[] = [];
      const soon = syncAfterPlays(async () => void runs.push(1), () => on, 20_000);
      soon();
      vi.advanceTimersByTime(30_000);
      expect(runs).toEqual([]);
      on = true;
      soon();
      soon();
      vi.advanceTimersByTime(19_000);
      expect(runs).toEqual([]);
      vi.advanceTimersByTime(2_000);
      expect(runs).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Activity calls back when a play of 30 seconds or more stops', async () => {
    const plex = new FakeMediaServer('plex');
    let clock = NOW;
    const stopped: string[] = [];
    const t = makeApp({ clients: { plexServer: (u, k) => plex.as(u, k) } });
    const admin = await setupAdmin(t.app);
    await call(t.app, 'PUT', '/api/settings/services', { plexUrl: 'http://plex:32400', plexToken: 'plex-token' }, admin);
    const m = new ActivityMonitor({ db: t.db, clients: { plexServer: (u, k) => plex.as(u, k), jellyfin: () => { throw new Error('none'); } }, now: () => clock, onStopped: (s) => stopped.push(s) });
    plex.playing = [{ kind: 'movie', title: 'Up', show: null, season: null, episode: null, year: 2009, tmdbId: 14160, sessionId: 's1', platform: 'Plex', resolution: '1080', user: 'Ana', device: 'TV', state: 'playing', progress: 0.1, transcoding: false }];
    await m.refresh();
    clock += 45_000;
    await m.refresh();
    plex.playing = [];
    clock += 10_000;
    await m.refresh();
    expect(stopped).toEqual(['plex']);
  });
});

describe('Never watched', () => {
  it('lists titles with a file nobody has played, or not in a year, oldest first', async () => {
    const t = makeApp({ now: () => NOW });
    const admin = await setupAdmin(t.app);
    const movie = (tmdbId: number, title: string, addedAt: number) => {
      const m = t.db.insert(schema.movies).values({ tmdbId, title, sortTitle: title, year: 2000, profile: 'cinema', addedAt, refreshedAt: 0 }).returning().get();
      t.db.insert(schema.mediaFiles).values({ path: `/m/${title}.mkv`, movieId: m.id, size: 1, mtime: 0, addedAt: 0, seenAt: 0 }).run();
      return m;
    };
    movie(1, 'Never Seen', 5);
    movie(2, 'Seen Long Ago', 1);
    movie(3, 'Seen Last Week', 2);
    t.db.insert(schema.movies).values({ tmdbId: 4, title: 'No File', sortTitle: 'x', profile: 'cinema', addedAt: 0, refreshedAt: 0 }).run();
    const play = (tmdbId: number, title: string, at: number) => t.db.insert(schema.plays).values({ server: 'plex', serverUserId: '1', userName: 'Ana', itemKey: String(tmdbId), kind: 'movie', title, year: 2000, tmdbId, playedAt: at }).run();
    play(2, 'Seen Long Ago', NOW - 400 * DAY);
    play(3, 'Seen Last Week', NOW - 7 * DAY);
    const never = (await call(t.app, 'GET', '/api/activity/unwatched?kind=movie&since=never', undefined, admin)).body as UnwatchedView;
    expect(never.items.map((i) => i.title)).toEqual(['Never Seen']);
    const year = (await call(t.app, 'GET', '/api/activity/unwatched?kind=movie&since=year', undefined, admin)).body as UnwatchedView;
    expect(year.items.map((i) => [i.title, i.plays])).toEqual([
      ['Never Seen', 0],
      ['Seen Long Ago', 1],
    ]);
    expect(year.note).toBeNull();
  });
});

describe('Tautulli’s history', () => {
  it('brings plays in once, skips ones Marquee already has, and can be undone', async () => {
    const asked: string[] = [];
    const rows = [
      { stopped: 1_700_000_000, user_id: 11, friendly_name: 'Ana', media_type: 'movie', title: 'Up', year: 2009, rating_key: 500, guid: 'plex://movie/x?tmdb://14160' },
      { stopped: 1_700_100_000, user_id: 11, friendly_name: 'Ana', media_type: 'episode', title: 'Half Loop', grandparent_title: 'Severance', parent_media_index: 1, media_index: 2, rating_key: 501 },
      { stopped: 1_700_200_000, user_id: 11, friendly_name: 'Ana', media_type: 'track', title: 'A song', rating_key: 502 },
    ];
    const t = makeApp({
      now: () => NOW,
      clients: {
        tautulliFetch: async (url) => {
          asked.push(url);
          if (!url.includes('apikey=good')) return { status: 200, text: JSON.stringify({ response: { result: 'error', message: 'Invalid apikey' } }) };
          return { status: 200, text: JSON.stringify({ response: { result: 'success', data: { data: rows } } }) };
        },
      },
    });
    const admin = await setupAdmin(t.app);
    // Plex's own history already has the episode (a few minutes apart).
    t.db.insert(schema.plays).values({ server: 'plex', serverUserId: '11', userName: 'Ana', itemKey: '501', kind: 'episode', title: 'Half Loop', playedAt: 1_700_100_000_000 - 120_000 }).run();
    const bad = await call(t.app, 'POST', '/api/activity/tautulli/import', { url: 'http://tautulli:8181', apiKey: 'nope' }, admin);
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/Tautulli turned the key down \(Invalid apikey\)/);
    expect((await call(t.app, 'POST', '/api/activity/tautulli/import', { url: 'tautulli:8181', apiKey: 'good' }, admin)).status).toBe(400);
    const res = await call(t.app, 'POST', '/api/activity/tautulli/import', { url: 'http://tautulli:8181/', apiKey: 'good' }, admin);
    expect(res.status).toBe(201);
    const v = res.body as TautulliImportView;
    expect(v.imports[0]).toMatchObject({ added: 1, skipped: 1, seen: 3, undoneAt: null });
    expect(asked.at(-1)).toMatch(/^http:\/\/tautulli:8181\/api\/v2\?apikey=good&cmd=get_history/);
    expect(t.db.select().from(schema.plays).all().map((p) => [p.title, p.tmdbId, p.importBatch !== null])).toEqual([
      ['Half Loop', null, false],
      ['Up', 14160, true],
    ]);
    const undone = await call(t.app, 'POST', '/api/activity/tautulli/undo', { at: v.imports[0]!.at }, admin);
    expect(undone.body.removed).toBe(1);
    expect(t.db.select().from(schema.plays).all().map((p) => p.title)).toEqual(['Half Loop']);
    expect((await call(t.app, 'GET', '/api/activity/tautulli', undefined, admin)).body.imports[0].undoneAt).toBe(NOW);
  });
});
