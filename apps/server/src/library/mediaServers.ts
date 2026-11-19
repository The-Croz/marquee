import path from 'node:path';
import { keepListening, nodeSocket, type SocketFactory } from '../activity/socket.js';
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

/** What was (or is being) watched. Episodes carry their show's name. */
export interface WatchItem {
  kind: 'movie' | 'episode';
  title: string;
  show: string | null;
  season: number | null;
  episode: number | null;
  year: number | null;
  tmdbId: number | null;
}
export interface NowPlayingItem extends WatchItem {
  /** The server's id for this stream, needed to stop it. */
  sessionId: string;
  /** The app playing it, e.g. "Plex for Roku". */
  platform: string;
  /** "4k", "1080", "720", "480" or "sd"; null when the server doesn't say. */
  resolution: string | null;
  user: string;
  device: string;
  state: 'playing' | 'paused' | 'buffering';
  /** 0 to 1 */
  progress: number;
  transcoding: boolean;
}
export interface PlayRecord extends WatchItem {
  /** The server's id for the person, and the name it shows. */
  userId: string;
  user: string;
  /** The server's id for the item, so a play is never counted twice. */
  key: string;
  playedAt: number;
}

export interface MediaServerApi {
  /** Who is watching right now. */
  nowPlaying(): Promise<NowPlayingItem[]>;
  /** Stops one stream, showing the viewer `message`. Throws MediaServerError if the server says no. */
  stop(sessionId: string, message: string): Promise<void>;
  /**
   * Calls `onHint` the moment the server says something started, paused or
   * stopped playing, so Marquee can look at once instead of waiting for its
   * next check. `onState` says whether that live line is open. Returns a
   * function that closes it. Servers without one just don't offer this.
   */
  watch?(onHint: () => void, onState?: (connected: boolean) => void): () => void;
  /** Finished plays since a time (ms), newest first. */
  history(since: number): Promise<PlayRecord[]>;
  /** The people who can use this server (Plex: you and the friends it's shared with). */
  people(): Promise<MediaPerson[]>;
  /** Name and version, or throws MediaServerError. */
  ping(): Promise<{ name: string; version: string }>;
  libraries(): Promise<MediaLibrary[]>;
  /** Asks the server to scan one folder of one library. */
  scan(library: MediaLibrary, folder: string): Promise<void>;
  /** Watched sync: the server's people, each person's movies and episodes, and ticking one watched or not. */
  watchedUsers?(): Promise<MediaPerson[]>;
  watchedLibrary?(userId: string): Promise<SyncItem[]>;
  setWatched?(userId: string, ref: string, watched: boolean): Promise<void>;
}

/** One movie or episode as one person sees it, for watched sync. */
export interface SyncItem {
  /** The server's id for it. */
  ref: string;
  /**
   * What it is, in ids both servers know: "m:tmdb:603" for a movie,
   * "e:tvdb:371980:1:2" for an episode (the show's id, season, episode).
   */
  keys: string[];
  watched: boolean;
  title: string;
}

/** "tmdb://603", "imdb://tt0133093" or a Jellyfin ProviderIds map → "tmdb:603", "imdb:tt0133093". */
function idKeys(ids: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(ids)) {
    const name = k.toLowerCase();
    if (v && ['tmdb', 'tvdb', 'imdb'].includes(name)) out.push(`${name}:${v}`);
  }
  return out;
}
const plexIds = (guids: { id: string }[] | undefined) => Object.fromEntries((guids ?? []).map((g) => g.id.split('://') as [string, string]));
const sxe = (show: string[], s: number | undefined, e: number | undefined) => (s === undefined || e === undefined ? [] : show.map((k) => `e:${k}:${s}:${e}`));

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

/** One short name for a picture size. */
export function resolutionLabel(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string' && /^(4k|sd)$/i.test(v)) return v.toLowerCase();
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  // Plex says the height already ("1080"); Jellyfin gives a height too.
  return n >= 2000 ? '4k' : n >= 1000 ? '1080' : n >= 700 ? '720' : n >= 400 ? '480' : 'sd';
}

