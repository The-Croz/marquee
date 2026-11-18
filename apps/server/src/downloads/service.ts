import type { DownloaderHealth, DownloaderState, DownloaderView } from '@marquee/shared';
import { getSetting, setSetting, type Db } from '../db/index.js';
import { QbitError, apiAtLeast, type QbitApi } from './qbittorrent.js';

/**
 * Settings → Downloader: where qBittorrent is, how to sign in, which category
 * Marquee files its downloads under, and its health in plain words.
 */

export interface DownloaderSettings {
  url: string | null;
  username: string;
  password: string | null;
  category: string;
  /** Hours without progress before a download counts as stuck. */
  stuckHours: number;
  /** Hours without progress before Marquee tries another copy by itself. */
  giveUpHours: number;
  /** Try another copy by itself after giveUpHours, or after spotting a fake. */
  tryAnother: boolean;
  /** When qBittorrent sees the download folder under another name than Marquee does. */
  folderPairs: FolderPair[];
  /** Keep sharing until this ratio (0 = no ratio limit), unless a Source says otherwise. */
  seedRatio: number;
  /** …or for this many days (0 = no time limit), whichever comes first. */
  seedDays: number;
  /** Private sites keep sharing with no limit unless their Source has its own rule. */
  privateKeepSharing: boolean;
  /** Remove a download from qBittorrent once it's in the library and has shared enough. */
  removeWhenShared: boolean;
}

export interface FolderPair {
  /** The folder as qBittorrent sees it, e.g. /downloads. */
  from: string;
  /** The same folder as Marquee sees it, e.g. /data/torrents. */
  to: string;
}

const KEYS = {
  url: 'downloader.url',
  username: 'downloader.username',
  password: 'downloader.password',
  category: 'downloader.category',
  stuckHours: 'downloader.stuck_hours',
  giveUpHours: 'downloader.give_up_hours',
  tryAnother: 'downloader.try_another',
  folderPairs: 'downloader.folder_pairs',
  seedRatio: 'downloader.seed_ratio',
  seedDays: 'downloader.seed_days',
  privateKeepSharing: 'downloader.private_keep_sharing',
  removeWhenShared: 'downloader.remove_when_shared',
} as const;

export const DEFAULT_SEED_RATIO = 2;
export const DEFAULT_SEED_DAYS = 14;

export const DEFAULT_STUCK_HOURS = 6;
export const DEFAULT_GIVE_UP_HOURS = 24;

export const DEFAULT_CATEGORY = 'marquee';

export function readDownloader(db: Db): DownloaderSettings {
  return {
    url: getSetting(db, KEYS.url) || null,
    username: getSetting(db, KEYS.username) ?? '',
    password: getSetting(db, KEYS.password) || null,
    category: getSetting(db, KEYS.category) || DEFAULT_CATEGORY,
    stuckHours: Number(getSetting(db, KEYS.stuckHours)) || DEFAULT_STUCK_HOURS,
    giveUpHours: Number(getSetting(db, KEYS.giveUpHours)) || DEFAULT_GIVE_UP_HOURS,
    tryAnother: getSetting(db, KEYS.tryAnother) !== '0',
    folderPairs: JSON.parse(getSetting(db, KEYS.folderPairs) || '[]') as FolderPair[],
    seedRatio: numberOr(getSetting(db, KEYS.seedRatio), DEFAULT_SEED_RATIO),
    seedDays: numberOr(getSetting(db, KEYS.seedDays), DEFAULT_SEED_DAYS),
    privateKeepSharing: getSetting(db, KEYS.privateKeepSharing) !== '0',
    removeWhenShared: getSetting(db, KEYS.removeWhenShared) === '1',
  };
}

