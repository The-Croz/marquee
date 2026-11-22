import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { QbitFile } from './qbittorrent.js';

/**
 * Copies that come packed in .rar files (common for scene copies on private
 * sites): finds each .rar set in a download, looks inside before unpacking
 * (a password, no video, or files that climb out of their folder mean a
 * fake), and unpacks it with 7-Zip into a folder Marquee owns next to the
 * download. The download itself is never touched, so qBittorrent keeps
 * sharing it. This is what Unpackerr did for the older apps.
 */

/** One file inside an archive. */
export interface ArchiveEntry {
  name: string;
  size: number;
  encrypted: boolean;
  folder: boolean;
}

/**
 * What went wrong. `password`, `no_video` and `unsafe` mean a fake;
 * `missing_part` and `broken` mean the download is damaged (it waits for
 * you); `no_tool`, `no_room` and `failed` are tried again by themselves.
 */
export type UnpackProblem = 'password' | 'no_video' | 'unsafe' | 'missing_part' | 'broken' | 'no_tool' | 'no_room' | 'failed';
export class UnpackError extends Error {
  constructor(
    readonly kind: UnpackProblem,
    message: string,
  ) {
    super(message);
  }
}
export const FAKE_PROBLEMS = new Set<UnpackProblem>(['password', 'no_video', 'unsafe']);
export const DAMAGED_PROBLEMS = new Set<UnpackProblem>(['missing_part', 'broken']);

/** The unpacking tool. Tests and demo mode swap in a fake. */
export interface Unpacker {
  /** What's inside an archive set (give its first part), without unpacking it. */
  list(archive: string): Promise<ArchiveEntry[]>;
  /** Unpacks a whole set (give its first part) into `dest`. */
  extract(archive: string, dest: string): Promise<void>;
  /** For the Health page: whether the tool is here, and its version. */
  check(): Promise<{ ok: true; version: string } | { ok: false; message: string }>;
}

/** One .rar set in a download: its first part (null when that part is missing) and every part. Names are as qBittorrent lists them. */
export interface RarSet {
  first: string | null;
  parts: string[];
  size: number;
}

const PART = /^(.*)\.part0*(\d+)\.rar$/i;
const RAR = /^(.*)\.rar$/i;
const OLD_PART = /^(.*)\.[rs]\d{2,3}$/i;
/** Folders whose archives aren't the movie or episode itself. */
const SIDE_FOLDERS = /(^|\/)(subs?|subtitles?|samples?|proofs?|extras?|featurettes?)\//i;
const VIDEO = /\.(mkv|mp4|m4v|avi|ts|m2ts|wmv|mov|webm|mpg|mpeg)$/i;
const SAMPLE = /(^|[._ -])sample([._ -]|\.)/i;

/**
 * The .rar sets in a download, in the two ways they're named: `name.rar`,
 * `name.r00`, `name.r01`… or `name.part01.rar`, `name.part02.rar`…
 * Archives in Subs, Sample or Proof folders are left alone.
 */
export function rarSets(files: QbitFile[]): RarSet[] {
  const sets = new Map<string, RarSet>();
  const add = (key: string, name: string, size: number, first: boolean) => {
    const set = sets.get(key) ?? { first: null, parts: [], size: 0 };
    set.parts.push(name);
    set.size += size;
    if (first) set.first = name;
    sets.set(key, set);
  };
  for (const f of files) {
    if (SIDE_FOLDERS.test(f.name)) continue;
    const part = PART.exec(f.name);
    if (part) {
      add(`part:${part[1]!.toLowerCase()}`, f.name, f.size, Number(part[2]) === 1);
      continue;
    }
    const rar = RAR.exec(f.name);
    if (rar) {
      add(`old:${rar[1]!.toLowerCase()}`, f.name, f.size, true);
      continue;
    }
    const old = OLD_PART.exec(f.name);
    if (old) add(`old:${old[1]!.toLowerCase()}`, f.name, f.size, false);
  }
  return [...sets.values()].map((s) => ({ ...s, parts: s.parts.sort() }));
}

/** A download that's only .rar files (no video of its own outside them), so it needs unpacking. */
export function needsUnpacking(files: QbitFile[], videos: QbitFile[]): boolean {
  return videos.length === 0 && rarSets(files).some((s) => s.first !== null);
}