interface PlexMeta {
  type: string;
  ratingKey?: string | number;
  title: string;
  grandparentTitle?: string;
  parentIndex?: number;
  index?: number;
  year?: number;
  viewOffset?: number;
  duration?: number;
  viewedAt?: number;
  accountID?: number;
  User?: { title?: string };
  Player?: { title?: string; product?: string; platform?: string; state?: string };
  Session?: { id?: string };
  Media?: { videoResolution?: string }[];
  TranscodeSession?: { videoDecision?: string };
  Guid?: { id: string }[];
  viewCount?: number;
  grandparentRatingKey?: string | number;
}

function plexItem(m: PlexMeta): WatchItem {
  const tmdb = m.Guid?.map((g) => /^tmdb:\/\/(\d+)/.exec(g.id)?.[1]).find(Boolean);
  const ep = m.type === 'episode';
  return { kind: ep ? 'episode' : 'movie', title: m.title, show: ep ? (m.grandparentTitle ?? null) : null, season: ep ? (m.parentIndex ?? null) : null, episode: ep ? (m.index ?? null) : null, year: m.year ?? null, tmdbId: !ep && tmdb ? Number(tmdb) : null };
}

export class PlexServerClient implements MediaServerApi {
  private readonly base: string;
  constructor(
    url: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly socket: SocketFactory = nodeSocket,
  ) {
    this.base = url.replace(/\/+$/, '');
  }

  watch(onHint: () => void, onState: (connected: boolean) => void = () => {}): () => void {
    // Plex sends {"NotificationContainer":{"type":"playing", ...}} on every play, pause and stop.
    return keepListening(
      {
        url: `${this.base.replace(/^http/, 'ws')}/:/websockets/notifications?X-Plex-Token=${encodeURIComponent(this.token)}`,
        onMessage: (text) => {
          try {
            if ((JSON.parse(text) as { NotificationContainer?: { type?: string } }).NotificationContainer?.type === 'playing') onHint();
          } catch {
            /* not JSON: ignore */
          }
        },
      },
      onState,
      this.socket,
    );
  }

  async stop(sessionId: string, message: string): Promise<void> {
    await this.get(`/status/sessions/terminate?sessionId=${encodeURIComponent(sessionId)}&reason=${encodeURIComponent(message)}`);
  }

  private get(p: string, token = this.token): Promise<Response> {
    return request(this.fetchImpl, 'Plex', this.base, `${this.base}${p}`, { headers: { Accept: 'application/json', 'X-Plex-Token': token } });
  }

  /** Each person's own key for this server (the owner uses the admin token), from plex.tv's sharing list. */
  private tokens = new Map<string, string>();

  async watchedUsers(): Promise<MediaPerson[]> {
    const h = { Accept: 'application/json', 'X-Plex-Token': this.token, 'X-Plex-Client-Identifier': 'marquee', 'X-Plex-Product': 'Marquee' };
    const me = (await (await request(this.fetchImpl, 'Plex', 'plex.tv', 'https://plex.tv/api/v2/user', { headers: h })).json()) as { id: number; username?: string; title?: string };
    const machine = ((await (await this.get('/')).json()) as { MediaContainer?: { machineIdentifier?: string } }).MediaContainer?.machineIdentifier;
    const people: MediaPerson[] = [{ id: String(me.id), username: me.username || me.title || String(me.id), name: me.title || me.username || String(me.id) }];
    this.tokens = new Map([[String(me.id), this.token]]);
    if (machine) {
      // This list only comes as XML. Each <SharedServer> carries the person's own key for this server.
      const xml = await (await request(this.fetchImpl, 'Plex', 'plex.tv', `https://plex.tv/api/servers/${encodeURIComponent(machine)}/shared_servers`, { headers: { ...h, Accept: 'application/xml' } })).text();
      for (const tag of xml.match(/<SharedServer\b[^>]*>/g) ?? []) {
        const attr = (n: string) => new RegExp(`\\b${n}="([^"]*)"`).exec(tag)?.[1];
        const id = attr('userID');
        const token = attr('accessToken');
        if (!id || !token) continue;
        this.tokens.set(id, token);
        const name = attr('username') || attr('email') || id;
        people.push({ id, username: name, name });
      }
    }
    return people;
  }

