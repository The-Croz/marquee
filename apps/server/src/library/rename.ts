import fs from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { RenameMove, RenamePlanView, RenameResult, RenameRunView, RenameTitlePlan } from '@marquee/shared';
import type { Db } from '../db/index.js';
import { downloads, episodes, history, mediaFiles, movies, renames, series, users } from '../db/schema.js';
import { HttpError, type Deps } from '../http.js';
import { parseRelease } from '../releases/parse.js';
import { extrasNames, subtitlesBeside } from './extras.js';
import { tellMediaServers } from './mediaServers.js';
import { hdrLabel, renderName } from './naming.js';
import { pruneEmpty, pruneTree } from './remove.js';
import { libraryRoots, readNaming } from './services.js';

/**
 * "Rename files": gives files already in the library Marquee's names (the
 * pattern in Settings → Services), for one title or a whole library. Never
 * automatic, always previewed first (old → new), and only what the preview
 * showed is moved. A rename is a move on the same disk, never a copy.
 *
 * When a title's folder gets a new name, everything in the old folder comes
 * along (posters, extras, subtitles), so nothing is left behind. Subtitles
 * beside a video are renamed to match it, keeping their language tags.
 * Every move is recorded, so a whole run can be undone.
 */

type Kind = 'movie' | 'tv';
type TitleKind = 'movie' | 'series';
interface FileMove {
  from: string;
  to: string;
}
interface TitleChange {
  kind: TitleKind;
  id: number;
  from: string | null;
  to: string | null;
}
interface RunRecord {
  files: FileMove[];
  /** Titles whose folder changed. */
  titles: TitleChange[];
  /** Every title with a file renamed, for the History when it's undone. */
  touched?: { kind: TitleKind; id: number; title: string }[];
}

const stem = (p: string) => path.basename(p, path.extname(p));
const exists = (p: string) => fs.stat(p).then((s) => s, () => null);

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

interface Video {
  from: string;
  to: string;
}

/** One title's moves: its videos to their new names, their subtitles beside them, and the rest of its folder along with it. */
async function planTitle(
  t: { kind: TitleKind; id: number; title: string; path: string | null },
  root: string,
  videos: Video[],
  claimed: Set<string>,
  otherFolders: Set<string>,
): Promise<{ plan: RenameTitlePlan; right: number }> {
  const plan: RenameTitlePlan = { kind: t.kind, id: t.id, title: t.title, folderFrom: t.path, folderTo: t.path, moves: [], skipped: [] };
  let right = 0;
  const segs = path.relative(root, videos[0]!.to).split(path.sep);
  const newFolder = segs.length > 1 ? path.join(root, segs[0]!) : null;
  const oldStat = t.path ? await exists(t.path) : null;
  const oldIsFolder = !!t.path && !!oldStat?.isDirectory() && path.dirname(t.path) === root;
  const moveFolder = oldIsFolder && newFolder !== null && newFolder !== t.path;
  if (newFolder) plan.folderTo = newFolder;
  if (moveFolder && otherFolders.has(newFolder!)) {
    plan.skipped.push({ path: t.path!, reason: `Another title already uses the folder ${newFolder}, so nothing here was renamed.` });
    plan.folderTo = t.path;
    return { plan, right: 0 };
  }

  const perDir = new Map<string, number>();
  for (const v of videos) perDir.set(path.dirname(v.from), (perDir.get(path.dirname(v.from)) ?? 0) + 1);
  const handled = new Set<string>();
  const dirMap = new Map<string, string>();
  const groups: RenameMove[][] = [];
  for (const v of videos) {
    handled.add(v.from);
    if (!dirMap.has(path.dirname(v.from))) dirMap.set(path.dirname(v.from), path.dirname(v.to));
    const group: RenameMove[] = [];
    if (v.from !== v.to) group.push({ from: v.from, to: v.to, what: 'video' });
    else right++;
    const subs = await subtitlesBeside(v.from, perDir.get(path.dirname(v.from)) === 1);
    for (const x of extrasNames(subs, stem(v.from), stem(v.to))) {
      handled.add(x.from);
      const to = path.join(path.dirname(v.to), x.name);
      if (x.from !== to) group.push({ from: x.from, to, what: 'subtitle' });
    }
    groups.push(group);
  }

  // A video that can't have its new name: the whole title is left as it is, so it isn't split over two folders.
  const local = new Set<string>();
  for (const g of groups) {
    for (const m of g) {
      if (m.what !== 'video') continue;
      const why = await blocked(m, claimed, local);
      if (why) plan.skipped.push({ path: m.from, reason: why });
      local.add(m.to);
    }
  }
  if (plan.skipped.length) {
    plan.folderTo = t.path;
    return { plan, right };
  }
  for (const g of groups) {
    for (const m of g) {
      const why = m.what === 'video' ? null : await blocked(m, claimed, local);
      if (why) plan.skipped.push({ path: m.from, reason: why });
      else plan.moves.push(m);
      local.add(m.to);
    }
  }

  // Everything else in the old folder comes along: posters, extras, a Subs folder.
  if (moveFolder) {
    for (const file of await walk(t.path!)) {
      if (handled.has(file)) continue;
      const dir = path.dirname(file);
      const to = path.join(dirMap.get(dir) ?? path.join(newFolder!, path.relative(t.path!, dir)), path.basename(file));
      const m: RenameMove = { from: file, to, what: 'other' };
      const why = await blocked(m, claimed, local);
      if (why) plan.skipped.push({ path: file, reason: why });
      else plan.moves.push(m);
      local.add(to);
    }
  }
  for (const to of local) claimed.add(to);
  if (!plan.moves.length) plan.folderTo = t.path;
  return { plan, right };
}

