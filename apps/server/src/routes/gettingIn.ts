import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { CollectionView, ListChoiceResult, ListItemView, ListsView, ListView } from '@marquee/shared';
import { setSetting } from '../db/index.js';
import { importLists, listExclusions, series, users } from '../db/schema.js';
import { HttpError, requireAdmin, requireUser, type Ctx, type Deps, type Env } from '../http.js';
import { collectionView, followCollections, getCollection, stopFollowing, wantCollection } from '../library/collections.js';
import { chooseFromList, listItemsView, listsView, listView, parseListUrl, realListFetch, syncDueLists, syncList, TRAKT_KEY, type ListDeps } from '../library/lists.js';
import { applyShowPreset, SHOW_PRESETS, type ShowPreset } from '../library/showPresets.js';
import { createRequest } from '../requests/service.js';
import { scanSourcesFor } from './library.js';

/**
 * Getting titles in: movie collections, lists (Plex watchlists, Trakt, IMDb,
 * Letterboxd) and a show's "which episodes" choice.
 */

const notify = (d: Deps) => ({ db: d.db, push: d.clients.push, now: d.now, baseUrl: () => d.config.baseUrl ?? null });

export function listDepsFor(d: Deps): ListDeps {
  return {
    db: d.db,
    tmdb: () => scanSourcesFor(d).tmdb,
    scanner: d.scanner,
    fetchPage: d.clients.listFetch ?? realListFetch,
    request: (user, input) => createRequest({ db: d.db, scanner: d.scanner, tmdb: scanSourcesFor(d).tmdb, clients: d.clients, sources: d.sources, notify: notify(d), now: d.now }, user, input),
    now: d.now,
  };
}

/** The background jobs for this: lists and collections. */
export function addGettingInJobs(d: Deps): void {
  if (!d.jobs.has('lists')) {
    d.jobs.add({
      id: 'lists',
      label: 'Sync lists',
      description: 'Reads Plex watchlists every 15 minutes (new titles become that person’s requests) and Trakt, IMDb and Letterboxd lists every 6 hours (new titles are added as Wanted).',
      everyMs: 5 * 60_000,
      firstAfterMs: 2 * 60_000,
      off: () => (d.db.select({ id: importLists.id }).from(importLists).where(eq(importLists.enabled, true)).get() ? null : 'No lists yet. Add one in Settings → Lists.'),
      run: async () => {
        const r = await syncDueLists(listDepsFor(d));
        if (r.problems.length && !r.added) throw new Error(r.problems.join(' · '));
        return r.synced ? `Read ${r.synced} ${r.synced === 1 ? 'list' : 'lists'}, ${r.added} new${r.problems.length ? `; ${r.problems.join(' · ')}` : ''}` : 'Nothing was due';
      },
    });
  }
  if (!d.jobs.has('collections')) {
    d.jobs.add({
      id: 'collections',
      label: 'Follow collections',
      description: 'Once a day, adds new films to collections you want as a whole (as Wanted).',
      everyMs: 24 * 3_600_000,
      firstAfterMs: 20 * 60_000,
      run: async () => {
        const r = await followCollections({ db: d.db, tmdb: scanSourcesFor(d).tmdb, scanner: d.scanner, now: d.now });
        if (r.problems.length && !r.checked) throw new Error(r.problems.join(' · '));
        return `Checked ${r.checked}, added ${r.added}${r.problems.length ? `; ${r.problems.join(' · ')}` : ''}`;
      },
    });
  }
}

// ---------------------------------------------------------------- collections

export const collectionRoutes = new Hono<Env>();
const tmdbIdParam = (c: Ctx) => {
  const n = Number(c.req.param('id'));
  if (!Number.isInteger(n) || n < 1) throw new HttpError(404, 'not_found', 'No such collection.');
  return n;
};

collectionRoutes.get('/:id', async (c) => {
  const user = requireUser(c);
  const d = c.get('deps');
  const row = await getCollection({ db: d.db, tmdb: scanSourcesFor(d).tmdb, now: d.now }, tmdbIdParam(c));
  return c.json<CollectionView>(collectionView(d.db, row, d.now(), user.role === 'kid'));
});

