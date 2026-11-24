import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { PlexLabelSettings, WatchLink } from '@marquee/shared';
import type { Db } from '../db/index.js';
import { getSetting, setSetting } from '../db/index.js';
import { mediaFiles, movies, requests, series, users } from '../db/schema.js';
import type { Clients } from '../http.js';
import { MediaServerError, readMediaServer, type MediaServerApi, type ServerKind, type ServerTitle } from './mediaServers.js';

/**
 * Library titles on Plex and Jellyfin: finding a title there by its ids
 * (remembering the server's id for it), "Watch in Plex / Jellyfin" links, and
 * labelling requested titles in Plex.
 */

type Kind = 'movie' | 'tv';
type ServerClients = Pick<Clients, 'plexServer' | 'jellyfin'>;
const LABEL = { plex: 'Plex', jellyfin: 'Jellyfin' } as const;

function api(db: Db, clients: ServerClients, server: ServerKind): MediaServerApi | null {
  const s = readMediaServer(db, server);
  if (!s.url || !s.secret) return null;
  return server === 'plex' ? clients.plexServer(s.url, s.secret) : clients.jellyfin(s.url, s.secret);
}

/** The ids a title is known by ("tmdb:603", "tvdb:371980", "imdb:tt0133093"), and the server ids Marquee remembers for it. */
function title(db: Db, kind: Kind, id: number): { keys: string[]; refs: Partial<Record<ServerKind, string>> } | null {
  const row =
    kind === 'movie'
      ? db.select({ tmdbId: movies.tmdbId, imdbId: movies.imdbId, refs: movies.serverRefs }).from(movies).where(eq(movies.id, id)).get()
      : db.select({ tmdbId: series.tmdbId, imdbId: series.imdbId, tvdbId: series.tvdbId, refs: series.serverRefs }).from(series).where(eq(series.id, id)).get();
  if (!row) return null;
  const keys = [`tmdb:${row.tmdbId}`];
  if (row.imdbId) keys.push(`imdb:${row.imdbId}`);
  if ('tvdbId' in row && row.tvdbId) keys.push(`tvdb:${row.tvdbId}`);
  let refs: Partial<Record<ServerKind, string>> = {};
  try {
    refs = row.refs ? (JSON.parse(row.refs) as typeof refs) : {};
  } catch {
    /* start again */
  }
  return { keys, refs };
}

function saveRef(db: Db, kind: Kind, id: number, refs: Partial<Record<ServerKind, string>>): void {
  const value = JSON.stringify(refs);
  if (kind === 'movie') db.update(movies).set({ serverRefs: value }).where(eq(movies.id, id)).run();
  else db.update(series).set({ serverRefs: value }).where(eq(series.id, id)).run();
}

const same = (a: string[], b: string[]) => a.some((k) => b.includes(k));

/**
 * A library title on one server, or null when the server doesn't have it (yet).
 * Uses the id Marquee remembered when it still points at the same title;
 * otherwise reads the server's list once and remembers what it finds.
 */
export async function findOnServer(db: Db, server: ServerKind, client: MediaServerApi, kind: Kind, id: number): Promise<ServerTitle | null> {
  const t = title(db, kind, id);
  if (!t || !client.titles) return null;
  const known = t.refs[server];
  if (known && client.item) {
    const item = await client.item(known);
    if (item && same(item.keys, t.keys)) return item;
  }
  const match = (await client.titles(kind)).find((x) => same(x.keys, t.keys));
  if (!match) {
    if (known) saveRef(db, kind, id, { ...t.refs, [server]: undefined });
    return null;
  }
  saveRef(db, kind, id, { ...t.refs, [server]: match.ref });
  return (client.item ? await client.item(match.ref) : null) ?? match;
}

