import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import type { RemovalInput, RemovalPreview, RemovalResult } from '@marquee/shared';
import type { Db } from '../db/index.js';
import { downloads, history, leftOut, mediaFiles, movies, requests, series, users, type Download } from '../db/schema.js';
import { HttpError, type Deps } from '../http.js';
import { recordHistory } from '../downloads/history.js';
import { sharedMonitor } from '../downloads/monitor.js';
import { describeDownload } from '../downloads/view.js';
import { size } from '../system/disk.js';
import { REPLACED_FOLDER } from '../downloads/importer.js';
import { subtitlesBeside } from './extras.js';
import { tellMediaServers } from './mediaServers.js';
import { libraryRoots } from './services.js';

/**
 * "Remove from Marquee": Marquee forgets a title. That never touches disk.
 * Deleting its files is a separate choice, made by hand behind a confirm that
 * names every file; only those exact files are deleted, and a folder only
 * goes when it's empty afterwards. "Don't add it back when scanning" puts it
 * on the left-out list, which you can undo.
 */

type Kind = 'movie' | 'series';

interface Title {
  id: number;
  tmdbId: number;
  title: string;
  year: number | null;
  path: string | null;
}

function load(db: Db, kind: Kind, id: number): Title {
  const row = kind === 'movie' ? db.select().from(movies).where(eq(movies.id, id)).get() : db.select().from(series).where(eq(series.id, id)).get();
  if (!row) throw new HttpError(404, 'not_found', kind === 'movie' ? 'That movie isn’t in your library.' : 'That show isn’t in your library.');
  return row;
}

const owner = (kind: Kind, id: number) => (kind === 'movie' ? eq(mediaFiles.movieId, id) : eq(mediaFiles.seriesId, id));
const dlOwner = (kind: Kind, id: number) => (kind === 'movie' ? eq(downloads.movieId, id) : eq(downloads.seriesId, id));
const onTheWay = or(inArray(downloads.state, ['sent', 'downloading']), and(eq(downloads.state, 'done'), isNull(downloads.importedAt)));

/** The library files Marquee knows for a title, with the subtitles beside each: what "delete its files" means. */
async function titleFiles(db: Db, kind: Kind, id: number): Promise<{ path: string; sizeBytes: number }[]> {
  const roots = libraryRoots(db);
  const root = kind === 'movie' ? roots.movies : roots.tv;
  const videos = db.select({ path: mediaFiles.path, size: mediaFiles.size }).from(mediaFiles).where(owner(kind, id)).all();
  const perDir = new Map<string, number>();
  for (const v of videos) perDir.set(path.dirname(v.path), (perDir.get(path.dirname(v.path)) ?? 0) + 1);
  const out = new Map<string, number>();
  for (const v of videos) {
    if (!inside(v.path, root)) continue;
    out.set(v.path, v.size);
    for (const s of await subtitlesBeside(v.path, perDir.get(path.dirname(v.path)) === 1)) {
      const st = await fs.stat(s).catch(() => null);
      if (st) out.set(s, st.size);
    }
  }
  return [...out].map(([p, n]) => ({ path: p, sizeBytes: n })).sort((a, b) => a.path.localeCompare(b.path));
}

/** Under the library folder, and not in the replaced folder (that's emptied separately). */
function inside(p: string, root: string): boolean {
  const rel = path.relative(root, p);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && rel.split(path.sep)[0] !== REPLACED_FOLDER;
}

export async function removalPreview(db: Db, kind: Kind, id: number, now: number): Promise<RemovalPreview> {
  const t = load(db, kind, id);
  const files = await titleFiles(db, kind, id);
  const dls = db.select().from(downloads).where(and(dlOwner(kind, id), onTheWay)).all();
  const sharing = db.select({ id: downloads.id }).from(downloads).where(and(dlOwner(kind, id), eq(downloads.state, 'done'), isNotNull(downloads.importedAt))).all().length;
  const asked = db
    .select({ name: users.displayName })
    .from(requests)
    .leftJoin(users, eq(users.id, requests.requestedBy))
    .where(and(eq(requests.kind, kind), eq(requests.titleId, id)))
    .all()
    .map((r) => r.name ?? 'Someone no longer here');
  return {
    kind,
    title: t.year ? `${t.title} (${t.year})` : t.title,
    files,
    totalBytes: files.reduce((n, f) => n + f.sizeBytes, 0),
    folder: t.path,
    onTheWay: dls.map((d) => ({ id: d.id, copy: d.title, status: describeDownload(db, d, now).status.label })),
    sharing,
    requests: [...new Set(asked)],
  };
}

/** Removes empty folders from `dir` upwards, stopping at the library folder. */
export async function pruneEmpty(dir: string, root: string): Promise<void> {
  let d = dir;
  while (inside(d, root)) {
    const left = await fs.readdir(d).catch(() => null);
    if (left === null) {
      d = path.dirname(d);
      continue;
    }
    if (left.length) return;
    await fs.rmdir(d).catch(() => {});
    d = path.dirname(d);
  }
}

