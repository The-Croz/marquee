import { Hono } from 'hono';
import { z } from 'zod';
import type { ServiceTestResult, ServicesView } from '@marquee/shared';
import { readNaming, readServices, writeNaming, writeServices } from '../library/services.js';
import { DEFAULT_MOVIE_PATTERN, DEFAULT_TV_PATTERN, patternProblem, renderName } from '../library/naming.js';
import { pickLibrary, readMediaServer, writeMediaServer, type ServerKind } from '../library/mediaServers.js';
import { libraryRoots } from '../library/services.js';
import { readPlexLabels, writePlexLabels } from '../library/onServers.js';
import type { MediaLibrariesResult, MediaServerView } from '@marquee/shared';
import type { Db } from '../db/index.js';
import { HttpError, requireAdmin, type Ctx, type Env } from '../http.js';
import { getSetting } from '../db/index.js';

/** Settings → Services: TMDB, Radarr, Sonarr and library folders. Admin only. */
export const servicesRoutes = new Hono<Env>();

const url = z
  .string()
  .trim()
  .refine((v) => v === '' || /^https?:\/\/[^\s]+$/i.test(v), 'Addresses start with http:// or https://, e.g. http://192.168.1.100:7878')
  .transform((v) => v.replace(/\/+$/, ''));
const secret = z.string().trim().max(500);
const folder = z
  .string()
  .trim()
  .refine((v) => v.startsWith('/'), 'Folders are full paths inside the container, e.g. /data/media/movies')
  .transform((v) => v.replace(/\/+$/, '') || '/');

/** A name pattern; "" means the default. */
const pattern = (kind: 'movie' | 'tv') =>
  z
    .string()
    .max(300)
    .superRefine((v, ctx) => {
      const problem = v.trim() ? patternProblem(v, kind) : null;
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    });

servicesRoutes.get('/', (c) => {
  requireAdmin(c);
  const { db, config } = c.get('deps');
  const s = readServices(db, config);
  const view: ServicesView = {
    tmdb: { configured: !!s.tmdbApiKey, fromEnvironment: !getSetting(db, 'services.tmdb_api_key') && !!config.tmdbApiKey },
    streamingTop: { configured: !!s.streamingTopKey },
    omdb: { configured: !!s.omdbKey },
    radarr: { url: s.radarrUrl, configured: !!(s.radarrUrl && s.radarrApiKey) },
    sonarr: { url: s.sonarrUrl, configured: !!(s.sonarrUrl && s.sonarrApiKey) },
    moviesRoot: s.moviesRoot,
    tvRoot: s.tvRoot,
    naming: { ...readNaming(db), defaultMovie: DEFAULT_MOVIE_PATTERN, defaultTv: DEFAULT_TV_PATTERN },
    plex: serverView(db, 'plex'),
    jellyfin: serverView(db, 'jellyfin'),
  };
  return c.json(view);
});

