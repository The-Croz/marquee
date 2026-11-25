import fs from 'node:fs/promises';
import path from 'node:path';
import { eq, inArray, isNotNull } from 'drizzle-orm';
import type { CleanupResult, ReconcileGroupKey, ReconcileTorrent, ReconcileView } from '@marquee/shared';
import type { Db } from '../db/index.js';
import { downloads, mediaFiles, movies, series, type Download } from '../db/schema.js';
import { HttpError } from '../http.js';
import { recordHistory } from '../downloads/history.js';
import type { QbitApi, QbitTorrent } from '../downloads/qbittorrent.js';
import { seedRule, sharedEnough, type SeedRule } from '../downloads/seeding.js';
import { mapPath, readDownloader } from '../downloads/service.js';
import { size } from '../system/disk.js';
import { libraryRoots } from './services.js';

/**
 * Clean up → In qBittorrent: every torrent in every category, sorted by
 * whether it still earns its place. A torrent "feeds" a library title when
 * one of its files is the same file on disk as a library file (a hardlink:
 * same device and inode). Worked out on demand, kept 10 minutes (each
 * finished torrent's file list is one call to qBittorrent). Never removes
 * anything by itself; Remove only takes what it lists, checked again.
 */

const KEEP_MS = 10 * 60_000;
const CHUNK = 200;
const AT_ONCE = 8;

export interface ReconcileDeps {
  db: Db;
  now: () => number;
  qbit: () => QbitApi | null;
}

const GROUPS: { key: ReconcileGroupKey; label: string; explain: string }[] = [
  { key: 'missing', label: 'Files missing', explain: 'qBittorrent has the torrent, but its files aren’t where it expects them. Removing it from qBittorrent tidies the list; there are no files to delete.' },
  { key: 'stuck', label: 'Stuck or errored', explain: 'An error in qBittorrent, or no progress for longer than your stuck time (Settings → Downloader). Remove it with its files, or for one Marquee follows, Try another copy on the Downloads page.' },
  { key: 'orphan', label: 'Not in your library', explain: 'Finished, but nothing in your library uses its files, so they only take room. Removing it with its files gives the space back.' },
  { key: 'done', label: 'Done sharing', explain: 'In your library and past its sharing rule. Removing it with its files keeps the library copy (it’s a hardlink) and stops sharing.' },
  { key: 'sharing', label: 'Still sharing', explain: 'In your library and still sharing under its rule. Nothing to do.' },
  { key: 'downloading', label: 'Downloading', explain: 'On its way. Nothing to do.' },
];

const PLAIN: Record<string, string> = {
  downloading: 'Downloading',
  forcedDL: 'Downloading',
  metaDL: 'Getting its file list',
  forcedMetaDL: 'Getting its file list',
  stalledDL: 'Waiting · nobody is sharing it',
  pausedDL: 'Paused',
  stoppedDL: 'Paused',
  queuedDL: 'Waiting in line',
  checkingDL: 'Checking its files',
  checkingUP: 'Checking its files',
  checkingResumeData: 'Checking its files',
  moving: 'Moving',
  uploading: 'Sharing',
  forcedUP: 'Sharing',
  stalledUP: 'Finished · sharing when asked',
  pausedUP: 'Finished · paused',
  stoppedUP: 'Finished · paused',
  queuedUP: 'Finished · waiting in line',
  error: 'Problem in qBittorrent',
  missingFiles: 'Files missing',
};

/** Who sent it: Marquee (its own download), else a guess from the category and tags. */
function sentBy(t: QbitTorrent, row: Download | undefined): string {
  if (row && !row.adopted) return 'Marquee';
  const hint = `${t.category} ${(t.tags ?? []).join(' ')}`.toLowerCase();
  if (hint.includes('radarr')) return 'Radarr';
  if (hint.includes('sonarr')) return 'Sonarr';
  if (hint.includes('lidarr') || hint.includes('readarr')) return 'Another app';
  return t.category ? `Another app (${t.category})` : 'Another app';
}

async function inChunks<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += n) out.push(...(await Promise.all(items.slice(i, i + n).map(fn))));
  return out;
}

/** dev:inode → the library title that file belongs to. */
async function libraryIndex(db: Db): Promise<Map<string, { name: string; href: string }>> {
  const files = db.select({ path: mediaFiles.path, movieId: mediaFiles.movieId, seriesId: mediaFiles.seriesId }).from(mediaFiles).all();
  const movieIds = [...new Set(files.map((f) => f.movieId).filter((x): x is number => !!x))];
  const showIds = [...new Set(files.map((f) => f.seriesId).filter((x): x is number => !!x))];
  const mv = new Map(movieIds.length ? db.select().from(movies).where(inArray(movies.id, movieIds)).all().map((m) => [m.id, m]) : []);
  const sh = new Map(showIds.length ? db.select().from(series).where(inArray(series.id, showIds)).all().map((s) => [s.id, s]) : []);
  const index = new Map<string, { name: string; href: string }>();
  await inChunks(files, 50, async (f) => {
    const st = await fs.stat(f.path).catch(() => null);
    if (!st) return;
    const t = f.movieId ? mv.get(f.movieId) : f.seriesId ? sh.get(f.seriesId) : undefined;
    if (!t) return;
    index.set(`${st.dev}:${st.ino}`, { name: t.year ? `${t.title} (${t.year})` : t.title, href: f.movieId ? `/movies/${t.id}` : `/shows/${t.id}` });
  });
  return index;
}

