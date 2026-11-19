import path from 'node:path';
import { getSetting, setSetting, type Db } from '../db/index.js';
import { libraryRoots } from './services.js';

/**
 * Plex and Jellyfin: after Marquee puts something in the library, it asks
 * each media server to scan just that folder, so the title shows up in
 * seconds instead of at the next scheduled scan.
 *
 * Media servers often see the library under another path than Marquee does
 * (Plex might mount it at /movies). Marquee works the server's path out from
 * the library you pick: the folder's place under Marquee's movie or TV folder,
 * put under that library's own folder.
 *
 * Tokens and keys are never sent back to the browser or put in messages.
 */

export type ServerKind = 'plex' | 'jellyfin';

export interface MediaLibrary {
  /** Plex section key, or Jellyfin library id. */
  id: string;
  name: string;
  kind: 'movie' | 'tv' | 'other';
  /** Its folders, as the media server sees them. */
  locations: string[];
}

/** Someone with access to a media server, as its own user list shows them. */
export interface MediaPerson {
  /** Plex account id, or Jellyfin user id. */
  id: string;
  username: string;
  name: string;
}

export interface MediaServerApi {
  /** The people who can use this server (Plex: you and the friends it's shared with). */
  people(): Promise<MediaPerson[]>;
  /** Name and version, or throws MediaServerError. */
  ping(): Promise<{ name: string; version: string }>;
  libraries(): Promise<MediaLibrary[]>;
  /** Asks the server to scan one folder of one library. */
  scan(library: MediaLibrary, folder: string): Promise<void>;
}

export class MediaServerError extends Error {}

async function request(fetchImpl: typeof fetch, label: string, base: string, url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    const e = err as { name?: string; cause?: { code?: string } };
    const why = e.name === 'TimeoutError' ? 'no answer in time' : e.cause?.code;
    throw new MediaServerError(`Couldn't reach ${label} at ${base}${why ? ` (${why})` : ''}.`);
  }
  if (res.status === 401 || res.status === 403) throw new MediaServerError(`${label} turned down the ${label === 'Plex' ? 'token' : 'API key'}.`);
  if (!res.ok) throw new MediaServerError(`${label} answered ${res.status}.`);
  return res;
}

export class PlexServerClient implements MediaServerApi {
  private readonly base: string;
  constructor(
    url: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = url.replace(/\/+$/, '');
  }

  private get(p: string): Promise<Response> {
    return request(this.fetchImpl, 'Plex', this.base, `${this.base}${p}`, { headers: { Accept: 'application/json', 'X-Plex-Token': this.token } });
  }

  async ping() {
    const body = (await (await this.get('/')).json()) as { MediaContainer?: { friendlyName?: string; version?: string } };
    if (!body.MediaContainer?.version) throw new MediaServerError(`${this.base} answers, but it isn't a Plex server.`);
    return { name: body.MediaContainer.friendlyName ?? 'Plex', version: body.MediaContainer.version };
  }

  async libraries(): Promise<MediaLibrary[]> {
    type Dir = { key: string; title: string; type: string; Location?: { path: string }[] };
    const body = (await (await this.get('/library/sections')).json()) as { MediaContainer?: { Directory?: Dir[] } };
    return (body.MediaContainer?.Directory ?? []).map((d) => ({
      id: String(d.key),
      name: d.title,
      kind: d.type === 'movie' ? 'movie' : d.type === 'show' ? 'tv' : 'other',
      locations: (d.Location ?? []).map((l) => l.path),
    }));
  }

  async people(): Promise<MediaPerson[]> {
    // The server's own address doesn't know the sharing list; plex.tv does, and the same token opens it.
    const h = { Accept: 'application/json', 'X-Plex-Token': this.token, 'X-Plex-Client-Identifier': 'marquee', 'X-Plex-Product': 'Marquee' };
    const me = await request(this.fetchImpl, 'Plex', 'plex.tv', 'https://plex.tv/api/v2/user', { headers: h });
    const friends = await request(this.fetchImpl, 'Plex', 'plex.tv', 'https://plex.tv/api/v2/friends', { headers: h });
    type P = { id: number; username?: string; title?: string };
    const rows = [(await me.json()) as P, ...((await friends.json()) as P[])];
    return rows.filter((p) => p.id).map((p) => ({ id: String(p.id), username: p.username || p.title || String(p.id), name: p.title || p.username || String(p.id) }));
  }