servicesRoutes.put('/', async (c) => {
  requireAdmin(c);
  const input = z
    .object({
      tmdbApiKey: secret.nullable().optional(),
      streamingTopKey: secret.nullable().optional(),
      omdbKey: secret.nullable().optional(),
      radarrUrl: url.nullable().optional(),
      radarrApiKey: secret.nullable().optional(),
      sonarrUrl: url.nullable().optional(),
      sonarrApiKey: secret.nullable().optional(),
      moviesRoot: folder.optional(),
      tvRoot: folder.optional(),
      moviePattern: pattern('movie').optional(),
      tvPattern: pattern('tv').optional(),
      plexUrl: url.nullable().optional(),
      plexToken: secret.nullable().optional(),
      plexMovieLibrary: z.string().max(100).nullable().optional(),
      plexTvLibrary: z.string().max(100).nullable().optional(),
      jellyfinUrl: url.nullable().optional(),
      jellyfinApiKey: secret.nullable().optional(),
      jellyfinMovieLibrary: z.string().max(100).nullable().optional(),
      jellyfinTvLibrary: z.string().max(100).nullable().optional(),
      jellyfinPublicUrl: url.nullable().optional(),
      plexLabels: z.object({ on: z.boolean().optional(), text: z.string().trim().min(1, 'Type the label to add, e.g. Requested.').max(60).optional(), requester: z.boolean().optional() }).optional(),
    })
    .parse(await c.req.json());
  const { moviePattern, tvPattern, plexUrl, plexToken, plexMovieLibrary, plexTvLibrary, jellyfinUrl, jellyfinApiKey, jellyfinMovieLibrary, jellyfinTvLibrary, jellyfinPublicUrl, plexLabels, ...rest } = input;
  const db = c.get('deps').db;
  writeServices(db, rest);
  writeNaming(db, { movie: moviePattern, tv: tvPattern });
  writeMediaServer(db, 'plex', { url: plexUrl, secret: plexToken, movieLibrary: plexMovieLibrary || (plexMovieLibrary === undefined ? undefined : null), tvLibrary: plexTvLibrary || (plexTvLibrary === undefined ? undefined : null) });
  writeMediaServer(db, 'jellyfin', {
    url: jellyfinUrl,
    secret: jellyfinApiKey,
    movieLibrary: jellyfinMovieLibrary || (jellyfinMovieLibrary === undefined ? undefined : null),
    tvLibrary: jellyfinTvLibrary || (jellyfinTvLibrary === undefined ? undefined : null),
    publicUrl: jellyfinPublicUrl,
  });
  if (plexLabels) writePlexLabels(db, plexLabels);
  return c.json({ ok: true });
});

function serverView(db: Db, kind: ServerKind): MediaServerView {
  const s = readMediaServer(db, kind);
  return { url: s.url, configured: !!(s.url && s.secret), movieLibrary: s.movieLibrary, tvLibrary: s.tvLibrary, publicUrl: s.publicUrl, ...(kind === 'plex' ? { labels: readPlexLabels(db) } : {}) };
}

/** A media server from typed values, falling back to saved ones. A saved secret only goes to its own address. */
function mediaServerFor(c: Ctx, kind: ServerKind, typed: { url?: string; secret?: string }) {
  const { db, clients } = c.get('deps');
  const saved = readMediaServer(db, kind);
  const u = typed.url || saved.url;
  const label = kind === 'plex' ? 'Plex' : 'Jellyfin';
  if (!u) throw new HttpError(400, 'not_set_up', `Enter ${label}'s address first.`);
  let secretValue = typed.secret;
  if (!secretValue) {
    if (saved.secret && u !== saved.url) throw new HttpError(400, 'needs_secret', `The address changed. For safety, type the ${kind === 'plex' ? 'token' : 'API key'} again.`);
    secretValue = saved.secret ?? '';
  }
  if (!secretValue) throw new HttpError(400, 'needs_secret', `Enter ${label}'s ${kind === 'plex' ? 'token' : 'API key'} first.`);
  return kind === 'plex' ? clients.plexServer(u, secretValue) : clients.jellyfin(u, secretValue);
}

/** A media server's libraries, and which ones Marquee would scan, for the pickers. */
servicesRoutes.post('/media-libraries', async (c) => {
  requireAdmin(c);
  const input = z.object({ server: z.enum(['plex', 'jellyfin']), url: url.optional(), secret: secret.optional() }).parse(await c.req.json());
  const { db } = c.get('deps');
  const api = mediaServerFor(c, input.server, input);
  try {
    const libraries = await api.libraries();
    const s = readMediaServer(db, input.server);
    const roots = libraryRoots(db);
    return c.json<MediaLibrariesResult>({
      libraries,
      picked: { movie: pickLibrary(libraries, 'movie', s.movieLibrary, roots.movies)?.id ?? null, tv: pickLibrary(libraries, 'tv', s.tvLibrary, roots.tv)?.id ?? null },
    });
  } catch (err) {
    throw new HttpError(502, 'media_server_failed', (err as Error).message);
  }
});

