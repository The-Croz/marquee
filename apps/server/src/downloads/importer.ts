import fs from 'node:fs/promises';
import { noRoomReason, type DiskProbe } from '../system/disk.js';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { episodes, mediaFiles, movies, series, type Download } from '../db/schema.js';
import { parseQuality } from '../library/parse.js';
import { hdrLabel, renderName } from '../library/naming.js';
import { libraryRoots, readNaming } from '../library/services.js';
import { parseRelease } from '../releases/parse.js';
import type { QbitFile } from './qbittorrent.js';
import { mapPath, readDownloader } from './service.js';

/**
 * Puts a finished download in the library: picks the video file(s), skipping
 * samples and extras, checks they're the right title and episodes, and
 * hardlinks each one into the library folder under a clean name. The
 * download stays where it is so qBittorrent keeps sharing it.
 *
 * Nothing is ever deleted. A file it replaces (an upgrade) is moved into a
 * hidden ".marquee-replaced" folder in the same library folder, where Plex
 * and Jellyfin don't look.
 */

export class ImportError extends Error {}

export interface ImportResult {
  paths: string[];
  /** Copied rather than linked, because the download and the library are on different disks. */
  copied: boolean;
  replaced: string[];
}

/** Swappable for tests: link, then copy if linking across disks isn't possible. */
export interface FileOps {
  link(src: string, dest: string): Promise<void>;
  copy(src: string, dest: string): Promise<void>;
  /** Whether a file and a folder are on the same disk (so a hardlink works). Left out, Marquee compares the disks itself. */
  sameDisk?(src: string, destDir: string): Promise<boolean>;
}
const realOps: FileOps = { link: (a, b) => fs.link(a, b), copy: (a, b) => fs.copyFile(a, b, fs.constants.COPYFILE_FICLONE) };

const VIDEO = /\.(mkv|mp4|m4v|avi|ts|m2ts|wmv|mov|webm|mpg|mpeg)$/i;
const EXTRAS = /(^|\/)(extras?|featurettes?|behind[ ._-]the[ ._-]scenes|deleted[ ._-]scenes|interviews?|trailers?|bonus|shorts|samples?)\//i;
export const REPLACED_FOLDER = '.marquee-replaced';

/** The video files in a download worth putting in the library. */
export function videoFiles(files: QbitFile[]): QbitFile[] {
  const videos = files.filter((f) => VIDEO.test(f.name) && !EXTRAS.test(f.name) && !/(^|[._ -])sample([._ -]|\.)/i.test(path.basename(f.name)));
  const biggest = Math.max(0, ...videos.map((f) => f.size));
  // Samples without the word in their name are tiny next to the real thing.
  return videos.filter((f) => f.size >= biggest * 0.05);
}

function why(err: unknown, dir: string): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM') return `Marquee isn't allowed to write in ${dir}. Check the PUID and PGID in the container settings match the owner of your data share.`;
  if (code === 'ENOSPC') return `The disk with ${dir} is full.`;
  if (code === 'EROFS') return `${dir} is read-only inside the Marquee container. Give the Data path read and write access in the container settings.`;
  return `Couldn't write in ${dir} (${code ?? (err as Error).message}).`;
}

/** Keeps a title's existing folder (say, Radarr's) instead of making a second one next to it. */
function inFolder(rel: string, root: string, existing: string | null): string {
  if (!existing || !existing.startsWith(`${root}/`)) return path.join(root, rel);
  const rest = rel.split('/').slice(1);
  return path.join(existing, ...(rest.length ? rest : [rel]));
}

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(
    () => true,
    () => false,
  );
}

/** Moves a library file into the hidden replaced folder at the same place under the library folder. */
async function setAside(file: string, root: string): Promise<string | null> {
  if (!file.startsWith(`${root}/`) || !(await exists(file))) return null;
  const dest = path.join(root, REPLACED_FOLDER, path.relative(root, file));
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const free = (await exists(dest)) ? `${dest}.${Date.now()}` : dest;
  await fs.rename(file, free);
  return free;
}