  async scan(library: MediaLibrary, folder: string): Promise<void> {
    await this.get(`/library/sections/${encodeURIComponent(library.id)}/refresh?path=${encodeURIComponent(folder)}`);
  }
}

export class JellyfinClient implements MediaServerApi {
  private readonly base: string;
  constructor(
    url: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = url.replace(/\/+$/, '');
  }

  private send(p: string, init: RequestInit = {}): Promise<Response> {
    const headers = { Accept: 'application/json', Authorization: `MediaBrowser Token="${this.apiKey}"`, ...(init.headers as Record<string, string>) };
    return request(this.fetchImpl, 'Jellyfin', this.base, `${this.base}${p}`, { ...init, headers });
  }

  async ping() {
    const info = (await (await this.send('/System/Info')).json()) as { ServerName?: string; Version?: string; ProductName?: string };
    if (!info.Version) throw new MediaServerError(`${this.base} answers, but it isn't a Jellyfin server.`);
    return { name: info.ServerName ?? 'Jellyfin', version: info.Version };
  }

  async libraries(): Promise<MediaLibrary[]> {
    type Folder = { Name: string; ItemId: string; CollectionType?: string; Locations?: string[] };
    const rows = (await (await this.send('/Library/VirtualFolders')).json()) as Folder[];
    return rows.map((f) => ({
      id: f.ItemId,
      name: f.Name,
      kind: f.CollectionType === 'movies' ? 'movie' : f.CollectionType === 'tvshows' ? 'tv' : 'other',
      locations: f.Locations ?? [],
    }));
  }

  async people(): Promise<MediaPerson[]> {
    type U = { Id: string; Name: string; Policy?: { IsDisabled?: boolean } };
    const rows = (await (await this.send('/Users')).json()) as U[];
    return rows.filter((u) => !u.Policy?.IsDisabled).map((u) => ({ id: u.Id, username: u.Name, name: u.Name }));
  }

  async scan(_library: MediaLibrary, folder: string): Promise<void> {
    await this.send('/Library/Media/Updated', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Updates: [{ Path: folder, UpdateType: 'Created' }] }),
    });
  }
}

// ---------------------------------------------------------------- settings

export interface MediaServerSettings {
  url: string | null;
  secret: string | null;
  /** Library ids picked for movies and TV; null means "pick for me". */
  movieLibrary: string | null;
  tvLibrary: string | null;
}

const key = (kind: ServerKind, field: string) => `services.${kind}_${field}`;

export function readMediaServer(db: Db, kind: ServerKind): MediaServerSettings {
  const get = (f: string) => getSetting(db, key(kind, f)) || null;
  return { url: get('url'), secret: get(kind === 'plex' ? 'token' : 'api_key'), movieLibrary: get('movie_library'), tvLibrary: get('tv_library') };
}

/** `undefined` leaves a field alone; `null` or "" clears it. A saved secret is forgotten when the address changes without a new one. */
export function writeMediaServer(db: Db, kind: ServerKind, v: Partial<MediaServerSettings>): void {
  const saved = readMediaServer(db, kind);
  const secretKey = key(kind, kind === 'plex' ? 'token' : 'api_key');
  if (v.url !== undefined) {
    const url = (v.url ?? '').trim().replace(/\/+$/, '');
    if (url !== (saved.url ?? '') && v.secret === undefined) setSetting(db, secretKey, '');
    setSetting(db, key(kind, 'url'), url);
  }
  if (v.secret !== undefined) setSetting(db, secretKey, (v.secret ?? '').trim());
  if (v.movieLibrary !== undefined) setSetting(db, key(kind, 'movie_library'), v.movieLibrary ?? '');
  if (v.tvLibrary !== undefined) setSetting(db, key(kind, 'tv_library'), v.tvLibrary ?? '');
}

/**
 * The library to scan for movies or TV: the one you picked, or else the only
 * one of that kind, or the one whose folder ends like Marquee's (".../movies").
 */
