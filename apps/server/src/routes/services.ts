import { Hono } from 'hono';
import { z } from 'zod';
import type { ServiceTestResult, ServicesView } from '@marquee/shared';
import { readNaming, readServices, writeNaming, writeServices } from '../library/services.js';
import { DEFAULT_MOVIE_PATTERN, DEFAULT_TV_PATTERN, patternProblem, renderName } from '../library/naming.js';
import { requireAdmin, type Env } from '../http.js';
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
    radarr: { url: s.radarrUrl, configured: !!(s.radarrUrl && s.radarrApiKey) },
    sonarr: { url: s.sonarrUrl, configured: !!(s.sonarrUrl && s.sonarrApiKey) },
    moviesRoot: s.moviesRoot,
    tvRoot: s.tvRoot,
    naming: { ...readNaming(db), defaultMovie: DEFAULT_MOVIE_PATTERN, defaultTv: DEFAULT_TV_PATTERN },
  };
  return c.json(view);
});

servicesRoutes.put('/', async (c) => {
  requireAdmin(c);
  const input = z
    .object({
      tmdbApiKey: secret.nullable().optional(),
      radarrUrl: url.nullable().optional(),
      radarrApiKey: secret.nullable().optional(),
      sonarrUrl: url.nullable().optional(),
      sonarrApiKey: secret.nullable().optional(),
      moviesRoot: folder.optional(),
      tvRoot: folder.optional(),
      moviePattern: pattern('movie').optional(),
      tvPattern: pattern('tv').optional(),
    })
    .parse(await c.req.json());
  const { moviePattern, tvPattern, ...rest } = input;
  writeServices(c.get('deps').db, rest);
  writeNaming(c.get('deps').db, { movie: moviePattern, tv: tvPattern });
  return c.json({ ok: true });
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
    .object({ service: z.enum(['tmdb', 'radarr', 'sonarr']), url: url.optional(), apiKey: secret.optional() })
    .parse(await c.req.json());
  const saved = readServices(db, config);
  const result = async (): Promise<ServiceTestResult> => {
    if (input.service === 'tmdb') {
      const key = input.apiKey || saved.tmdbApiKey;
      if (!key) return { ok: false, message: 'Enter your TMDB API key first.' };
      await clients.tmdb(key).ping();
      return { ok: true, message: 'Connected to TMDB.' };
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