/** Why a move can't happen, or null. Case-only changes of the same file are fine. */
async function blocked(m: { from: string; to: string }, claimed: Set<string>, local: Set<string>): Promise<string | null> {
  if (claimed.has(m.to) || local.has(m.to)) return 'Two files would get the same name, so this one is left as it is.';
  const [a, b] = await Promise.all([exists(m.from), exists(m.to)]);
  if (b && !(a && a.ino === b.ino && a.dev === b.dev)) return `Another file already has the name ${path.basename(m.to)}, so this one is left as it is.`;
  return null;
}

function movieVideos(db: Db, m: typeof movies.$inferSelect, root: string, pattern: string): Video[] {
  const files = db.select({ path: mediaFiles.path }).from(mediaFiles).where(eq(mediaFiles.movieId, m.id)).all();
  const folder = parseRelease(m.path ? path.basename(m.path) : '');
  return files.map((f) => {
    const p = parseRelease(stem(f.path));
    const q = p.resolution ? p : folder.resolution ? folder : p;
    const rel = renderName(pattern, {
      Title: m.title, Year: m.year, TmdbId: m.tmdbId, ImdbId: m.imdbId, Quality: q.quality === 'Unknown' ? null : q.quality, HDR: hdrLabel(q.hdr),
      Edition: p.editions[0] ?? folder.editions[0] ?? null, Group: p.group ?? folder.group,
    });
    return { from: f.path, to: path.join(root, rel + path.extname(f.path).toLowerCase()) };
  });
}

function showVideos(db: Db, s: typeof series.$inferSelect, root: string, pattern: string): Video[] {
  const files = db.select().from(mediaFiles).where(eq(mediaFiles.seriesId, s.id)).all();
  const titles = new Map(db.select().from(episodes).where(eq(episodes.seriesId, s.id)).all().map((e) => [`${e.season}:${e.episode}`, e.title]));
  return files
    .filter((f) => f.season !== null && (JSON.parse(f.episodes ?? '[]') as number[]).length > 0)
    .map((f) => {
      const eps = JSON.parse(f.episodes!) as number[];
      const names = eps.map((e) => titles.get(`${f.season}:${e}`)).filter(Boolean);
      const p = parseRelease(stem(f.path));
      const rel = renderName(pattern, {
        Show: s.title, Year: s.year, TvdbId: s.tvdbId, TmdbId: s.tmdbId, ImdbId: s.imdbId, Season: f.season, Episodes: eps,
        'Episode Title': names.length === 1 ? names[0] : names.length ? names.join(' + ') : null,
        Quality: p.quality === 'Unknown' ? null : p.quality, HDR: hdrLabel(p.hdr), Group: p.group,
      });
      return { from: f.path, to: path.join(root, rel + path.extname(f.path).toLowerCase()) };
    });
}