/** "Watch in Plex" and "Watch in Jellyfin" for a library title: only servers that have it. Never throws. */
export async function watchLinks(deps: { db: Db; clients: ServerClients }, kind: Kind, id: number): Promise<WatchLink[]> {
  const out: WatchLink[] = [];
  for (const server of ['plex', 'jellyfin'] as const) {
    const client = api(deps.db, deps.clients, server);
    if (!client?.webLink) continue;
    try {
      const found = await findOnServer(deps.db, server, client, kind, id);
      if (found) out.push({ server: LABEL[server], url: await client.webLink(found.ref, readMediaServer(deps.db, server).publicUrl) });
    } catch (err) {
      console.warn(`[watch links] ${LABEL[server]}: ${(err as Error).message}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- Plex labels

const KEYS = { on: 'plex.label_requests', text: 'plex.label_text', requester: 'plex.label_requester' };
export const DEFAULT_LABEL = 'Requested';

export function readPlexLabels(db: Db): PlexLabelSettings {
  return { on: getSetting(db, KEYS.on) === '1', text: getSetting(db, KEYS.text) || DEFAULT_LABEL, requester: getSetting(db, KEYS.requester) === '1' };
}

export function writePlexLabels(db: Db, v: Partial<PlexLabelSettings>): void {
  if (v.on !== undefined) setSetting(db, KEYS.on, v.on ? '1' : '');
  if (v.text !== undefined) setSetting(db, KEYS.text, v.text.trim());
  if (v.requester !== undefined) setSetting(db, KEYS.requester, v.requester ? '1' : '');
}

/** How many titles one run labels at most, so a first run on a big library is spread out. */
const PER_RUN = 50;

/**
 * Adds Marquee's label (and, if chosen, the name of each person who asked)
 * to requested titles once they're in Plex. Titles Plex hasn't added yet are
 * tried on the next run. Labels already on a title stay; Marquee remembers
 * what it added, so it adds each once and never removes any.
 */
export async function labelRequested(deps: { db: Db; clients: ServerClients }): Promise<string> {
  const { db } = deps;
  const settings = readPlexLabels(db);
  if (!settings.on) return 'Off';
  const client = api(db, deps.clients, 'plex');
  if (!client?.setLabels) return 'Plex isn’t connected';

  // What each requested title should carry.
  const want = new Map<string, { kind: Kind; id: number; labels: Set<string> }>();
  const rows = db
    .select({ kind: requests.kind, titleId: requests.titleId, name: users.displayName })
    .from(requests)
    .leftJoin(users, eq(users.id, requests.requestedBy))
    .where(and(eq(requests.status, 'approved'), isNotNull(requests.titleId)))
    .all();
  for (const r of rows) {
    const kind: Kind = r.kind === 'movie' ? 'movie' : 'tv';
    const k = `${kind}:${r.titleId}`;
    const entry = want.get(k) ?? { kind, id: r.titleId!, labels: new Set<string>() };
    entry.labels.add(settings.text);
    if (settings.requester && r.name) entry.labels.add(r.name);
    want.set(k, entry);
  }
  const haveFiles = (kind: Kind, ids: number[]) =>
    new Set(
      ids.length === 0
        ? []
        : kind === 'movie'
          ? db.select({ id: mediaFiles.movieId }).from(mediaFiles).where(inArray(mediaFiles.movieId, ids)).all().map((f) => f.id)
          : db.select({ id: mediaFiles.seriesId }).from(mediaFiles).where(inArray(mediaFiles.seriesId, ids)).all().map((f) => f.id),
    );
  const filed = {
    movie: haveFiles('movie', [...want.values()].filter((w) => w.kind === 'movie').map((w) => w.id)),
    tv: haveFiles('tv', [...want.values()].filter((w) => w.kind === 'tv').map((w) => w.id)),
  };

  let labelled = 0;
  let waiting = 0;
  for (const w of want.values()) {
    if (labelled >= PER_RUN) break;
    if (!filed[w.kind].has(w.id)) continue;
    const added = addedLabels(db, w.kind, w.id);
    const missing = [...w.labels].filter((l) => !added.includes(l));
    if (!missing.length) continue;
    const item = await findOnServer(db, 'plex', client, w.kind, w.id);
    if (!item) {
      waiting++;
      continue;
    }
    const current = item.labels ?? [];
    const next = [...current, ...missing.filter((l) => !current.some((c) => c.toLowerCase() === l.toLowerCase()))];
    try {
      if (next.length !== current.length) await client.setLabels(item, w.kind, next);
    } catch (err) {
      if (err instanceof MediaServerError) return `Plex turned down a label: ${err.message}`;
      throw err;
    }
    saveAdded(db, w.kind, w.id, [...added, ...missing]);
    labelled++;
  }
  const parts = [labelled ? `Labelled ${labelled} ${labelled === 1 ? 'title' : 'titles'}` : 'Nothing new to label'];
  if (waiting) parts.push(`${waiting} not in Plex yet`);
  return parts.join('; ');
}

function addedLabels(db: Db, kind: Kind, id: number): string[] {
  const row = kind === 'movie' ? db.select({ v: movies.plexLabels }).from(movies).where(eq(movies.id, id)).get() : db.select({ v: series.plexLabels }).from(series).where(eq(series.id, id)).get();
  try {
    return row?.v ? (JSON.parse(row.v) as string[]) : [];
  } catch {
    return [];
  }
}

function saveAdded(db: Db, kind: Kind, id: number, labels: string[]): void {
  const value = JSON.stringify([...new Set(labels)]);
  if (kind === 'movie') db.update(movies).set({ plexLabels: value }).where(eq(movies.id, id)).run();
  else db.update(series).set({ plexLabels: value }).where(eq(series.id, id)).run();
}
