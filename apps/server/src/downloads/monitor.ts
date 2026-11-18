import path from 'node:path';
import { and, eq, inArray, isNotNull, isNull, or, lt } from 'drizzle-orm';
import fs from 'node:fs/promises';
import type { DownloadActionResult, DownloadsView } from '@marquee/shared';
import type { Db } from '../db/index.js';
import { downloads, neverPick, type Download } from '../db/schema.js';
import { HttpError, type Clients } from '../http.js';
import type { SourceService } from '../sources/service.js';
import { QbitError, type QbitApi, type QbitFile } from './qbittorrent.js';
import { bestPick, searchTitle } from './search.js';
import { sendFromSearch } from './send.js';
import { DOWNLOADER_TEXT, readDownloader } from './service.js';
import { FINISHED, RESTING, describeDownload } from './view.js';
import type { SearchTarget } from './cache.js';
import { ImportError, importDownload } from './importer.js';
import { seedRule, sharedEnough, sharingProgress } from './seeding.js';
import { tellMediaServers } from '../library/mediaServers.js';

/**
 * Follows Marquee's downloads in qBittorrent: progress, finished, gone,
 * stuck, and fakes (programs or only archives inside). When a download is
 * stuck for too long or looks fake, it turns that copy down for the title
 * ("Never pick"), removes it from qBittorrent and sends the next best copy.
 *
 * Downloads Marquee adopted from another app (say Radarr) are only watched:
 * Marquee never pauses, removes or replaces them.
 */

const HOUR = 3_600_000;
const FOLLOWED = ['sent', 'downloading'] as const;
/** A failed import is tried again this often. */
export const IMPORT_RETRY_MS = 15 * 60_000;

export interface MonitorDeps {
  db: Db;
  clients: Pick<Clients, 'qbittorrent' | 'fetchTorrent' | 'plexServer' | 'jellyfin'>;
  sources: SourceService;
  now: () => number;
}

const PROGRAMS = /\.(exe|bat|cmd|scr|lnk|msi|com|vbs|ps1|jar|apk|dmg|pif)$/i;
const VIDEO = /\.(mkv|mp4|m4v|avi|ts|m2ts|wmv|mov|webm|mpg|mpeg)$/i;
const ARCHIVE = /\.(rar|zip|7z|r\d\d|\d\d\d)$/i;

/** Says why a torrent's file list looks fake, or null if it looks like real video (or isn't known yet). */
export function fakeReason(files: QbitFile[]): string | null {
  if (files.length === 0) return null;
  const program = files.find((f) => PROGRAMS.test(f.name));
  if (program) return `It holds a program (${path.basename(program.name)}), which is never a real movie or episode.`;
  if (files.some((f) => VIDEO.test(f.name))) return null;
  if (files.some((f) => ARCHIVE.test(f.name))) return 'It only holds archives and no video. Real copies almost never do; this is usually a fake.';
  return 'There’s no video in it.';
}

export class DownloadMonitor {
  private lastCheck = 0;
  constructor(private readonly deps: MonitorDeps) {}

  private qbit(): QbitApi | null {
    const s = readDownloader(this.deps.db);
    return s.url ? this.deps.clients.qbittorrent(s.url, s.username, s.password ?? '') : null;
  }

  /** The Downloads page: checks qBittorrent if the last check is over `maxAgeMs` old. */
  async view(maxAgeMs = 10_000, filter?: { movieId?: number; seriesId?: number }): Promise<DownloadsView> {
    let problem: DownloadsView['problem'] = null;
    if (this.deps.now() - this.lastCheck > maxAgeMs) {
      try {
        await this.check();
      } catch (err) {
        if (!(err instanceof QbitError)) throw err;
        const t = DOWNLOADER_TEXT[err.kind === 'error' ? 'error' : err.kind];
        problem = { label: t.label, fix: t.fix };
      }
    }
    const { db, now } = this.deps;
    let rows = db.select().from(downloads).all().reverse();
    if (filter?.movieId) rows = rows.filter((r) => r.movieId === filter.movieId);
    if (filter?.seriesId) rows = rows.filter((r) => r.seriesId === filter.seriesId);
    return { items: rows.map((r) => describeDownload(db, r, now())), problem, checkedAt: this.lastCheck || null };
  }