  private async tokenFor(userId: string): Promise<string> {
    if (!this.tokens.has(userId)) await this.watchedUsers();
    const t = this.tokens.get(userId);
    if (!t) throw new MediaServerError('Plex doesn’t share this server with that person any more.');
    return t;
  }

  async watchedLibrary(userId: string): Promise<SyncItem[]> {
    const token = await this.tokenFor(userId);
    const list = async (p: string) => ((await (await this.get(p, token)).json()) as { MediaContainer?: { Metadata?: PlexMeta[] } }).MediaContainer?.Metadata ?? [];
    const out: SyncItem[] = [];
    for (const lib of await this.libraries()) {
      const key = encodeURIComponent(lib.id);
      if (lib.kind === 'movie') {
        for (const m of await list(`/library/sections/${key}/all?type=1&includeGuids=1`)) {
          out.push({ ref: String(m.ratingKey), keys: idKeys(plexIds(m.Guid)).map((k) => `m:${k}`), watched: (m.viewCount ?? 0) > 0, title: m.year ? `${m.title} (${m.year})` : m.title });
        }
      } else if (lib.kind === 'tv') {
        const shows = new Map((await list(`/library/sections/${key}/all?type=2&includeGuids=1`)).map((m) => [String(m.ratingKey), idKeys(plexIds(m.Guid))]));
        for (const m of await list(`/library/sections/${key}/all?type=4&includeGuids=1`)) {
          const show = shows.get(String(m.grandparentRatingKey)) ?? [];
          out.push({ ref: String(m.ratingKey), keys: sxe(show, m.parentIndex, m.index), watched: (m.viewCount ?? 0) > 0, title: `${m.grandparentTitle ?? ''} S${String(m.parentIndex ?? 0).padStart(2, '0')}E${String(m.index ?? 0).padStart(2, '0')}` });
        }
      }
    }
    return out;
  }