/** Every change a rename would make, for one title (`only`) or the whole movie or TV library. Touches nothing. */
export async function planRenames(db: Db, kind: Kind, only?: number): Promise<RenamePlanView> {
  const roots = libraryRoots(db);
  const root = kind === 'movie' ? roots.movies : roots.tv;
  const naming = readNaming(db);
  const pattern = kind === 'movie' ? naming.movie : naming.tv;
  const table = kind === 'movie' ? movies : series;
  const all = db.select({ id: table.id, path: table.path }).from(table).where(isNotNull(table.path)).all();
  const claimed = new Set<string>();
  const out: RenamePlanView = { kind, titles: [], alreadyRight: 0, pattern };
  const rows = kind === 'movie' ? db.select().from(movies).where(only ? eq(movies.id, only) : undefined).all() : db.select().from(series).where(only ? eq(series.id, only) : undefined).all();
  if (only && !rows.length) throw new HttpError(404, 'not_found', kind === 'movie' ? 'That movie isn’t in your library.' : 'That show isn’t in your library.');
  for (const row of rows.sort((a, b) => a.sortTitle.localeCompare(b.sortTitle))) {
    const videos = kind === 'movie' ? movieVideos(db, row as typeof movies.$inferSelect, root, pattern) : showVideos(db, row as typeof series.$inferSelect, root, pattern);
    if (!videos.length) continue;
    const others = new Set(all.filter((r) => r.id !== row.id).map((r) => r.path!));
    const label = row.year ? `${row.title} (${row.year})` : row.title;
    const { plan, right } = await planTitle({ kind: kind === 'movie' ? 'movie' : 'series', id: row.id, title: label, path: row.path }, root, videos, claimed, others);
    out.alreadyRight += right;
    if (plan.moves.length || plan.skipped.length) out.titles.push(plan);
  }
  return out;
}

/**
 * Makes the moves you agreed to in the preview. Each title is all or none:
 * the preview is worked out again and every move sent must still match it,
 * so nothing moves that you didn't see.
 */
