import { Hono } from 'hono';
import { z } from 'zod';
import type { EpisodeDetailView } from '@marquee/shared';
import { requireAdmin, type Ctx, type Deps, type Env } from '../http.js';
import { episodeFacts, removeEpisode, type EpisodeDeps } from '../library/episodeCare.js';
import { tellMediaServers } from '../library/mediaServers.js';
import { readDownloader } from '../downloads/service.js';
import { sharedMonitor } from '../downloads/monitor.js';
import { fileView } from './library.js';
import path from 'node:path';

/** One episode up close, and removing it (admins). Mounted under /api/shows. */
export const episodeRoutes = new Hono<Env>();

function deps(d: Deps): EpisodeDeps {
  return {
    db: d.db,
    now: d.now,
    qbit: () => {
      const s = readDownloader(d.db);
      return s.url ? d.clients.qbittorrent(s.url, s.username, s.password ?? '') : null;
    },
  };
}

const where = (c: Ctx) => [Number(c.req.param('id')), Number(c.req.param('season')), Number(c.req.param('episode'))] as const;
const PATH = '/:id{[0-9]+}/seasons/:season{[0-9]+}/episodes/:episode{[0-9]+}';

episodeRoutes.get(PATH, async (c) => {
  requireAdmin(c);
  const [id, season, episode] = where(c);
  const f = await episodeFacts(deps(c.get('deps')), id, season, episode);
  const today = new Date(c.get('deps').now()).toISOString().slice(0, 10);
  return c.json<EpisodeDetailView>({
    seriesId: id,
    season,
    episode,
    title: f.episode.title,
    airDate: f.episode.airDate,
    overview: f.episode.overview,
    aired: !!(f.episode.airDate && f.episode.airDate <= today),
    wanted: f.episode.monitored,
    files: f.files.map((x) => ({ ...fileView(x.row), name: path.basename(x.row.path), otherEpisodes: x.otherEpisodes, shared: x.shared })),
    torrents: f.torrents.map(({ hash, name, followed, inDownloader, wholeSeason }) => ({ hash, name, followed, inDownloader, wholeSeason })),
    downloaderNote: f.downloaderNote,
  });
});

episodeRoutes.post(`${PATH}/remove`, async (c) => {
  const user = requireAdmin(c);
  const input = z.object({ stopWanting: z.boolean(), torrents: z.array(z.string().regex(/^[0-9a-f]{40,64}$/)).max(50) }).parse(await c.req.json());
  const [id, season, episode] = where(c);
  const d = c.get('deps');
  const monitor = sharedMonitor({ db: d.db, clients: d.clients, sources: d.sources, now: d.now });
  const r = await removeEpisode({ ...deps(d), removeFollowed: async (downloadId) => void (await monitor.remove(downloadId, true, user.id)) }, id, season, episode, input, user.id);
  if (r.folders.length) {
    const told = await tellMediaServers(d.db, d.clients, 'tv', r.folders).catch(() => null);
    if (told?.failed.length) r.problems.push(...told.failed);
  }
  return c.json({ message: r.message, problems: r.problems });
});