/** The video worth keeping among an archive's files: not samples, not tiny. */
export function videosInside(entries: ArchiveEntry[]): ArchiveEntry[] {
  const videos = entries.filter((e) => !e.folder && VIDEO.test(e.name) && !SAMPLE.test(path.basename(e.name)) && !SIDE_FOLDERS.test(e.name));
  const biggest = Math.max(0, ...videos.map((e) => e.size));
  return videos.filter((e) => e.size >= biggest * 0.05);
}

function unsafeName(name: string): boolean {
  const n = name.replace(/\\/g, '/');
  return n.startsWith('/') || /^[a-z]:/i.test(n) || n.split('/').includes('..');
}

export interface UnpackPlan {
  /** Each set's first part (a full path) and the folder it unpacks into. */
  sets: { archive: string; into: string }[];
  /** Room it needs on the downloads disk. */
  bytes: number;
}

/**
 * Looks inside each set before anything is unpacked. Throws an UnpackError
 * for a fake (password, no video, files climbing out of their folder) or a
 * set whose first part is missing.
 */
export async function lookInside(sets: RarSet[], from: string, dest: string, unpacker: Unpacker): Promise<UnpackPlan> {
  const plan: UnpackPlan = { sets: [], bytes: 0 };
  let videos = 0;
  const seen: string[] = [];
  for (const set of sets) {
    if (!set.first) throw new UnpackError('missing_part', unpackText('missing_part', `${path.basename(set.parts[0]!)} is there, but not the first part`));
    const archive = path.join(from, set.first);
    const entries = await unpacker.list(archive);
    if (entries.some((e) => e.encrypted)) throw new UnpackError('password', unpackText('password'));
    if (entries.some((e) => unsafeName(e.name))) throw new UnpackError('unsafe', unpackText('unsafe'));
    videos += videosInside(entries).length;
    seen.push(...entries.filter((e) => !e.folder).map((e) => path.basename(e.name)));
    plan.bytes += entries.reduce((n, e) => n + (e.folder ? 0 : e.size), 0);
    plan.sets.push({ archive, into: path.join(dest, path.dirname(set.first)) });
  }
  if (!videos) {
    const some = seen.slice(0, 3).join(', ');
    throw new UnpackError('no_video', unpackText('no_video', some ? `just ${some}${seen.length > 3 ? '…' : ''}` : 'nothing at all'));
  }
  return plan;
}

/** What each problem means and what to do, in plain words. */
export function unpackText(kind: UnpackProblem, detail?: string): string {
  const d = detail ? ` (${detail})` : '';
  switch (kind) {
    case 'password':
      return 'The .rar files are locked with a password. Real copies never are, so this is almost certainly a fake.';
    case 'no_video':
      return `There’s no video inside the .rar files${d}, so this is almost certainly a fake.`;
    case 'unsafe':
      return 'The .rar files try to put files outside their own folder, which real copies never do, so this is almost certainly a fake.';
    case 'missing_part':
      return `Part of the .rar set is missing${d}. In qBittorrent, right-click the download and choose Force recheck, then press Try again here. Or press Try another copy.`;
    case 'broken':
      return `The .rar files are damaged${d}. In qBittorrent, right-click the download and choose Force recheck, then press Try again here. Or press Try another copy.`;
    case 'no_tool':
      return 'This install of Marquee has no unpacking tool. The Marquee Docker image has 7-Zip built in; if you run Marquee another way, install 7-Zip so the 7zz command works (or set MARQUEE_UNPACK_BIN), then press Try again.';
    case 'no_room':
      return detail ?? 'Not enough room on the downloads disk to unpack it.';
    case 'failed':
      return `Unpacking didn’t work${d}. Marquee tries again every 15 minutes, or press Try again.`;
  }
}

/** Every file under a folder, as names relative to it with their sizes. */
export async function filesUnder(dir: string): Promise<QbitFile[]> {
  const out: QbitFile[] = [];
  const walk = async (rel: string) => {
    for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const name = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(name);
      else if (e.isFile()) out.push({ name, size: (await fs.stat(path.join(dir, name))).size });
    }
  };
  await walk('');
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- 7-Zip

/** No archive Marquee unpacks needs a password; a made-up one keeps 7-Zip from waiting for someone to type one. */
const NO_PASSWORD = '-pmarquee-no-password';
const THREE_HOURS = 3 * 3_600_000;