/**
 * Puts a finished download in the library. A copy (download and library on
 * different disks) only goes ahead when it leaves the minimum free on the
 * library's disk; a hardlink takes no space, so it always can.
 */
export async function importDownload(db: Db, d: Download, files: QbitFile[], now: number, ops: FileOps = realOps, disk?: DiskProbe): Promise<ImportResult> {
  if (d.adopted) throw new ImportError('Another app sent this download, so that app puts it in your library.');
  const settings = readDownloader(db);
  const roots = libraryRoots(db);
  const naming = readNaming(db);
  if (!d.savePath) throw new ImportError('qBittorrent hasn’t said where it saved this download yet. Marquee tries again shortly.');
  const picked = videoFiles(files);
  if (!picked.length) throw new ImportError('There’s no video file in this download. Press Try another copy.');
  const source = (f: QbitFile) => mapPath(path.posix.join(d.savePath!, f.name), settings.folderPairs);

  // Can Marquee see the download at all?
  const first = source(picked[0]!);
  if (!(await exists(first))) {
    const hint = settings.folderPairs.length
      ? 'Check the folder pairs in Settings → Downloader → For experts.'
      : `If qBittorrent sees its download folder under a different name than Marquee does, add a folder pair in Settings → Downloader → For experts (qBittorrent's folder: ${d.savePath}).`;
    throw new ImportError(`Marquee can't see the downloaded file at ${first}. ${hint}`);
  }

  const fromName = parseRelease(d.title);
  type Plan = { src: string; size: number; dest: string; season: number | null; episodes: number[] };
  const plans: Plan[] = [];
  let root: string;
  if (d.kind === 'movie') {
    const m = d.movieId ? db.select().from(movies).where(eq(movies.id, d.movieId)).get() : undefined;
    if (!m) throw new ImportError('This movie isn’t in your library any more.');
    root = roots.movies;
    const f = picked.reduce((a, b) => (b.size > a.size ? b : a));
    const p = parseRelease(path.basename(f.name));
    const q = p.resolution ? p : fromName;
    const rel = renderName(naming.movie, {
      Title: m.title, Year: m.year, TmdbId: m.tmdbId, ImdbId: m.imdbId, Quality: q.quality === 'Unknown' ? null : q.quality, HDR: hdrLabel(q.hdr),
      Edition: (p.editions[0] ?? fromName.editions[0]) || null, Group: p.group ?? fromName.group,
    });
    plans.push({ src: source(f), size: f.size, dest: inFolder(rel + path.extname(f.name).toLowerCase(), root, m.path), season: null, episodes: [] });
  } else {
    const s = d.seriesId ? db.select().from(series).where(eq(series.id, d.seriesId)).get() : undefined;
    if (!s) throw new ImportError('This show isn’t in your library any more.');
    root = roots.tv;
    const wantedEps = d.episodes ? (JSON.parse(d.episodes) as number[]) : null;
    for (const f of picked) {
      const p = parseRelease(path.basename(f.name));
      const season = p.season ?? (p.episodes.length ? d.season : null);
      if (season === null || season !== d.season || !p.episodes.length) continue;
      if (wantedEps && !p.episodes.some((e) => wantedEps.includes(e))) continue;
      const q = p.resolution ? p : fromName;
      const titles = p.episodes.map((e) => db.select({ title: episodes.title }).from(episodes).where(and(eq(episodes.seriesId, s.id), eq(episodes.season, season), eq(episodes.episode, e))).get()?.title).filter(Boolean);
      const rel = renderName(naming.tv, {
        Show: s.title, Year: s.year, TvdbId: s.tvdbId, TmdbId: s.tmdbId, ImdbId: s.imdbId, Season: season, Episodes: p.episodes,
        'Episode Title': titles.length === 1 ? titles[0] : titles.length ? titles.join(' + ') : null,
        Quality: q.quality === 'Unknown' ? null : q.quality, HDR: hdrLabel(q.hdr), Group: p.group ?? fromName.group,
      });
      plans.push({ src: source(f), size: f.size, dest: inFolder(rel + path.extname(f.name).toLowerCase(), root, s.path), season, episodes: p.episodes });
    }
    if (!plans.length) {
      const which = wantedEps ? `S${String(d.season).padStart(2, '0')}E${wantedEps.map((e) => String(e).padStart(2, '0')).join('-E')}` : `season ${d.season}`;
      throw new ImportError(`None of the files in this download are ${which}. Press Try another copy.`);
    }
  }

  // The files these replace: same movie, or the same episodes.
  const old = db
    .select()
    .from(mediaFiles)
    .where(d.kind === 'movie' ? eq(mediaFiles.movieId, d.movieId!) : and(eq(mediaFiles.seriesId, d.seriesId!), eq(mediaFiles.season, d.season ?? -1)))
    .all()
    .filter((f) => d.kind === 'movie' || plans.some((p) => (JSON.parse(f.episodes ?? '[]') as number[]).some((e) => p.episodes.includes(e))));

  const done: string[] = [];
  const replaced: string[] = [];
  let copied = false;
  for (const p of plans) {
    const dir = path.dirname(p.dest);
    try {
      await fs.mkdir(dir, { recursive: true });
      const [a, b] = await Promise.all([fs.stat(p.src), fs.stat(p.dest).catch(() => null)]);
      if (b && a.ino === b.ino && a.dev === b.dev) {
        done.push(p.dest); // already linked, e.g. a retry
        continue;
      }
      // Before touching anything: a copy needs room.
      const same = ops.sameDisk ? await ops.sameDisk(p.src, dir) : (await fs.stat(dir)).dev === a.dev;
      if (!same) {
        const noRoom = await noRoomReason(db, d.kind === 'movie' ? 'movies' : 'tv', a.size, disk);
        if (noRoom) throw new ImportError(`${noRoom} Marquee tries again by itself.`);
      }
      if (b) {
        const moved = await setAside(p.dest, root);
        if (moved) replaced.push(p.dest);
      }
      try {
        await ops.link(p.src, p.dest);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
        await ops.copy(p.src, p.dest);
        copied = true;
      }
      const made = await fs.stat(p.dest);
      if (made.size !== a.size) throw new ImportError(`The library file came out a different size from the download (${made.size} vs ${a.size} bytes). Marquee tries again shortly.`);
      done.push(p.dest);
    } catch (err) {
      if (err instanceof ImportError) throw err;
      throw new ImportError(why(err, dir));
    }
  }

  // Set the replaced files aside and forget them; record the new ones.
  for (const f of old) {
    if (done.includes(f.path)) continue;
    if (await setAside(f.path, root).catch(() => null)) replaced.push(f.path);
    db.delete(mediaFiles).where(eq(mediaFiles.id, f.id)).run();
  }
  for (const [i, dest] of done.entries()) {
    const p = plans[i]!;
    const st = await fs.stat(dest);
    const q = parseQuality(path.basename(dest));
    const values = {
      movieId: d.movieId, seriesId: d.seriesId, season: p.season, episodes: d.kind === 'tv' ? JSON.stringify(p.episodes) : null,
      size: st.size, mtime: Math.round(st.mtimeMs), resolution: q.resolution, source: q.source, hdr: q.hdr, codec: q.codec, releaseGroup: q.group, seenAt: now,
    };
    db.insert(mediaFiles).values({ path: dest, addedAt: now, ...values }).onConflictDoUpdate({ target: mediaFiles.path, set: values }).run();
  }
  // The title's folder, for titles that had nothing on disk before.
  const top = path.join(root, path.relative(root, done[0]!).split(path.sep)[0]!);
  const table = d.kind === 'movie' ? movies : series;
  const id = d.kind === 'movie' ? d.movieId! : d.seriesId!;
  const had = db.select({ path: table.path }).from(table).where(eq(table.id, id)).get();
  if (!had?.path) db.update(table).set({ path: top }).where(eq(table.id, id)).run();
  return { paths: done, copied, replaced };
}
