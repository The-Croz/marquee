import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { BackupKind, BackupView, BackupsView } from '@marquee/shared';
import { migrations, migrateNow, type Db } from '../db/index.js';
import { HttpError } from '../http.js';

/**
 * Backups of Marquee's database (one file holding everything: library,
 * profiles, Sources, requests, history, settings). A backup is taken every
 * night and kept 14 days, or whenever you press Back up now. Restoring one
 * takes a fresh backup first, so a restore can itself be undone.
 *
 * Backups use SQLite's online backup, so Marquee keeps running while one is taken.
 */

export const KEEP_DAYS = 14;
const DAY = 24 * 60 * 60 * 1000;
/** A nightly backup is due once the last one is this old. */
export const NIGHTLY_EVERY = DAY;

const NAME = /^marquee-(\d{8})-(\d{6})-(nightly|by-hand|before-restore)\.sqlite$/;
const KIND_IN_NAME: Record<BackupKind, string> = { nightly: 'nightly', by_hand: 'by-hand', before_restore: 'before-restore' };

export function backupFolder(dataDir: string): string {
  return path.join(dataDir, 'backups');
}

function stamp(ms: number): string {
  const iso = new Date(ms).toISOString(); // 2026-11-22T03:00:00.000Z
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
}

function parseName(name: string): { createdAt: number; kind: BackupKind } | null {
  const m = NAME.exec(name);
  if (!m) return null;
  const [, d, t, k] = m;
  const createdAt = Date.UTC(+d!.slice(0, 4), +d!.slice(4, 6) - 1, +d!.slice(6, 8), +t!.slice(0, 2), +t!.slice(2, 4), +t!.slice(4, 6));
  const kind = (Object.keys(KIND_IN_NAME) as BackupKind[]).find((x) => KIND_IN_NAME[x] === k)!;
  return { createdAt, kind };
}

export function listBackups(dataDir: string): BackupView[] {
  const dir = backupFolder(dataDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .flatMap((name) => {
      const p = parseName(name);
      if (!p) return [];
      const st = fs.statSync(path.join(dir, name));
      return [{ name, size: st.size, createdAt: p.createdAt, kind: p.kind }];
    })
    .sort((a, b) => b.createdAt - a.createdAt || b.name.localeCompare(a.name));
}

export function backupsView(dataDir: string, now: number): BackupsView {
  const backups = listBackups(dataDir);
  const lastNightly = backups.find((b) => b.kind === 'nightly')?.createdAt ?? null;
  return { folder: backupFolder(dataDir), keepDays: KEEP_DAYS, backups, lastNightly, nextNightly: lastNightly === null ? now : Math.max(now, lastNightly + NIGHTLY_EVERY) };
}

/** Takes a backup now. Returns it. */
export async function backUp(db: Db, dataDir: string, kind: BackupKind, now: number): Promise<BackupView> {
  const dir = backupFolder(dataDir);
  let name = `marquee-${stamp(now)}-${KIND_IN_NAME[kind]}.sqlite`;
  // Two in the same second (Back up now twice): step the time on a second.
  for (let n = 1; fs.existsSync(path.join(dir, name)); n++) name = `marquee-${stamp(now + n * 1000)}-${KIND_IN_NAME[kind]}.sqlite`;
  const file = path.join(dir, name);
  const part = `${file}.part`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    await db.$client.backup(part);
    fs.renameSync(part, file);
  } catch (err) {
    try {
      fs.rmSync(part, { force: true });
    } catch {
      /* nothing was written */
    }
    throw new Error(`Couldn’t write a backup in ${dir} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}). Check that folder has space and Marquee can write there.`);
  }
  return { name, size: fs.statSync(file).size, createdAt: parseName(name)!.createdAt, kind };
}

/** Deletes backups older than KEEP_DAYS, but always keeps the newest one. Returns how many went. */
export function pruneBackups(dataDir: string, now: number): number {
  const all = listBackups(dataDir);
  let removed = 0;
  for (const b of all.slice(1)) {
    if (now - b.createdAt > KEEP_DAYS * DAY) {
      fs.rmSync(path.join(backupFolder(dataDir), b.name), { force: true });
      removed++;
    }
  }
  return removed;
}

