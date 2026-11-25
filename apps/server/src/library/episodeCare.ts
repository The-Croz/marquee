import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { downloads, episodes, history, mediaFiles, series, type Download, type MediaFile } from '../db/schema.js';
import { HttpError } from '../http.js';
import { REPLACED_FOLDER, setAside } from '../downloads/importer.js';
import { recordHistory } from '../downloads/history.js';
import type { QbitApi } from '../downloads/qbittorrent.js';
import { mapPath, readDownloader } from '../downloads/service.js';
import { normalizeTitle } from './parse.js';
import { libraryRoots } from './services.js';

/**
 * One episode up close: its files, and the torrents in qBittorrent that hold
 * it (the ones Marquee follows, and ones another app sent, found because the
 * library file is a hardlink to the torrent's file). Removing an episode sets
 * its file aside (the recycle bin), can stop looking for it, and can remove
 * chosen torrents from qBittorrent with their files.
 */

export interface EpisodeTorrent {
  hash: string;
  name: string;
  /** Marquee follows it (it sent it, or adopted it). */
  followed: boolean;
  /** Its download row, when Marquee has one. */
  downloadId: number | null;
  /** In qBittorrent right now. */
  inDownloader: boolean;
  /** A whole season (or more than this episode). */
  wholeSeason: boolean;
}

export interface EpisodeFacts {
  show: typeof series.$inferSelect;
  episode: typeof episodes.$inferSelect;
  files: { row: MediaFile; otherEpisodes: number[]; shared: boolean }[];
  torrents: EpisodeTorrent[];
  /** Why torrents another app sent couldn't be looked for, if they couldn't. */
  downloaderNote: string | null;
}

export interface EpisodeDeps {
  db: Db;
  now: () => number;
  qbit: () => QbitApi | null;
}

const words = (s: string) => normalizeTitle(s).split(' ').filter((w) => w.length > 1);

export async function episodeFacts(deps: EpisodeDeps, seriesId: number, season: number, episode: number): Promise<EpisodeFacts> {
  const { db } = deps;
  const show = db.select().from(series).where(eq(series.id, seriesId)).get();
  const ep = show && db.select().from(episodes).where(and(eq(episodes.seriesId, seriesId), eq(episodes.season, season), eq(episodes.episode, episode))).get();
  if (!show || !ep) throw new HttpError(404, 'not_found', 'No such episode.');

  const files = db
    .select()
    .from(mediaFiles)
    .where(and(eq(mediaFiles.seriesId, seriesId), eq(mediaFiles.season, season)))
    .all()
    .filter((f) => (JSON.parse(f.episodes ?? '[]') as number[]).includes(episode));
  const stats = await Promise.all(files.map((f) => fs.stat(f.path).catch(() => null)));
  const fileViews = files.map((row, i) => ({ row, otherEpisodes: (JSON.parse(row.episodes ?? '[]') as number[]).filter((n) => n !== episode), shared: (stats[i]?.nlink ?? 1) > 1 }));

  // Downloads Marquee follows for this episode or its whole season.
  const rows = db
    .select()
    .from(downloads)
    .where(and(eq(downloads.seriesId, seriesId), eq(downloads.season, season), ne(downloads.state, 'removed')))
    .all()
    .filter((d) => !d.episodes || (JSON.parse(d.episodes) as number[]).includes(episode));
  const torrents = new Map<string, EpisodeTorrent>();
  for (const d of rows) {
    const eps = d.episodes ? (JSON.parse(d.episodes) as number[]) : null;
    torrents.set(d.infoHash, { hash: d.infoHash, name: d.title, followed: true, downloadId: d.id, inDownloader: d.qbitState !== 'gone', wholeSeason: !eps || eps.length > 1 });
  }

  let downloaderNote: string | null = null;
  const qbit = deps.qbit();
  if (!qbit) downloaderNote = 'qBittorrent isn’t connected, so only downloads Marquee follows are shown.';
  else {
    try {
      const all = await qbit.allTorrents();
      const present = new Set(all.map((t) => t.hash));
      for (const t of torrents.values()) t.inDownloader = present.has(t.hash);
      // Another app's torrents: names that mention the show, then confirmed by the hardlink (same file on disk).
      const inodes = new Set(stats.filter((s) => s && s.nlink > 1).map((s) => `${s!.dev}:${s!.ino}`));
      if (inodes.size) {
        const want = words(show.title);
        const pairs = readDownloader(db).folderPairs;
        for (const t of all) {
          if (torrents.has(t.hash)) continue;
          const name = words(t.name.replace(/[._]/g, ' '));
          if (!want.every((w) => name.includes(w))) continue;
          for (const f of await qbit.files(t.hash).catch(() => [])) {
            const st = await fs.stat(mapPath(path.posix.join(t.savePath, f.name), pairs)).catch(() => null);
            if (st && inodes.has(`${st.dev}:${st.ino}`)) {
              const sxe = /s(\d{1,2})e(\d{1,3})/i.exec(t.name);
              torrents.set(t.hash, { hash: t.hash, name: t.name, followed: false, downloadId: null, inDownloader: true, wholeSeason: !sxe });
              break;
            }
          }
        }
      }
    } catch (err) {
      downloaderNote = `Marquee couldn’t ask qBittorrent (${(err as Error).message}), so only downloads Marquee follows are shown.`;
    }
  }
  return { show, episode: ep, files: fileViews, torrents: [...torrents.values()], downloaderNote };
}

