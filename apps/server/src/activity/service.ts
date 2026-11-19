import { desc, eq, gte, max, sql } from 'drizzle-orm';
import type { ActivityStats, PersonSummary, PersonView, PlayView, StreamView, WatchersView } from '@marquee/shared';
import type { Db } from '../db/index.js';
import { mediaFiles, movies, plays, series, streams, users, type User } from '../db/schema.js';
import type { Clients } from '../http.js';
import { MediaServerError, readMediaServer, type ServerKind, type WatchItem } from '../library/mediaServers.js';
import { normalizeTitle } from '../releases/decide.js';

/**
 * Watching, from Plex and Jellyfin: who is watching now, and a copy of every
 * finished watch so it can be searched, counted and shown on a title's page.
 * Read-only towards both servers. Plex and Jellyfin keep their own history;
 * this is a copy, so it carries on if either server is rebuilt.
 */

const DAY = 86_400_000;
const KINDS: ServerKind[] = ['plex', 'jellyfin'];

type Deps = { db: Db; clients: Pick<Clients, 'plexServer' | 'jellyfin'>; now: () => number };

function api(deps: Deps, kind: ServerKind) {
  const s = readMediaServer(deps.db, kind);
  if (!s.url || !s.secret) return null;
  return kind === 'plex' ? deps.clients.plexServer(s.url, s.secret) : deps.clients.jellyfin(s.url, s.secret);
}

const problem = (kind: ServerKind, err: unknown) => `${kind === 'plex' ? 'Plex' : 'Jellyfin'}: ${err instanceof MediaServerError ? err.message : (err as Error).message}`;

/** Copies new finished watches from each connected server. The first time it goes back a year. */
export async function syncPlays(deps: Deps): Promise<{ added: number; problems: string[] }> {
  const { db, now } = deps;
  let added = 0;
  const problems: string[] = [];
  for (const kind of KINDS) {
    const server = api(deps, kind);
    if (!server) continue;
    try {
      const last = db.select({ t: max(plays.playedAt) }).from(plays).where(eq(plays.server, kind)).get()?.t;
      // A day of overlap catches anything the server recorded late; duplicates are ignored.
      const since = last ? last - DAY : now() - 365 * DAY;
      for (const p of await server.history(since)) {
        const r = db
          .insert(plays)
          .values({ server: kind, serverUserId: p.userId, userName: p.user, itemKey: p.key, kind: p.kind, title: p.title, show: p.show, season: p.season, episode: p.episode, year: p.year, tmdbId: p.tmdbId, playedAt: p.playedAt })
          .onConflictDoNothing()
          .run();
        added += r.changes;
      }
    } catch (err) {
      problems.push(problem(kind, err));
    }
  }
  return { added, problems };
}

/** The library page for what is playing, if Marquee has it. */
export function hrefFor(db: Db, w: WatchItem): string | null {
  if (w.kind === 'movie') {
    const m =
      (w.tmdbId ? db.select({ id: movies.id }).from(movies).where(eq(movies.tmdbId, w.tmdbId)).get() : undefined) ??
      db.select({ id: movies.id, title: movies.title, year: movies.year }).from(movies).all().find((x) => normalizeTitle(x.title) === normalizeTitle(w.title) && (!w.year || !x.year || x.year === w.year));
    return m ? `/movies/${m.id}` : null;
  }
  const show = w.show ? showByName(db, w.show) : undefined;
  return show ? `/shows/${show.id}` : null;
}

const showByName = (db: Db, name: string) => db.select({ id: series.id, title: series.title }).from(series).all().find((s) => normalizeTitle(s.title) === normalizeTitle(name));

export const describeItem = (w: WatchItem): { title: string; subtitle: string | null } =>
  w.kind === 'movie'
    ? { title: w.title, subtitle: w.year ? String(w.year) : null }
    : { title: w.show ?? w.title, subtitle: `${w.season != null && w.episode != null ? `S${String(w.season).padStart(2, '0')}E${String(w.episode).padStart(2, '0')} · ` : ''}${w.title}` };

export function recentPlays(db: Db, limit: number, offset = 0): { plays: PlayView[]; total: number } {
  const rows = db.select().from(plays).orderBy(desc(plays.playedAt)).limit(limit).offset(offset).all();
  const total = db.select({ n: sql<number>`count(*)` }).from(plays).get()?.n ?? 0;
  return {
    total,
    plays: rows.map((r) => ({
      id: r.id,
      server: r.server,
      user: r.userName,
      ...describeItem({ kind: r.kind, title: r.title, show: r.show, season: r.season, episode: r.episode, year: r.year, tmdbId: r.tmdbId }),
      at: r.playedAt,
      href: hrefFor(db, { kind: r.kind, title: r.title, show: r.show, season: r.season, episode: r.episode, year: r.year, tmdbId: r.tmdbId }),
    })),
  };
}

