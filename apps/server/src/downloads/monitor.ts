import { tell, type NotifyDeps } from '../notify/service.js';
import type { Vars } from '../notify/template.js';
import { posterUrl } from '../notify/vars.js';
import { markReady, tellNewEpisodes } from '../requests/service.js';
import path from 'node:path';
import { and, eq, inArray, isNotNull, isNull, or, lt } from 'drizzle-orm';
import fs from 'node:fs/promises';
import type { DownloadActionResult, DownloadDetails, DownloadsView } from '@marquee/shared';
import type { Db } from '../db/index.js';
import { downloads, movies, neverPick, series, type Download } from '../db/schema.js';
import { HttpError, type Clients } from '../http.js';
import type { SourceService } from '../sources/service.js';
import { QbitError, type QbitApi, type QbitFile, type QbitTorrent } from './qbittorrent.js';
import { bestPick, searchTitle } from './search.js';
import { sendFromSearch } from './send.js';
import { DOWNLOADER_TEXT, mapPath, readDownloader } from './service.js';
import { ALL_STOPPED_NOTE, FINISHED, HELD_NOTES, NO_INTERNET_NOTE, RESTING, describeDownload } from './view.js';
import type { SearchTarget } from './cache.js';
import { ImportError, cantSee, exists, importDownload, videoFiles, type ImportResult } from './importer.js';
import { DAMAGED_PROBLEMS, FAKE_PROBLEMS, UnpackError, filesUnder, lookInside, needsUnpacking, rarSets, sevenZip, unpackText, type Unpacker } from './unpack.js';
import { recordHistory } from './history.js';
import { noRoomReason } from '../system/disk.js';
import { seedRule, sharedEnough, sharingProgress } from './seeding.js';
import { tellMediaServers } from '../library/mediaServers.js';

/**
 * Follows Marquee's downloads in qBittorrent: progress, finished, gone,
 * stuck, and fakes (programs, or archives with no video inside). When a
 * download is stuck for too long or looks fake, it turns that copy down for
 * the title ("Never pick"), removes it from qBittorrent and sends the next
 * best copy. A copy that comes packed in .rar files is unpacked when it
 * finishes (unpack.ts), then put in the library. Everything that happens
 * goes in the History (history.ts).
 *
 * Downloads Marquee adopted from another app (say Radarr) are only watched:
 * Marquee never pauses, removes or replaces them.
 */

const HOUR = 3_600_000;
const FOLLOWED = ['sent', 'downloading'] as const;
/** "Try another copy" picks from a search for the same title this recent, rather than searching again. */
export const REUSE_SEARCH_MS = 3 * HOUR;
/** A failed import is tried again this often. */
export const IMPORT_RETRY_MS = 15 * 60_000;

export interface MonitorDeps {
  db: Db;
  clients: Pick<Clients, 'qbittorrent' | 'fetchTorrent' | 'plexServer' | 'jellyfin' | 'disk' | 'unpacker'>;
  sources: SourceService;
  now: () => number;
  /** Tells people about finished, imported and problem downloads (and what they asked for being ready). */
  notify?: NotifyDeps;
}

const PROGRAMS = /\.(exe|bat|cmd|scr|lnk|msi|com|vbs|ps1|jar|apk|dmg|pif)$/i;
const VIDEO = /\.(mkv|mp4|m4v|avi|ts|m2ts|wmv|mov|webm|mpg|mpeg)$/i;
const ARCHIVE = /\.(rar|zip|7z|r\d\d|\d\d\d)$/i;

/**
 * Says why a torrent's file list looks fake, or null if it looks like real
 * video (or isn't known yet). A .rar set is fine: it's unpacked when it
 * finishes, and what's inside is checked then.
 */
