import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { CleanupDownloadsView, CleanupResult, CopyGroup, SetAsideItem, SetAsideView, UntrackedFile } from '@marquee/shared';
import type { Db } from '../db/index.js';
import { history, leftOut, mediaFiles, movies, scanItems, series } from '../db/schema.js';
import { HttpError } from '../http.js';
import { REPLACED_FOLDER, setAside } from '../downloads/importer.js';
import type { QbitApi } from '../downloads/qbittorrent.js';
import { mapPath, readDownloader } from '../downloads/service.js';
import { ProfileService, type FullProfile } from '../releases/profiles.js';
import { judgeFile } from '../releases/upgrade.js';
import { downloadsFolder } from '../system/disk.js';
import { EXTRAS_FOLDERS, VIDEO_EXTENSIONS } from './parse.js';
import { libraryRoots } from './services.js';

/**
 * Library → Clean up: what takes room for nothing, found on demand and never
 * changed by itself.
 *
 * - **Two copies of one title**: a movie, or an episode, with more than one
 *   video file. The best copy by the title's profile is marked to keep.
 * - **Set aside**: every file in the hidden `.marquee-replaced` folders (the
 *   recycle bin), one by one, to put back or delete for good.
 * - **Downloads nobody uses**: whatever in the downloads folder no torrent in
 *   qBittorrent points at (every category, so Radarr's and Sonarr's count).
 *   Only listed while qBittorrent answers, so nothing looks unused by mistake.
 * - **Library files with no title**: video files Marquee doesn't count as
 *   any title's, with why.
 *
 * Getting rid of something only ever **sets it aside** (an instant move on
 * the same disk, which can be undone). Deleting happens in the recycle bin,
 * by hand, behind a confirm. The server only moves what it would list itself.
 */

type Root = 'movies' | 'tv' | 'downloads';
const ROOT_LABEL: Record<Root, string> = { movies: 'Movies', tv: 'TV', downloads: 'Downloads' };

export interface CleanupDeps {
  db: Db;
  now: () => number;
  /** qBittorrent, or null when it isn't set up. */
  qbit: () => QbitApi | null;
}

const inside = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);
const hidden = (rel: string) => rel.split('/').some((s) => s.startsWith('.'));

function roots(db: Db): Record<Root, string> {
  const r = libraryRoots(db);
  return { movies: path.resolve(r.movies), tv: path.resolve(r.tv), downloads: path.resolve(downloadsFolder(db)) };
}

/** The size of a file or folder, and what removing it would free (files with another hardlink free nothing). */
async function measure(p: string): Promise<{ bytes: number; freedBytes: number; files: number }> {
  const st = await fs.lstat(p).catch(() => null);
  if (!st) return { bytes: 0, freedBytes: 0, files: 0 };
  if (st.isFile()) return { bytes: st.size, freedBytes: st.nlink <= 1 ? st.size : 0, files: 1 };
  if (!st.isDirectory()) return { bytes: 0, freedBytes: 0, files: 0 };
  const out = { bytes: 0, freedBytes: 0, files: 0 };
  for (const e of await fs.readdir(p).catch(() => [] as string[])) {
    const m = await measure(path.join(p, e));
    out.bytes += m.bytes;
    out.freedBytes += m.freedBytes;
    out.files += m.files;
  }
  return out;
}

const isSample = (name: string, size: number) => /(^|[ ._-])sample([ ._-]|$)/i.test(name) && size < 400 * 1024 * 1024;

