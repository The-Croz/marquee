import fs from 'node:fs/promises';
import path from 'node:path';
import type { ReplacedView } from '@marquee/shared';
import type { Db } from '../db/index.js';
import { REPLACED_FOLDER } from '../downloads/importer.js';
import { libraryRoots } from './services.js';

/**
 * The hidden `.marquee-replaced` folder in each library folder holds the
 * files upgrades set aside. Nothing empties it by itself: Settings → Health
 * shows how much it holds and what emptying it would give back, and Empty
 * (behind a confirm) deletes what's in it.
 *
 * A set-aside file can still be shared by a download in qBittorrent (it's a
 * hardlink to it), so deleting it frees no space until that download goes.
 */

async function measure(dir: string): Promise<{ files: number; bytes: number; freedBytes: number }> {
  const out = { files: 0, bytes: 0, freedBytes: 0 };
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = await measure(p);
      out.files += sub.files;
      out.bytes += sub.bytes;
      out.freedBytes += sub.freedBytes;
    } else if (e.isFile()) {
      const st = await fs.stat(p).catch(() => null);
      if (!st) continue;
      out.files++;
      out.bytes += st.size;
      if (st.nlink <= 1) out.freedBytes += st.size;
    }
  }
  return out;
}

function folders(db: Db): { label: string; path: string }[] {
  const roots = libraryRoots(db);
  return [
    { label: 'Movies', path: path.join(roots.movies, REPLACED_FOLDER) },
    { label: 'TV', path: path.join(roots.tv, REPLACED_FOLDER) },
  ];
}

export async function replacedView(db: Db): Promise<ReplacedView> {
  const list = await Promise.all(folders(db).map(async (f) => ({ ...f, ...(await measure(f.path)) })));
  return {
    folders: list,
    files: list.reduce((n, f) => n + f.files, 0),
    bytes: list.reduce((n, f) => n + f.bytes, 0),
    freedBytes: list.reduce((n, f) => n + f.freedBytes, 0),
  };
}

/** Deletes everything in both replaced folders. Only ever by hand. */
export async function emptyReplaced(db: Db): Promise<{ files: number; bytes: number; problems: string[] }> {
  const before = await replacedView(db);
  const problems: string[] = [];
  for (const f of folders(db)) {
    try {
      await fs.rm(f.path, { recursive: true, force: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      problems.push(`Couldn’t empty ${f.path} (${code === 'EACCES' || code === 'EPERM' ? 'Marquee isn’t allowed to: check the PUID and PGID in the container settings' : (code ?? (err as Error).message)}).`);
    }
  }
  const after = await replacedView(db);
  return { files: before.files - after.files, bytes: before.bytes - after.bytes, problems };
}
