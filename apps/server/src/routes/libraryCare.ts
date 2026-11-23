import { Hono } from 'hono';
import { eq, like, or } from 'drizzle-orm';
import { z } from 'zod';
import type { BrowseView, ImportItemResult, ImportScanView, LeftOutItem, RemovalPreview, RemovalResult, RenamePlanView, RenameResult, RenameRunView } from '@marquee/shared';
import { leftOut, movies, series, tmdbCache } from '../db/schema.js';
import { HttpError, requireAdmin, type Ctx, type Env } from '../http.js';
import { leftOutList, removalPreview, removeTitle } from '../library/remove.js';
import { applyRenames, planRenames, renameRuns, undoRename } from '../library/rename.js';
import { browse, importFiles, scanForImport } from '../library/manualImport.js';
import { lookNow } from '../library/lookNow.js';
import { scanSources } from './library.js';

/**
 * Looking after the library by hand (admins): remove a title, rename files
 * to Marquee's names (preview first, undo after), put files in the library
 * yourself, refresh a title from TMDB, and "Look for these".
 */

const id = (c: Ctx) => Number(c.req.param('id'));
const idsBody = z.object({ ids: z.array(z.number().int().positive()).min(1).max(500) });
const removal = z.object({
  deleteFiles: z.array(z.string().min(1)).max(5000).optional(),
  leaveOut: z.boolean().default(false),
  onTheWay: z.enum(['remove', 'leave']).default('remove'),
});

/** Asks TMDB again for one title, skipping what Marquee kept from earlier, and keeps its folder, profile and Wanted. */
async function refresh(c: Ctx, kind: 'movie' | 'series') {
  requireAdmin(c);
  const { db, scanner, now } = c.get('deps');
  const row = kind === 'movie' ? db.select().from(movies).where(eq(movies.id, id(c))).get() : db.select().from(series).where(eq(series.id, id(c))).get();
  if (!row) throw new HttpError(404, 'not_found', kind === 'movie' ? 'That movie isn’t in your library.' : 'That show isn’t in your library.');
  const { tmdb } = scanSources(c);
  const prefix = `/${kind === 'movie' ? 'movie' : 'tv'}/${row.tmdbId}`;
  db.delete(tmdbCache).where(or(like(tmdbCache.key, `${prefix}?%`), like(tmdbCache.key, `${prefix}/%`))).run();
  try {
    if (kind === 'movie') await scanner.upsertMovie(tmdb, row.tmdbId, null, now());
    else await scanner.upsertSeries(tmdb, row.tmdbId, null, now());
  } catch (err) {
    throw new HttpError(502, 'tmdb_failed', `TMDB didn’t answer (${(err as Error).message}). Try again in a minute.`);
  }
  return c.json({ ok: true, message: 'Up to date with TMDB: title, artwork, dates, age rating' + (kind === 'series' ? ' and episodes.' : '.') });
}

function titleRoutes(kind: 'movie' | 'series') {
  const r = new Hono<Env>();
  r.post('/look-now', async (c) => {
    requireAdmin(c);
    const { ids } = idsBody.parse(await c.req.json());
    return c.json(lookNow(c.get('deps'), kind, ids), 202);
  });
  r.post('/:id{[0-9]+}/refresh', (c) => refresh(c, kind));
  r.get('/:id{[0-9]+}/removal', async (c) => {
    requireAdmin(c);
    const { db, now } = c.get('deps');
    return c.json<RemovalPreview>(await removalPreview(db, kind, id(c), now()));
  });
  r.post('/:id{[0-9]+}/remove', async (c) => {
    const user = requireAdmin(c);
    const input = removal.parse(await c.req.json());
    return c.json<RemovalResult>(await removeTitle(c.get('deps'), kind, id(c), input, user.id));
  });
  return r;
}

export const movieCareRoutes = titleRoutes('movie');
export const showCareRoutes = titleRoutes('series');

export const libraryCareRoutes = new Hono<Env>();

// ---------------- Left out of scans ----------------

libraryCareRoutes.get('/left-out', (c) => {
  requireAdmin(c);
  return c.json<{ items: LeftOutItem[] }>({ items: leftOutList(c.get('deps').db) });
});

/** "Let it back in": the next scan adds it again. */
libraryCareRoutes.delete('/left-out/:id{[0-9]+}', (c) => {
  requireAdmin(c);
  const r = c.get('deps').db.delete(leftOut).where(eq(leftOut.id, id(c))).run();
  if (!r.changes) throw new HttpError(404, 'not_found', 'That title isn’t left out any more.');
  return c.json({ ok: true, message: 'The next library scan adds it again.' });
});

// ---------------- Rename files ----------------

const renameKind = z.enum(['movie', 'tv']);

libraryCareRoutes.get('/rename', async (c) => {
  requireAdmin(c);
  const q = z.object({ kind: renameKind, id: z.coerce.number().int().positive().optional() }).parse(c.req.query());
  return c.json<RenamePlanView>(await planRenames(c.get('deps').db, q.kind, q.id));
});

libraryCareRoutes.post('/rename', async (c) => {
  const user = requireAdmin(c);
  const body = z
    .object({
      kind: renameKind,
      id: z.number().int().positive().optional(),
      moves: z.array(z.object({ from: z.string().min(1), to: z.string().min(1) })).min(1).max(100_000),
    })
    .parse(await c.req.json());
  return c.json<RenameResult>(await applyRenames(c.get('deps'), body.kind, body.id, body.moves, user.id));
});

libraryCareRoutes.get('/renames', (c) => {
  requireAdmin(c);
  const kind = renameKind.optional().parse(c.req.query('kind') || undefined);
  return c.json<{ items: RenameRunView[] }>({ items: renameRuns(c.get('deps').db, kind) });
});

libraryCareRoutes.post('/renames/:id{[0-9]+}/undo', async (c) => {
  const user = requireAdmin(c);
  return c.json<RenameResult>(await undoRename(c.get('deps'), id(c), user.id));
});

// ---------------- Put files in your library ----------------

libraryCareRoutes.get('/import/browse', async (c) => {
  requireAdmin(c);
  return c.json<BrowseView>(await browse(c.get('deps').db, c.req.query('path') || null));
});

libraryCareRoutes.get('/import/scan', async (c) => {
  requireAdmin(c);
  const folder = z.string().min(1, 'Pick a folder first.').parse(c.req.query('path') ?? '');
  let tmdb = null;
  try {
    tmdb = scanSources(c).tmdb;
  } catch {
    // No TMDB key: guesses come from your library only.
  }
  return c.json<ImportScanView>(await scanForImport(c.get('deps').db, tmdb, folder));
});

libraryCareRoutes.post('/import', async (c) => {
  const user = requireAdmin(c);
  const { items } = z
    .object({
      items: z
        .array(
          z.object({
            path: z.string().min(1),
            kind: z.enum(['movie', 'series']),
            tmdbId: z.number().int().positive(),
            season: z.number().int().min(0).max(1000).optional(),
            episodes: z.array(z.number().int().min(0).max(10_000)).max(50).optional(),
          }),
        )
        .min(1, 'Pick at least one file.')
        .max(500),
    })
    .parse(await c.req.json());
  const deps = c.get('deps');
  return c.json<{ results: ImportItemResult[] }>({ results: await importFiles({ ...deps, tmdb: () => scanSources(c).tmdb }, items, user.id) });
});
