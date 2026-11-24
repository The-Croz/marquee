import { and, desc, eq } from 'drizzle-orm';
import type { ListItemView, ListView, ListsView, NewRequest } from '@marquee/shared';
import { getSetting, type Db } from '../db/index.js';
import { importLists, letterboxdFilms, listExclusions, listItems, movies, series, users, type User } from '../db/schema.js';
import { HttpError } from '../http.js';
import { ProfileService } from '../releases/profiles.js';
import type { LibraryScanner } from './scanner.js';
import { applyShowPreset, SHOW_PRESETS, type ShowPreset } from './showPresets.js';
import type { TmdbApi } from './tmdb.js';
import { setMoviesWanted } from './wanted.js';

/**
 * Lists Marquee follows (Radarr/Sonarr's import lists and Seerr's watchlist
 * sync). Each person's **Plex watchlist**: whatever they add becomes their
 * request, approved by their role as usual. **Trakt**, **IMDb** and
 * **Letterboxd** lists: new titles are added to the library as Wanted. A
 * title is handled once, when it first shows up on a list; taking it off the
 * list later changes nothing, and nothing is ever removed. Titles on the
 * exclusions list are never added.
 */

export type ListKind = 'plex_watchlist' | 'trakt' | 'imdb' | 'letterboxd';
export const TRAKT_KEY = 'lists.trakt_client_id';
const MIN = 60_000;
/** How often each kind is read. Watchlists are what people add to by hand, so they're read often. */
export const LIST_EVERY: Record<ListKind, number> = { plex_watchlist: 15 * MIN, trakt: 6 * 60 * MIN, imdb: 6 * 60 * MIN, letterboxd: 6 * 60 * MIN };

/** Fetches a page or API answer. Tests fake it; left out, Marquee uses fetch. */
export type ListFetch = (url: string, headers?: Record<string, string>) => Promise<{ status: number; text: string }>;

export const realListFetch: ListFetch = async (url, headers = {}) => {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Marquee)', ...headers }, signal: AbortSignal.timeout(30_000) });
  return { status: res.status, text: await res.text() };
};

/** One title as a list gives it, before Marquee looks it up on TMDB. */
export interface ListEntry {
  kind: 'movie' | 'series';
  title: string;
  year: number | null;
  tmdbId?: number | null;
  imdbId?: string | null;
  tvdbId?: number | null;
}

class ListError extends Error {}

// ---------------------------------------------------------------- reading each kind

/** What a list address means, or a plain reason it isn't one Marquee can follow. */
export function parseListUrl(kind: Exclude<ListKind, 'plex_watchlist'>, raw: string): { url: string; name: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new HttpError(400, 'invalid_input', 'That isn’t a web address. Copy it from your browser’s address bar.');
  }
  const p = u.pathname.replace(/\/+$/, '');
  if (kind === 'trakt') {
    const m = p.match(/^\/users\/([^/]+)\/(?:lists\/([^/]+)|(watchlist))$/);
    if (!/trakt\.tv$/.test(u.hostname) || !m) throw new HttpError(400, 'invalid_input', 'Use a Trakt list address like https://trakt.tv/users/you/lists/favourites or https://trakt.tv/users/you/watchlist.');
    return { url: `https://trakt.tv/users/${m[1]}/${m[3] ? 'watchlist' : `lists/${m[2]}`}`, name: m[3] ? `${m[1]}’s Trakt watchlist` : `Trakt: ${m[2]!.replace(/-/g, ' ')}` };
  }
  if (kind === 'imdb') {
    const list = p.match(/^\/list\/(ls\d+)$/);
    const watch = p.match(/^\/user\/(ur\d+)\/watchlist$/);
    if (!/imdb\.com$/.test(u.hostname) || (!list && !watch)) throw new HttpError(400, 'invalid_input', 'Use an IMDb list address like https://www.imdb.com/list/ls012345678 or a public watchlist like https://www.imdb.com/user/ur12345678/watchlist.');
    return list ? { url: `https://www.imdb.com/list/${list[1]}/`, name: `IMDb list ${list[1]}` } : { url: `https://www.imdb.com/user/${watch![1]}/watchlist/`, name: `IMDb watchlist ${watch![1]}` };
  }
  const m = p.match(/^\/([^/]+)\/(?:list\/([^/]+)|(watchlist))$/);
  if (!/letterboxd\.com$/.test(u.hostname) || !m) throw new HttpError(400, 'invalid_input', 'Use a Letterboxd list address like https://letterboxd.com/you/list/best-of-2024 or https://letterboxd.com/you/watchlist.');
  return { url: `https://letterboxd.com/${m[1]}/${m[3] ? 'watchlist' : `list/${m[2]}`}/`, name: m[3] ? `${m[1]}’s Letterboxd watchlist` : `Letterboxd: ${m[2]!.replace(/-/g, ' ')}` };
}

