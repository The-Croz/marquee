import { describe, expect, it } from 'vitest';
import { JellyfinClient, PlexServerClient, type NowPlayingItem } from '../src/library/mediaServers.js';
import { movies, series } from '../src/db/schema.js';
import { FakeMediaServer } from './fakes/mediaServers.js';
import { FakeTmdb } from './fakes/tmdb.js';
import { call, makeApp, setupAdmin } from './helpers.js';

/** Watching now: finding the title (and its artwork), and what the stream is doing. */

const item = (o: Partial<NowPlayingItem>): NowPlayingItem => ({
  sessionId: 's1', platform: 'Plex for Roku', resolution: '1080', kind: 'movie', title: 'Dune', show: null, season: null, episode: null, year: 2024, tmdbId: null,
  user: 'ana', device: 'Living room TV', state: 'playing', progress: 0.5, transcoding: false, ...o,
});

async function setup() {
  const plex = new FakeMediaServer('plex');
  const t = makeApp({ clients: { plexServer: (u, k) => plex.as(u, k), tmdb: () => new FakeTmdb() } });
  const admin = await setupAdmin(t.app);
  await call(t.app, 'PUT', '/api/settings/services', { tmdbApiKey: 'good-key', plexUrl: 'http://plex:32400', plexToken: 'plex-token' }, admin);
  const now = async () => (await call(t.app, 'GET', '/api/activity/now', undefined, admin)).body.sessions[0];
  return { ...t, plex, admin, now };
}

describe('finding what is playing', () => {
  it('matches a movie by its ids when the server calls it something else', async () => {
    const { db, plex, now } = await setup();
    const m = db.insert(movies).values({ tmdbId: 671, imdbId: 'tt0241527', title: 'Harry Potter and the Philosopher’s Stone', sortTitle: 'harry potter', year: 2001, posterPath: '/hp.jpg', backdropPath: '/hp-bg.jpg', addedAt: 1, refreshedAt: 1 } as never).returning().get();
    plex.playing = [item({ title: 'Harry Potter and the Sorcerer’s Stone', year: 2001, keys: ['imdb:tt0241527'] })];
    expect(await now()).toMatchObject({ href: `/movies/${m.id}`, posterPath: '/hp.jpg', backdropPath: '/hp-bg.jpg' });
  });

  it('matches a show by its ids', async () => {
    const { db, plex, now } = await setup();
    const s = db.insert(series).values({ tmdbId: 95396, tvdbId: 371980, title: 'Severance', sortTitle: 'severance', backdropPath: '/sev-bg.jpg', addedAt: 1, refreshedAt: 1 } as never).returning().get();
    plex.playing = [item({ kind: 'episode', title: 'Half Loop', show: 'Severance (US)', season: 1, episode: 2, keys: ['tvdb:371980'] })];
    expect(await now()).toMatchObject({ href: `/shows/${s.id}`, backdropPath: '/sev-bg.jpg' });
  });

  it('borrows artwork from TMDB for a title that isn’t in the library', async () => {
    const { plex, now } = await setup();
    plex.playing = [item({ title: 'Dune: Part Two', tmdbId: 693134 })];
    const s = await now();
    expect(s.href).toBeNull();
    const dune = await new FakeTmdb().movie(693134);
    expect(s).toMatchObject({ posterPath: dune.posterPath, backdropPath: dune.backdropPath });
  });

  it('passes on the facts about the stream and how long it runs', async () => {
    const { plex, now } = await setup();
    plex.playing = [item({ facts: [{ label: 'Stream', value: 'Direct play' }], durationMs: 7_200_000 })];
    expect(await now()).toMatchObject({ facts: [{ label: 'Stream', value: 'Direct play' }], durationMs: 7_200_000 });
  });
});

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const fakeFetch = (routes: Record<string, unknown>) => {
  const asked: string[] = [];
  const f = (async (url: string) => {
    const path = new URL(url).pathname;
    asked.push(path);
    return path in routes ? json(routes[path]) : new Response('no', { status: 404 });
  }) as unknown as typeof fetch;
  return { f, asked };
};