/** Want the whole collection: adds the films you don't have as Wanted; with `followNew`, new ones too. */
collectionRoutes.post('/:id/want', async (c) => {
  requireAdmin(c);
  const { followNew } = z.object({ followNew: z.boolean().default(true) }).parse(await c.req.json());
  const d = c.get('deps');
  const deps = { db: d.db, tmdb: scanSourcesFor(d).tmdb, scanner: d.scanner, now: d.now };
  const r = await wantCollection(deps, tmdbIdParam(c), followNew);
  const row = await getCollection(deps, tmdbIdParam(c));
  return c.json<CollectionView & { added: number; nowWanted: number }>({ ...collectionView(d.db, row, d.now()), added: r.added, nowWanted: r.wanted });
});

collectionRoutes.post('/:id/stop', async (c) => {
  requireAdmin(c);
  const d = c.get('deps');
  stopFollowing(d.db, tmdbIdParam(c));
  const row = await getCollection({ db: d.db, tmdb: scanSourcesFor(d).tmdb, now: d.now }, tmdbIdParam(c));
  return c.json<CollectionView>(collectionView(d.db, row, d.now()));
});

// ---------------------------------------------------------------- a show's "which episodes"

export const showPresetRoutes = new Hono<Env>();
const preset = z.enum(SHOW_PRESETS as [ShowPreset, ...ShowPreset[]]);

showPresetRoutes.put('/:id{[0-9]+}/episodes-wanted', async (c) => {
  requireAdmin(c);
  const { preset: p } = z.object({ preset }).parse(await c.req.json());
  const { db, now } = c.get('deps');
  const id = Number(c.req.param('id'));
  if (!db.select({ id: series.id }).from(series).where(eq(series.id, id)).get()) throw new HttpError(404, 'not_found', 'No such show.');
  return c.json(applyShowPreset(db, id, p, new Date(now()).toISOString().slice(0, 10)));
});

// ---------------------------------------------------------------- lists

export const listRoutes = new Hono<Env>();
const listId = (c: Ctx) => {
  const id = Number(c.req.param('id'));
  const row = c.get('deps').db.select().from(importLists).where(eq(importLists.id, id)).get();
  if (!row) throw new HttpError(404, 'not_found', 'No such list.');
  return row;
};

listRoutes.get('/', (c) => {
  requireAdmin(c);
  return c.json<ListsView>(listsView(c.get('deps').db));
});

listRoutes.post('/', async (c) => {
  requireAdmin(c);
  const input = z
    .object({ kind: z.enum(['trakt', 'imdb', 'letterboxd']), url: z.string().trim().min(1, 'Paste the list’s address.').max(500), name: z.string().trim().max(80).optional(), profile: z.string().max(60).nullable().optional(), showPreset: preset.optional() })
    .parse(await c.req.json());
  const { db, now } = c.get('deps');
  const parsed = parseListUrl(input.kind, input.url);
  const clash = db.select().from(importLists).where(and(eq(importLists.kind, input.kind), eq(importLists.url, parsed.url))).get();
  if (clash) throw new HttpError(409, 'already_there', `Marquee already follows that list (“${clash.name}”).`);
  const row = db
    .insert(importLists)
    .values({ kind: input.kind, name: input.name || parsed.name, url: parsed.url, profile: input.profile ?? null, showPreset: input.showPreset ?? 'all', createdAt: now() })
    .returning()
    .get();
  // Read it straight away, so you see at once whether it works.
  await syncList(listDepsFor(c.get('deps')), row);
  return c.json<ListView>(listView(db, db.select().from(importLists).where(eq(importLists.id, row.id)).get()!), 201);
});

listRoutes.patch('/:id{[0-9]+}', async (c) => {
  requireAdmin(c);
  const row = listId(c);
  const input = z.object({ name: z.string().trim().min(1).max(80), enabled: z.boolean(), profile: z.string().max(60).nullable(), showPreset: preset }).partial().strict().parse(await c.req.json());
  const { db } = c.get('deps');
  // Switched back on: anything new since then waits for you to choose, like the first read.
  const restart = input.enabled === true && !row.enabled ? { startedAt: null } : {};
  const updated = db.update(importLists).set({ ...input, ...restart }).where(eq(importLists.id, row.id)).returning().get();
  return c.json<ListView>(listView(db, updated));
});

/** Stops following a list. Nothing it added is removed. */
listRoutes.delete('/:id{[0-9]+}', (c) => {
  requireAdmin(c);
  const row = listId(c);
  c.get('deps').db.delete(importLists).where(eq(importLists.id, row.id)).run();
  return c.json({ ok: true });
});