  async setWatched(userId: string, ref: string, watched: boolean): Promise<void> {
    await this.get(`/:/${watched ? 'scrobble' : 'unscrobble'}?identifier=com.plexapp.plugins.library&key=${encodeURIComponent(ref)}`, await this.tokenFor(userId));
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

  private async list<T>(p: string): Promise<T[]> {
    const body = (await (await this.get(p)).json()) as { MediaContainer?: { Metadata?: T[]; Account?: T[] } };
    return body.MediaContainer?.Metadata ?? body.MediaContainer?.Account ?? [];
  }

  async nowPlaying(): Promise<NowPlayingItem[]> {
    const rows = await this.list<PlexMeta>('/status/sessions?includeGuids=1');
    return rows.filter((m) => m.type === 'movie' || m.type === 'episode').map((m) => ({
      ...plexItem(m),
      sessionId: String(m.Session?.id ?? m.ratingKey ?? ''),
      platform: m.Player?.product || m.Player?.platform || 'an app',
      resolution: resolutionLabel(m.Media?.[0]?.videoResolution),
      user: m.User?.title ?? 'Someone',
      device: m.Player?.title || m.Player?.product || 'a device',
      state: m.Player?.state === 'paused' ? 'paused' : m.Player?.state === 'buffering' ? 'buffering' : 'playing',
      progress: m.duration ? Math.min(1, (m.viewOffset ?? 0) / m.duration) : 0,
      transcoding: Boolean(m.TranscodeSession && m.TranscodeSession.videoDecision !== 'copy'),
    }));
  }

  async history(since: number): Promise<PlayRecord[]> {
    const names = new Map((await this.list<{ id: number; name: string }>('/accounts')).map((a) => [String(a.id), a.name]));
    const rows = await this.list<PlexMeta>(`/status/sessions/history/all?sort=viewedAt:desc&includeGuids=1&X-Plex-Container-Start=0&X-Plex-Container-Size=2000&viewedAt>=${Math.floor(since / 1000)}`);
    return rows
      .filter((m) => (m.type === 'movie' || m.type === 'episode') && m.viewedAt)
      .map((m) => ({ ...plexItem(m), userId: String(m.accountID), user: names.get(String(m.accountID)) ?? `User ${m.accountID}`, key: String(m.ratingKey), playedAt: m.viewedAt! * 1000 }));
  }

  async people(): Promise<MediaPerson[]> {
    // The server's own address doesn't know the sharing list; plex.tv does, and the same token opens it.
    const h = { Accept: 'application/json', 'X-Plex-Token': this.token, 'X-Plex-Client-Identifier': 'marquee', 'X-Plex-Product': 'Marquee' };
    type P = { id: number; username?: string; title?: string };
    const me = (await (await request(this.fetchImpl, 'Plex', 'plex.tv', 'https://plex.tv/api/v2/user', { headers: h })).json()) as P;
    let friends: P[];
    try {
      // The friends list Seerr and Tautulli read. It only comes as XML: <User id=".." title=".." username=".."/>.
      const xml = await (await request(this.fetchImpl, 'Plex', 'plex.tv', 'https://plex.tv/api/users', { headers: { ...h, Accept: 'application/xml' } })).text();
      friends = (xml.match(/<User\b[^>]*>/g) ?? []).map((tag) => {
        const attr = (n: string) => new RegExp(`\\s${n}="([^"]*)"`).exec(tag)?.[1];
        return { id: Number(attr('id')), username: attr('username') || undefined, title: attr('title') || undefined };
      });
    } catch {
      // Older accounts: the newer list, which plex.tv has retired for some (it answers 410).
      friends = (await (await request(this.fetchImpl, 'Plex', 'plex.tv', 'https://plex.tv/api/v2/friends', { headers: h })).json()) as P[];
    }
    return [me, ...friends].filter((p) => p.id).map((p) => ({ id: String(p.id), username: p.username || p.title || String(p.id), name: p.title || p.username || String(p.id) }));
  }

  async scan(library: MediaLibrary, folder: string): Promise<void> {
    await this.get(`/library/sections/${encodeURIComponent(library.id)}/refresh?path=${encodeURIComponent(folder)}`);
  }
}

interface JfItem {
  Id?: string;
  Type: string;
  Name: string;
  SeriesName?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  ProductionYear?: number;
  RunTimeTicks?: number;
  Height?: number;
  ProviderIds?: Record<string, string>;
  UserData?: { LastPlayedDate?: string; Played?: boolean };
  SeriesId?: string;
}

function jfItem(i: JfItem): WatchItem {
  const ep = i.Type === 'Episode';
  return { kind: ep ? 'episode' : 'movie', title: i.Name, show: ep ? (i.SeriesName ?? null) : null, season: ep ? (i.ParentIndexNumber ?? null) : null, episode: ep ? (i.IndexNumber ?? null) : null, year: i.ProductionYear ?? null, tmdbId: !ep && i.ProviderIds?.Tmdb ? Number(i.ProviderIds.Tmdb) : null };
}

export class JellyfinClient implements MediaServerApi {
  private readonly base: string;
  constructor(
    url: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly socket: SocketFactory = nodeSocket,
  ) {
    this.base = url.replace(/\/+$/, '');
  }

  watch(onHint: () => void, onState: (connected: boolean) => void = () => {}): () => void {
    // Jellyfin sends the whole session list every few seconds once we ask for it, and
    // straight away on changes. We use each message as a nudge and read the list ourselves.
    return keepListening(
      {
        url: `${this.base.replace(/^http/, 'ws')}/socket?api_key=${encodeURIComponent(this.apiKey)}&deviceId=marquee`,
        onOpen: (s) => s.send(JSON.stringify({ MessageType: 'SessionsStart', Data: '0,5000' })),
        onMessage: (text) => {
          try {
            if ((JSON.parse(text) as { MessageType?: string }).MessageType === 'Sessions') onHint();
          } catch {
            /* not JSON: ignore */
          }
        },
      },
      onState,
      this.socket,
    );
  }

