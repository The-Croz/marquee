import { and, desc, eq, gte, inArray, like, lt, lte, or, type SQL } from 'drizzle-orm';
import type { HistoryEvent, HistoryItem, HistoryView } from '@marquee/shared';
import type { Db } from '../db/index.js';
import { history, movies, series, users, type Download } from '../db/schema.js';

/**
 * One History of what happened to every download: sent, in the library,
 * upgraded, replaced (turned down and swapped for another copy), removed,
 * imports that failed, and copies taken off Never pick. Also what you did to
 * a title by hand: renamed its files, or removed it from Marquee. Rows are only ever
 * added. A title's own History and the History page both read from here.
 */

export const HISTORY_EVENTS: HistoryEvent[] = ['sent', 'in_library', 'upgraded', 'replaced', 'removed', 'import_failed', 'allowed_again', 'title_removed', 'renamed'];

const LOOK: Record<HistoryEvent, { label: string; tone: HistoryItem['tone'] }> = {
  sent: { label: 'Sent to qBittorrent', tone: 'busy' },
  in_library: { label: 'In your library', tone: 'good' },
  upgraded: { label: 'Upgraded', tone: 'good' },
  replaced: { label: 'Replaced', tone: 'bad' },
  removed: { label: 'Removed from qBittorrent', tone: 'quiet' },
  import_failed: { label: 'Couldn’t put it in your library', tone: 'bad' },
  allowed_again: { label: 'Taken off Never pick', tone: 'quiet' },
  title_removed: { label: 'Removed from Marquee', tone: 'quiet' },
  renamed: { label: 'Renamed', tone: 'quiet' },
};

const pad = (n: number) => String(n).padStart(2, '0');

/** "Dune: Part Two (2024)", "Severance · S02E03", "Severance · Season 2". */
export function titleName(db: Db, t: { kind: 'movie' | 'tv'; movieId: number | null; seriesId: number | null; season: number | null; episodes: string | null }, fallback: string): string {
  if (t.kind === 'movie') {
    const m = t.movieId ? db.select({ title: movies.title, year: movies.year }).from(movies).where(eq(movies.id, t.movieId)).get() : undefined;
    return m ? (m.year ? `${m.title} (${m.year})` : m.title) : fallback;
  }
  const show = (t.seriesId ? db.select({ title: series.title }).from(series).where(eq(series.id, t.seriesId)).get()?.title : undefined) ?? fallback.split(' · ')[0]!;
  const eps = t.episodes ? (JSON.parse(t.episodes) as number[]) : null;
  if (t.season === null) return show;
  return `${show} · ${eps?.length ? `S${pad(t.season)}E${eps.map(pad).join('-E')}` : `Season ${t.season}`}`;
}

/** Adds one thing that happened to a download. */
export function recordHistory(db: Db, event: HistoryEvent, d: Download, at: number, extra: { detail?: string | null; userId?: number | null } = {}): void {
  db.insert(history)
    .values({
      at,
      event,
      kind: d.kind,
      movieId: d.movieId,
      seriesId: d.seriesId,
      season: d.season,
      episodes: d.episodes,
      downloadId: d.id,
      copy: d.title,
      title: titleName(db, d, d.title),
      source: d.sourceName,
      quality: d.quality,
      size: d.size,
      detail: extra.detail ?? null,
      userId: extra.userId ?? null,
    })
    .run();
}

/** Adds a copy taken off a title's Never pick list. */
export function recordAllowedAgain(db: Db, t: { kind: 'movie' | 'tv'; movieId: number | null; seriesId: number | null; copy: string; reason: string }, at: number, userId: number | null): void {
  db.insert(history)
    .values({
      at,
      event: 'allowed_again',
      kind: t.kind,
      movieId: t.movieId,
      seriesId: t.seriesId,
      copy: t.copy,
      title: titleName(db, { ...t, season: null, episodes: null }, t.copy),
      detail: `It was turned down because: ${t.reason}`,
      userId,
    })
    .run();
}

export interface HistoryQuery {
  events?: HistoryEvent[];
  /** Words in the title or the copy's name. */
  q?: string;
  /** From and to, in ms (inclusive). */
  from?: number;
  to?: number;
  movieId?: number;
  seriesId?: number;
  /** Only rows older than this (the previous page's `next`). */
  before?: string;
  limit?: number;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Newest first, one page at a time. */
export function historyView(db: Db, query: HistoryQuery): HistoryView {
  const limit = Math.min(500, Math.max(1, query.limit ?? 100));
  const where: SQL[] = [];
  if (query.events?.length) where.push(inArray(history.event, query.events));
  if (query.movieId) where.push(eq(history.movieId, query.movieId));
  if (query.seriesId) where.push(eq(history.seriesId, query.seriesId));
  if (query.from !== undefined) where.push(gte(history.at, query.from));
  if (query.to !== undefined) where.push(lte(history.at, query.to));
  const cursor = /^(\d+)\.(\d+)$/.exec(query.before ?? '');
  if (cursor) {
    const [at, id] = [Number(cursor[1]), Number(cursor[2])];
    where.push(or(lt(history.at, at), and(eq(history.at, at), lt(history.id, id)))!);
  }
  const words = query.q?.trim();
  if (words) {
    const pattern = `%${likeEscape(words)}%`;
    where.push(or(like(history.title, pattern), like(history.copy, pattern))!);
  }
  const rows = db
    .select({ h: history, who: users.displayName })
    .from(history)
    .leftJoin(users, eq(users.id, history.userId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(history.at), desc(history.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const items = page.map(({ h, who }): HistoryItem => {
    const look = LOOK[h.event];
    const link = h.kind === 'movie' ? (h.movieId ? `/movies/${h.movieId}` : null) : h.seriesId ? `/shows/${h.seriesId}` : null;
    return {
      id: h.id,
      at: h.at,
      event: h.event,
      label: look.label,
      tone: look.tone,
      kind: h.kind,
      movieId: h.movieId,
      seriesId: h.seriesId,
      titleName: titleName(db, h, h.title),
      titleLink: link,
      copy: h.copy,
      source: h.source,
      quality: h.quality,
      size: h.size,
      detail: h.detail,
      who: who ?? null,
    };
  });
  const last = page.at(-1)?.h;
  return { items, next: rows.length > limit && last ? `${last.at}.${last.id}` : null };
}