export function fakeReason(files: QbitFile[]): string | null {
  if (files.length === 0) return null;
  const program = files.find((f) => PROGRAMS.test(f.name));
  if (program) return `It holds a program (${path.basename(program.name)}), which is never a real movie or episode.`;
  if (files.some((f) => VIDEO.test(f.name))) return null;
  if (rarSets(files).some((set) => set.first !== null)) return null;
  if (files.some((f) => ARCHIVE.test(f.name))) return 'It only holds archives that aren’t a .rar set, and no video. Real copies almost never do; this is usually a fake.';
  return 'There’s no video in it.';
}

/** The folder Marquee unpacks a download's .rar files into, next to the download (as Marquee sees it). */
export const UNPACK_FOLDER = '.marquee-unpacked';
export function unpackFolder(db: Db, row: Download): string | null {
  if (!row.savePath) return null;
  return path.join(mapPath(row.savePath, readDownloader(db).folderPairs), UNPACK_FOLDER, String(row.id));
}

/** Removes a download's unpack folder (and the parent, once it's empty). Only ever Marquee's own folder. */
async function clearUnpackFolder(dir: string | null): Promise<void> {
  if (!dir || path.basename(path.dirname(dir)) !== UNPACK_FOLDER) return;
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  await fs.rmdir(path.dirname(dir)).catch(() => {});
}

let defaultUnpacker: Unpacker | null = null;

/** The swarm and sharing numbers saved on each check, for the Downloads table. */
const swarm = (t: QbitTorrent) => ({
  uploadSpeed: t.uploadSpeed ?? null,
  peers: t.peersConnected === undefined ? null : Math.max(t.peersConnected, t.peersKnown ?? 0),
  uploaded: t.uploaded ?? null,
});

/** A tracker's host name only: tracker addresses often carry a private key in the path. */
export function trackerHost(tracker: string | undefined): string | null {
  if (!tracker) return null;
  try {
    return new URL(tracker).hostname || null;
  } catch {
    return null;
  }
}

export class DownloadMonitor {
  private lastCheck = 0;
  /** Unpacks running now, by download id. */
  private readonly unpacks = new Map<number, Promise<void>>();
  constructor(private readonly deps: MonitorDeps) {}

  private unpacker(): Unpacker {
    return this.deps.clients.unpacker ?? (defaultUnpacker ??= sevenZip());
  }

