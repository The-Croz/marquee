import { and, eq, gte, isNotNull, lte } from 'drizzle-orm';
import type { TautulliImportView } from '@marquee/shared';
import { getSetting, setSetting, type Db } from '../db/index.js';
import { plays } from '../db/schema.js';
import { HttpError } from '../http.js';

/**
 * W5: brings Tautulli's play history into Marquee once (its API), so the
 * Watching pages reach back further than Plex's own history. Each import is
 * one batch that can be undone. A play Marquee already has from Plex (same
 * person and item within six hours) isn't added twice.
 */

export type TautulliFetch = (url: string) => Promise<{ status: number; text: string }>;

export const realTautulliFetch: TautulliFetch = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  return { status: res.status, text: await res.text() };
};

interface Row {
  date?: number;
  stopped?: number;
  user_id?: number | string;
  friendly_name?: string;
  user?: string;
  media_type?: string;
  title?: string;
  full_title?: string;
  grandparent_title?: string;
  parent_media_index?: number | string;
  media_index?: number | string;
  year?: number | string;
  rating_key?: number | string;
  guid?: string;
}

const LOG = 'tautulli.imports';
const SIX_HOURS = 6 * 3_600_000;
const PAGE = 1000;

export function tautulliImports(db: Db): TautulliImportView['imports'] {
  return JSON.parse(getSetting(db, LOG) || '[]') as TautulliImportView['imports'];
}

export async function importTautulli(db: Db, fetchPage: TautulliFetch, input: { url: string; apiKey: string }, now: number): Promise<TautulliImportView['imports'][number]> {
  const base = input.url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) throw new HttpError(400, 'invalid_input', 'Tautulli’s address should start with http:// or https://, like http://tautulli:8181.');
  const batch = now;
  let added = 0;
  let skipped = 0;
  let seen = 0;
  for (let start = 0; start < 500_000; start += PAGE) {
    const url = `${base}/api/v2?apikey=${encodeURIComponent(input.apiKey)}&cmd=get_history&order_column=date&order_dir=desc&start=${start}&length=${PAGE}`;
    let res;
    try {
      res = await fetchPage(url);
    } catch {
      throw new HttpError(502, 'tautulli_unreachable', `Couldn’t reach Tautulli at ${base}. Check the address, and that Marquee can reach it.`);
    }
    let body: { response?: { result?: string; message?: string; data?: { data?: Row[]; recordsFiltered?: number } } };
    try {
      body = JSON.parse(res.text);
    } catch {
      throw new HttpError(502, 'tautulli_bad', `${base} answered, but not like Tautulli does. Check the address.`);
    }
    if (res.status === 401 || body.response?.result === 'error') throw new HttpError(400, 'tautulli_key', `Tautulli turned the key down${body.response?.message ? ` (${body.response.message})` : ''}. Copy the API key from Tautulli → Settings → Web Interface.`);
    const rows = body.response?.data?.data ?? [];
    for (const r of rows) {
      seen++;
      if (r.media_type !== 'movie' && r.media_type !== 'episode') continue;
      const at = ((r.stopped || r.date) ?? 0) * 1000;
      const userId = String(r.user_id ?? '');
      const key = String(r.rating_key ?? '');
      if (!at || !userId || !key) continue;
      const dupe = db
        .select({ id: plays.id })
        .from(plays)
        .where(and(eq(plays.server, 'plex'), eq(plays.serverUserId, userId), eq(plays.itemKey, key), gte(plays.playedAt, at - SIX_HOURS), lte(plays.playedAt, at + SIX_HOURS)))
        .get();
      if (dupe) {
        skipped++;
        continue;
      }
      const ep = r.media_type === 'episode';
      const tmdb = !ep && r.guid ? /tmdb:\/\/(\d+)/.exec(r.guid)?.[1] : undefined;
      const res2 = db
        .insert(plays)
        .values({
          server: 'plex',
          serverUserId: userId,
          userName: r.friendly_name || r.user || 'Someone',
          itemKey: key,
          kind: ep ? 'episode' : 'movie',
          title: r.title ?? r.full_title ?? '?',
          show: ep ? (r.grandparent_title ?? null) : null,
          season: ep && r.parent_media_index !== '' && r.parent_media_index !== undefined ? Number(r.parent_media_index) : null,
          episode: ep && r.media_index !== '' && r.media_index !== undefined ? Number(r.media_index) : null,
          year: r.year ? Number(r.year) : null,
          tmdbId: tmdb ? Number(tmdb) : null,
          playedAt: at,
          importBatch: batch,
        })
        .onConflictDoNothing()
        .run();
      if (res2.changes) added++;
      else skipped++;
    }
    if (rows.length < PAGE) break;
  }
  const entry = { at: batch, added, skipped, seen, undoneAt: null as number | null };
  setSetting(db, LOG, JSON.stringify([entry, ...tautulliImports(db)].slice(0, 10)));
  return entry;
}

/** Takes one import's plays back out. Plays Marquee got from Plex itself are untouched. */
export function undoTautulli(db: Db, at: number, now: number): number {
  const log = tautulliImports(db);
  const entry = log.find((e) => e.at === at);
  if (!entry) throw new HttpError(404, 'not_found', 'No such import.');
  const removed = db.delete(plays).where(and(isNotNull(plays.importBatch), eq(plays.importBatch, at))).run().changes;
  entry.undoneAt = now;
  setSetting(db, LOG, JSON.stringify(log));
  return removed;
}