  /** Brings every followed download up to date with qBittorrent. Throws QbitError when it can't be reached. */
  async check(): Promise<{ replaced: number }> {
    const { db, now } = this.deps;
    const qbit = this.qbit();
    const rows = db
      .select()
      .from(downloads)
      .where(
        or(
          inArray(downloads.state, [...FOLLOWED]),
          // Finished but not in the library yet: try again every 15 minutes.
          and(eq(downloads.state, 'done'), eq(downloads.adopted, false), isNull(downloads.importedAt), or(isNull(downloads.importTriedAt), lt(downloads.importTriedAt, now() - IMPORT_RETRY_MS))),
          // In the library and still sharing: watch the seeding rule.
          and(eq(downloads.state, 'done'), eq(downloads.adopted, false), isNotNull(downloads.importedAt)),
        ),
      )
      .all();
    if (!qbit || rows.length === 0) {
      this.lastCheck = now();
      return { replaced: 0 };
    }
    const settings = readDownloader(db);
    const found = new Map((await qbit.torrents(rows.map((r) => r.infoHash))).map((t) => [t.hash, t]));
    this.lastCheck = now();
    let replaced = 0;
    for (const row of rows) {
      const t = found.get(row.infoHash);
      if (!t) {
        if (row.qbitState !== 'gone') db.update(downloads).set({ qbitState: 'gone', checkedAt: now() }).where(eq(downloads.id, row.id)).run();
        if (row.state === 'done' && row.importedAt) {
          db.update(downloads).set({ state: 'removed', message: 'Removed from qBittorrent. The library file stays.' }).where(eq(downloads.id, row.id)).run();
        } else if (row.state === 'done') {
          db.update(downloads)
            .set({ importError: 'It was removed from qBittorrent before Marquee could put it in your library. Search again from the title’s page.', importTriedAt: now() })
            .where(eq(downloads.id, row.id))
            .run();
        }
        continue;
      }
      if (row.state === 'done') {
        db.update(downloads).set({ savePath: t.savePath, qbitState: t.state, ratio: t.ratio, seedingSeconds: t.seedingSeconds, checkedAt: now() }).where(eq(downloads.id, row.id)).run();
        if (!row.importedAt) await this.putInLibrary(row.id);
        else {
          if (row.scanPending && now() - (row.scanTriedAt ?? 0) >= IMPORT_RETRY_MS) await this.tellServers(row.id);
          await this.checkSharing(row.id, qbit);
        }
        continue;
      }
      const moved = t.progress > row.progress + 0.0001;
      const resting = RESTING.has(t.state);
      const done = t.progress >= 1 || FINISHED.has(t.state);
      db.update(downloads)
        .set({
          qbitState: t.state,
          progress: t.progress,
          speed: t.downloadSpeed,
          eta: t.eta,
          seeds: Math.max(t.seedsConnected, t.seedsKnown),
          savePath: t.savePath,
          checkedAt: now(),
          // Waiting, paused and checking don't count towards "stuck".
          lastProgressAt: moved || resting ? now() : row.lastProgressAt ?? row.addedAt,
          ...(done ? { state: 'done' as const, finishedAt: now() } : row.state === 'sent' ? { state: 'downloading' as const } : {}),
        })
        .where(eq(downloads.id, row.id))
        .run();
      if (done && !row.adopted) await this.putInLibrary(row.id);
      if (done || row.adopted) continue;

      // Fakes show in the file list as soon as qBittorrent has it.
      if (!row.filesChecked && t.state !== 'metaDL' && t.state !== 'forcedMetaDL') {
        const files = await qbit.files(t.hash);
        if (files.length) {
          db.update(downloads).set({ filesChecked: true }).where(eq(downloads.id, row.id)).run();
          const fake = fakeReason(files);
          if (fake && settings.tryAnother) {
            await this.tryAnother(row.id, fake, null).catch((e) => console.error('[downloads] try another failed:', (e as Error).message));
            replaced++;
            continue;
          }
          if (fake) db.update(downloads).set({ message: fake }).where(eq(downloads.id, row.id)).run();
        }
      }

      const since = moved || resting ? now() : row.lastProgressAt ?? row.addedAt;
      if (settings.tryAnother && now() - since >= settings.giveUpHours * HOUR) {
        const h = Math.floor((now() - since) / HOUR);
        await this.tryAnother(row.id, `No progress for ${h} hours.`, null).catch((e) => console.error('[downloads] try another failed:', (e as Error).message));
        replaced++;
      }
    }
    return { replaced };
  }

  private row(id: number): Download {
    const row = this.deps.db.select().from(downloads).where(eq(downloads.id, id)).get();
    if (!row) throw new HttpError(404, 'not_found', 'No such download.');
    return row;
  }

