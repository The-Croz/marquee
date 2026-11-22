import fs from 'node:fs/promises';
import path from 'node:path';
import { UnpackError, unpackText, type ArchiveEntry, type Unpacker } from '../../src/downloads/unpack.js';

/**
 * A fake 7-Zip for route tests and demo mode. A fake ".rar" file holds JSON
 * saying what's inside (see `fakeRar`); unpacking makes those files, sparse,
 * at their sizes. A file that isn't such JSON is "damaged".
 */
export class FakeUnpacker implements Unpacker {
  /** Pretend the tool isn't installed. */
  missing = false;
  /** Make every unpack fail this way. */
  failExtract: UnpackError | null = null;
  /** How long each unpack takes (demo mode shows "Finished · unpacking"). */
  delayMs = 0;
  /** Each archive unpacked, with where to. */
  extracted: { archive: string; dest: string }[] = [];

  async list(archive: string): Promise<ArchiveEntry[]> {
    if (this.missing) throw new UnpackError('no_tool', unpackText('no_tool'));
    const text = await fs.readFile(archive, 'utf8').catch(() => {
      throw new UnpackError('missing_part', unpackText('missing_part', `${path.basename(archive)} isn’t there`));
    });
    try {
      return (JSON.parse(text) as { entries: ArchiveEntry[] }).entries;
    } catch {
      throw new UnpackError('broken', unpackText('broken', 'it isn’t a readable archive'));
    }
  }

  async extract(archive: string, dest: string): Promise<void> {
    const entries = await this.list(archive);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failExtract) throw this.failExtract;
    this.extracted.push({ archive, dest });
    for (const e of entries) {
      const p = path.join(dest, e.name);
      if (e.folder) {
        await fs.mkdir(p, { recursive: true });
        continue;
      }
      await fs.mkdir(path.dirname(p), { recursive: true });
      const fh = await fs.open(p, 'w');
      await fh.truncate(e.size);
      await fh.close();
    }
  }

  async check() {
    return this.missing ? { ok: false as const, message: 'spawn 7zz ENOENT' } : { ok: true as const, version: '7-Zip 26.06' };
  }
}

/** The text of a fake .rar holding these files. */
export function fakeRar(entries: { name: string; size: number; encrypted?: boolean; folder?: boolean }[]): string {
  return JSON.stringify({ entries: entries.map((e) => ({ encrypted: false, folder: false, ...e })) });
}