export interface RemoveEpisodeInput {
  /** Stop looking for it (and any other episode in the same file), so it isn't downloaded again. */
  stopWanting: boolean;
  /** Torrents to remove from qBittorrent with their files: hashes from the episode's details. */
  torrents: string[];
}

/**
 * Removes an episode's file from the library (into the recycle bin), and if
 * asked, takes chosen torrents out of qBittorrent with their files.
 * Torrents go first, while the library file is still there to check against.
 */
export async function removeEpisode(
  deps: EpisodeDeps & { removeFollowed: (downloadId: number) => Promise<void> },
  seriesId: number,
  season: number,
  episode: number,
  input: RemoveEpisodeInput,
  userId: number | null,
): Promise<{ message: string; problems: string[]; folders: string[] }> {
  const { db, now } = deps;
  const facts = await episodeFacts(deps, seriesId, season, episode);
  const known = new Map(facts.torrents.map((t) => [t.hash, t]));
  const stray = input.torrents.find((h) => !known.has(h));
  if (stray) throw new HttpError(409, 'torrents_changed', 'The downloads changed since you looked. Open the episode again to see them as they are now.');
  const problems: string[] = [];
  const label = `${facts.show.title} · S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;

  let removedTorrents = 0;
  for (const hash of input.torrents) {
    const t = known.get(hash)!;
    const row = t.downloadId ? db.select().from(downloads).where(eq(downloads.id, t.downloadId)).get() : undefined;
    try {
      if (row && !row.adopted) await deps.removeFollowed(row.id);
      else {
        const qbit = deps.qbit();
        if (!qbit) throw new Error('qBittorrent isn’t connected');
        if (t.inDownloader) await qbit.remove(hash, true);
        if (row) markRemoved(db, row, now(), userId);
      }
      removedTorrents++;
    } catch (err) {
      problems.push(`Couldn’t remove ${t.name} from qBittorrent (${(err as Error).message}). Remove it in qBittorrent yourself.`);
    }
  }

  const root = libraryRoots(db).tv;
  const folders = new Set<string>();
  let setAsideCount = 0;
  const alsoEpisodes = new Set<number>([episode]);
  for (const f of facts.files) {
    try {
      const moved = await setAside(f.row.path, root);
      db.delete(mediaFiles).where(eq(mediaFiles.id, f.row.id)).run();
      if (moved) setAsideCount++;
      folders.add(path.dirname(f.row.path));
      for (const n of f.otherEpisodes) alsoEpisodes.add(n);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      problems.push(`Couldn’t move ${path.basename(f.row.path)} (${code === 'EACCES' || code === 'EPERM' ? 'Marquee isn’t allowed to: check the PUID and PGID in the container settings' : (code ?? (err as Error).message)}).`);
    }
  }
  if (input.stopWanting) db.update(episodes).set({ monitored: false }).where(and(eq(episodes.seriesId, seriesId), eq(episodes.season, season), inArray(episodes.episode, [...alsoEpisodes]))).run();

  const parts = [
    setAsideCount ? `Set ${setAsideCount === 1 ? 'its file' : `${setAsideCount} files`} aside in the recycle bin (${REPLACED_FOLDER}).` : facts.files.length ? null : 'It had no file in the library.',
    alsoEpisodes.size > 1 ? `The file also held episode${alsoEpisodes.size > 2 ? 's' : ''} ${[...alsoEpisodes].filter((n) => n !== episode).join(', ')}.` : null,
    removedTorrents ? `Removed ${removedTorrents === 1 ? 'its download' : `${removedTorrents} downloads`} from qBittorrent with ${removedTorrents === 1 ? 'its' : 'their'} files.` : null,
    input.stopWanting ? 'Marquee won’t look for it again.' : 'It’s still Wanted, so Marquee will look for it again.',
  ].filter(Boolean);
  const message = `${label}: ${parts.join(' ')}`;
  if (setAsideCount || removedTorrents)
    db.insert(history).values({ at: now(), event: 'set_aside', kind: 'tv', seriesId, season, episodes: JSON.stringify([...alsoEpisodes]), title: label, detail: parts.join(' '), userId }).run();
  return { message, problems, folders: [...folders] };
}

function markRemoved(db: Db, row: Download, at: number, userId: number | null) {
  const what = 'Removed from qBittorrent with its files, by hand from the episode.';
  db.update(downloads).set({ state: 'removed', message: what }).where(eq(downloads.id, row.id)).run();
  recordHistory(db, 'removed', row, at, { detail: what, userId });
}