describe('Plex streams', () => {
  const converting = {
    type: 'movie', ratingKey: '10', title: 'Dune', year: 2024, duration: 7_200_000, viewOffset: 3_600_000,
    User: { title: 'ana' },
    Player: { title: 'Living room TV', product: 'Plex for Roku', version: '7.2', state: 'playing', address: '203.0.113.9', local: false },
    Session: { id: 'abc', bandwidth: 9200, location: 'wan' },
    Media: [{ id: '2', videoResolution: '720', bitrate: 4000, container: 'mpegts', videoCodec: 'h264', audioCodec: 'aac', audioChannels: 2, Part: [{ decision: 'transcode', Stream: [{ streamType: 3, selected: true, decision: 'burn', displayTitle: 'English (SRT)' }] }] }],
    TranscodeSession: { videoDecision: 'transcode', audioDecision: 'transcode', subtitleDecision: 'burn', sourceVideoCodec: 'hevc', videoCodec: 'h264', sourceAudioCodec: 'eac3', audioCodec: 'aac', transcodeHwEncoding: 'qsv' },
  };
  const source = {
    MediaContainer: { Metadata: [{ type: 'movie', ratingKey: '10', title: 'Dune', Guid: [{ id: 'tmdb://693134' }], Media: [{ id: '2', videoResolution: '4k', bitrate: 24_000, container: 'mkv', videoCodec: 'hevc', audioCodec: 'eac3', audioChannels: 6, Part: [{ Stream: [{ streamType: 1, displayTitle: '4K HDR10 (HEVC Main 10)' }, { streamType: 2, selected: true, displayTitle: 'English (EAC3 5.1)' }] }] }] }] },
  };

  it('describes a converted stream, source and what the device gets', async () => {
    const { f } = fakeFetch({ '/status/sessions': { MediaContainer: { Metadata: [converting] } }, '/library/metadata/10': source });
    const [s] = await new PlexServerClient('http://plex:32400', 't', f).nowPlaying();
    expect(s).toMatchObject({ tmdbId: 693134, keys: ['tmdb:693134'], durationMs: 7_200_000, transcoding: true });
    expect(Object.fromEntries(s!.facts!.map((x) => [x.label, x.value]))).toEqual({
      Stream: 'Converting (using the graphics chip)',
      Quality: '720p · 4.0 Mbps',
      Video: '4K HDR10 (HEVC Main 10) → 720p H264',
      Audio: 'English (EAC3 5.1) → AAC stereo',
      Subtitles: 'English (SRT) · drawn onto the picture',
      Container: 'MKV → MPEGTS',
      Bandwidth: '9.2 Mbps',
      Connection: 'Away from home · 203.0.113.9',
      App: 'Plex for Roku 7.2',
    });
  });

  it('looks a title up once for its ids, then remembers', async () => {
    const direct = { type: 'movie', ratingKey: '11', title: 'Dune', duration: 100, Media: [{ videoResolution: '1080', bitrate: 8100, container: 'mkv', videoCodec: 'h264', audioCodec: 'ac3', audioChannels: 6 }], Player: { local: true, address: '192.168.1.20', product: 'Plex Web' } };
    const { f, asked } = fakeFetch({ '/status/sessions': { MediaContainer: { Metadata: [direct] } }, '/library/metadata/11': { MediaContainer: { Metadata: [{ type: 'movie', title: 'Dune', Guid: [{ id: 'tmdb://438631' }] }] } } });
    const client = () => new PlexServerClient('http://plex:32400', 't', f);
    const [s] = await client().nowPlaying();
    await client().nowPlaying();
    expect(s!.tmdbId).toBe(438631);
    expect(asked.filter((p) => p === '/library/metadata/11')).toHaveLength(1);
    expect(Object.fromEntries(s!.facts!.map((x) => [x.label, x.value]))).toMatchObject({ Stream: 'Direct play', Quality: '1080p · 8.1 Mbps', Video: 'H264 1080p', Audio: 'AC3 5.1', Container: 'MKV', Connection: 'Home network · 192.168.1.20' });
  });

  it('still lists the stream when the title can’t be looked up', async () => {
    const { f } = fakeFetch({ '/status/sessions': { MediaContainer: { Metadata: [{ type: 'episode', ratingKey: '5', grandparentRatingKey: '4', title: 'Pilot', grandparentTitle: 'Show' }] } } });
    const [s] = await new PlexServerClient('http://plex:32400', 't', f).nowPlaying();
    expect(s).toMatchObject({ show: 'Show', title: 'Pilot' });
    expect(s!.keys).toEqual([]);
  });
});

describe('Jellyfin streams', () => {
  it('describes the stream and finds the show’s ids', async () => {
    const { f } = fakeFetch({
      '/Sessions': [
        {
          Id: 'j1', UserName: 'sam', DeviceName: 'iPad', Client: 'Jellyfin iOS', ApplicationVersion: '1.6', RemoteEndPoint: '192.168.1.30',
          NowPlayingItem: { Id: 'e1', Type: 'Episode', Name: 'Pilot', SeriesName: 'Severance', SeriesId: 'sh1', RunTimeTicks: 36_000_000_000, Height: 1080, Container: 'mkv', MediaStreams: [{ Type: 'Video', Index: 0, DisplayTitle: '1080p H264 SDR', BitRate: 8_000_000 }, { Type: 'Audio', Index: 1, DisplayTitle: 'English - AC3 - 5.1' }, { Type: 'Subtitle', Index: 2, DisplayTitle: 'English - SRT' }] },
          PlayState: { PositionTicks: 18_000_000_000, PlayMethod: 'Transcode', AudioStreamIndex: 1, SubtitleStreamIndex: 2 },
          TranscodingInfo: { VideoCodec: 'h264', AudioCodec: 'aac', Container: 'ts', Bitrate: 3_000_000, Height: 720, AudioChannels: 2, IsVideoDirect: false, IsAudioDirect: false },
        },
      ],
      '/Items': { Items: [{ Id: 'sh1', Type: 'Series', Name: 'Severance', ProviderIds: { Tvdb: '371980' } }] },
    });
    const [s] = await new JellyfinClient('http://jellyfin:8096', 'k', f).nowPlaying();
    expect(s).toMatchObject({ keys: ['tvdb:371980'], durationMs: 3_600_000 });
    expect(Object.fromEntries(s!.facts!.map((x) => [x.label, x.value]))).toEqual({
      Stream: 'Converting',
      Quality: '720p · 3.0 Mbps',
      Video: '1080p H264 SDR → 720p H264',
      Audio: 'English - AC3 - 5.1 → AAC stereo',
      Subtitles: 'English - SRT',
      Container: 'MKV → TS',
      Connection: 'Home network · 192.168.1.30',
      App: 'Jellyfin iOS 1.6',
    });
  });
});
