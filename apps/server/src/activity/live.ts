import { eq, isNull } from 'drizzle-orm';
import type { NowPlayingView } from '@marquee/shared';
import type { Db } from '../db/index.js';
import { streams } from '../db/schema.js';
import type { Clients } from '../http.js';
import { MediaServerError, readMediaServer, type MediaServerApi, type NowPlayingItem, type ServerKind } from '../library/mediaServers.js';
import { notifyAdmins, type NotifyDeps } from '../notify/service.js';
import { describeItem, hrefFor } from './service.js';

/**
 * Watching what is playing, the way it should work: the media servers tell us
 * the moment something changes (a live line each for Plex and Jellyfin), and we
 * also look every few seconds while anything is playing, because a live line can
 * drop. Either way, what is playing is read from the server itself, compared
 * with what we saw last time, and every start, pause, resume and stop is
 * recorded, tells the page, and can send a notification.
 *
 * - A stream is saved when it starts, and kept up to date, so a restart loses nothing.
 * - "Watched" time only counts while a stream is playing, not paused.
 * - If a server stops answering we keep what we know for 2 minutes, then close those streams.
 */

type Deps = {
  db: Db;
  clients: Pick<Clients, 'plexServer' | 'jellyfin'>;
  now: () => number;
  notify?: () => NotifyDeps;
};

interface Live {
  key: string;
  server: ServerKind;
  rowId: number;
  item: NowPlayingItem;
  startedAt: number;
  lastTick: number;
  lastWrite: number;
  watchedMs: number;
  progress: number;
  transcodeTold: boolean;
}

const KINDS: ServerKind[] = ['plex', 'jellyfin'];
const SERVER_NAME = { plex: 'Plex', jellyfin: 'Jellyfin' } as const;
/** A gap longer than this between looks isn't counted as watching. */
const MAX_GAP = 60_000;
/** Streams shorter than this don't get a "stopped" message (a quick tap on the wrong thing). */
const MIN_STOP_MS = 30_000;
const GIVE_UP_AFTER = 2 * 60_000;
const WRITE_EVERY = 30_000;

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

export interface LiveStatus {
  server: ServerKind;
  /** The live line to the server is open, so changes show up at once. */
  live: boolean;
}

export class ActivityMonitor {
  private current = new Map<string, Live>();
  private lastOk = new Map<ServerKind, number>();
  private problems = new Map<ServerKind, string>();
  private lines = new Map<ServerKind, { stop: () => void; connected: boolean; fingerprint: string }>();
  private listeners = new Set<(view: { sessions: NowPlayingView[]; problems: string[] }) => void>();
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private hintTimer: ReturnType<typeof setTimeout> | null = null;
  private lastJson = '';
  private started = false;

  constructor(private readonly deps: Deps) {}

  // ------------------------------------------------------------ running

  /** Starts watching in the background. Safe to call again; it picks up new servers. */
  start(): void {
    if (!this.started) {
      this.started = true;
      this.closeLeftovers();
    }
    this.connectLines();
    this.schedule();
  }