  private controllable(row: Download): QbitApi {
    if (row.adopted) throw new HttpError(409, 'not_ours', 'Another app sent this download, so Marquee leaves it alone. Change it in that app or in qBittorrent.');
    const qbit = this.qbit();
    if (!qbit) throw new HttpError(409, 'no_downloader', 'Connect qBittorrent first, in Settings → Downloader.');
    return qbit;
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof QbitError) throw new HttpError(502, 'downloader_failed', `${DOWNLOADER_TEXT[err.kind === 'error' ? 'error' : err.kind].label}: ${err.message}`);
      throw err;
    }
  }

  async pause(id: number): Promise<DownloadActionResult> {
    const row = this.row(id);
    const qbit = this.controllable(row);
    await this.call(() => qbit.pause(row.infoHash));
    this.deps.db.update(downloads).set({ qbitState: 'stoppedDL', lastProgressAt: this.deps.now() }).where(eq(downloads.id, id)).run();
    return { message: 'Paused.', next: null };
  }

  async resume(id: number): Promise<DownloadActionResult> {
    const row = this.row(id);
    const qbit = this.controllable(row);
    await this.call(() => qbit.resume(row.infoHash));
    this.deps.db.update(downloads).set({ qbitState: 'downloading', lastProgressAt: this.deps.now() }).where(eq(downloads.id, id)).run();
    return { message: 'Carrying on.', next: null };
  }

  /**
   * Puts a finished download in the library (see importer.ts). Records what
   * happened on the download; never throws for an import problem.
   */
  async putInLibrary(id: number): Promise<DownloadActionResult> {
    const { db, now } = this.deps;
    const row = this.row(id);
    if (row.state !== 'done' || row.adopted) throw new HttpError(409, 'not_finished', row.adopted ? 'Another app sent this download, so that app puts it in your library.' : 'It hasn’t finished downloading yet.');
    if (row.importedAt) return { message: 'It’s already in your library.', next: null };
    const qbit = this.qbit();
    if (!qbit) throw new HttpError(409, 'no_downloader', 'Connect qBittorrent first, in Settings → Downloader.');
    try {
      const files = await this.call(() => qbit.files(row.infoHash));
      const r = await importDownload(db, row, files, now());
      db.update(downloads)
        .set({ importedAt: now(), importedPaths: JSON.stringify(r.paths), importCopied: r.copied, importError: null, importTriedAt: now(), scanPending: true })
        .where(eq(downloads.id, id))
        .run();
      const told = await this.tellServers(id);
      return { message: `In your library: ${r.paths.map((p) => p.split('/').at(-1)).join(', ')}.${told ? ` ${told}` : ''}`, next: null };
    } catch (err) {
      if (!(err instanceof ImportError) && !(err instanceof HttpError)) throw err;
      db.update(downloads).set({ importError: err.message, importTriedAt: now() }).where(eq(downloads.id, id)).run();
      return { message: `Couldn't put it in your library: ${err.message}`, next: null };
    }
  }

  /**
   * Asks Plex and Jellyfin to scan the folders a download went into. A server
   * that doesn't answer is asked again every 15 minutes for a day.
   */
  async tellServers(id: number): Promise<string> {
    const { db, now } = this.deps;
    const row = this.row(id);
    const paths = row.importedPaths ? (JSON.parse(row.importedPaths) as string[]) : [];
    const r = await tellMediaServers(db, this.deps.clients, row.kind, paths.map((p) => path.dirname(p)));
    const tooLong = now() - (row.importedAt ?? now()) > 24 * HOUR;
    const message = [r.told.length ? `Told ${r.told.join(' and ')} to scan it.` : null, ...r.failed].filter(Boolean).join(' ') || null;
    db.update(downloads)
      .set({ scanPending: r.failed.length > 0 && !tooLong, scanMessage: message, scanTriedAt: now() })
      .where(eq(downloads.id, id))
      .run();
    return message ?? '';
  }

  /** Marks a download "done sharing" when it meets its rule, and removes it from qBittorrent if that's turned on. */
  private async checkSharing(id: number, qbit: QbitApi): Promise<void> {
    const { db, now } = this.deps;
    const row = this.row(id);
    const rule = seedRule(db, row);
    if (!sharedEnough(rule, row.ratio ?? 0, row.seedingSeconds ?? 0)) return;
    if (!row.sharedEnoughAt) db.update(downloads).set({ sharedEnoughAt: now() }).where(eq(downloads.id, id)).run();
    if (!readDownloader(db).removeWhenShared) return;
    const deleteFiles = await this.libraryFilesThere(row);
    await qbit.remove(row.infoHash, deleteFiles);
    const what = deleteFiles ? 'Removed from qBittorrent with the download’s files; the library file stays.' : 'Removed from qBittorrent. Its files were kept because Marquee couldn’t find the library file.';
    db.update(downloads).set({ state: 'removed', message: `Done sharing (${sharingProgress(rule, row.ratio ?? 0, row.seedingSeconds ?? 0)}). ${what}` }).where(eq(downloads.id, id)).run();
  }

  /** Every library file this download became is still on disk, so deleting the download's own files is safe. */
  private async libraryFilesThere(row: Download): Promise<boolean> {
    const paths = row.importedPaths ? (JSON.parse(row.importedPaths) as string[]) : [];
    if (!paths.length) return false;
    const found = await Promise.all(paths.map((p) => fs.stat(p).then(() => true, () => false)));
    return found.every(Boolean);
  }

  /** Stops following a download; removes it from qBittorrent (and its files, if asked) when Marquee sent it. */
  async remove(id: number, deleteFiles: boolean): Promise<DownloadActionResult> {
    const row = this.row(id);
    if (row.adopted) {
      this.deps.db.update(downloads).set({ state: 'removed', message: 'Marquee stopped following it. It’s still in qBittorrent.' }).where(eq(downloads.id, id)).run();
      return { message: 'Marquee stopped following it. It’s still in qBittorrent, for the app that sent it.', next: null };
    }
    const qbit = this.qbit();
    if (row.importedAt) deleteFiles = deleteFiles && (await this.libraryFilesThere(row));
    if (qbit && row.qbitState !== 'gone') await this.call(() => qbit.remove(row.infoHash, deleteFiles));
    const what = row.importedAt
      ? deleteFiles
        ? 'Removed from qBittorrent with the download’s files. The library file stays.'
        : 'Removed from qBittorrent. The download’s files are still in the download folder.'
      : deleteFiles
        ? 'Removed from qBittorrent with its files.'
        : 'Removed from qBittorrent. Its files are still in the download folder.';
    this.deps.db.update(downloads).set({ state: 'removed', message: what }).where(eq(downloads.id, id)).run();
    return { message: what, next: null };
  }

  /**
   * Turns this copy down for the title (with the reason), removes it from
   * qBittorrent with its files, and sends the next best copy if there is one.
   */
  async tryAnother(id: number, reason: string, userId: number | null): Promise<DownloadActionResult> {
    const { db, now } = this.deps;
    const row = this.row(id);
    if (row.state !== 'sent' && row.state !== 'downloading') throw new HttpError(409, 'not_active', 'This download isn’t on the way any more.');
    const qbit = this.controllable(row);
    db.insert(neverPick)
      .values({ kind: row.kind, movieId: row.movieId, seriesId: row.seriesId, infoHash: row.infoHash, title: row.title, reason, at: now() })
      .run();
    if (row.qbitState !== 'gone') await this.call(() => qbit.remove(row.infoHash, true));
    db.update(downloads).set({ state: 'failed', message: reason }).where(eq(downloads.id, id)).run();

    const target: SearchTarget =
      row.kind === 'movie'
        ? { kind: 'movie', movieId: row.movieId! }
        : { kind: 'tv', seriesId: row.seriesId!, season: row.season ?? undefined, episode: row.episodes ? (JSON.parse(row.episodes) as number[])[0] : undefined };
    if ((row.kind === 'movie' && !row.movieId) || (row.kind === 'tv' && !row.seriesId)) {
      return { message: `Turned that copy down (${reason}) The title is no longer in your library, so nothing else was sent.`, next: null };
    }
    const found = await searchTitle({ db, sources: this.deps.sources, now }, target);
    const pick = bestPick(found.search);
    if (pick === null) {
      const note = `${reason} No other copy suits ${found.profile.name} right now. Search again later, or pick one yourself.`;
      db.update(downloads).set({ message: note }).where(eq(downloads.id, id)).run();
      return { message: `Turned that copy down. No other copy suits ${found.profile.name} right now; search again later, or pick one yourself.`, next: null };
    }
    const sent = await sendFromSearch({ db, now, qbittorrent: this.deps.clients.qbittorrent, fetchTorrent: this.deps.clients.fetchTorrent }, found.search, pick, userId ?? row.requestedBy, false);
    db.update(downloads).set({ message: `${reason} Replaced by ${sent.download.title}.` }).where(eq(downloads.id, id)).run();
    return { message: `Turned that copy down and sent the next best: ${sent.download.title}.`, next: sent.download };
  }
}

/** One monitor per database, so the page and the background check share "last checked". */
const monitors = new WeakMap<Db, DownloadMonitor>();
export function sharedMonitor(deps: MonitorDeps): DownloadMonitor {
  let m = monitors.get(deps.db);
  if (!m) monitors.set(deps.db, (m = new DownloadMonitor(deps)));
  return m;
}
