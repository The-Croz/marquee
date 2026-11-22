import fs from 'node:fs/promises';
import type { DiskSettingsView, DiskView } from '@marquee/shared';
import { getSetting, setSetting, type Db } from '../db/index.js';
import { libraryRoots } from '../library/services.js';
import { readDownloader } from '../downloads/service.js';

/**
 * Free space on the downloads, movies and TV folders, and the minimum Marquee
 * keeps spare: it won't send a copy to qBittorrent, or copy a finished
 * download into the library, when that would leave less than the minimum.
 * (Hardlinks take no extra space, so they still go ahead.)
 */

export const DEFAULT_MIN_FREE_GB = 20;
const GB = 1024 ** 3;

const KEYS = { downloadsFolder: 'disk.downloads_folder', minFreeGb: 'disk.min_free_gb' } as const;

export type DiskKey = DiskView['key'];

/** How much is free on the disk holding `path`, or null when Marquee can't see it. */
export type DiskProbe = (path: string) => Promise<{ free: number; total: number } | null>;

export const realDiskProbe: DiskProbe = async (p) => {
  try {
    const st = await fs.statfs(p);
    return { free: st.bavail * st.bsize, total: st.blocks * st.bsize };
  } catch {
    return null;
  }
};

/** Where downloads land as Marquee sees it: the setting, else the first folder pair, else /data/torrents. */
export function downloadsFolder(db: Db): string {
  return getSetting(db, KEYS.downloadsFolder) || readDownloader(db).folderPairs[0]?.to || '/data/torrents';
}

export function readDiskSettings(db: Db): DiskSettingsView {
  const saved = getSetting(db, KEYS.minFreeGb);
  const n = saved === undefined || saved === '' ? NaN : Number(saved);
  return { downloadsFolder: downloadsFolder(db), downloadsFolderSet: !!getSetting(db, KEYS.downloadsFolder), minFreeGb: Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_FREE_GB, defaultMinFreeGb: DEFAULT_MIN_FREE_GB };
}

/** `undefined` leaves a field alone; `null` or "" puts it back to the default. */
export function writeDiskSettings(db: Db, v: { downloadsFolder?: string | null; minFreeGb?: number | null }): void {
  if (v.downloadsFolder !== undefined) setSetting(db, KEYS.downloadsFolder, (v.downloadsFolder ?? '').trim().replace(/(.)\/+$/, '$1'));
  if (v.minFreeGb !== undefined) setSetting(db, KEYS.minFreeGb, v.minFreeGb === null ? '' : String(v.minFreeGb));
}

export function folderFor(db: Db, key: DiskKey): string {
  if (key === 'downloads') return downloadsFolder(db);
  return libraryRoots(db)[key];
}

const LABEL: Record<DiskKey, string> = { downloads: 'Downloads', movies: 'Movies', tv: 'TV' };

/** "12.4 GB", "1.2 TB". */
export function size(bytes: number): string {
  if (bytes >= 1024 * GB) return `${(bytes / (1024 * GB)).toFixed(1)} TB`;
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** Free space on each folder, with a plain state and what to do. */
export async function diskViews(db: Db, probe: DiskProbe = realDiskProbe): Promise<DiskView[]> {
  const { minFreeGb } = readDiskSettings(db);
  const keys: DiskKey[] = ['downloads', 'movies', 'tv'];
  return Promise.all(
    keys.map(async (key): Promise<DiskView> => {
      const path = folderFor(db, key);
      const st = await probe(path);
      const base = { key, label: LABEL[key], path, free: st?.free ?? null, total: st?.total ?? null };
      if (!st) {
        return { ...base, tone: 'problem', state: 'Can’t see this folder', fix: `Check ${path} is mapped into the Marquee container (Unraid: the Data path), or change the folder in ${key === 'downloads' ? 'For experts below' : 'Settings → Services'}.` };
      }
      if (st.free < minFreeGb * GB) {
        return {
          ...base,
          tone: 'problem',
          state: `Nearly full · ${size(st.free)} free`,
          fix: `Marquee keeps at least ${minFreeGb} GB spare, so it’s holding off on ${key === 'downloads' ? 'sending new downloads' : 'copying files into the library'}. Free up some space; it carries on by itself.`,
        };
      }
      return { ...base, tone: 'ok', state: `${size(st.free)} free`, fix: null };
    }),
  );
}

/**
 * A plain reason `bytes` more on `key`'s disk would leave less than the minimum
 * spare, or null when there's room (or Marquee can't tell, so it doesn't stand in the way).
 */
export async function noRoomReason(db: Db, key: DiskKey, bytes: number, probe: DiskProbe = realDiskProbe): Promise<string | null> {
  const { minFreeGb } = readDiskSettings(db);
  const path = folderFor(db, key);
  const st = await probe(path);
  if (!st || st.free - Math.max(0, bytes) >= minFreeGb * GB) return null;
  const what = key === 'downloads' ? 'the downloads disk' : `the ${LABEL[key]} disk`;
  const needs = bytes > 0 ? `, this needs ${size(bytes)},` : '';
  return `Not enough room on ${what} (${path}): ${size(st.free)} free${needs} and Marquee keeps ${minFreeGb} GB spare. Free up some space, or lower the minimum in Settings → Health → For experts.`;
}