  stopWatching(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.hintTimer) clearTimeout(this.hintTimer);
    for (const l of this.lines.values()) l.stop();
    this.lines.clear();
  }

  /** Streams that were still open when Marquee last stopped can't be followed, so close them. */
  private closeLeftovers(): void {
    for (const r of this.deps.db.select().from(streams).where(isNull(streams.endedAt)).all()) {
      this.deps.db.update(streams).set({ endedAt: r.lastSeenAt }).where(eq(streams.id, r.id)).run();
    }
  }

  private api(kind: ServerKind): MediaServerApi | null {
    const s = readMediaServer(this.deps.db, kind);
    if (!s.url || !s.secret) return null;
    return kind === 'plex' ? this.deps.clients.plexServer(s.url, s.secret) : this.deps.clients.jellyfin(s.url, s.secret);
  }

  /** Opens or closes each server's live line to match what is set up in Settings. */
  private connectLines(): void {
    for (const kind of KINDS) {
      const s = readMediaServer(this.deps.db, kind);
      const fingerprint = s.url && s.secret ? `${s.url}|${s.secret}` : '';
      const line = this.lines.get(kind);
      if (line && line.fingerprint === fingerprint) continue;
      line?.stop();
      this.lines.delete(kind);
      if (!fingerprint) continue;
      const api = this.api(kind);
      if (!api?.watch) continue;
      const entry = { stop: () => {}, connected: false, fingerprint };
      this.lines.set(kind, entry);
      entry.stop = api.watch(
        () => this.hint(),
        (connected) => {
          entry.connected = connected;
        },
      );
    }
  }

  status(): LiveStatus[] {
    return KINDS.filter((k) => this.lines.has(k) || readMediaServer(this.deps.db, k).url).map((k) => ({ server: k, live: this.lines.get(k)?.connected ?? false }));
  }

  /** The server said something changed: look in a moment (several changes often arrive together). */
  private hint(): void {
    if (this.hintTimer) return;
    this.hintTimer = setTimeout(() => {
      this.hintTimer = null;
      void this.refresh();
    }, 300);
    this.hintTimer.unref?.();
  }

  /** While anything plays, look every 10 s (5 s with no live line); idle, every 60 s (30 s with no live line). */
  private schedule(): void {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    const live = [...this.lines.values()].some((l) => l.connected);
    const wait = this.current.size > 0 ? (live ? 10_000 : 5_000) : live ? 60_000 : 30_000;
    this.timer = setTimeout(() => {
      this.connectLines();
      void this.refresh().finally(() => this.schedule());
    }, wait);
    this.timer.unref?.();
  }

  // ------------------------------------------------------------ looking

  /** Looks at every connected server now. Calls made while one is running share it. */
  refresh(): Promise<void> {
    if (!this.running) {
      this.running = this.look().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async look(): Promise<void> {
    const { now } = this.deps;
    for (const kind of KINDS) {
      const api = this.api(kind);
      if (!api) {
        this.problems.delete(kind);
        this.lastOk.delete(kind);
        this.endAll(kind, now());
        continue;
      }
      try {
        const items = await api.nowPlaying();
        this.problems.delete(kind);
        this.lastOk.set(kind, now());
        this.apply(kind, items);
      } catch (err) {
        this.problems.set(kind, `${SERVER_NAME[kind]}: ${err instanceof MediaServerError ? err.message : (err as Error).message}`);
        const since = this.lastOk.get(kind);
        if (since !== undefined && now() - since > GIVE_UP_AFTER) this.endAll(kind, since);
      }
    }
    this.publish();
  }

  private endAll(kind: ServerKind, at: number): void {
    for (const live of [...this.current.values()]) if (live.server === kind) this.end(live, at);
  }

  private tell(event: string, title: string, body: string): void {
    const n = this.deps.notify?.();
    if (n) void notifyAdmins(n, event, { title, body, link: '/activity' }).catch((e) => console.error('[notify] failed:', (e as Error).message));
  }

  /** Compares what the server says is playing with what we knew, and records the differences. */
  private apply(kind: ServerKind, items: NowPlayingItem[]): void {
    const { db, now } = this.deps;
    const t = now();
    const seen = new Set<string>();
    for (const it of items) {
      if (!it.sessionId) continue;
      // Autoplay keeps the same session for the next episode, so the item is part of the key.
      const key = `${kind}:${it.sessionId}:${it.show ?? ''}:${it.season ?? ''}:${it.episode ?? ''}:${it.title}`;
      seen.add(key);
      const live = this.current.get(key);
      const what = describeItem(it);
      const where = `on ${it.device}${it.transcoding ? ' (the server is converting it)' : ''}`;

      if (!live) {
        const row = db
          .insert(streams)
          .values({ server: kind, sessionId: it.sessionId, userName: it.user, kind: it.kind, title: it.title, show: it.show, season: it.season, episode: it.episode, year: it.year, tmdbId: it.tmdbId, device: it.device, platform: it.platform, resolution: it.resolution, transcoding: it.transcoding, startedAt: t, lastSeenAt: t, progress: it.progress })
          .returning({ id: streams.id })
          .get();
        this.current.set(key, { key, server: kind, rowId: row.id, item: it, startedAt: t, lastTick: t, lastWrite: t, watchedMs: 0, progress: it.progress, transcodeTold: it.transcoding });
        this.tell('stream_started', `${it.user} started ${what.title}`, `${what.subtitle ? `${what.subtitle} ` : ''}${where}.`);
        if (it.transcoding) this.tell('stream_transcoding', `${what.title} is being converted`, `${it.user} ${where}. Converting uses extra power on the server.`);
        continue;
      }

      const gap = Math.min(t - live.lastTick, MAX_GAP);
      if (live.item.state === 'playing') live.watchedMs += gap;
      if (live.item.state === 'playing' && it.state === 'paused') this.tell('stream_paused', `${it.user} paused ${what.title}`, `${what.subtitle ?? ''} ${where}.`.trim());
      if (live.item.state === 'paused' && it.state === 'playing') this.tell('stream_resumed', `${it.user} resumed ${what.title}`, `${what.subtitle ?? ''} ${where}.`.trim());
      if (it.transcoding && !live.transcodeTold) {
        live.transcodeTold = true;
        this.tell('stream_transcoding', `${what.title} is being converted`, `${it.user} ${where}. Converting uses extra power on the server.`);
      }
      live.lastTick = t;
      live.progress = Math.max(live.progress, it.progress);
      live.item = it;
      if (t - live.lastWrite >= WRITE_EVERY) this.save(live, t);
    }
    for (const live of [...this.current.values()]) if (live.server === kind && !seen.has(live.key)) this.end(live, t);
  }

  private save(live: Live, t: number): void {
    live.lastWrite = t;
    this.deps.db.update(streams).set({ lastSeenAt: t, watchedMs: live.watchedMs, progress: live.progress, transcoding: live.item.transcoding || live.transcodeTold, resolution: live.item.resolution, device: live.item.device }).where(eq(streams.id, live.rowId)).run();
  }

  private end(live: Live, at: number): void {
    this.current.delete(live.key);
    this.deps.db.update(streams).set({ endedAt: at, lastSeenAt: at, watchedMs: live.watchedMs, progress: live.progress, transcoding: live.item.transcoding || live.transcodeTold }).where(eq(streams.id, live.rowId)).run();
    if (live.watchedMs >= MIN_STOP_MS) {
      const what = describeItem(live.item);
      this.tell('stream_stopped', `${live.item.user} finished watching ${what.title}`, `${what.subtitle ? `${what.subtitle}: ` : ''}watched ${minutes(live.watchedMs)} min (${Math.round(live.progress * 100)}% through) on ${live.item.device}.`);
    }
  }

  // ------------------------------------------------------------ the page

  view(): { sessions: NowPlayingView[]; problems: string[] } {
    const sessions = [...this.current.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((l) => ({
        server: l.server,
        sessionId: l.item.sessionId,
        user: l.item.user,
        ...describeItem(l.item),
        device: l.item.device,
        platform: l.item.platform,
        resolution: l.item.resolution,
        state: l.item.state,
        progress: l.item.progress,
        transcoding: l.item.transcoding,
        startedAt: l.startedAt,
        href: hrefFor(this.deps.db, l.item),
      }));
    return { sessions, problems: [...this.problems.values()] };
  }

  /** Called with the new list whenever it changes, for the live page. Returns a function to stop. */
  subscribe(fn: (view: { sessions: NowPlayingView[]; problems: string[] }) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private publish(): void {
    const v = this.view();
    const json = JSON.stringify(v);
    if (json === this.lastJson) return;
    this.lastJson = json;
    for (const l of this.listeners) l(v);
  }

  // ------------------------------------------------------------ stopping

  /** Stops one stream, showing the viewer why. The server decides whether it is allowed (Plex needs a Plex Pass for this). */
  async stopStream(kind: ServerKind, sessionId: string, message: string): Promise<void> {
    const api = this.api(kind);
    if (!api) throw new MediaServerError(`${SERVER_NAME[kind]} isn't connected.`);
    await api.stop(sessionId, message);
    await this.refresh();
  }
}