  async stop(sessionId: string, message: string): Promise<void> {
    const id = encodeURIComponent(sessionId);
    const json = { 'Content-Type': 'application/json' };
    if (message) await this.send(`/Sessions/${id}/Message`, { method: 'POST', headers: json, body: JSON.stringify({ Header: 'Playback stopped', Text: message, TimeoutMs: 10_000 }) }).catch(() => {});
    await this.send(`/Sessions/${id}/Playing/Stop`, { method: 'POST' });
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

  async nowPlaying(): Promise<NowPlayingItem[]> {
    type S = { Id?: string; UserName?: string; DeviceName?: string; Client?: string; NowPlayingItem?: JfItem; PlayState?: { PositionTicks?: number; IsPaused?: boolean; PlayMethod?: string } };
    const rows = (await (await this.send('/Sessions')).json()) as S[];
    return rows.filter((r) => r.NowPlayingItem && (r.NowPlayingItem.Type === 'Movie' || r.NowPlayingItem.Type === 'Episode')).map((r) => ({
      ...jfItem(r.NowPlayingItem!),
      sessionId: r.Id ?? '',
      platform: r.Client || 'an app',
      resolution: resolutionLabel(r.NowPlayingItem!.Height),
      user: r.UserName ?? 'Someone',
      device: r.DeviceName || r.Client || 'a device',
      state: r.PlayState?.IsPaused ? 'paused' : 'playing',
      progress: r.NowPlayingItem!.RunTimeTicks ? Math.min(1, (r.PlayState?.PositionTicks ?? 0) / r.NowPlayingItem!.RunTimeTicks) : 0,
      transcoding: r.PlayState?.PlayMethod === 'Transcode',
    }));
  }

  async history(since: number): Promise<PlayRecord[]> {
    const users = (await (await this.send('/Users')).json()) as { Id: string; Name: string }[];
    const out: PlayRecord[] = [];
    for (const u of users) {
      const q = 'Recursive=true&Filters=IsPlayed&IncludeItemTypes=Movie,Episode&SortBy=DatePlayed&SortOrder=Descending&Limit=300&Fields=ProviderIds&EnableUserData=true';
      const body = (await (await this.send(`/Users/${encodeURIComponent(u.Id)}/Items?${q}`)).json()) as { Items?: JfItem[] };
      for (const i of body.Items ?? []) {
        const at = i.UserData?.LastPlayedDate ? Date.parse(i.UserData.LastPlayedDate) : NaN;
        if (Number.isFinite(at) && at >= since) out.push({ ...jfItem(i), userId: u.Id, user: u.Name, key: i.Id ?? '', playedAt: at });
      }
    }
    return out.sort((a, b) => b.playedAt - a.playedAt);
  }

  async people(): Promise<MediaPerson[]> {
    type U = { Id: string; Name: string; Policy?: { IsDisabled?: boolean } };
    const rows = (await (await this.send('/Users')).json()) as U[];
    return rows.filter((u) => !u.Policy?.IsDisabled).map((u) => ({ id: u.Id, username: u.Name, name: u.Name }));
  }

  watchedUsers(): Promise<MediaPerson[]> {
    return this.people();
  }

  async watchedLibrary(userId: string): Promise<SyncItem[]> {
    const items = async (types: string) =>
      ((await (await this.send(`/Users/${encodeURIComponent(userId)}/Items?Recursive=true&IncludeItemTypes=${types}&Fields=ProviderIds&EnableUserData=true`)).json()) as { Items?: JfItem[] }).Items ?? [];
    const shows = new Map((await items('Series')).map((i) => [i.Id ?? '', idKeys(i.ProviderIds ?? {})]));
    return (await items('Movie,Episode')).map((i) => {
      const ep = i.Type === 'Episode';
      return {
        ref: i.Id ?? '',
        keys: ep ? sxe(shows.get(i.SeriesId ?? '') ?? [], i.ParentIndexNumber, i.IndexNumber) : idKeys(i.ProviderIds ?? {}).map((k) => `m:${k}`),
        watched: Boolean(i.UserData?.Played),
        title: ep ? `${i.SeriesName ?? ''} S${String(i.ParentIndexNumber ?? 0).padStart(2, '0')}E${String(i.IndexNumber ?? 0).padStart(2, '0')}` : i.ProductionYear ? `${i.Name} (${i.ProductionYear})` : i.Name,
      };
    });
  }

  async setWatched(userId: string, ref: string, watched: boolean): Promise<void> {
    await this.send(`/Users/${encodeURIComponent(userId)}/PlayedItems/${encodeURIComponent(ref)}`, { method: watched ? 'POST' : 'DELETE' });
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