const json = <T>(text: string, what: string): T => {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ListError(`${what} didn’t answer in a way Marquee understands.`);
  }
};

const plexHeaders = (token: string) => ({ Accept: 'application/json', 'X-Plex-Token': token, 'X-Plex-Product': 'Marquee', 'X-Plex-Client-Identifier': 'marquee-lists' });
const PLEX = 'https://discover.provider.plex.tv';

interface PlexItem {
  type?: string;
  title?: string;
  year?: number;
  ratingKey?: string;
  Guid?: { id: string }[];
}

function fromGuids(guids: { id: string }[] | undefined): Pick<ListEntry, 'tmdbId' | 'imdbId' | 'tvdbId'> {
  const get = (scheme: string) => guids?.find((g) => g.id.startsWith(`${scheme}://`))?.id.slice(scheme.length + 3) ?? null;
  const tmdb = get('tmdb');
  const tvdb = get('tvdb');
  return { tmdbId: tmdb ? Number(tmdb) : null, imdbId: get('imdb'), tvdbId: tvdb ? Number(tvdb) : null };
}

/** A person's Plex watchlist, with TMDB/IMDb/TVDB ids (looked up per title when the list leaves them out). */
async function readPlexWatchlist(fetchPage: ListFetch, token: string): Promise<ListEntry[]> {
  const out: ListEntry[] = [];
  for (let start = 0; start < 2000; start += 100) {
    const res = await fetchPage(`${PLEX}/library/sections/watchlist/all?includeGuids=1&X-Plex-Container-Start=${start}&X-Plex-Container-Size=100`, plexHeaders(token));
    if (res.status === 401) throw new ListError('Plex turned down their sign-in. They need to sign in to Marquee with Plex again.');
    if (res.status !== 200) throw new ListError(`Plex answered ${res.status}.`);
    const page = json<{ MediaContainer?: { Metadata?: PlexItem[]; totalSize?: number } }>(res.text, 'Plex').MediaContainer;
    const items = page?.Metadata ?? [];
    for (const it of items) {
      if (it.type !== 'movie' && it.type !== 'show') continue;
      let ids = fromGuids(it.Guid);
      if (!ids.tmdbId && !ids.imdbId && !ids.tvdbId && it.ratingKey) {
        const one = await fetchPage(`${PLEX}/library/metadata/${it.ratingKey}`, plexHeaders(token));
        if (one.status === 200) ids = fromGuids(json<{ MediaContainer?: { Metadata?: PlexItem[] } }>(one.text, 'Plex').MediaContainer?.Metadata?.[0]?.Guid);
      }
      out.push({ kind: it.type === 'movie' ? 'movie' : 'series', title: it.title ?? '?', year: it.year ?? null, ...ids });
    }
    if (items.length < 100 || out.length >= (page?.totalSize ?? 0)) break;
  }
  return out;
}

interface TraktItem {
  type: string;
  movie?: { title: string; year: number | null; ids: { tmdb?: number | null; imdb?: string | null } };
  show?: { title: string; year: number | null; ids: { tmdb?: number | null; imdb?: string | null; tvdb?: number | null } };
}

async function readTrakt(fetchPage: ListFetch, url: string, clientId: string | undefined): Promise<ListEntry[]> {
  if (!clientId) throw new ListError('Add a Trakt app key (Client ID) on this page first. Trakt gives you one free at trakt.tv/oauth/applications.');
  const path = new URL(url).pathname.replace(/\/$/, '');
  const api = path.endsWith('/watchlist') ? `https://api.trakt.tv${path}` : `https://api.trakt.tv${path}/items`;
  const res = await fetchPage(api, { 'Content-Type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': clientId });
  if (res.status === 401 || res.status === 403) throw new ListError('Trakt turned down the app key, or the list is private. Check the key, and that the list is public.');
  if (res.status === 404) throw new ListError('Trakt says there’s no such list. Check the address, and that it’s public.');
  if (res.status !== 200) throw new ListError(`Trakt answered ${res.status}.`);
  return json<TraktItem[]>(res.text, 'Trakt').flatMap((it): ListEntry[] => {
    if (it.type === 'movie' && it.movie) return [{ kind: 'movie', title: it.movie.title, year: it.movie.year, tmdbId: it.movie.ids.tmdb ?? null, imdbId: it.movie.ids.imdb ?? null }];
    if (it.type === 'show' && it.show) return [{ kind: 'series', title: it.show.title, year: it.show.year, tmdbId: it.show.ids.tmdb ?? null, imdbId: it.show.ids.imdb ?? null, tvdbId: it.show.ids.tvdb ?? null }];
    return [];
  });
}