/** Video files under a library folder (hidden and extras folders skipped, like the scan). */
async function videosUnder(dir: string, depth = 4): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth > 0 && !EXTRAS_FOLDERS.has(e.name.toLowerCase())) out.push(...(await videosUnder(p, depth - 1)));
    } else if (e.isFile() && VIDEO_EXTENSIONS.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- two copies of one title

const pad = (n: number) => String(n).padStart(2, '0');
const quality = (f: { resolution: string | null; source: string | null; hdr: string | null; codec: string | null; releaseGroup: string | null }) =>
  [f.resolution, f.source, f.hdr, f.codec, f.releaseGroup].filter(Boolean).join(' · ') || null;

export async function copyGroups(deps: CleanupDeps): Promise<CopyGroup[]> {
  const { db, now } = deps;
  const r = roots(db);
  const profiles = new ProfileService(db, now);
  const cache = new Map<string, FullProfile>();
  const profile = (k: 'movie' | 'tv', key: string) => {
    if (!cache.has(`${k}:${key}`)) cache.set(`${k}:${key}`, profiles.forTitle(k, key));
    return cache.get(`${k}:${key}`)!;
  };
  type F = typeof mediaFiles.$inferSelect;
  const groups: { kind: 'movie' | 'series'; titleId: number; label: string; href: string; files: F[]; judge: (f: F) => ReturnType<typeof judgeFile> }[] = [];

  const movieFiles = db.select().from(mediaFiles).where(isNotNull(mediaFiles.movieId)).all();
  const byMovie = new Map<number, F[]>();
  for (const f of movieFiles) byMovie.set(f.movieId!, [...(byMovie.get(f.movieId!) ?? []), f]);
  const twice = [...byMovie].filter(([, fs]) => fs.length > 1);
  const movieRows = new Map(twice.length ? db.select().from(movies).where(inArray(movies.id, twice.map(([id]) => id))).all().map((m) => [m.id, m]) : []);
  for (const [id, files] of twice) {
    const m = movieRows.get(id);
    if (!m) continue;
    const wanted = { kind: 'movie' as const, title: m.title, year: m.year, tmdbId: m.tmdbId, imdbId: m.imdbId, runtime: m.runtime };
    groups.push({ kind: 'movie', titleId: id, label: m.year ? `${m.title} (${m.year})` : m.title, href: `/movies/${id}`, files, judge: (f) => judgeFile(wanted, f.path, profile('movie', m.profile)) });
  }

  // Episodes: files that cover the same episode go together (a two-episode file joins both).
  const showFiles = db.select().from(mediaFiles).where(isNotNull(mediaFiles.seriesId)).all();
  const byEpisode = new Map<string, F[]>();
  for (const f of showFiles) for (const e of JSON.parse(f.episodes ?? '[]') as number[]) byEpisode.set(`${f.seriesId}:${f.season}:${e}`, [...(byEpisode.get(`${f.seriesId}:${f.season}:${e}`) ?? []), f]);
  const merged: F[][] = [];
  for (const fs of byEpisode.values()) {
    if (fs.length < 2) continue;
    const hit = merged.find((g) => g.some((x) => fs.some((y) => y.id === x.id)));
    if (!hit) merged.push([...fs]);
    else for (const f of fs) if (!hit.some((x) => x.id === f.id)) hit.push(f);
  }
  const showIds = [...new Set(merged.map((g) => g[0]!.seriesId!))];
  const shows = new Map(showIds.length ? db.select().from(series).where(inArray(series.id, showIds)).all().map((s) => [s.id, s]) : []);
  for (const files of merged) {
    const s = shows.get(files[0]!.seriesId!);
    if (!s) continue;
    const season = files[0]!.season ?? 0;
    const eps = [...new Set(files.flatMap((f) => JSON.parse(f.episodes ?? '[]') as number[]))].sort((a, b) => a - b);
    const where = `S${pad(season)}E${pad(eps[0]!)}${eps.length > 1 ? `–E${pad(eps.at(-1)!)}` : ''}`;
    const wanted = { kind: 'tv' as const, title: s.title, year: s.year, tmdbId: s.tmdbId, imdbId: s.imdbId, tvdbId: s.tvdbId, season, runtime: null };
    groups.push({ kind: 'series', titleId: s.id, label: `${s.title} · ${where}`, href: `/shows/${s.id}`, files, judge: (f) => judgeFile(wanted, f.path, profile('tv', s.profile)) });
  }

  const rank = (j: { tierRank: number | null }) => (j.tierRank === null || j.tierRank < 0 ? Infinity : j.tierRank);
  const out: CopyGroup[] = [];
  for (const g of groups) {
    const root = g.kind === 'movie' ? r.movies : r.tv;
    const files = await Promise.all(
      g.files.map(async (f) => {
        const st = await fs.stat(f.path).catch(() => null);
        const j = g.judge(f);
        return { f, j, st };
      }),
    );
    const present = files.filter((x) => x.st);
    if (present.length < 2) continue;
    // Sharper picture first (a profile may not list an old 4K encode, but nobody wants it swapped for a 720p), then the profile's order, then size.
    const res = (f: F) => Number(/(\d{3,4})p/.exec(f.resolution ?? '')?.[1] ?? 0);
    const best = [...present].sort((a, b) => res(b.f) - res(a.f) || rank(a.j) - rank(b.j) || b.j.score - a.j.score || b.f.size - a.f.size || b.f.addedAt - a.f.addedAt)[0]!;
    out.push({
      key: `${g.kind}:${g.titleId}:${present.map((x) => x.f.id).join(',')}`,
      kind: g.kind,
      titleId: g.titleId,
      title: g.label,
      href: g.href,
      files: present.map(({ f, j, st }) => ({
        path: f.path,
        name: path.basename(f.path),
        folder: path.relative(root, path.dirname(f.path)) || '.',
        sizeBytes: st!.size,
        shared: st!.nlink > 1,
        addedAt: f.addedAt,
        quality: quality(f) ?? j.qualityLabel,
        judged: j.qualityLabel,
        best: f.id === best.f.id,
      })),
    });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

// ---------------------------------------------------------------- set aside (the recycle bin)

function binFolders(db: Db): { root: Root; base: string; bin: string }[] {
  const r = roots(db);
  return (['movies', 'tv', 'downloads'] as Root[]).map((k) => ({ root: k, base: r[k], bin: path.join(r[k], REPLACED_FOLDER) }));
}

/** The movie or show a library path belongs to (by its folder), if any. */
function titleAt(db: Db, root: Root, original: string, base: string): { kind: 'movie' | 'tv'; id: number; name: string; href: string } | null {
  if (root === 'downloads') return null;
  const top = original.slice(base.length + 1).split('/')[0];
  if (!top) return null;
  const folder = path.join(base, top);
  if (root === 'movies') {
    const m = db.select().from(movies).where(eq(movies.path, folder)).get();
    return m ? { kind: 'movie', id: m.id, name: m.year ? `${m.title} (${m.year})` : m.title, href: `/movies/${m.id}` } : null;
  }
  const s = db.select().from(series).where(eq(series.path, folder)).get();
  return s ? { kind: 'tv', id: s.id, name: s.year ? `${s.title} (${s.year})` : s.title, href: `/shows/${s.id}` } : null;
}

/** What's in the bin, file by file, newest first. */
export async function setAsideView(db: Db): Promise<SetAsideView> {
  const items: SetAsideItem[] = [];
  for (const f of binFolders(db)) {
    const walk = async (dir: string): Promise<void> => {
      for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(dir, e.name);
        const original = path.join(f.base, path.relative(f.bin, p)).replace(/\.\d{13}$/, '');
        if (e.isDirectory()) {
          await walk(p);
          continue;
        }
        if (!e.isFile()) continue;
        const st = await fs.stat(p).catch(() => null);
        if (!st) continue;
        const m = await measure(p);
        const t = titleAt(db, f.root, original, f.base);
        items.push({
          path: p,
          name: e.name.replace(/\.\d{13}$/, ''),
          root: f.root,
          rootLabel: ROOT_LABEL[f.root],
          originalPath: original,
          originalFolder: path.relative(f.base, path.dirname(original)) || '.',
          sizeBytes: m.bytes,
          freedBytes: m.freedBytes,
          setAsideAt: Math.round(st.ctimeMs),
          title: t ? { name: t.name, href: t.href } : null,
          canPutBack: !(await fs.stat(original).catch(() => null)),
        });
      }
    };
    await walk(f.bin);
  }
  items.sort((a, b) => b.setAsideAt - a.setAsideAt || a.path.localeCompare(b.path));
  return { items, bytes: items.reduce((n, i) => n + i.sizeBytes, 0), freedBytes: items.reduce((n, i) => n + i.freedBytes, 0) };
}

function inBin(db: Db, p: string): { root: Root; base: string; bin: string } {
  const abs = path.resolve(p);
  const f = binFolders(db).find((b) => abs.startsWith(`${b.bin}/`));
  if (!f || abs.includes('/../')) throw new HttpError(400, 'invalid_input', 'That isn’t in a set-aside folder.');
  return f;
}

const fsProblem = (p: string, err: unknown) => {
  const code = (err as NodeJS.ErrnoException).code;
  return `${path.basename(p)}: ${code === 'EACCES' || code === 'EPERM' ? 'Marquee isn’t allowed to (check the PUID and PGID in the container settings)' : code === 'EXDEV' ? 'it’s on a different disk' : (code ?? (err as Error).message)}.`;
};

/** Removes folders left empty under `dir` (up to, not including, `stop`). */
async function pruneEmpty(dir: string, stop: string): Promise<void> {
  let d = dir;
  while (d !== stop && d.startsWith(`${stop}/`)) {
    if ((await fs.readdir(d).catch(() => ['x'])).length) return;
    await fs.rmdir(d).catch(() => null);
    d = path.dirname(d);
  }
}

function record(db: Db, event: 'set_aside' | 'put_back' | 'deleted', t: { kind: 'movie' | 'tv'; id: number; name: string } | null, detail: string, at: number, userId: number | null) {
  if (!t) return;
  db.insert(history).values({ at, event, kind: t.kind, movieId: t.kind === 'movie' ? t.id : null, seriesId: t.kind === 'tv' ? t.id : null, title: t.name, detail, userId }).run();
}

/** Moves set-aside things back where they were. The next scan counts library files again. */
export async function putBack(db: Db, paths: string[], at: number, userId: number | null): Promise<CleanupResult & { library: ('movie' | 'tv')[] }> {
  const problems: string[] = [];
  let moved = 0;
  const library = new Set<'movie' | 'tv'>();
  for (const p of paths) {
    const f = inBin(db, p);
    const original = path.join(f.base, path.relative(f.bin, path.resolve(p))).replace(/\.\d{13}$/, '');
    if (await fs.stat(original).catch(() => null)) {
      problems.push(`${path.basename(original)}: there’s already a file where it was.`);
      continue;
    }
    try {
      await fs.mkdir(path.dirname(original), { recursive: true });
      await fs.rename(p, original);
      await pruneEmpty(path.dirname(p), f.bin);
      moved++;
      if (f.root !== 'downloads') library.add(f.root === 'movies' ? 'movie' : 'tv');
      record(db, 'put_back', titleAt(db, f.root, original, f.base), `${path.basename(original)} is back in ${path.relative(f.base, path.dirname(original)) || 'the library folder'}.`, at, userId);
    } catch (err) {
      problems.push(fsProblem(p, err));
    }
  }
  return { done: moved, problems, message: moved ? `Put ${moved} back.${library.size ? ' Marquee scans the library so it counts again.' : ''}` : 'Nothing was put back.', library: [...library] };
}

/** Deletes set-aside things for good. Only ever by hand, behind a confirm. */
export async function deleteForGood(db: Db, paths: string[], at: number, userId: number | null): Promise<CleanupResult & { bytes: number }> {
  const problems: string[] = [];
  let done = 0;
  let bytes = 0;
  for (const p of paths) {
    const f = inBin(db, p);
    const original = path.join(f.base, path.relative(f.bin, path.resolve(p))).replace(/\.\d{13}$/, '');
    const m = await measure(p);
    try {
      await fs.rm(p, { recursive: true });
      await pruneEmpty(path.dirname(p), f.bin);
      done++;
      bytes += m.freedBytes;
      record(db, 'deleted', titleAt(db, f.root, original, f.base), `Deleted ${path.basename(original)} from the set-aside folder.`, at, userId);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      problems.push(fsProblem(p, err));
    }
  }
  return { done, problems, bytes, message: done ? `Deleted ${done} for good.` : 'Nothing was deleted.' };
}

// ---------------------------------------------------------------- downloads nobody uses

export async function unusedDownloads(deps: CleanupDeps): Promise<CleanupDownloadsView> {
  const { db } = deps;
  const folder = roots(db).downloads;
  const none = (problem: string): CleanupDownloadsView => ({ ok: false, problem, folder, items: [] });
  const qbit = deps.qbit();
  if (!qbit) return none('Connect qBittorrent first (Settings → Downloader). Without it Marquee can’t tell what’s still in use.');
  let torrents: Awaited<ReturnType<QbitApi['allTorrents']>>;
  try {
    torrents = await qbit.allTorrents();
  } catch (err) {
    return none(`Marquee couldn’t ask qBittorrent what it’s using (${(err as Error).message}), so it lists nothing rather than guess. It tries again when you open this.`);
  }
  if (!(await fs.stat(folder).catch(() => null))) return none(`Marquee can’t see the downloads folder (${folder}). Check it in Settings → Health → Disk space.`);
  const pairs = readDownloader(db).folderPairs;
  const used = torrents.map((t) => path.resolve(mapPath(t.contentPath, pairs)));
  const usedHere = used.filter((u) => inside(u, folder));
  if (torrents.length && !usedHere.length)
    return none(`None of qBittorrent’s ${torrents.length} torrents are in ${folder} as Marquee sees it, so its folders don’t line up with Marquee’s. Add a folder pair in Settings → Downloader → For experts; until then Marquee lists nothing.`);

  // qBittorrent's own folders (its save folder and each category's) hold torrents: look inside them, never list them whole.
  const status = await qbit.status().catch(() => null);
  const containers = new Set(
    [status?.savePath, ...Object.values(status?.categories ?? {}).map((c) => (c && !path.isAbsolute(c) && status ? path.join(status.savePath, c) : c))]
      .filter((p): p is string => !!p)
      .map((p) => path.resolve(mapPath(p, pairs))),
  );
  const items: CleanupDownloadsView['items'] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (usedHere.some((u) => inside(p, u))) continue;
      if (usedHere.some((u) => u.startsWith(`${p}/`)) || (e.isDirectory() && containers.has(p))) {
        if (e.isDirectory()) await walk(p);
        continue;
      }
      if (!e.isDirectory() && !e.isFile()) continue;
      const st = await fs.stat(p).catch(() => null);
      if (!st) continue;
      const m = await measure(p);
      // Category folders qBittorrent made but nothing's in: not worth listing.
      if (e.isDirectory() && m.files === 0) continue;
      items.push({ path: p, name: e.name, folder: path.relative(folder, dir) || '.', isFolder: e.isDirectory(), files: m.files, sizeBytes: m.bytes, freedBytes: m.freedBytes, inLibrary: m.bytes > 0 && m.freedBytes === 0, modifiedAt: Math.round(st.mtimeMs) });
    }
  };
  await walk(folder);
  return { ok: true, problem: null, folder, items: items.sort((a, b) => b.sizeBytes - a.sizeBytes) };
}