export function pickLibrary(libraries: MediaLibrary[], kind: 'movie' | 'tv', picked: string | null, marqueeRoot: string): MediaLibrary | null {
  if (picked) return libraries.find((l) => l.id === picked) ?? null;
  const ofKind = libraries.filter((l) => l.kind === kind);
  if (ofKind.length <= 1) return ofKind[0] ?? null;
  const tail = path.posix.basename(marqueeRoot);
  return ofKind.find((l) => l.locations.some((x) => path.posix.basename(x.replace(/\/+$/, '')) === tail)) ?? ofKind[0]!;
}

/**
 * The folder as the media server sees it: its place under Marquee's library
 * folder, put under the library's own folder. Uses the library folder that
 * ends like Marquee's, or the first.
 */
export function serverPath(folder: string, marqueeRoot: string, library: MediaLibrary): string {
  const rel = path.posix.relative(marqueeRoot, folder);
  if (rel.startsWith('..') || path.posix.isAbsolute(rel)) return folder;
  if (library.locations.some((l) => l.replace(/\/+$/, '') === marqueeRoot)) return folder; // same paths on both sides
  const tail = path.posix.basename(marqueeRoot);
  const base = (library.locations.find((l) => path.posix.basename(l.replace(/\/+$/, '')) === tail) ?? library.locations[0] ?? marqueeRoot).replace(/\/+$/, '');
  return rel ? `${base}/${rel}` : base;
}

export interface ScanOutcome {
  /** "Plex", "Jellyfin": servers that were asked to scan. */
  told: string[];
  /** Plain messages for servers that couldn't be told. */
  failed: string[];
}

/** Asks every connected media server to scan these folders. Never throws. */
export async function tellMediaServers(
  db: Db,
  clients: { plexServer(url: string, token: string): MediaServerApi; jellyfin(url: string, key: string): MediaServerApi },
  kind: 'movie' | 'tv',
  folders: string[],
): Promise<ScanOutcome> {
  const out: ScanOutcome = { told: [], failed: [] };
  const roots = libraryRoots(db);
  const root = kind === 'movie' ? roots.movies : roots.tv;
  for (const server of ['plex', 'jellyfin'] as const) {
    const s = readMediaServer(db, server);
    if (!s.url || !s.secret) continue;
    const label = server === 'plex' ? 'Plex' : 'Jellyfin';
    const api = server === 'plex' ? clients.plexServer(s.url, s.secret) : clients.jellyfin(s.url, s.secret);
    try {
      const lib = pickLibrary(await api.libraries(), kind, kind === 'movie' ? s.movieLibrary : s.tvLibrary, root);
      if (!lib) {
        out.failed.push(`${label} has no ${kind === 'movie' ? 'movie' : 'TV'} library. Pick one in Settings → Services.`);
        continue;
      }
      for (const f of [...new Set(folders)]) await api.scan(lib, serverPath(f, root, lib));
      out.told.push(label);
    } catch (err) {
      out.failed.push(err instanceof MediaServerError ? err.message : `${label}: ${(err as Error).message}`);
    }
  }
  return out;
}

/**
 * Jellyfin sign-in: asks Jellyfin to check a username and password. Returns the
 * person's Jellyfin id, or null when Jellyfin says no. The password is passed
 * straight through and never stored or logged.
 */
export async function jellyfinCheckLogin(url: string, username: string, password: string, fetchImpl: typeof fetch = fetch): Promise<{ id: string; name: string } | null> {
  const base = url.replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetchImpl(`${base}/Users/AuthenticateByName`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: 'MediaBrowser Client="Marquee", Device="Marquee", DeviceId="marquee", Version="1"',
      },
      body: JSON.stringify({ Username: username, Pw: password }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new MediaServerError(`Couldn't reach Jellyfin at ${base}.`);
  }
  if (res.status === 401 || res.status === 400 || res.status === 403) return null;
  if (!res.ok) throw new MediaServerError(`Jellyfin answered ${res.status}.`);
  const body = (await res.json()) as { User?: { Id?: string; Name?: string } };
  return body.User?.Id ? { id: body.User.Id, name: body.User.Name ?? username } : null;
}