  /** Resolves once every unpack started so far has finished (and gone in the library, or failed). */
  async unpacksDone(): Promise<void> {
    while (this.unpacks.size) await Promise.allSettled([...this.unpacks.values()]);
  }

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
    const hold = await this.connectionHold(qbit, rows, found, settings.stuckHours);
    this.lastCheck = now();
    let replaced = 0;
    for (const row of rows) {
      const t = found.get(row.infoHash);
      if (!t) {
        if (row.qbitState !== 'gone') db.update(downloads).set({ qbitState: 'gone', checkedAt: now() }).where(eq(downloads.id, row.id)).run();
        if (row.state === 'done' && row.importedAt) {
          const message = 'Removed from qBittorrent. The library file stays.';
          db.update(downloads).set({ state: 'removed', message }).where(eq(downloads.id, row.id)).run();
          recordHistory(db, 'removed', row, now(), { detail: 'Removed in qBittorrent. The library file stays.' });
        } else if (row.state === 'done' && !this.unpacks.has(row.id)) {
          const importError = 'It was removed from qBittorrent before Marquee could put it in your library. Search again from the title’s page.';
          if (row.importError !== importError) recordHistory(db, 'import_failed', row, now(), { detail: importError });
          db.update(downloads).set({ importError, importTriedAt: now(), unpackState: null }).where(eq(downloads.id, row.id)).run();
        }
        continue;
      }
      if (row.state === 'done') {
        db.update(downloads)
          .set({ savePath: t.savePath, qbitState: t.state, ratio: t.ratio, seedingSeconds: t.seedingSeconds, ...swarm(t), checkedAt: now() })
          .where(eq(downloads.id, row.id))
          .run();
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
      // While the connection is the trouble, the stuck clock stands still. From the check where the hold began
      // (time before it counts as usual), it moves on by the time since the last check.
      const held = hold !== null && !moved && !resting && !done;
      const wasHeld = HELD_NOTES.has(row.message ?? '');
      const shift = held && wasHeld && row.checkedAt ? Math.max(0, now() - row.checkedAt) : 0;
      const lastProgressAt = moved || resting ? now() : (row.lastProgressAt ?? row.addedAt) + shift;
      const message = held ? hold : wasHeld ? null : row.message;
      db.update(downloads)
        .set({
          qbitState: t.state,
          progress: t.progress,
          speed: t.downloadSpeed,
          eta: t.eta,
          seeds: Math.max(t.seedsConnected, t.seedsKnown),
          ...swarm(t),
          ratio: t.ratio,
          savePath: t.savePath,
          checkedAt: now(),
          // Waiting, paused and checking don't count towards "stuck", nor does time the connection is down.
          lastProgressAt,
          message,
          ...(done ? { state: 'done' as const, finishedAt: now() } : row.state === 'sent' ? { state: 'downloading' as const } : {}),
        })
        .where(eq(downloads.id, row.id))
        .run();
      if (done && !row.adopted) {
        this.tell('download_finished', this.vars(row));
        await this.putInLibrary(row.id);
      }
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

      if (settings.tryAnother && !held && now() - lastProgressAt >= settings.giveUpHours * HOUR) {
        const h = Math.floor((now() - lastProgressAt) / HOUR);
        await this.tryAnother(row.id, `No progress for ${h} hours.`, null).catch((e) => console.error('[downloads] try another failed:', (e as Error).message));
        replaced++;
      }
    }
    return { replaced };
  }

  /**
   * Why stuck downloads shouldn't count right now, or null. qBittorrent saying
   * it has no internet, or every download on the way (two or more) stopped
   * for the stuck time at once, means the connection is down (a VPN like
   * gluetun can fail without qBittorrent noticing), not the copies: replacing
   * them would turn good copies down and throw away what they'd fetched.
   */
  private async connectionHold(qbit: QbitApi, rows: Download[], found: Map<string, QbitTorrent>, stuckHours: number): Promise<string | null> {
    const connection = await qbit.connection().catch(() => 'connected' as const);
    if (connection === 'disconnected') return NO_INTERNET_NOTE;
    const now = this.deps.now();
    const onTheWay = rows.flatMap((r) => {
      const t = found.get(r.infoHash);
      if (!t || (r.state !== 'sent' && r.state !== 'downloading')) return [];
      if (RESTING.has(t.state) || t.progress >= 1 || FINISHED.has(t.state)) return [];
      return [{ r, t }];
    });
    const allStopped =
      onTheWay.length >= 2 && onTheWay.every(({ r, t }) => t.progress <= r.progress + 0.0001 && now - (r.lastProgressAt ?? r.addedAt) >= stuckHours * HOUR);
    return allStopped ? ALL_STOPPED_NOTE : null;
  }

  /** Tells the admins (inbox and push). Never holds up the monitor. */
  private tell(event: string, vars: Vars, link: string | null = '/downloads'): void {
    tell(this.deps.notify, 'admins', event, { vars, link });
  }