const kept = new WeakMap<Db, { at: number; view: ReconcileView }>();

export async function reconcileView(deps: ReconcileDeps, opts: { fresh?: boolean } = {}): Promise<ReconcileView> {
  const { db, now } = deps;
  const hit = kept.get(db);
  if (!opts.fresh && hit && now() - hit.at < KEEP_MS) return hit.view;
  const view = await build(deps);
  if (view.ok) kept.set(db, { at: now(), view });
  return view;
}

/** Forgets the kept answer (after removing something). */
export function forgetReconcile(db: Db): void {
  kept.delete(db);
}

async function build(deps: ReconcileDeps): Promise<ReconcileView> {
  const { db, now } = deps;
  const none = (problem: string): ReconcileView => ({ ok: false, problem, checkedAt: now(), total: 0, groups: [] });
  const qbit = deps.qbit();
  if (!qbit) return none('Connect qBittorrent first (Settings → Downloader).');
  const settings = readDownloader(db);
  let list: QbitTorrent[];
  try {
    const all = await qbit.allTorrents();
    list = [];
    for (let i = 0; i < all.length; i += CHUNK) list.push(...(await qbit.torrents(all.slice(i, i + CHUNK).map((t) => t.hash))));
  } catch (err) {
    return none(`Marquee couldn’t ask qBittorrent (${(err as Error).message}), so it lists nothing rather than guess. It tries again when you open this.`);
  }
  const pairs = settings.folderPairs;
  const local = (p: string) => path.resolve(mapPath(p, pairs));
  const exists = await inChunks(list, 50, async (t) => !!(await fs.stat(local(t.contentPath)).catch(() => null)));
  // If Marquee can see none of qBittorrent's files, the folders don't line up: everything would look missing.
  if (list.length && !exists.some(Boolean)) {
    return none(`Marquee can’t see any of qBittorrent’s ${list.length} torrents’ files where qBittorrent says they are, so its folders don’t line up with Marquee’s. Add a folder pair in Settings → Downloader → For experts; until then Marquee lists nothing.`);
  }

  const rows = db.select().from(downloads).where(isNotNull(downloads.infoHash)).all();
  const rowFor = new Map<string, Download>();
  for (const r of rows) if (r.state !== 'removed' || !rowFor.has(r.infoHash)) rowFor.set(r.infoHash, r);
  const index = await libraryIndex(db);
  const defaultRule: SeedRule = { ratio: settings.seedRatio, days: settings.seedDays, from: 'the default rule' };
  const stuckMs = settings.stuckHours * 3_600_000;

  const items = await inChunks(list.map((t, i) => ({ t, there: exists[i]! })), AT_ONCE, async ({ t, there }): Promise<ReconcileTorrent> => {
    const row = rowFor.get(t.hash);
    const finished = t.progress >= 1;
    // Each file: is it the library's (same inode), and would removing it free room?
    let freed = 0;
    let feeds: { name: string; href: string } | null = null;
    let sawFiles = false;
    if (there) {
      for (const f of await qbit.files(t.hash).catch(() => [])) {
        const st = await fs.stat(local(path.posix.join(t.savePath, f.name))).catch(() => null);
        if (!st) continue;
        sawFiles = true;
        if (st.nlink <= 1) freed += st.size;
        feeds ??= index.get(`${st.dev}:${st.ino}`) ?? null;
      }
    }
    if (!feeds && row?.importedAt && (row.movieId || row.seriesId)) {
      // A copied (not linked) import still counts as feeding its title.
      const t2 = row.movieId ? db.select().from(movies).where(eq(movies.id, row.movieId)).get() : db.select().from(series).where(eq(series.id, row.seriesId!)).get();
      if (t2 && row.importCopied) feeds = { name: t2.year ? `${t2.title} (${t2.year})` : t2.title, href: row.movieId ? `/movies/${t2.id}` : `/shows/${t2.id}` };
    }
    const isPrivate = t.isPrivate ?? null;
    const rule = row ? seedRule(db, row) : isPrivate && settings.privateKeepSharing ? { ratio: 0, days: 0, from: 'a private site' } : defaultRule;
    let group: ReconcileGroupKey;
    // An unfinished torrent may have nothing on disk yet; only a finished one with its files gone is missing.
    if (t.state === 'missingFiles' || (!there && finished)) group = 'missing';
    else if (t.state === 'error' || (!finished && (t.state === 'stalledDL' || t.state === 'metaDL') && t.addedOn && now() - t.addedOn > stuckMs)) group = 'stuck';
    else if (!finished) group = 'downloading';
    else if (!feeds) group = 'orphan';
    else if (sharedEnough(rule, t.ratio, t.seedingSeconds)) group = 'done';
    else group = 'sharing';
    return {
      hash: t.hash,
      name: t.name,
      status: PLAIN[t.state] ?? 'In qBittorrent',
      group,
      sentBy: sentBy(t, row),
      followed: !!row && row.state !== 'removed',
      feeds,
      sizeBytes: t.size,
      freedBytes: sawFiles ? freed : 0,
      progress: t.progress,
      ratio: t.ratio,
      sharingDays: Math.floor(t.seedingSeconds / 86_400),
      rule: rule.ratio || rule.days ? [rule.ratio ? `ratio ${rule.ratio}` : null, rule.days ? `${rule.days} days` : null].filter(Boolean).join(' or ') + ` (${rule.from})` : `keeps sharing (${rule.from})`,
      isPrivate,
      addedAt: t.addedOn ?? null,
      inLibraryFolder: insideLibrary(db, local(t.contentPath)),
    };
  });
  return {
    ok: true,
    problem: null,
    checkedAt: now(),
    total: items.length,
    groups: GROUPS.map((g) => ({ ...g, items: items.filter((i) => i.group === g.key).sort((a, b) => b.freedBytes - a.freedBytes || a.name.localeCompare(b.name)), freedBytes: items.filter((i) => i.group === g.key).reduce((n, i) => n + i.freedBytes, 0) })),
  };
}