// ---------------------------------------------------------------- library files with no title

export async function untrackedFiles(db: Db): Promise<UntrackedFile[]> {
  const r = roots(db);
  const known = new Set(db.select({ path: mediaFiles.path }).from(mediaFiles).all().map((f) => f.path));
  const out: UntrackedFile[] = [];
  for (const root of ['movies', 'tv'] as const) {
    const base = r[root];
    for (const p of await videosUnder(base)) {
      if (known.has(p)) continue;
      const st = await fs.stat(p).catch(() => null);
      if (!st || isSample(path.basename(p), st.size)) continue;
      const rel = path.relative(base, p);
      const top = path.join(base, rel.split('/')[0]!);
      let reason: string;
      let href: string | null = null;
      const scan = db.select().from(scanItems).where(eq(scanItems.path, top)).get();
      const left = db.select().from(leftOut).where(eq(leftOut.path, top)).get();
      const t = titleAt(db, root, p, base);
      if (!rel.includes('/')) reason = 'It’s loose in the library folder, not in a title’s own folder, so the scan skips it.';
      else if (left) ((reason = `Left out of the library on purpose (${left.title}).`), (href = '/library/left-out'));
      else if (scan?.status === 'ignored') ((reason = 'You chose to ignore this folder when matching.'), (href = '/library/unmatched'));
      else if (scan) ((reason = 'Its folder is waiting for a match.'), (href = '/library/unmatched'));
      else if (t && root === 'tv') ((reason = `In ${t.name}’s folder, but Marquee can’t tell which episode it is.`), (href = t.href));
      else if (t) ((reason = `In ${t.name}’s folder, but not counted as one of its files. Scanning again may pick it up.`), (href = t.href));
      else reason = 'Not matched to anything yet. Scanning the library again may pick it up.';
      out.push({ path: p, name: path.basename(p), root, folder: path.dirname(rel) || '.', sizeBytes: st.size, shared: st.nlink > 1, modifiedAt: Math.round(st.mtimeMs), reason, href });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------- setting aside

/**
 * Sets aside what Clean up listed: library files (two copies, or files with
 * no title) and downloads nobody uses. Each moves into the hidden set-aside
 * folder of its own library or downloads folder. A title's last copy is never
 * set aside here: Remove from Marquee on its page does that.
 */
export async function setAsideByHand(deps: CleanupDeps, paths: string[], userId: number | null): Promise<CleanupResult & { folders: { kind: 'movie' | 'tv'; folder: string }[] }> {
  const { db, now } = deps;
  const r = roots(db);
  const wanted = [...new Set(paths.map((p) => path.resolve(p)))];
  for (const p of wanted) {
    const root = (['movies', 'tv', 'downloads'] as Root[]).find((k) => p.startsWith(`${r[k]}/`));
    if (!root || hidden(path.relative(r[root], p))) throw new HttpError(400, 'invalid_input', `${path.basename(p)} isn’t something Clean up lists.`);
  }
  const lib = wanted.filter((p) => !p.startsWith(`${r.downloads}/`));
  const dls = wanted.filter((p) => p.startsWith(`${r.downloads}/`));

  // Library files: tracked ones Marquee knows; untracked ones must be listed as such right now.
  const tracked = lib.length ? db.select().from(mediaFiles).where(inArray(mediaFiles.path, lib)).all() : [];
  const untracked = lib.filter((p) => !tracked.some((t) => t.path === p));
  if (untracked.length) {
    const listed = new Set((await untrackedFiles(db)).map((u) => u.path));
    const stray = untracked.find((p) => !listed.has(p));
    if (stray) throw new HttpError(400, 'invalid_input', `${path.basename(stray)} isn’t something Clean up lists.`);
  }
  // Never a title's last copy.
  const going = new Set(tracked.map((t) => t.id));
  for (const t of tracked) {
    const others = t.movieId
      ? db.select().from(mediaFiles).where(eq(mediaFiles.movieId, t.movieId)).all()
      : db.select().from(mediaFiles).where(and(eq(mediaFiles.seriesId, t.seriesId!), eq(mediaFiles.season, t.season ?? 0))).all();
    const left = others.filter((o) => !going.has(o.id));
    const eps = JSON.parse(t.episodes ?? '[]') as number[];
    const covered = t.movieId ? left.length > 0 : eps.every((e) => left.some((o) => (JSON.parse(o.episodes ?? '[]') as number[]).includes(e)));
    if (!covered) {
      const name = t.movieId ? db.select().from(movies).where(eq(movies.id, t.movieId)).get()?.title : db.select().from(series).where(eq(series.id, t.seriesId!)).get()?.title;
      throw new HttpError(409, 'last_copy', `That would leave ${name ?? 'a title'} with no copy. Keep one, or use Remove from Marquee on its page to remove it altogether.`);
    }
  }
  if (dls.length) {
    const view = await unusedDownloads(deps);
    if (!view.ok) throw new HttpError(409, 'downloads_unknown', view.problem!);
    const listed = new Set(view.items.map((i) => i.path));
    const busy = dls.find((p) => !listed.has(p));
    if (busy) throw new HttpError(409, 'in_use', `${path.basename(busy)} is in use by qBittorrent now, or isn’t in the list any more. Nothing was moved.`);
  }

  const problems: string[] = [];
  const folders = new Map<string, { kind: 'movie' | 'tv'; folder: string }>();
  let done = 0;
  for (const p of lib) {
    const root = p.startsWith(`${r.movies}/`) ? 'movies' : 'tv';
    try {
      const moved = await setAside(p, r[root]);
      if (!moved) continue;
      done++;
      const t = tracked.find((x) => x.path === p);
      if (t) db.delete(mediaFiles).where(eq(mediaFiles.id, t.id)).run();
      folders.set(path.dirname(p), { kind: root === 'movies' ? 'movie' : 'tv', folder: path.dirname(p) });
      record(db, 'set_aside', titleAt(db, root, p, r[root]), `${path.basename(p)} was set aside by hand from Clean up. It’s in the library’s .marquee-replaced folder until you delete it there.`, now(), userId);
    } catch (err) {
      problems.push(fsProblem(p, err));
    }
  }
  for (const p of dls) {
    const dest = path.join(r.downloads, REPLACED_FOLDER, path.relative(r.downloads, p));
    try {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(p, (await fs.stat(dest).catch(() => null)) ? `${dest}.${now()}` : dest);
      done++;
    } catch (err) {
      problems.push(fsProblem(p, err));
    }
  }
  return { done, problems, message: done ? `Set aside ${done}. They’re in the recycle bin until you delete them for good.` : 'Nothing was set aside.', folders: [...folders.values()] };
}