interface Ran {
  code: number | null;
  out: string;
}

function run(bin: string, args: string[], timeoutMs = THREE_HOURS): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const keep = (b: Buffer) => {
      // Listings are small; extraction only prints a few lines. Keep the end if it isn't.
      out = (out + b.toString('utf8')).slice(-200_000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    timer.unref();
    child.on('error', (err) => {
      clearTimeout(timer);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') reject(new UnpackError('no_tool', unpackText('no_tool')));
      else reject(new UnpackError('failed', unpackText('failed', err.message)));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

/** Turns 7-Zip's complaint into a plain problem. */
export function sevenZipProblem(out: string): UnpackError {
  if (/wrong password|can ?not open encrypted archive/i.test(out)) return new UnpackError('password', unpackText('password'));
  const missing = /missing volume\s*:\s*(.+)/i.exec(out);
  if (missing) return new UnpackError('missing_part', unpackText('missing_part', `${path.basename(missing[1]!.trim())} isn’t there`));
  if (/unexpected end of archive/i.test(out)) return new UnpackError('missing_part', unpackText('missing_part', 'the last part ends too soon'));
  if (/crc failed|data error|headers error|is not archive|cannot open the file as archive/i.test(out)) {
    return new UnpackError('broken', unpackText('broken', /crc failed|data error/i.test(out) ? 'a check failed' : 'it isn’t a readable archive'));
  }
  if (/no space left|not enough space/i.test(out)) return new UnpackError('failed', unpackText('failed', 'the disk filled up'));
  const last = out.split('\n').map((l) => l.trim()).filter((l) => /^(error|errors?:|e_)/i.test(l) || l.startsWith('ERROR')).at(-1);
  return new UnpackError('failed', unpackText('failed', last ?? '7-Zip stopped with an error'));
}

/** Reads 7-Zip's `l -slt` listing: blocks of `Key = value` lines, one per file, after a line of dashes. */
export function parseSevenZipList(out: string): ArchiveEntry[] {
  const at = out.indexOf('\n----------');
  const body = at >= 0 ? out.slice(at + 11) : out;
  const entries: ArchiveEntry[] = [];
  for (const block of body.split(/\r?\n\s*\r?\n/)) {
    const kv = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      const m = /^([A-Za-z ]+?) = ?(.*)$/.exec(line);
      if (m) kv.set(m[1]!, m[2]!);
    }
    const name = kv.get('Path');
    if (!name || kv.has('Type') || kv.has('Physical Size')) continue;
    entries.push({
      name: name.replace(/\\/g, '/'),
      size: Number(kv.get('Size') ?? 0) || 0,
      encrypted: kv.get('Encrypted') === '+',
      folder: kv.get('Folder') === '+' || (kv.get('Attributes') ?? '').startsWith('D'),
    });
  }
  return entries;
}

/** 7-Zip's `7zz` (the official build: reads .rar, including RAR5 and sets split into parts). */
export function sevenZip(bin = process.env.MARQUEE_UNPACK_BIN || '7zz'): Unpacker {
  return {
    async list(archive) {
      const r = await run(bin, ['l', '-slt', '-sccUTF-8', NO_PASSWORD, '--', archive], 120_000);
      if (r.code !== 0) throw sevenZipProblem(r.out);
      return parseSevenZipList(r.out);
    },
    async extract(archive, dest) {
      await fs.mkdir(dest, { recursive: true });
      const r = await run(bin, ['x', '-y', '-aoa', '-bd', '-sccUTF-8', NO_PASSWORD, `-o${dest}`, '--', archive]);
      // 1 is a warning (like extra bytes after the end), which still unpacks everything.
      if (r.code !== 0 && r.code !== 1) throw sevenZipProblem(r.out);
    },
    async check() {
      try {
        const r = await run(bin, ['i'], 15_000);
        const v = /7-Zip[^0-9]*(\d+\.\d+)/.exec(r.out);
        if (r.code === 0 && v) return { ok: true, version: `7-Zip ${v[1]}` };
        return { ok: false, message: `${bin} answered, but not like 7-Zip. Set MARQUEE_UNPACK_BIN to 7-Zip’s 7zz.` };
      } catch (err) {
        return { ok: false, message: (err as Error).message };
      }
    },
  };
}