export async function applyRenames(deps: Deps, kind: Kind, only: number | undefined, agreed: FileMove[], userId: number): Promise<RenameResult> {
  const { db, now } = deps;
  const roots = libraryRoots(db);
  const root = kind === 'movie' ? roots.movies : roots.tv;
  const plan = await planRenames(db, kind, only);
  const byFrom = new Map(plan.titles.flatMap((t) => t.moves.map((m) => [m.from, { t, m }] as const)));
  const titles = new Set<RenameTitlePlan>();
  for (const a of agreed) {
    const hit = byFrom.get(a.from);
    if (!hit || hit.m.to !== a.to) throw new HttpError(409, 'plan_changed', 'Something changed since the preview. Look at the preview again before renaming.');
    titles.add(hit.t);
  }
  const sent = new Set(agreed.map((a) => a.from));
  for (const t of titles) if (t.moves.some((m) => !sent.has(m.from))) throw new HttpError(400, 'whole_titles', `Rename all of ${t.title}’s files or none of them.`);
  if (!titles.size) return { run: null, moved: 0, problems: [], message: 'Nothing to rename.' };

  const record: RunRecord = { files: [], titles: [], touched: [] };
  const problems: string[] = [];
  const folders = new Set<string>();
  for (const t of titles) {
    const done: FileMove[] = [];
    for (const m of t.moves) {
      try {
        await fs.mkdir(path.dirname(m.to), { recursive: true });
        await fs.rename(m.from, m.to);
        done.push({ from: m.from, to: m.to });
      } catch (err) {
        problems.push(`${path.basename(m.from)}: ${moveProblem(err, m.from, m.to)}`);
      }
    }
    record.files.push(...done);
    movePaths(db, done);
    const change = moveTitle(db, t, done);
    if (change) record.titles.push(change);
    if (t.folderFrom && t.folderFrom !== t.folderTo) await pruneTree(t.folderFrom, root);
    for (const d of new Set(done.map((m) => path.dirname(m.from)))) await pruneEmpty(d, root);
    for (const f of [t.folderFrom, t.folderTo]) if (f) folders.add(f);
    if (done.length) {
      record.touched!.push({ kind: t.kind, id: t.id, title: t.title });
      const videos = done.filter((m) => t.moves.find((x) => x.from === m.from)?.what === 'video').length;
      const detail = [
        `Renamed ${videos} ${videos === 1 ? 'video' : 'videos'} to Marquee’s names${done.length > videos ? `, and moved ${done.length - videos} other ${done.length - videos === 1 ? 'file' : 'files'} along` : ''}.`,
        t.folderFrom !== t.folderTo && t.folderTo ? `Folder: ${path.basename(t.folderFrom ?? '')} → ${path.basename(t.folderTo)}.` : null,
      ].filter(Boolean).join(' ');
      db.insert(history).values({ at: now(), event: 'renamed', kind, movieId: t.kind === 'movie' ? t.id : null, seriesId: t.kind === 'series' ? t.id : null, title: t.title, detail, userId }).run();
    }
  }
  const label = titles.size === 1 ? [...titles][0]!.title : `${titles.size} ${kind === 'movie' ? 'movies' : 'shows'}`;
  const row = record.files.length ? db.insert(renames).values({ at: now(), kind, label, moves: JSON.stringify(record), userId }).returning().get() : null;
  const told = record.files.length ? await tellServers(deps, kind, root, [...folders]) : '';
  const n = record.files.length;
  return {
    run: row ? runView(db, row) : null,
    moved: n,
    problems,
    message: n ? `Renamed ${n} ${n === 1 ? 'file' : 'files'} in ${label}.${told}` : 'Nothing could be renamed.',
  };
}

function moveProblem(err: unknown, from: string, to: string): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'EXDEV') return `It’s on a different disk from ${path.dirname(to)}. Marquee only renames on the same disk, so it was left as it is.`;
  if (code === 'EACCES' || code === 'EPERM') return `Marquee isn’t allowed to move it. Check the PUID and PGID in the container settings match the owner of your data share.`;
  if (code === 'ENOENT') return `It isn’t at ${from} any more, so it was left out.`;
  return `Couldn’t move it (${code ?? (err as Error).message}).`;
}

/** Keeps Marquee's records (library files, and what each download became) pointing at the files' new names. */
function movePaths(db: Db, moved: FileMove[]): void {
  if (!moved.length) return;
  const to = new Map(moved.map((m) => [m.from, m.to]));
  for (const m of moved) db.update(mediaFiles).set({ path: m.to }).where(eq(mediaFiles.path, m.from)).run();
  for (const d of db.select({ id: downloads.id, paths: downloads.importedPaths }).from(downloads).where(isNotNull(downloads.importedPaths)).all()) {
    const paths = JSON.parse(d.paths!) as string[];
    if (!paths.some((p) => to.has(p))) continue;
    db.update(downloads).set({ importedPaths: JSON.stringify(paths.map((p) => to.get(p) ?? p)) }).where(eq(downloads.id, d.id)).run();
  }
}

/** The title's folder becomes the new one once something has moved into it. */
function moveTitle(db: Db, t: RenameTitlePlan, done: FileMove[]): TitleChange | null {
  if (!done.length) return null;
  let to = t.folderTo;
  // A loose file with no folder in the pattern: the title's "folder" is the file itself.
  if (!to || to === t.folderFrom) {
    const self = done.find((m) => m.from === t.folderFrom);
    if (!self) return null;
    to = self.to;
  }
  if (to === t.folderFrom) return null;
  const table = t.kind === 'movie' ? movies : series;
  db.update(table).set({ path: to }).where(eq(table.id, t.id)).run();
  return { kind: t.kind, id: t.id, from: t.folderFrom, to };
}