/** IMDb list pages carry each title's IMDb id ("tt0133093"); TMDB turns them into movies or shows. */
async function readImdb(fetchPage: ListFetch, url: string): Promise<ListEntry[]> {
  const res = await fetchPage(url, { 'Accept-Language': 'en-US' });
  if (res.status === 404) throw new ListError('IMDb says there’s no such list. Check the address, and that the list is public.');
  if (res.status !== 200) throw new ListError(`IMDb answered ${res.status}.`);
  const ids = [...new Set([...res.text.matchAll(/\/title\/(tt\d{7,9})\//g)].map((m) => m[1]!))];
  if (!ids.length && /sign in|private/i.test(res.text)) throw new ListError('IMDb shows this list only when signed in. Make it public on IMDb.');
  return ids.map((imdbId) => ({ kind: 'movie', title: imdbId, year: null, imdbId }));
}

/** Letterboxd lists name each film by its page ("/film/dune-part-two/"); each film page says its TMDB id, read once and kept. */
async function readLetterboxd(db: Db, fetchPage: ListFetch, url: string, now: number): Promise<ListEntry[]> {
  const slugs: string[] = [];
  for (let page = 1; page <= 20; page++) {
    const res = await fetchPage(page === 1 ? url : `${url}page/${page}/`);
    if (res.status === 404 && page === 1) throw new ListError('Letterboxd says there’s no such list. Check the address, and that it’s public.');
    if (res.status === 403 && page === 1) throw new ListError('Letterboxd turned Marquee away (it may be checking for bots). Try again later.');
    if (res.status !== 200) break;
    const found = [...res.text.matchAll(/data-(?:film-slug|target-link)="(?:\/film\/)?([a-z0-9-]+)\/?"/g)].map((m) => m[1]!);
    const fresh = found.filter((s) => !slugs.includes(s));
    if (!fresh.length) break;
    slugs.push(...fresh);
  }
  const out: ListEntry[] = [];
  for (const slug of slugs) {
    let film = db.select().from(letterboxdFilms).where(eq(letterboxdFilms.slug, slug)).get();
    if (!film) {
      const res = await fetchPage(`https://letterboxd.com/film/${slug}/`);
      const id = res.text.match(/data-tmdb-id="(\d+)"/)?.[1];
      const type = res.text.match(/data-tmdb-type="(movie|tv)"/)?.[1] ?? 'movie';
      if (res.status !== 200) continue;
      film = db.insert(letterboxdFilms).values({ slug, tmdbId: id ? Number(id) : null, kind: type === 'tv' ? 'series' : 'movie', seenAt: now }).returning().get();
    }
    if (film.tmdbId) out.push({ kind: film.kind === 'series' ? 'series' : 'movie', title: slug.replace(/-/g, ' '), year: null, tmdbId: film.tmdbId });
  }
  return out;
}

// ---------------------------------------------------------------- syncing

export interface ListDeps {
  db: Db;
  tmdb: () => TmdbApi;
  scanner: LibraryScanner;
  fetchPage: ListFetch;
  /** Makes a request as this person (the usual request flow: admins' go straight through). */
  request: (user: User, input: NewRequest) => Promise<unknown>;
  now: () => number;
}

type ListRow = typeof importLists.$inferSelect;

/** TMDB's id for an entry, looking it up by IMDb or TVDB id when the list didn't give one. */
async function resolve(tmdb: TmdbApi, e: ListEntry): Promise<{ kind: 'movie' | 'series'; tmdbId: number } | null> {
  if (e.tmdbId) return { kind: e.kind, tmdbId: e.tmdbId };
  if (e.imdbId) {
    // IMDb ids are shared by movies and shows; lists from IMDb don't say which.
    if (e.kind === 'movie') {
      const m = await tmdb.findMovie({ imdbId: e.imdbId });
      if (m) return { kind: 'movie', tmdbId: m };
    }
    const s = await tmdb.findShow({ imdbId: e.imdbId, tvdbId: e.tvdbId ?? null });
    if (s) return { kind: 'series', tmdbId: s };
    if (e.kind === 'series') {
      const m = await tmdb.findMovie({ imdbId: e.imdbId });
      if (m) return { kind: 'movie', tmdbId: m };
    }
    return null;
  }
  if (e.tvdbId) {
    const s = await tmdb.findShow({ tvdbId: e.tvdbId });
    return s ? { kind: 'series', tmdbId: s } : null;
  }
  return null;
}

export interface SyncResult {
  ok: boolean;
  message: string;
  added: number;
}

const OUTCOME = {
  added: 'Added and Wanted',
  wanted: 'Already here; now Wanted',
  asked: 'Asked for',
  already: 'Already here or asked for',
  excluded: 'On the exclusions list',
  not_for_kids: 'Not for kid profiles',
  failed: 'Couldn’t add it',
} as const;
export type Outcome = keyof typeof OUTCOME;

export async function syncList(deps: ListDeps, row: ListRow): Promise<SyncResult> {
  const { db, now } = deps;
  let result: SyncResult;
  try {
    const entries = await read(deps, row);
    const tmdb = deps.tmdb();
    let added = 0;
    let unknown = 0;
    let fresh = 0;
    for (const e of entries) {
      const found = await resolve(tmdb, e);
      if (!found) {
        unknown++;
        continue;
      }
      if (db.select().from(listItems).where(and(eq(listItems.listId, row.id), eq(listItems.kind, found.kind), eq(listItems.tmdbId, found.tmdbId))).get()) continue;
      fresh++;
      const { outcome, title, year } = await handle(deps, row, found, e);
      if (outcome === 'added' || outcome === 'asked' || outcome === 'wanted') added++;
      db.insert(listItems).values({ listId: row.id, kind: found.kind, tmdbId: found.tmdbId, title, year, seenAt: now(), outcome }).onConflictDoNothing().run();
    }
    const verb = row.kind === 'plex_watchlist' ? 'asked for' : 'added';
    const parts = [`${entries.length} on the list`, fresh ? `${fresh} new` : 'nothing new', added ? `${added} ${verb}` : null, unknown ? `${unknown} not found on TMDB` : null].filter(Boolean);
    result = { ok: true, message: `${parts.join(', ')}.`, added };
  } catch (err) {
    const message = err instanceof ListError || err instanceof HttpError ? err.message : `Couldn’t read it: ${(err as Error).message}`;
    result = { ok: false, message: `${message} Marquee tries again by itself.`, added: 0 };
  }
  db.update(importLists).set({ lastSyncAt: now(), lastOk: result.ok, lastMessage: result.message }).where(eq(importLists.id, row.id)).run();
  return result;
}

async function read(deps: ListDeps, row: ListRow): Promise<ListEntry[]> {
  switch (row.kind) {
    case 'plex_watchlist': {
      const user = row.userId ? deps.db.select().from(users).where(eq(users.id, row.userId)).get() : undefined;
      if (!user?.plexToken) throw new ListError(`${user?.displayName ?? 'They'} need${user ? 's' : ''} to sign in to Marquee with Plex once, so Marquee can read their watchlist.`);
      return readPlexWatchlist(deps.fetchPage, user.plexToken);
    }
    case 'trakt':
      return readTrakt(deps.fetchPage, row.url!, getSetting(deps.db, TRAKT_KEY) || undefined);
    case 'imdb':
      return readImdb(deps.fetchPage, row.url!);
    case 'letterboxd':
      return readLetterboxd(deps.db, deps.fetchPage, row.url!, deps.now());
  }
}

async function handle(deps: ListDeps, row: ListRow, found: { kind: 'movie' | 'series'; tmdbId: number }, e: ListEntry): Promise<{ outcome: Outcome; title: string; year: number | null }> {
  const { db, now } = deps;
  const tmdb = deps.tmdb();
  let title = e.title;
  let year = e.year;
  const excluded = db.select().from(listExclusions).where(and(eq(listExclusions.kind, found.kind), eq(listExclusions.tmdbId, found.tmdbId))).get();
  if (excluded) return { outcome: 'excluded', title: excluded.title, year: excluded.year };

  if (row.kind === 'plex_watchlist') {
    const user = db.select().from(users).where(eq(users.id, row.userId!)).get()!;
    try {
      await deps.request(user, { kind: found.kind, tmdbId: found.tmdbId });
      return { outcome: 'asked', title, year };
    } catch (err) {
      if (err instanceof HttpError && (err.code === 'already_here' || err.code === 'already_requested')) return { outcome: 'already', title, year };
      if (err instanceof HttpError && err.code === 'not_for_kids') return { outcome: 'not_for_kids', title, year };
      console.warn(`[lists] ${user.displayName}'s watchlist: ${title}: ${(err as Error).message}`);
      return { outcome: 'failed', title, year };
    }
  }

  try {
    if (found.kind === 'movie') {
      const existing = db.select().from(movies).where(eq(movies.tmdbId, found.tmdbId)).get();
      const m = existing ?? (await deps.scanner.upsertMovie(tmdb, found.tmdbId, null, now()));
      ((title = m.title), (year = m.year));
      if (existing?.monitored) return { outcome: 'already', title, year };
      setMoviesWanted(db, [m.id], true);
      if (row.profile && !m.profileByHand) new ProfileService(db, now).assign('movie', m.id, row.profile);
      return { outcome: existing ? 'wanted' : 'added', title, year };
    }
    const existing = db.select().from(series).where(eq(series.tmdbId, found.tmdbId)).get();
    const s = existing ?? (await deps.scanner.upsertSeries(tmdb, found.tmdbId, null, now()));
    ((title = s.title), (year = s.year));
    if (existing?.monitored) return { outcome: 'already', title, year };
    applyShowPreset(db, s.id, (SHOW_PRESETS.includes(row.showPreset as ShowPreset) ? row.showPreset : 'all') as ShowPreset, new Date(now()).toISOString().slice(0, 10));
    if (row.profile && !s.profileByHand) new ProfileService(db, now).assign('tv', s.id, row.profile);
    return { outcome: existing ? 'wanted' : 'added', title, year };
  } catch (err) {
    console.warn(`[lists] ${row.name}: ${title}: ${(err as Error).message}`);
    return { outcome: 'failed', title, year };
  }
}

/** Every enabled list that's due. Called by the "Sync lists" job. */
export async function syncDueLists(deps: ListDeps): Promise<{ synced: number; added: number; problems: string[] }> {
  const out = { synced: 0, added: 0, problems: [] as string[] };
  for (const row of deps.db.select().from(importLists).where(eq(importLists.enabled, true)).all()) {
    if (row.lastSyncAt && deps.now() - row.lastSyncAt < LIST_EVERY[row.kind] - MIN) continue;
    const r = await syncList(deps, row);
    out.synced++;
    out.added += r.added;
    if (!r.ok) out.problems.push(`${row.name}: ${r.message}`);
  }
  return out;
}

// ---------------------------------------------------------------- screens

export function listView(db: Db, row: ListRow): ListView {
  const owner = row.userId ? db.select().from(users).where(eq(users.id, row.userId)).get() : undefined;
  const counts = db.select({ outcome: listItems.outcome }).from(listItems).where(eq(listItems.listId, row.id)).all();
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    url: row.url,
    owner: owner ? { id: owner.id, name: owner.displayName } : null,
    enabled: row.enabled,
    profile: row.profile,
    showPreset: row.showPreset as ShowPreset,
    lastSyncAt: row.lastSyncAt,
    lastOk: row.lastOk,
    lastMessage: row.lastMessage,
    seen: counts.length,
    added: counts.filter((c) => c.outcome === 'added' || c.outcome === 'asked' || c.outcome === 'wanted').length,
  };
}

export function listItemsView(db: Db, listId: number): ListItemView[] {
  return db
    .select()
    .from(listItems)
    .where(eq(listItems.listId, listId))
    .orderBy(desc(listItems.seenAt))
    .limit(200)
    .all()
    .map((i) => ({ kind: i.kind, tmdbId: i.tmdbId, title: i.title, year: i.year, seenAt: i.seenAt, outcome: i.outcome, outcomeText: OUTCOME[i.outcome as Outcome] ?? i.outcome }));
}

export function listsView(db: Db): ListsView {
  const lists = db.select().from(importLists).all();
  return {
    lists: lists.filter((l) => l.kind !== 'plex_watchlist').map((l) => listView(db, l)),
    people: db
      .select()
      .from(users)
      .all()
      .map((u) => {
        const wl = lists.find((l) => l.kind === 'plex_watchlist' && l.userId === u.id);
        return { userId: u.id, name: u.displayName, role: u.role, plexLinked: !!u.plexId, canRead: !!u.plexToken, watchlist: wl ? listView(db, wl) : null };
      }),
    exclusions: db
      .select()
      .from(listExclusions)
      .orderBy(desc(listExclusions.addedAt))
      .all()
      .map((x) => ({ kind: x.kind, tmdbId: x.tmdbId, title: x.title, year: x.year, addedAt: x.addedAt })),
    traktKeySet: !!getSetting(db, TRAKT_KEY),
  };
}