/** Removes every empty folder inside `dir` (deepest first), then `dir` itself if it's empty too. */
export async function pruneTree(dir: string, root: string): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) if (e.isDirectory()) await pruneTree(path.join(dir, e.name), root);
  await pruneEmpty(dir, root);
}

export async function removeTitle(deps: Deps, kind: Kind, id: number, input: RemovalInput, userId: number): Promise<RemovalResult> {
  const { db, now } = deps;
  const t = load(db, kind, id);
  const name = t.year ? `${t.title} (${t.year})` : t.title;
  const roots = libraryRoots(db);
  const root = kind === 'movie' ? roots.movies : roots.tv;
  const problems: string[] = [];

  // Deleting files: only ever exactly what the confirm showed.
  let toDelete: { path: string; sizeBytes: number }[] = [];
  if (input.deleteFiles) {
    const files = await titleFiles(db, kind, id);
    const shown = new Set(input.deleteFiles);
    if (files.length !== shown.size || files.some((f) => !shown.has(f.path))) {
      throw new HttpError(409, 'files_changed', 'The files changed since you looked. Open Remove again to see the list as it is now.');
    }
    toDelete = files;
  }

  // Downloads on the way: stop them, plainly.
  const monitor = sharedMonitor({ db, clients: deps.clients, sources: deps.sources, now });
  const dls = db.select().from(downloads).where(and(dlOwner(kind, id), onTheWay)).all();
  for (const d of dls) {
    if (input.onTheWay === 'remove' && !d.adopted) {
      try {
        await monitor.remove(d.id, true, userId);
        continue;
      } catch (err) {
        problems.push(`Couldn’t remove ${d.title} from qBittorrent (${(err as Error).message}) Marquee stopped following it; remove it in qBittorrent yourself.`);
      }
    }
    stopFollowing(db, d, name, now(), userId);
  }

  // Delete the files (each one by name), then any folder left empty.
  const deleted: string[] = [];
  for (const f of toDelete) {
    try {
      await fs.unlink(f.path);
      deleted.push(f.path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') deleted.push(f.path);
      else problems.push(`Couldn’t delete ${f.path} (${code === 'EACCES' || code === 'EPERM' ? 'Marquee isn’t allowed to: check the PUID and PGID in the container settings' : (code ?? (err as Error).message)}).`);
    }
  }
  for (const dir of new Set(deleted.map((p) => path.dirname(p)))) await pruneEmpty(dir, root);
  const folderLeft = t.path && toDelete.length ? await fs.stat(t.path).then(() => true, () => false) : false;

  const freed = toDelete.filter((f) => deleted.includes(f.path)).reduce((n, f) => n + f.sizeBytes, 0);
  const parts = [
    toDelete.length ? `Removed from Marquee and deleted ${deleted.length} ${deleted.length === 1 ? 'file' : 'files'} (${size(freed)}).` : 'Removed from Marquee. Its files were left on disk.',
    folderLeft ? `The folder ${t.path} stays because other files are in it.` : null,
    input.leaveOut ? 'Left out of library scans.' : null,
  ].filter(Boolean);
  db.insert(history)
    .values({ at: now(), event: 'title_removed', kind: kind === 'movie' ? 'movie' : 'tv', movieId: kind === 'movie' ? id : null, seriesId: kind === 'series' ? id : null, title: name, detail: parts.join(' '), userId })
    .run();

  if (input.leaveOut) {
    db.insert(leftOut)
      .values({ kind, tmdbId: t.tmdbId, title: t.title, year: t.year, path: t.path, at: now(), userId })
      .onConflictDoUpdate({ target: [leftOut.kind, leftOut.tmdbId], set: { path: t.path, at: now(), userId } })
      .run();
  }
  // Requests go too, so the title can be asked for again.
  db.delete(requests).where(and(eq(requests.kind, kind), eq(requests.titleId, id))).run();
  if (kind === 'movie') db.delete(movies).where(eq(movies.id, id)).run();
  else db.delete(series).where(eq(series.id, id)).run();

  let told = '';
  if (deleted.length) {
    const r = await tellMediaServers(db, deps.clients, kind === 'movie' ? 'movie' : 'tv', [t.path ?? path.dirname(deleted[0]!)]);
    if (r.told.length) told = ` Told ${r.told.join(' and ')}.`;
    problems.push(...r.failed);
  }
  return { message: `${name}: ${parts.join(' ')}${told}`, deleted, problems };
}

function stopFollowing(db: Db, d: Download, name: string, at: number, userId: number): void {
  const message = `Marquee stopped following it when ${name} was removed. It’s still in qBittorrent.`;
  db.update(downloads).set({ state: 'removed', message }).where(eq(downloads.id, d.id)).run();
  recordHistory(db, 'removed', d, at, { detail: message, userId });
}

/** The left-out list, newest first. */
export function leftOutList(db: Db) {
  return db
    .select({ l: leftOut, who: users.displayName })
    .from(leftOut)
    .leftJoin(users, eq(users.id, leftOut.userId))
    .all()
    .sort((a, b) => b.l.at - a.l.at)
    .map(({ l, who }) => ({ id: l.id, kind: l.kind, tmdbId: l.tmdbId, title: l.title, year: l.year, path: l.path, at: l.at, who: who ?? null }));
}
