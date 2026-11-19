import { MediaServerError, type MediaLibrary, type MediaPerson, type NowPlayingItem, type PlayRecord, type MediaServerApi } from '../../src/library/mediaServers.js';

/** A fake Plex or Jellyfin for tests and demo mode: its libraries, and every scan it was asked for. No network. */
export class FakeMediaServer {
  name: string;
  secret: string;
  libs: MediaLibrary[];
  scans: { library: string; folder: string }[] = [];
  fail: string | null = null;
  people: MediaPerson[] = [];
  playing: NowPlayingItem[] = [];
  plays: PlayRecord[] = [];
  /** Streams stopped by an admin: session id and the message shown. */
  stopped: { sessionId: string; message: string }[] = [];
  /** Set to make stopping fail this way. */
  failStop: string | null = null;
  private hints = new Set<() => void>();
  /** Pretends the server just pushed "something changed". */
  hint(): void {
    for (const h of this.hints) h();
  }
  /** How many live lines are open. */
  get watchers(): number {
    return this.hints.size;
  }

  constructor(kind: 'plex' | 'jellyfin', libs?: MediaLibrary[]) {
    this.name = kind === 'plex' ? 'Plex' : 'Jellyfin';
    this.secret = kind === 'plex' ? 'plex-token' : 'jellyfin-key';
    // Plex here sees the library under /media, Jellyfin under /data like Marquee.
    this.libs = libs ?? (kind === 'plex'
      ? [
          { id: '1', name: 'Movies', kind: 'movie', locations: ['/media/movies'] },
          { id: '2', name: 'TV Shows', kind: 'tv', locations: ['/media/tv'] },
          { id: '3', name: 'Music', kind: 'other', locations: ['/media/music'] },
        ]
      : [
          { id: 'a1', name: 'Movies', kind: 'movie', locations: ['/data/media/movies'] },
          { id: 'b2', name: 'Shows', kind: 'tv', locations: ['/data/media/tv'] },
        ]);
  }

  as(_url: string, secret: string): MediaServerApi {
    const gate = () => {
      if (this.fail) throw new MediaServerError(this.fail);
      if (secret !== this.secret) throw new MediaServerError(`${this.name} turned down the ${this.name === 'Plex' ? 'token' : 'API key'}.`);
    };
    return {
      ping: async () => {
        gate();
        return { name: `Josh's ${this.name}`, version: this.name === 'Plex' ? '1.41.3' : '10.10.3' };
      },
      stop: async (sessionId, message) => {
        gate();
        if (this.failStop) throw new MediaServerError(this.failStop);
        this.stopped.push({ sessionId, message });
        this.playing = this.playing.filter((p) => p.sessionId !== sessionId);
      },
      watch: (onHint, onState) => {
        this.hints.add(onHint);
        onState?.(true);
        return () => void this.hints.delete(onHint);
      },
      nowPlaying: async () => {
        gate();
        return structuredClone(this.playing);
      },
      history: async (since) => {
        gate();
        return structuredClone(this.plays.filter((p) => p.playedAt >= since));
      },
      people: async () => {
        gate();
        return structuredClone(this.people);
      },
      libraries: async () => {
        gate();
        return structuredClone(this.libs);
      },
      scan: async (library, folder) => {
        gate();
        this.scans.push({ library: library.id, folder });
      },
    };
  }
}
