import { and, eq, inArray } from 'drizzle-orm';
import type { DownloadView, SendResult } from '@marquee/shared';
import { recordHistory } from './history.js';
import { describeDownload } from './view.js';
import type { Db } from '../db/index.js';
import { downloads, type Download } from '../db/schema.js';
import { noRoomReason, type DiskProbe } from '../system/disk.js';
import { HttpError } from '../http.js';
import type { CachedSearch, CopyCache } from './cache.js';
import { QbitError, type QbitApi } from './qbittorrent.js';
import { DOWNLOADER_TEXT, readDownloader } from './service.js';
import { TorrentFetchError, type FetchedTorrent } from './torrent.js';
import { TorznabError } from '../sources/torznab.js';

/**
 * "Download this": takes a copy from a recent search, fetches its torrent on
 * the server, and adds it to qBittorrent under Marquee's category. If
 * qBittorrent already has that torrent (say Radarr sent it), Marquee adopts
 * it instead of adding it twice.
 */

export interface SendDeps {
  db: Db;
  copies: CopyCache;
  qbittorrent(url: string, username: string, password: string): QbitApi;
  fetchTorrent(url: string, headers?: Record<string, string>): Promise<FetchedTorrent>;
  /** Free space on a folder's disk; left out, Marquee asks the system. */
  disk?: DiskProbe;
  now: () => number;
}

const ACTIVE = ['sent', 'downloading'] as const;
export const MARQUEE_TAG = 'marquee';

export async function sendCopy(deps: SendDeps, input: { searchId: string; copyId: string; anyway?: boolean }, userId: number): Promise<SendResult> {
  const { db, now } = deps;
  const search = deps.copies.get(input.searchId);
  if (!search) throw new HttpError(404, 'search_expired', 'This list of copies is out of date. Search again, then pick a copy.');
  const index = Number(input.copyId);
  if (!Number.isInteger(index) || !search.decisions[index]) throw new HttpError(404, 'no_such_copy', 'That copy isn’t in this search any more. Search again.');
  return sendFromSearch(deps, search, index, userId, !!input.anyway);
}

/** Sends one copy of a search to qBittorrent. Used by "Download this" and "Try another copy". */
export async function sendFromSearch(
  deps: Omit<SendDeps, 'copies'>,
  search: Omit<CachedSearch, 'at'>,
  index: number,
  userId: number | null,
  anyway: boolean,
): Promise<SendResult> {
  const { db, now } = deps;
  const d = search.decisions[index]!;
  const vs = search.vsYours[index] ?? null;

  if (!anyway) {
    if (!d.accepted) throw new HttpError(409, 'needs_confirm', `Marquee wouldn’t pick this one: ${d.rejections.map((r) => r.message).join(' ')} Download it anyway?`);
    if (vs && !vs.better) throw new HttpError(409, 'needs_confirm', `${vs.message} Download it anyway?`);
  }

  const settings = readDownloader(db);
  if (!settings.url) throw new HttpError(409, 'no_downloader', 'Connect qBittorrent first, in Settings → Downloader.');

  const t = search.target;
  const sameTitle =
    t.kind === 'movie'
      ? eq(downloads.movieId, t.movieId!)
      : and(eq(downloads.seriesId, t.seriesId!), eq(downloads.season, t.season ?? -1));
  const busy = db.select().from(downloads).where(and(sameTitle, inArray(downloads.state, [...ACTIVE]))).all();
  const clash = busy.find((b) => t.kind === 'movie' || overlaps(b, t.episode));
  if (clash) throw new HttpError(409, 'already_downloading', `Marquee is already downloading “${clash.title}” for this. Wait for it, or remove it from the Downloads page first.`);

  // Keep the minimum free on the downloads disk (Settings → Health → For experts).
  const noRoom = await noRoomReason(db, 'downloads', d.copy.size ?? 0, deps.disk);
  if (noRoom) throw new HttpError(409, 'no_room', noRoom);

  let torrent: FetchedTorrent;
  try {
    // Sites Marquee runs itself may need to open the copy's page first, and send their cookies.
    const where = d.copy.resolveDownload ? await d.copy.resolveDownload() : { url: d.copy.downloadUrl, headers: {} };
    torrent = await deps.fetchTorrent(where.url, where.headers);
  } catch (err) {
    if (err instanceof TorrentFetchError) throw new HttpError(502, 'source_failed', err.message);
    if (err instanceof TorznabError) throw new HttpError(502, 'source_failed', `${err.message} Try again, or pick another copy.`);
    throw err;
  }

  const qbit = deps.qbittorrent(settings.url, settings.username, settings.password ?? '');
  const row = {
    kind: t.kind,
    movieId: t.movieId ?? null,
    seriesId: t.seriesId ?? null,
    season: t.season ?? null,
    episodes: t.episode !== undefined ? JSON.stringify([t.episode]) : null,
    title: d.copy.title,
    infoHash: torrent.infoHash,
    sourceId: d.copy.sourceId || null,
    sourceName: d.copy.sourceName,
    profile: search.profileKey,
    quality: d.quality,
    score: d.score,
    size: d.copy.size,
    requestedBy: userId,
    addedAt: now(),
    lastProgressAt: now(),
  };
  try {
    const existing = (await qbit.torrents([torrent.infoHash]))[0];
    if (existing) {
      const mine = db.select().from(downloads).where(and(eq(downloads.infoHash, torrent.infoHash), inArray(downloads.state, [...ACTIVE]))).get();
      if (mine) throw new HttpError(409, 'already_downloading', `Marquee is already downloading this copy for “${mine.title}”.`);
      const saved = db
        .insert(downloads)
        .values({ ...row, adopted: true, state: existing.progress >= 1 ? 'done' : 'downloading', progress: existing.progress })
        .returning()
        .get();
      const where = existing.category ? `in the “${existing.category}” category` : 'with no category';
      return { download: describeDownload(db, saved, now()), message: `qBittorrent already had this copy (${where}), so Marquee is following it there instead of adding it again.` };
    }
    await qbit.ensureCategory(settings.category);
    await qbit.add(torrent.payload, { category: settings.category, tags: [MARQUEE_TAG] });
  } catch (err) {
    if (err instanceof QbitError) {
      const state = err.kind === 'error' ? 'error' : err.kind;
      throw new HttpError(502, 'downloader_failed', `${DOWNLOADER_TEXT[state].label}: ${err.message}`);
    }
    throw err;
  }
  const saved = db.insert(downloads).values(row).returning().get();
  recordHistory(db, 'sent', saved, now(), { userId });
  return { download: describeDownload(db, saved, now()), message: `Sent to qBittorrent. It’s in the “${settings.category}” category.` };
}

function overlaps(b: Download, episode: number | undefined): boolean {
  if (episode === undefined || !b.episodes) return true; // a whole season overlaps everything in it
  return (JSON.parse(b.episodes) as number[]).includes(episode);
}

export function listDownloads(db: Db, now: number): DownloadView[] {
  return db.select().from(downloads).all().reverse().map((d) => describeDownload(db, d, now));
}
