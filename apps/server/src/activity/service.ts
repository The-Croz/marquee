import { and, desc, eq, gte, max, sql } from 'drizzle-orm';
import type { ActivityStats, NowPlayingView, PlayView, WatchersView } from '@marquee/shared';
import type { Db } from '../db/index.js';
import { movies, plays, series, users } from '../db/schema.js';
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
function hrefFor(db: Db, w: WatchItem): string | null {
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

export async function nowPlaying(deps: Deps): Promise<{ sessions: NowPlayingView[]; problems: string[] }> {
  const sessions: NowPlayingView[] = [];
  const problems: string[] = [];
  for (const kind of KINDS) {
    const server = api(deps, kind);
    if (!server) continue;
    try {
      for (const n of await server.nowPlaying()) {
        sessions.push({ server: kind, user: n.user, ...describeItem(n), device: n.device, state: n.state, progress: n.progress, transcoding: n.transcoding, href: hrefFor(deps.db, n) });
      }
    } catch (err) {
      problems.push(problem(kind, err));
    }
  }
  return { sessions, problems };
}

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

export function activityStats(db: Db, now: number, days = 30): ActivityStats {
  const since = now - days * DAY;
  const rows = db.select().from(plays).where(gte(plays.playedAt, since)).all();
  const perDay = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) perDay.set(new Date(now - i * DAY).toISOString().slice(0, 10), 0);
  const count = (key: (r: (typeof rows)[number]) => string | null) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const k = key(r);
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return top([...m].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).slice(0, 8));
  };
  for (const r of rows) {
    const d = new Date(r.playedAt).toISOString().slice(0, 10);
    if (perDay.has(d)) perDay.set(d, perDay.get(d)! + 1);
  }
  return {
    days,
    total: rows.length,
    last24h: rows.filter((r) => r.playedAt >= now - DAY).length,
    perDay: [...perDay].map(([day, n]) => ({ day, plays: n })),
    users: count((r) => r.userName),
    movies: count((r) => (r.kind === 'movie' ? r.title : null)),
    shows: count((r) => (r.kind === 'episode' ? r.show : null)),
    servers: { plex: rows.filter((r) => r.server === 'plex').length, jellyfin: rows.filter((r) => r.server === 'jellyfin').length },
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
  const accounts = db.select().from(users).all();
  const display = (name: string) => {
    const n = name.toLowerCase();
    return accounts.find((u) => [u.username, u.plexUsername, u.jellyfinUsername, u.displayName].some((x) => x?.toLowerCase() === n))?.displayName ?? name;
  };
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