listRoutes.post('/:id{[0-9]+}/sync', async (c) => {
  requireAdmin(c);
  const row = listId(c);
  await syncList(listDepsFor(c.get('deps')), row);
  const { db } = c.get('deps');
  return c.json<ListView>(listView(db, db.select().from(importLists).where(eq(importLists.id, row.id)).get()!));
});

listRoutes.get('/:id{[0-9]+}/items', (c) => {
  requireAdmin(c);
  return c.json<{ items: ListItemView[] }>({ items: listItemsView(c.get('deps').db, listId(c).id, { waiting: c.req.query('waiting') === '1' }) });
});

const pick = z.object({ kind: z.enum(['movie', 'series']), tmdbId: z.number().int().positive() });

/** Your choice from the titles waiting on a list: take some (asked for, or added as Wanted), leave the rest out. */
listRoutes.post('/:id{[0-9]+}/choose', async (c) => {
  requireAdmin(c);
  const row = listId(c);
  const input = z.object({ take: z.array(pick).max(5000).default([]), leaveOut: z.array(pick).max(5000).default([]) }).parse(await c.req.json());
  const r = await chooseFromList(listDepsFor(c.get('deps')), row, input.take, input.leaveOut);
  const { db } = c.get('deps');
  return c.json<ListChoiceResult>({ ...r, list: listView(db, db.select().from(importLists).where(eq(importLists.id, row.id)).get()!) });
});

/** Follow (or stop following) a person's Plex watchlist: what they add becomes their request. */
listRoutes.put('/watchlists/:userId{[0-9]+}', async (c) => {
  requireAdmin(c);
  const { on } = z.object({ on: z.boolean() }).parse(await c.req.json());
  const { db, now } = c.get('deps');
  const user = db.select().from(users).where(eq(users.id, Number(c.req.param('userId')))).get();
  if (!user) throw new HttpError(404, 'not_found', 'No such person.');
  if (on && !user.plexId) throw new HttpError(400, 'no_plex', `${user.displayName} hasn’t linked Plex. They can link it in Settings → Account, or sign in with Plex.`);
  const existing = db.select().from(importLists).where(and(eq(importLists.kind, 'plex_watchlist'), eq(importLists.userId, user.id))).get();
  let row = existing;
  // Switched back on: anything new since it was off waits for you to choose, like the first read.
  if (existing) row = db.update(importLists).set({ enabled: on, ...(on && !existing.enabled ? { startedAt: null } : {}) }).where(eq(importLists.id, existing.id)).returning().get();
  else if (on) row = db.insert(importLists).values({ kind: 'plex_watchlist', name: `${user.displayName}’s Plex watchlist`, userId: user.id, createdAt: now() }).returning().get();
  if (on && row) await syncList(listDepsFor(c.get('deps')), row);
  return c.json<ListsView>(listsView(db));
});

listRoutes.put('/trakt-key', async (c) => {
  requireAdmin(c);
  const { clientId } = z.object({ clientId: z.string().trim().max(200) }).parse(await c.req.json());
  setSetting(c.get('deps').db, TRAKT_KEY, clientId);
  return c.json<ListsView>(listsView(c.get('deps').db));
});

const exclusion = z.object({ kind: z.enum(['movie', 'series']), tmdbId: z.number().int().positive(), title: z.string().trim().min(1).max(300), year: z.number().int().nullable().optional() });

/** Lists never add these. */
listRoutes.post('/exclusions', async (c) => {
  requireAdmin(c);
  const x = exclusion.parse(await c.req.json());
  const { db, now } = c.get('deps');
  db.insert(listExclusions).values({ kind: x.kind, tmdbId: x.tmdbId, title: x.title, year: x.year ?? null, addedAt: now() }).onConflictDoNothing().run();
  return c.json<ListsView>(listsView(db), 201);
});

listRoutes.delete('/exclusions/:kind{movie|series}/:tmdbId{[0-9]+}', (c) => {
  requireAdmin(c);
  const { db } = c.get('deps');
  db.delete(listExclusions)
    .where(and(eq(listExclusions.kind, c.req.param('kind') as 'movie' | 'series'), eq(listExclusions.tmdbId, Number(c.req.param('tmdbId')))))
    .run();
  return c.json<ListsView>(listsView(db));
});