/** Torrents saved straight into the library folders: deleting their files would delete the library copy. */
function insideLibrary(db: Db, p: string): boolean {
  const r = libraryRoots(db);
  return [r.movies, r.tv].some((root) => p === path.resolve(root) || p.startsWith(`${path.resolve(root)}/`));
}

/**
 * Removes chosen torrents from qBittorrent, with their files when asked.
 * Only what the view lists right now; never with files for a torrent saved
 * inside the library folders. Downloads Marquee sent go through its own
 * Remove (which checks the library copy first); the rest straight to qBittorrent.
 */
export async function removeTorrents(
  deps: ReconcileDeps & { removeFollowed: (downloadId: number, deleteFiles: boolean) => Promise<void> },
  hashes: string[],
  deleteFiles: boolean,
  userId: number | null,
): Promise<CleanupResult & { bytes: number }> {
  const { db, now } = deps;
  const view = await reconcileView(deps, { fresh: true });
  if (!view.ok) throw new HttpError(409, 'downloader_unknown', view.problem!);
  const listed = new Map(view.groups.flatMap((g) => g.items).map((i) => [i.hash, i]));
  const stray = hashes.find((h) => !listed.has(h));
  if (stray) throw new HttpError(409, 'torrents_changed', 'qBittorrent’s list changed since you looked. Check again, then choose.');
  if (deleteFiles) {
    const risky = hashes.map((h) => listed.get(h)!).find((t) => t.inLibraryFolder);
    if (risky) throw new HttpError(409, 'in_library_folder', `${risky.name} is saved inside your library folder, so deleting its files would delete the library copy. Remove it without its files.`);
  }
  const qbit = deps.qbit();
  const problems: string[] = [];
  let done = 0;
  let bytes = 0;
  for (const h of hashes) {
    const t = listed.get(h)!;
    const row = db.select().from(downloads).where(eq(downloads.infoHash, h)).all().find((r) => r.state !== 'removed');
    try {
      if (row && !row.adopted) await deps.removeFollowed(row.id, deleteFiles);
      else {
        if (!qbit) throw new Error('qBittorrent isn’t connected');
        await qbit.remove(h, deleteFiles);
        if (row) {
          const what = `Removed from qBittorrent${deleteFiles ? ' with its files' : ''}, by hand from Clean up.`;
          db.update(downloads).set({ state: 'removed', message: what }).where(eq(downloads.id, row.id)).run();
          recordHistory(db, 'removed', row, now(), { detail: what, userId });
        }
      }
      done++;
      if (deleteFiles) bytes += t.freedBytes;
    } catch (err) {
      problems.push(`${t.name}: ${(err as Error).message}`);
    }
  }
  forgetReconcile(db);
  const message = done ? `Removed ${done} from qBittorrent${deleteFiles ? `, with ${done === 1 ? 'its' : 'their'} files (about ${size(bytes)} back)` : ''}.` : 'Nothing was removed.';
  return { done, problems, message, bytes };
}