const top = (rows: { name: string; n: number }[]) => rows.map((r) => ({ name: r.name, plays: r.n }));

/** The name to show for someone on Plex or Jellyfin: their Marquee name when an account matches. */
function namer(db: Db): (raw: string) => string {
  const accounts: User[] = db.select().from(users).all();
  return (raw) => {
    const n = raw.toLowerCase();
    return accounts.find((u) => [u.username, u.plexUsername, u.jellyfinUsername, u.displayName].some((x) => x?.toLowerCase() === n))?.displayName ?? raw;
  };
}

const MIN_REAL = 30_000;

/** Most streams playing at the same time, from their start and end times. */
function peakConcurrent(rows: { startedAt: number; endedAt: number | null; lastSeenAt: number }[]): number {
  const edges: [number, number][] = [];
  for (const r of rows) {
    edges.push([r.startedAt, 1], [r.endedAt ?? r.lastSeenAt, -1]);
  }
  // An end sorts before a start at the same moment, so back-to-back streams don't count as two.
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let now = 0;
  let peak = 0;
  for (const [, d] of edges) {
    now += d;
    peak = Math.max(peak, now);
  }
  return peak;
}

export function activityStats(db: Db, now: number, days = 30): ActivityStats {
  const since = now - days * DAY;
  const name = namer(db);
  const rows = db.select().from(plays).where(gte(plays.playedAt, since)).all();
  const perDay = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) perDay.set(new Date(now - i * DAY).toISOString().slice(0, 10), 0);
  const count = (list: string[]) => {
    const m = new Map<string, number>();
    for (const k of list) m.set(k, (m.get(k) ?? 0) + 1);
    return [...m].map(([n, plays]) => ({ name: n, plays })).sort((a, b) => b.plays - a.plays || a.name.localeCompare(b.name)).slice(0, 8);
  };
  const hours = new Array<number>(24).fill(0);
  const weekdays = new Array<number>(7).fill(0);
  for (const r of rows) {
    const d = new Date(r.playedAt);
    const key = d.toISOString().slice(0, 10);
    if (perDay.has(key)) perDay.set(key, perDay.get(key)! + 1);
    hours[d.getHours()]! += 1;
    weekdays[d.getDay()]! += 1;
  }

  const ss = db.select().from(streams).where(gte(streams.startedAt, since)).all().filter((r) => r.watchedMs >= MIN_REAL);
  const time = new Map<string, number>();
  for (const r of ss) time.set(name(r.userName), (time.get(name(r.userName)) ?? 0) + r.watchedMs);

  const files = db.select({ n: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(${mediaFiles.size}), 0)` }).from(mediaFiles).get();
  const group = (col: typeof mediaFiles.resolution | typeof mediaFiles.codec) =>
    db.select({ name: col, count: sql<number>`count(*)` }).from(mediaFiles).groupBy(col).orderBy(desc(sql`count(*)`)).limit(8).all().map((r) => ({ name: r.name ?? 'Unknown', count: r.count }));

  return {
    days,
    total: rows.length,
    last24h: rows.filter((r) => r.playedAt >= now - DAY).length,
    perDay: [...perDay].map(([day, n]) => ({ day, plays: n })),
    hours,
    weekdays,
    users: count(rows.map((r) => name(r.userName))).map((u) => u),
    movies: count(rows.filter((r) => r.kind === 'movie').map((r) => r.title)),
    shows: count(rows.filter((r) => r.kind === 'episode' && r.show).map((r) => r.show!)),
    servers: { plex: rows.filter((r) => r.server === 'plex').length, jellyfin: rows.filter((r) => r.server === 'jellyfin').length },
    live: {
      streams: ss.length,
      watchHours: Math.round((ss.reduce((a, r) => a + r.watchedMs, 0) / 3_600_000) * 10) / 10,
      peakStreams: peakConcurrent(ss),
      direct: ss.filter((r) => !r.transcoding).length,
      converted: ss.filter((r) => r.transcoding).length,
      platforms: count(ss.map((r) => r.platform)),
      resolutions: count(ss.filter((r) => r.resolution).map((r) => r.resolution!)),
      watchTime: [...time].map(([n, ms]) => ({ name: n, hours: Math.round((ms / 3_600_000) * 10) / 10 })).sort((a, b) => b.hours - a.hours).slice(0, 8),
    },
    library: { files: files?.n ?? 0, bytes: files?.bytes ?? 0, resolutions: group(mediaFiles.resolution), codecs: group(mediaFiles.codec) },
  };
}

const streamView = (r: typeof streams.$inferSelect): StreamView => ({
  id: r.id,
  server: r.server,
  ...describeItem({ kind: r.kind, title: r.title, show: r.show, season: r.season, episode: r.episode, year: r.year, tmdbId: r.tmdbId }),
  device: r.device,
  platform: r.platform,
  resolution: r.resolution,
  converted: r.transcoding,
  startedAt: r.startedAt,
  watchedMs: r.watchedMs,
  progress: r.progress,
  going: r.endedAt === null,
});

/** Everyone who has watched, merged across Plex and Jellyfin by Marquee name. */
export function people(db: Db): PersonSummary[] {
  const name = namer(db);
  const by = new Map<string, PersonSummary>();
  const get = (n: string) => {
    let p = by.get(n);
    if (!p) by.set(n, (p = { name: n, plays: 0, hours: 0, last: null, devices: [] }));
    return p;
  };
  for (const r of db.select().from(plays).all()) {
    const p = get(name(r.userName));
    p.plays += 1;
    p.last = Math.max(p.last ?? 0, r.playedAt);
  }
  const ms = new Map<string, number>();
  for (const r of db.select().from(streams).all()) {
    const p = get(name(r.userName));
    ms.set(p.name, (ms.get(p.name) ?? 0) + r.watchedMs);
    if (!p.devices.includes(r.device)) p.devices.push(r.device);
    p.last = Math.max(p.last ?? 0, r.startedAt);
  }
  for (const p of by.values()) p.hours = Math.round(((ms.get(p.name) ?? 0) / 3_600_000) * 10) / 10;
  return [...by.values()].sort((a, b) => (b.last ?? 0) - (a.last ?? 0));
}

export function person(db: Db, who: string): PersonView | null {
  const summary = people(db).find((p) => p.name.toLowerCase() === who.toLowerCase());
  if (!summary) return null;
  const name = namer(db);
  const mine = db.select().from(plays).orderBy(desc(plays.playedAt)).all().filter((r) => name(r.userName) === summary.name);
  const counts = new Map<string, number>();
  for (const r of mine) {
    const k = r.kind === 'episode' ? (r.show ?? r.title) : r.title;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return {
    ...summary,
    top: [...counts].map(([n, p]) => ({ name: n, plays: p })).sort((a, b) => b.plays - a.plays || a.name.localeCompare(b.name)).slice(0, 8),
    recent: mine.slice(0, 20).map((r) => ({
      id: r.id,
      server: r.server,
      user: summary.name,
      ...describeItem({ kind: r.kind, title: r.title, show: r.show, season: r.season, episode: r.episode, year: r.year, tmdbId: r.tmdbId }),
      at: r.playedAt,
      href: hrefFor(db, { kind: r.kind, title: r.title, show: r.show, season: r.season, episode: r.episode, year: r.year, tmdbId: r.tmdbId }),
    })),
    streams: db.select().from(streams).orderBy(desc(streams.startedAt)).all().filter((r) => name(r.userName) === summary.name).slice(0, 20).map(streamView),
  };
}

/** Who has watched a movie or show in the library. People are matched to Marquee accounts by name when they can be. */
export function watchersOf(db: Db, kind: 'movie' | 'tv', id: number): WatchersView | null {
  const title = kind === 'movie' ? db.select().from(movies).where(eq(movies.id, id)).get() : db.select().from(series).where(eq(series.id, id)).get();
  if (!title) return null;
  const want = normalizeTitle(title.title);
  const all = db.select().from(plays).where(eq(plays.kind, kind === 'movie' ? 'movie' : 'episode')).all();
  const mine = all.filter((p) =>
    kind === 'movie'
      ? (p.tmdbId ? p.tmdbId === (title as { tmdbId: number }).tmdbId : normalizeTitle(p.title) === want && (!p.year || !title.year || p.year === title.year))
      : p.show !== null && normalizeTitle(p.show) === want,
  );
  const display = namer(db);
  const by = new Map<string, { plays: number; last: number; eps: Set<string> }>();
  for (const p of mine) {
    const name = display(p.userName);
    const e = by.get(name) ?? { plays: 0, last: 0, eps: new Set() };
    e.plays += 1;
    e.last = Math.max(e.last, p.playedAt);
    if (p.season != null) e.eps.add(`${p.season}:${p.episode}`);
    by.set(name, e);
  }
  return {
    watchers: [...by]
      .map(([user, e]) => ({ user, plays: e.plays, last: e.last, episodes: kind === 'tv' ? e.eps.size : null }))
      .sort((a, b) => b.last - a.last),
  };
}