/** The nightly job: a backup when the last nightly one is a day old, then tidy old ones. */
export async function nightlyBackup(db: Db, dataDir: string, now: number): Promise<string> {
  const view = backupsView(dataDir, now);
  if (view.lastNightly !== null && now - view.lastNightly < NIGHTLY_EVERY - 60 * 60 * 1000) return 'Not due yet';
  const b = await backUp(db, dataDir, 'nightly', now);
  const removed = pruneBackups(dataDir, now);
  return `Backed up (${b.name})${removed ? `; removed ${removed} older than ${KEEP_DAYS} days` : ''}`;
}

/** The path of a backup by its name, or a 404. Names are checked, so no other file can be read. */
export function backupPath(dataDir: string, name: string): string {
  if (!parseName(name)) throw new HttpError(404, 'no_such_backup', 'There’s no backup with that name.');
  const file = path.join(backupFolder(dataDir), name);
  if (!fs.existsSync(file)) throw new HttpError(404, 'no_such_backup', 'That backup isn’t there any more.');
  return file;
}

/** Checks a backup file is a whole Marquee database this version can use. Returns its version. */
function checkBackup(file: string): number {
  let src: Database.Database;
  try {
    src = new Database(file, { readonly: true, fileMustExist: true });
  } catch {
    throw new HttpError(400, 'bad_backup', 'That file can’t be opened as a Marquee backup.');
  }
  try {
    const ok = (src.pragma('quick_check', { simple: true }) as string) === 'ok';
    if (!ok) throw new HttpError(400, 'bad_backup', 'That backup is damaged, so Marquee won’t restore it. Pick an older one.');
    const has = src.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
    if (!has) throw new HttpError(400, 'bad_backup', 'That file isn’t a Marquee backup.');
    const v = (src.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null }).v ?? 0;
    if (v > migrations.length) throw new HttpError(409, 'backup_too_new', 'That backup came from a newer Marquee. Update Marquee first, then restore it.');
    return v;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'bad_backup', 'That file can’t be read as a Marquee backup.');
  } finally {
    src.close();
  }
}

/**
 * Puts a backup's contents in place of the live database, in one go: either
 * everything is replaced or nothing is. A backup of how things are now is
 * taken first. An older backup is brought up to this version afterwards.
 */
export async function restoreBackup(db: Db, dataDir: string, name: string, now: number): Promise<{ restored: BackupView; safety: BackupView }> {
  const file = backupPath(dataDir, name);
  checkBackup(file);
  const restored = listBackups(dataDir).find((b) => b.name === name)!;
  const safety = await backUp(db, dataDir, 'before_restore', now);

  const sqlite = db.$client;
  sqlite.pragma('foreign_keys = OFF');
  try {
    sqlite.prepare('ATTACH DATABASE ? AS restore_from').run(file);
    try {
      sqlite.transaction(() => {
        type Obj = { type: string; name: string; sql: string | null };
        const mine = sqlite.prepare("SELECT type, name FROM main.sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'").all() as Obj[];
        for (const o of mine) sqlite.exec(`DROP ${o.type === 'view' ? 'VIEW' : 'TABLE'} IF EXISTS main."${o.name.replace(/"/g, '""')}"`);
        const theirs = sqlite.prepare("SELECT type, name, sql FROM restore_from.sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END").all() as Obj[];
        for (const o of theirs) {
          sqlite.exec(o.sql!);
          if (o.type === 'table') {
            const q = `"${o.name.replace(/"/g, '""')}"`;
            sqlite.exec(`INSERT INTO main.${q} SELECT * FROM restore_from.${q}`);
          }
        }
        const seq = sqlite.prepare("SELECT 1 FROM restore_from.sqlite_master WHERE name = 'sqlite_sequence'").get();
        const seqHere = sqlite.prepare("SELECT 1 FROM main.sqlite_master WHERE name = 'sqlite_sequence'").get();
        if (seq && seqHere) {
          sqlite.exec('DELETE FROM main.sqlite_sequence');
          sqlite.exec('INSERT INTO main.sqlite_sequence SELECT * FROM restore_from.sqlite_sequence');
        }
      })();
    } finally {
      sqlite.exec('DETACH DATABASE restore_from');
    }
  } finally {
    sqlite.pragma('foreign_keys = ON');
  }
  migrateNow(db);
  return { restored, safety };
}