async function tellServers(deps: Deps, kind: Kind, root: string, folders: string[]): Promise<string> {
  // Many titles at once: one scan of the whole library is kinder than hundreds.
  const r = await tellMediaServers(deps.db, deps.clients, kind, folders.length > 20 ? [root] : folders);
  return [r.told.length ? ` Told ${r.told.join(' and ')}.` : '', ...r.failed.map((f) => ` ${f}`)].join('');
}

function runView(db: Db, r: typeof renames.$inferSelect): RenameRunView {
  const who = r.userId ? (db.select({ n: users.displayName }).from(users).where(eq(users.id, r.userId)).get()?.n ?? null) : null;
  return { id: r.id, at: r.at, kind: r.kind, label: r.label, files: (JSON.parse(r.moves) as RunRecord).files.length, who, undoneAt: r.undoneAt };
}

/** Recent rename runs, newest first, with Undo for the ones not undone yet. */
export function renameRuns(db: Db, kind?: Kind): RenameRunView[] {
  return db
    .select()
    .from(renames)
    .where(kind ? eq(renames.kind, kind) : undefined)
    .orderBy(desc(renames.at), desc(renames.id))
    .limit(20)
    .all()
    .map((r) => runView(db, r));
}

/** Puts every file of a rename run back where it was, newest move first. Files moved since are left alone. */
export async function undoRename(deps: Deps, id: number, userId: number): Promise<RenameResult> {
  const { db, now } = deps;
  const row = db.select().from(renames).where(eq(renames.id, id)).get();
  if (!row) throw new HttpError(404, 'not_found', 'There’s no rename with that number.');
  if (row.undoneAt) throw new HttpError(409, 'already_undone', 'That rename was already undone.');
  const roots = libraryRoots(db);
  const root = row.kind === 'movie' ? roots.movies : roots.tv;
  const rec = JSON.parse(row.moves) as RunRecord;
  const back: FileMove[] = [];
  const problems: string[] = [];
  for (const m of [...rec.files].reverse()) {
    if (!(await exists(m.to)) || (await exists(m.from))) {
      problems.push(`${path.basename(m.to)} isn’t where the rename put it any more (or something else has its old name), so it was left as it is.`);
      continue;
    }
    try {
      await fs.mkdir(path.dirname(m.from), { recursive: true });
      await fs.rename(m.to, m.from);
      back.push({ from: m.to, to: m.from });
    } catch (err) {
      problems.push(`${path.basename(m.to)}: ${moveProblem(err, m.to, m.from)}`);
    }
  }
  movePaths(db, back);
  for (const t of rec.titles) {
    const table = t.kind === 'movie' ? movies : series;
    db.update(table).set({ path: t.from }).where(and(eq(table.id, t.id), eq(table.path, t.to!))).run();
    if (t.to) await pruneTree(t.to, root);
  }
  for (const d of new Set(back.map((m) => path.dirname(m.from)))) await pruneEmpty(d, root);
  db.update(renames).set({ undoneAt: now() }).where(eq(renames.id, id)).run();
  for (const t of rec.touched ?? []) {
    const alive = !!db.select({ id: (t.kind === 'movie' ? movies : series).id }).from(t.kind === 'movie' ? movies : series).where(eq((t.kind === 'movie' ? movies : series).id, t.id)).get();
    db.insert(history).values({ at: now(), event: 'renamed', kind: row.kind, movieId: alive && t.kind === 'movie' ? t.id : null, seriesId: alive && t.kind === 'series' ? t.id : null, title: t.title, detail: 'Undid a rename: the files have their old names again.', userId }).run();
  }
  const folders = [...new Set(rec.titles.flatMap((t) => [t.from, t.to]).filter((f): f is string => !!f))];
  const told = back.length ? await tellServers(deps, row.kind, root, folders) : '';
  return { run: runView(db, db.select().from(renames).where(eq(renames.id, id)).get()!), moved: back.length, problems, message: `Put ${back.length} ${back.length === 1 ? 'file' : 'files'} back the way they were.${told}` };
}