/** A saved number, where 0 is a real choice ("no limit"), or the default when nothing is saved. */
function numberOr(v: string | undefined, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function downloaderView(db: Db): DownloaderView {
  const s = readDownloader(db);
  return { url: s.url, username: s.username, hasPassword: !!s.password, category: s.category, stuckHours: s.stuckHours, giveUpHours: s.giveUpHours, tryAnother: s.tryAnother, folderPairs: s.folderPairs, seedRatio: s.seedRatio, seedDays: s.seedDays, privateKeepSharing: s.privateKeepSharing, removeWhenShared: s.removeWhenShared };
}

/**
 * Saves the given fields. `undefined` leaves a field alone; `null` or "" clears it.
 * A saved password belongs to its address: changing the address without typing
 * a password forgets the old one, so it's never sent somewhere new.
 */
export function writeDownloader(
  db: Db,
  v: { url?: string | null; username?: string; password?: string | null; category?: string; stuckHours?: number; giveUpHours?: number; tryAnother?: boolean; folderPairs?: FolderPair[]; seedRatio?: number; seedDays?: number; privateKeepSharing?: boolean; removeWhenShared?: boolean },
): void {
  const saved = readDownloader(db);
  if (v.url !== undefined) {
    const url = v.url?.trim() || '';
    if (url !== (saved.url ?? '') && v.password === undefined) setSetting(db, KEYS.password, '');
    setSetting(db, KEYS.url, url);
  }
  if (v.username !== undefined) setSetting(db, KEYS.username, v.username.trim());
  if (v.password !== undefined) setSetting(db, KEYS.password, v.password ?? '');
  if (v.category !== undefined) setSetting(db, KEYS.category, v.category.trim() || DEFAULT_CATEGORY);
  if (v.stuckHours !== undefined) setSetting(db, KEYS.stuckHours, String(v.stuckHours));
  if (v.giveUpHours !== undefined) setSetting(db, KEYS.giveUpHours, String(v.giveUpHours));
  if (v.folderPairs !== undefined) setSetting(db, KEYS.folderPairs, JSON.stringify(v.folderPairs.map((p) => ({ from: p.from.replace(/\/+$/, ''), to: p.to.replace(/\/+$/, '') }))));
  if (v.seedRatio !== undefined) setSetting(db, KEYS.seedRatio, String(v.seedRatio));
  if (v.seedDays !== undefined) setSetting(db, KEYS.seedDays, String(v.seedDays));
  if (v.privateKeepSharing !== undefined) setSetting(db, KEYS.privateKeepSharing, v.privateKeepSharing ? '1' : '0');
  if (v.removeWhenShared !== undefined) setSetting(db, KEYS.removeWhenShared, v.removeWhenShared ? '1' : '0');
  if (v.tryAnother !== undefined) setSetting(db, KEYS.tryAnother, v.tryAnother ? '1' : '0');
}

/** The label and what to do for each state. Screens show these as-is. */
export const DOWNLOADER_TEXT: Record<DownloaderState, { label: string; fix: string | null }> = {
  not_set_up: { label: 'Not set up', fix: 'Enter the address of qBittorrent\'s web page and its username and password.' },
  working: { label: 'Working', fix: null },
  unreachable: { label: "Can't reach it", fix: 'Check qBittorrent is running and the address and port are right (Unraid: the port on the qBittorrent or gluetun container). Marquee tries again next time it needs it.' },
  password_refused: { label: 'Password turned down', fix: 'Type the username and password from qBittorrent → Options → Web UI again, then Test.' },
  banned: { label: 'Too many wrong passwords', fix: 'qBittorrent blocks an address for a while after several wrong passwords (one hour by default). Fix the password, then wait or restart qBittorrent.' },
  needs_password: { label: 'Type the password again', fix: 'The address changed. For safety, Marquee only sends a saved password to the address it was saved with.' },
  not_qbittorrent: { label: 'Not qBittorrent', fix: "The address answers, but not as qBittorrent. Use the address of qBittorrent's web page, e.g. http://192.168.1.100:8080." },
  too_old: { label: 'Too old', fix: 'Marquee needs qBittorrent 4.5 or newer. Update the container.' },
  no_internet: { label: 'No internet for downloads', fix: "qBittorrent says it has no connection. If it runs behind a VPN (like gluetun), check the VPN container is up and connected, then restart qBittorrent." },
  firewalled: { label: "Others can't connect to you", fix: 'Downloads still work, but slower. Turn on port forwarding in your VPN and set that port in qBittorrent → Options → Connection.' },
  error: { label: 'Something went wrong', fix: 'qBittorrent gave an answer Marquee didn\'t expect. Try again; if it keeps happening, check qBittorrent\'s log.' },
};

function health(state: DownloaderState, now: number, extra: Partial<DownloaderHealth> = {}): DownloaderHealth {
  const t = DOWNLOADER_TEXT[state];
  return { state, ok: state === 'working' || state === 'firewalled', label: t.label, fix: t.fix, detail: null, checkedAt: now, ...extra };
}

/** Checks qBittorrent and describes what it found. Never throws. */
export async function checkDownloader(client: QbitApi | null, category: string, now: number): Promise<DownloaderHealth> {
  if (!client) return health('not_set_up', now);
  try {
    const s = await client.status();
    const facts = {
      version: s.version,
      savePath: s.savePath,
      freeSpace: s.freeSpace,
      categoryExists: category in s.categories,
    };
    if (!apiAtLeast(s.apiVersion)) return health('too_old', now, { ...facts, detail: `This is qBittorrent ${s.version}.` });
    if (s.connection === 'disconnected') return health('no_internet', now, facts);
    return health(s.connection === 'firewalled' ? 'firewalled' : 'working', now, facts);
  } catch (err) {
    if (err instanceof QbitError) {
      const state: DownloaderState = err.kind === 'error' ? 'error' : err.kind;
      return health(state, now, { detail: err.message });
    }
    return health('error', now, { detail: (err as Error).message });
  }
}

/** A path as qBittorrent sees it, turned into the path Marquee sees, using the longest matching folder pair. */
export function mapPath(p: string, pairs: FolderPair[]): string {
  const hit = [...pairs].sort((a, b) => b.from.length - a.from.length).find((x) => p === x.from || p.startsWith(`${x.from}/`));
  return hit ? hit.to + p.slice(hit.from.length) : p;
}