/** What a name pattern gives for an example title, or what's wrong with it. For the live preview. */
servicesRoutes.post('/name-example', async (c) => {
  requireAdmin(c);
  const { kind, pattern } = z.object({ kind: z.enum(['movie', 'tv']), pattern: z.string().max(300) }).parse(await c.req.json());
  const p = pattern.trim() || (kind === 'movie' ? DEFAULT_MOVIE_PATTERN : DEFAULT_TV_PATTERN);
  const problem = patternProblem(p, kind);
  if (problem) return c.json({ example: null, problem });
  const example =
    kind === 'movie'
      ? renderName(p, { Title: 'Dune: Part Two', Year: 2024, TmdbId: 693134, ImdbId: 'tt15239678', Quality: 'WEBDL-2160p', HDR: 'DV HDR10', Group: 'FLUX' }) + '.mkv'
      : renderName(p, { Show: 'Severance', Year: 2022, TvdbId: 371980, TmdbId: 95396, Season: 2, Episodes: [3], 'Episode Title': 'Who Is Alive?', Quality: 'WEBDL-1080p', HDR: null, Group: 'NTb' }) + '.mkv';
  return c.json({ example, problem: null });
});

/** Tries a connection using the typed values if given, else the saved ones. */
servicesRoutes.post('/test', async (c) => {
  requireAdmin(c);
  const { db, config, clients } = c.get('deps');
  const input = z
    .object({ service: z.enum(['tmdb', 'streamingTop', 'omdb', 'radarr', 'sonarr', 'plex', 'jellyfin']), url: url.optional(), apiKey: secret.optional() })
    .parse(await c.req.json());
  const saved = readServices(db, config);
  const result = async (): Promise<ServiceTestResult> => {
    if (input.service === 'tmdb') {
      const key = input.apiKey || saved.tmdbApiKey;
      if (!key) return { ok: false, message: 'Enter your TMDB API key first.' };
      await clients.tmdb(key).ping();
      return { ok: true, message: 'Connected to TMDB.' };
    }
    if (input.service === 'streamingTop') {
      const key = input.apiKey || saved.streamingTopKey;
      if (!key) return { ok: false, message: 'Enter your Streaming Availability key first.' };
      await clients.streamingTop(key).ping();
      return { ok: true, message: 'Connected to Streaming Availability. Discover shows each service’s own Top 10.' };
    }
    if (input.service === 'omdb') {
      const key = input.apiKey || saved.omdbKey;
      if (!key) return { ok: false, message: 'Enter your OMDb key first.' };
      await clients.omdb(key).ping();
      return { ok: true, message: 'Connected to OMDb. Title pages show IMDb and Rotten Tomatoes scores.' };
    }
    if (input.service === 'plex' || input.service === 'jellyfin') {
      const api = mediaServerFor(c, input.service, { url: input.url, secret: input.apiKey });
      const { name, version } = await api.ping();
      const libs = await api.libraries();
      const movies = libs.filter((l) => l.kind === 'movie').length;
      const tv = libs.filter((l) => l.kind === 'tv').length;
      const count = (n: number, what: string) => `${n} ${what} ${n === 1 ? 'library' : 'libraries'}`;
      return { ok: true, message: `Connected to ${name} (${input.service === 'plex' ? 'Plex' : 'Jellyfin'} ${version}): ${count(movies, 'movie')} and ${count(tv, 'TV')}.` };
    }
    const target = input.service === 'radarr' ? { url: saved.radarrUrl, key: saved.radarrApiKey } : { url: saved.sonarrUrl, key: saved.sonarrApiKey };
    const u = input.url || target.url;
    const k = input.apiKey || target.key;
    if (!u || !k) return { ok: false, message: 'Enter the address and API key first.' };
    const { app, version } = await clients.arr(input.service, u, k).ping();
    const titles = await clients.arr(input.service, u, k).titles();
    return { ok: true, message: `Connected to ${app} ${version}: ${titles.length} ${input.service === 'radarr' ? 'movies' : 'shows'}.` };
  };
  try {
    return c.json(await result());
  } catch (err) {
    return c.json<ServiceTestResult>({ ok: false, message: (err as Error).message });
  }
});