  /** The facts about a download for its messages: the copy's name, and the title and cover art when it's in the library. */
  private vars(row: Download): Vars {
    const { db } = this.deps;
    const t = row.movieId
      ? db.select({ title: movies.title, posterPath: movies.posterPath }).from(movies).where(eq(movies.id, row.movieId)).get()
      : row.seriesId
        ? db.select({ title: series.title, posterPath: series.posterPath }).from(series).where(eq(series.id, row.seriesId)).get()
        : undefined;
    return { release: row.title, title: t?.title ?? row.title, poster: posterUrl(t?.posterPath) };
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

  /** Everything qBittorrent says about one download right now, finished or not. Never throws for qBittorrent trouble. */
  async details(id: number): Promise<DownloadDetails> {
    const row = this.row(id);
    const qbit = this.qbit();
    if (!qbit) return { id, live: null, note: 'qBittorrent isn’t set up, so there’s nothing more to show. Add it in Settings → Downloader.' };
    try {
      const [t] = await qbit.torrents([row.infoHash]);
      if (!t) return { id, live: null, note: 'qBittorrent doesn’t have this one any more, so there’s nothing more to show. The library file, if any, stays.' };
      const files = await qbit.files(row.infoHash).catch(() => [] as QbitFile[]);
      return {
        id,
        note: null,
        live: {
          savePath: t.savePath,
          contentPath: t.contentPath,
          category: t.category || null,
          tags: t.tags ?? [],
          tracker: trackerHost(t.tracker),
          size: t.size,
          progress: t.progress,
          downloaded: t.downloaded ?? null,
          uploaded: t.uploaded ?? null,
          ratio: t.ratio,
          downloadSpeed: t.downloadSpeed,
          uploadSpeed: t.uploadSpeed ?? 0,
          eta: t.eta < 8640000 ? t.eta : null,
          seedsConnected: t.seedsConnected,
          seedsKnown: t.seedsKnown,
          peersConnected: t.peersConnected ?? 0,
          peersKnown: t.peersKnown ?? 0,
          addedAt: t.addedOn ?? null,
          completedAt: t.completedOn ?? null,
          activeSeconds: t.activeSeconds ?? null,
          seedingSeconds: t.seedingSeconds,
          files: files.map((f) => ({ name: f.name, size: f.size, progress: f.progress ?? null })),
        },
      };
    } catch (err) {
      if (!(err instanceof QbitError)) throw err;
      const text = DOWNLOADER_TEXT[err.kind === 'error' ? 'error' : err.kind];
      return { id, live: null, note: `qBittorrent: ${text.label}. ${text.fix ?? ''}`.trim() };
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
   * Puts a finished download in the library (see importer.ts), unpacking it
   * first when it came as .rar files. Records what happened on the download
   * and in the History; never throws for an import problem. `byHand` (the
   * Try again button) also retries a damaged .rar set, which Marquee
   * otherwise leaves until you've had a look.
   */
  async putInLibrary(id: number, byHand = false): Promise<DownloadActionResult> {
    const row = this.row(id);
    if (row.state !== 'done' || row.adopted) throw new HttpError(409, 'not_finished', row.adopted ? 'Another app sent this download, so that app puts it in your library.' : 'It hasn’t finished downloading yet.');
    if (row.importedAt) return { message: 'It’s already in your library.', next: null };
    const qbit = this.qbit();
    if (!qbit) throw new HttpError(409, 'no_downloader', 'Connect qBittorrent first, in Settings → Downloader.');
    try {
      const files = await this.call(() => qbit.files(row.infoHash));
      if (needsUnpacking(files, videoFiles(files))) return await this.unpackThenImport(row, files, byHand);
      const r = await importDownload(this.deps.db, row, files, this.deps.now(), undefined, this.deps.clients.disk);
      return await this.imported(row, r);
    } catch (err) {
      if (!(err instanceof ImportError) && !(err instanceof HttpError)) throw err;
      return this.importFailed(row, err.message);
    }
  }

  /** Records a download that went in the library, tells people, and asks Plex and Jellyfin to scan. */
  private async imported(row: Download, r: ImportResult): Promise<DownloadActionResult> {
    const { db, now } = this.deps;
    const id = row.id;
    db.update(downloads)
      .set({ importedAt: now(), importedPaths: JSON.stringify(r.paths), importCopied: r.copied, importUnpacked: r.unpacked, importError: null, importTriedAt: now(), scanPending: true })
      .where(eq(downloads.id, id))
      .run();
    const names = r.paths.map((p) => p.split('/').at(-1)).join(', ');
    const how = [
      r.unpacked ? 'Unpacked from .rar files, so the library file is its own file, not a hardlink.' : null,
      r.copied ? 'Copied, not linked: the download folder and the library are on different disks.' : null,
      r.replaced.length ? `The file it replaced (${r.replaced.map((p) => path.basename(p)).join(', ')}) is kept in the library’s .marquee-replaced folder.` : null,
      r.extras.length ? `${r.extras.length === 1 ? 'A subtitle file came' : `${r.extras.length} subtitle files came`} along with it.` : null,
    ].filter(Boolean);
    recordHistory(db, r.replaced.length ? 'upgraded' : 'in_library', row, now(), { detail: how.join(' ') || null });
    const told = await this.tellServers(id);
    const link = row.kind === 'movie' && row.movieId ? `/movies/${row.movieId}` : row.seriesId ? `/shows/${row.seriesId}` : '/downloads';
    // A copy that replaced one already there is an upgrade; otherwise it's new to the library.
    this.tell(r.replaced.length ? 'upgraded' : 'imported', { ...this.vars(row), files: names }, link);
    if (this.deps.notify) {
      if (!r.replaced.length) tellNewEpisodes({ db, notify: this.deps.notify, now }, row);
      markReady({ db, notify: this.deps.notify, now });
    }
    return { message: `In your library: ${names}.${told ? ` ${told}` : ''}`, next: null };
  }

  /** Records why a download couldn't go in the library (told to admins and added to the History once per new reason). */
  private importFailed(row: Download, message: string): DownloadActionResult {
    const { db, now } = this.deps;
    if (!row.importError) this.tell('download_problem', { ...this.vars(row), problem: 'Couldn’t put a download in the library', reason: message });
    if (row.importError !== message) recordHistory(db, 'import_failed', row, now(), { detail: message });
    db.update(downloads).set({ importError: message, importTriedAt: now() }).where(eq(downloads.id, row.id)).run();
    return { message: `Couldn't put it in your library: ${message}`, next: null };
  }

  /**
   * A finished copy that's only .rar files: looks inside first (a fake is
   * turned down), checks there's room, then unpacks it in the background
   * into Marquee's own folder next to the download and puts the result in
   * the library. The download itself is left as it is, so it keeps sharing.
   */
  private async unpackThenImport(row: Download, files: QbitFile[], byHand: boolean): Promise<DownloadActionResult> {
    const { db, now } = this.deps;
    const dir = unpackFolder(db, row);
    if (!dir) throw new ImportError('qBittorrent hasn’t said where it saved this download yet. Marquee tries again shortly.');
    if (this.unpacks.has(row.id)) return { message: 'Still unpacking it. It goes in your library when that’s done.', next: null };
    if (row.unpackState === 'unpacked' && (await exists(dir))) return this.importUnpacked(row, dir);
    if (row.unpackState === 'broken' && !byHand && row.importError) return { message: `Couldn't put it in your library: ${row.importError}`, next: null };

    const settings = readDownloader(db);
    const local = mapPath(row.savePath!, settings.folderPairs);
    const sets = rarSets(files);
    const first = sets.find((x) => x.first)!.first!;
    if (!(await exists(path.join(local, first)))) throw new ImportError(cantSee(path.join(local, first), row.savePath!, settings.folderPairs.length > 0));
    let plan;
    try {
      plan = await lookInside(sets, local, dir, this.unpacker());
      const noRoom = await noRoomReason(db, 'downloads', plan.bytes, this.deps.clients.disk);
      if (noRoom) throw new UnpackError('no_room', `${noRoom} Marquee tries again by itself.`);
    } catch (err) {
      if (!(err instanceof UnpackError)) throw err;
      return this.unpackFailed(row, err);
    }
    db.update(downloads).set({ unpackState: 'unpacking', unpackStartedAt: now(), importError: null, importTriedAt: now() }).where(eq(downloads.id, row.id)).run();
    const unpacker = this.unpacker();
    const job = (async () => {
      try {
        await fs.rm(dir, { recursive: true, force: true });
        for (const set of plan.sets) await unpacker.extract(set.archive, set.into);
      } catch (err) {
        await clearUnpackFolder(dir);
        this.unpacks.delete(row.id); // so a fake found while unpacking can be turned down
        const e = err instanceof UnpackError ? err : new UnpackError('failed', unpackText('failed', (err as Error).message));
        await this.unpackFailed(this.row(row.id), e);
        return;
      }
      db.update(downloads).set({ unpackState: 'unpacked' }).where(eq(downloads.id, row.id)).run();
      const latest = this.row(row.id);
      // Removed or replaced while it was unpacking: nothing more to do.
      if (latest.state !== 'done' || latest.importedAt) return clearUnpackFolder(dir);
      await this.importUnpacked(latest, dir);
    })()
      .catch((err) => console.error('[downloads] unpacking failed:', (err as Error).message))
      .finally(() => this.unpacks.delete(row.id));
    this.unpacks.set(row.id, job);
    return { message: 'It came packed in .rar files, so Marquee is unpacking it. It goes in your library when that’s done.', next: null };
  }

  /** Puts what was unpacked in the library, then removes the unpack folder. */
  private async importUnpacked(row: Download, dir: string): Promise<DownloadActionResult> {
    try {
      const r = await importDownload(this.deps.db, row, await filesUnder(dir), this.deps.now(), undefined, this.deps.clients.disk, { folder: dir });
      await clearUnpackFolder(dir);
      return await this.imported(row, r);
    } catch (err) {
      if (!(err instanceof ImportError)) throw err;
      return this.importFailed(row, err.message);
    }
  }

  /** A fake is turned down (another copy is sent if that's on); damage waits for you; anything else is tried again by itself. */
  private async unpackFailed(row: Download, err: UnpackError): Promise<DownloadActionResult> {
    const { db } = this.deps;
    if (FAKE_PROBLEMS.has(err.kind)) {
      db.update(downloads).set({ unpackState: null }).where(eq(downloads.id, row.id)).run();
      if (readDownloader(db).tryAnother) return this.tryAnother(row.id, err.message, null);
      return this.importFailed({ ...row, unpackState: null }, `${err.message} Press Try another copy.`);
    }
    db.update(downloads).set({ unpackState: DAMAGED_PROBLEMS.has(err.kind) ? 'broken' : 'failed' }).where(eq(downloads.id, row.id)).run();
    return this.importFailed(row, err.message);
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
    const message = `Done sharing (${sharingProgress(rule, row.ratio ?? 0, row.seedingSeconds ?? 0)}). ${what}`;
    db.update(downloads).set({ state: 'removed', message }).where(eq(downloads.id, id)).run();
    recordHistory(db, 'removed', row, now(), { detail: message });
    await clearUnpackFolder(unpackFolder(db, row));
  }

  /** Every library file this download became is still on disk, so deleting the download's own files is safe. */
  private async libraryFilesThere(row: Download): Promise<boolean> {
    const paths = row.importedPaths ? (JSON.parse(row.importedPaths) as string[]) : [];
    if (!paths.length) return false;
    const found = await Promise.all(paths.map((p) => fs.stat(p).then(() => true, () => false)));
    return found.every(Boolean);
  }

  /** Stops following a download; removes it from qBittorrent (and its files, if asked) when Marquee sent it. */
  async remove(id: number, deleteFiles: boolean, userId: number | null = null): Promise<DownloadActionResult> {
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
    recordHistory(this.deps.db, 'removed', row, this.deps.now(), { detail: what, userId });
    await clearUnpackFolder(unpackFolder(this.deps.db, row));
    return { message: what, next: null };
  }

  /**
   * Turns this copy down for the title (with the reason), removes it from
   * qBittorrent with its files, and sends the next best copy if there is one.
   */
  async tryAnother(id: number, reason: string, userId: number | null): Promise<DownloadActionResult> {
    const { db, now } = this.deps;
    const row = this.row(id);
    if (!canTryAnother(row)) throw new HttpError(409, 'not_active', row.importedAt ? 'This copy is already in your library. Search again from the title’s page to find a better one.' : 'This download isn’t on the way any more.');
    if (this.unpacks.has(id)) throw new HttpError(409, 'unpacking', 'Marquee is unpacking this copy right now. Wait for that to finish, then try again.');
    const qbit = this.controllable(row);
    db.insert(neverPick)
      .values({ kind: row.kind, movieId: row.movieId, seriesId: row.seriesId, infoHash: row.infoHash, title: row.title, reason, at: now() })
      .run();
    if (row.qbitState !== 'gone') await this.call(() => qbit.remove(row.infoHash, true));
    db.update(downloads).set({ state: 'failed', message: reason }).where(eq(downloads.id, id)).run();
    recordHistory(db, 'replaced', row, now(), { detail: reason, userId });
    await clearUnpackFolder(unpackFolder(db, row));
    this.tell('download_problem', { ...this.vars(row), problem: 'Tried another copy', reason });

    const target: SearchTarget =
      row.kind === 'movie'
        ? { kind: 'movie', movieId: row.movieId! }
        : { kind: 'tv', seriesId: row.seriesId!, season: row.season ?? undefined, episode: row.episodes ? (JSON.parse(row.episodes) as number[])[0] : undefined };
    if ((row.kind === 'movie' && !row.movieId) || (row.kind === 'tv' && !row.seriesId)) {
      return { message: `Turned that copy down (${reason}) The title is no longer in your library, so nothing else was sent.`, next: null };
    }
    // The copies a search brought back in the last few hours are reused, so Sources (and their daily limits)
    // aren't asked again; only when none of those suits is there a fresh search.
    let found = await searchTitle({ db, sources: this.deps.sources, now }, target, { reuseWithinMs: REUSE_SEARCH_MS });
    let pick = bestPick(found.search);
    if (pick === null && found.reused) {
      found = await searchTitle({ db, sources: this.deps.sources, now }, target);
      pick = bestPick(found.search);
    }
    if (pick === null) {
      const note = `${reason} No other copy suits ${found.profile.name} right now. Search again later, or pick one yourself.`;
      db.update(downloads).set({ message: note }).where(eq(downloads.id, id)).run();
      return { message: `Turned that copy down. No other copy suits ${found.profile.name} right now; search again later, or pick one yourself.`, next: null };
    }
    const sent = await sendFromSearch({ db, now, qbittorrent: this.deps.clients.qbittorrent, fetchTorrent: this.deps.clients.fetchTorrent, disk: this.deps.clients.disk }, found.search, pick, userId ?? row.requestedBy, false);
    db.update(downloads).set({ message: `${reason} Replaced by ${sent.download.title}.` }).where(eq(downloads.id, id)).run();
    return { message: `Turned that copy down and sent the next best: ${sent.download.title}.`, next: sent.download };
  }
}

/** On the way, or finished without making it into the library: "Try another copy" can turn it down. */
export function canTryAnother(row: Download): boolean {
  if (row.adopted) return false;
  return row.state === 'sent' || row.state === 'downloading' || (row.state === 'done' && !row.importedAt);
}

/** One monitor per database, so the page and the background check share "last checked". */
const monitors = new WeakMap<Db, DownloadMonitor>();
export function sharedMonitor(deps: MonitorDeps): DownloadMonitor {
  let m = monitors.get(deps.db);
  if (!m) monitors.set(deps.db, (m = new DownloadMonitor(deps)));
  return m;
}
