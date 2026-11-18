import { and, desc, eq, gte, isNotNull } from 'drizzle-orm';
import type { CutoverStep, CutoverView } from '@marquee/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { comparisons, downloads } from '../db/schema.js';
import type { Clients } from '../http.js';
import { readMediaServer } from '../library/mediaServers.js';
import { readServices } from '../library/services.js';
import { checkDownloader, readDownloader } from '../downloads/service.js';
import { lastWantedRuns, lookingForWanted } from '../downloads/wanted.js';
import { lastWantedTvRuns, lookingForWantedTv } from '../downloads/wantedTv.js';

/**
 * The switch-over checklists: what Marquee can check for itself before it
 * takes movies over from Radarr (or TV from Sonarr), then the steps to hand
 * over. Read-only towards Radarr and Sonarr: Marquee checks their queue and
 * how many titles they still watch, but you turn their watching off yourself.
 *
 * TV has no "picks what Sonarr would" step (comparison mode only reads
 * Radarr); it asks for movies to be switched over first instead, since by
 * then the profiles, Sources and downloader have been proven on movies.
 */

const DAY = 86_400_000;
/** Agreement needed over the last two weeks, from at least this many compared downloads. */
export const AGREE_PERCENT = 80;
export const AGREE_MIN = 10;

export async function cutoverChecklist(deps: { db: Db; config: Config; clients: Clients; now: () => number }, kind: 'movie' | 'tv' = 'movie'): Promise<CutoverView> {
  if (kind === 'tv') return tvChecklist(deps);
  const { db, config, clients, now } = deps;
  const steps: CutoverStep[] = [];
  const services = readServices(db, config);
  const radarr = services.radarrUrl && services.radarrApiKey ? { url: services.radarrUrl, key: services.radarrApiKey } : null;

  // 1. Agreement with Radarr over the last two weeks.
  const recent = db.select().from(comparisons).where(and(eq(comparisons.status, 'done'), gte(comparisons.grabbedAt, now() - 14 * DAY))).all();
  const agreed = recent.filter((r) => r.verdict === 'same' || r.verdict === 'same_quality').length;
  const pct = recent.length ? Math.round((agreed / recent.length) * 100) : null;
  steps.push({
    key: 'agree',
    title: 'Marquee picks what Radarr would',
    state: pct === null ? 'todo' : recent.length >= AGREE_MIN && pct >= AGREE_PERCENT ? 'done' : 'warn',
    detail:
      pct === null
        ? 'Nothing compared in the last two weeks. Turn on “Check every hour” on the Compare page and let it run for a while.'
        : `Agreed on ${agreed} of ${recent.length} downloads in the last two weeks (${pct}%).${recent.length < AGREE_MIN ? ` Wait for at least ${AGREE_MIN}.` : pct < AGREE_PERCENT ? ` Aim for ${AGREE_PERCENT}%: review where Marquee picks differently and adjust its profiles.` : ''}`,
    action: { label: 'Open Compare', to: '/compare' },
  });

  steps.push(await downloaderStep(deps));
  steps.push(importStep(db, 'movie'));
  steps.push(await mediaStep(deps, 'movies'));

  // 5. Radarr has nothing on the way. 6. Radarr no longer watches movies.
  if (!radarr) {
    const detail = 'Connect Radarr (read-only) in Settings → Services so Marquee can check.';
    steps.push({ key: 'radarr_queue', title: 'Radarr has nothing on the way', state: 'unknown', detail, action: { label: 'Settings → Services', to: '/settings/services' } });
    steps.push({ key: 'radarr_off', title: 'Radarr stops looking for movies', state: 'unknown', detail, action: null });
  } else {
    try {
      const queued = await clients.radarrHistory(radarr.url, radarr.key).queueSize();
      steps.push({
        key: 'radarr_queue',
        title: 'Radarr has nothing on the way',
        state: queued === 0 ? 'done' : 'warn',
        detail: queued === 0 ? 'Radarr’s queue is empty.' : `Radarr still has ${queued} ${queued === 1 ? 'download' : 'downloads'} on the way. Let ${queued === 1 ? 'it' : 'them'} finish first, so Radarr puts ${queued === 1 ? 'it' : 'them'} in your library and nothing is downloaded twice.`,
        action: null,
      });
    } catch (err) {
      steps.push({ key: 'radarr_queue', title: 'Radarr has nothing on the way', state: 'unknown', detail: (err as Error).message, action: { label: 'Settings → Services', to: '/settings/services' } });
    }
    try {
      const watched = (await clients.arr('radarr', radarr.url, radarr.key).titles()).filter((t) => t.monitored).length;
      steps.push({
        key: 'radarr_off',
        title: 'Radarr stops looking for movies',
        state: watched === 0 ? 'done' : 'todo',
        detail:
          watched === 0
            ? 'Radarr watches no movies, so it won’t download anything. Keep it running for a week or so in case you need to look something up, then you can remove it.'
            : `Radarr still watches ${watched} ${watched === 1 ? 'movie' : 'movies'}. In Radarr: Movies → Select Movies → Select All → Edit → Monitored: Unmonitored → Apply Changes. Leave Radarr running for now; Marquee only reads from it.`,
        action: null,
      });
    } catch (err) {
      steps.push({ key: 'radarr_off', title: 'Radarr stops looking for movies', state: 'unknown', detail: (err as Error).message, action: null });
    }
  }

  // 7. Marquee takes over.
  const on = lookingForWanted(db);
  steps.push({
    key: 'take_over',
    title: 'Marquee looks for wanted movies',
    state: on ? 'done' : 'todo',
    detail: on
      ? 'Every 6 hours Marquee searches for movies you want that have no file, and once a day it checks the ones you have for a better copy. It sends a copy only when it beats your file.'
      : 'Turn this on when the steps above are done. Marquee then searches for missing movies every 6 hours and checks for better copies once a day, a few movies at a time.',
    action: null,
  });

  const before = steps.filter((s) => s.key !== 'take_over');
  return {
    kind: 'movie',
    steps,
    ready: before.every((s) => s.state === 'done'),
    lookingForWanted: on,
    runs: lastWantedRuns(db),
  };
}

type Deps = { db: Db; config: Config; clients: Clients; now: () => number };

async function downloaderStep({ db, clients, now }: Deps): Promise<CutoverStep> {
  const dl = readDownloader(db);
  const health = await checkDownloader(dl.url ? clients.qbittorrent(dl.url, dl.username, dl.password ?? '') : null, dl.category, now());
  return {
    key: 'downloader',
    title: 'qBittorrent is connected',
    state: health.ok ? 'done' : 'todo',
    detail: health.ok ? `${health.label}${health.version ? ` · qBittorrent ${health.version}` : ''}.` : `${health.label}. ${health.fix ?? ''}`.trim(),
    action: { label: 'Settings → Downloader', to: '/settings/downloader' },
  };
}

function importStep(db: Db, kind: 'movie' | 'tv'): CutoverStep {
  const imported = db.select().from(downloads).where(and(eq(downloads.kind, kind), isNotNull(downloads.importedAt))).orderBy(desc(downloads.importedAt)).all();
  const one = kind === 'movie' ? 'movie' : 'download';
  const many = kind === 'movie' ? 'movies' : 'downloads';
  return {
    key: 'import',
    title: kind === 'movie' ? 'A movie went all the way into your library' : 'An episode went all the way into your library',
    state: imported.length ? 'done' : 'todo',
    detail: imported.length
      ? `${imported.length} ${imported.length === 1 ? one : many} downloaded and put in your library; the last was ${imported[0]!.title}.`
      : kind === 'movie'
        ? 'Find a movie you don’t have yet and press Add to library. On its page press Find copies, then Download this, and wait until the Downloads page says “In your library”.'
        : 'Open a show and press Find copies on an episode you’re missing (or a whole season), then Download this, and wait until the Downloads page says “In your library”.',
    action: imported.length ? { label: 'Open Downloads', to: '/downloads' } : kind === 'movie' ? { label: 'Find a movie to add', to: '/search?kind=movie' } : { label: 'Open your shows', to: '/shows' },
  };
}

async function mediaStep({ db, clients }: Deps, what: 'movies' | 'episodes'): Promise<CutoverStep> {
  const servers = (['plex', 'jellyfin'] as const).filter((k) => {
    const s = readMediaServer(db, k);
    return s.url && s.secret;
  });
  const problems: string[] = [];
  for (const k of servers) {
    const s = readMediaServer(db, k);
    const api = k === 'plex' ? clients.plexServer(s.url!, s.secret!) : clients.jellyfin(s.url!, s.secret!);
    await api.ping().catch((err: Error) => problems.push(err.message));
  }
  const names = servers.map((k) => (k === 'plex' ? 'Plex' : 'Jellyfin'));
  return {
    key: 'media',
    title: `Plex and Jellyfin hear about new ${what}`,
    state: !servers.length ? 'todo' : problems.length ? 'warn' : 'done',
    detail: !servers.length
      ? `Connect Plex or Jellyfin in Settings → Services so new ${what} show up straight away, not at the next scheduled scan.`
      : problems.length
        ? problems.join(' ')
        : `${names.join(' and ')} ${names.length === 1 ? 'is' : 'are'} connected and told to scan after each import.`,
    action: { label: 'Settings → Services', to: '/settings/services' },
  };
}

async function tvChecklist(deps: Deps): Promise<CutoverView> {
  const { db, config, clients } = deps;
  const steps: CutoverStep[] = [];
  const services = readServices(db, config);
  const sonarr = services.sonarrUrl && services.sonarrApiKey ? { url: services.sonarrUrl, key: services.sonarrApiKey } : null;

  // 1. Movies first: profiles, Sources and the downloader have been proven there.
  const moviesOn = lookingForWanted(db);
  steps.push({
    key: 'movies_first',
    title: 'Movies are switched over',
    state: moviesOn ? 'done' : 'todo',
    detail: moviesOn
      ? 'Marquee already looks for wanted movies, so your Sources, qBittorrent and library folders are proven.'
      : 'Switch movies over first. It proves your Sources, qBittorrent and library folders work before TV, which downloads far more often.',
    action: moviesOn ? null : { label: 'Switch movies over', to: '/switch-over' },
  });
  steps.push(await downloaderStep(deps));
  steps.push(importStep(db, 'tv'));
  steps.push(await mediaStep(deps, 'episodes'));

  if (!sonarr) {
    const detail = 'Connect Sonarr (read-only) in Settings → Services so Marquee can check.';
    steps.push({ key: 'sonarr_queue', title: 'Sonarr has nothing on the way', state: 'unknown', detail, action: { label: 'Settings → Services', to: '/settings/services' } });
    steps.push({ key: 'sonarr_off', title: 'Sonarr stops looking for episodes', state: 'unknown', detail, action: null });
  } else {
    const api = clients.arr('sonarr', sonarr.url, sonarr.key);
    try {
      const queued = await api.queueSize();
      steps.push({
        key: 'sonarr_queue',
        title: 'Sonarr has nothing on the way',
        state: queued === 0 ? 'done' : 'warn',
        detail: queued === 0 ? 'Sonarr’s queue is empty.' : `Sonarr still has ${queued} ${queued === 1 ? 'download' : 'downloads'} on the way. Let ${queued === 1 ? 'it' : 'them'} finish first, so Sonarr puts ${queued === 1 ? 'it' : 'them'} in your library and nothing is downloaded twice.`,
        action: null,
      });
    } catch (err) {
      steps.push({ key: 'sonarr_queue', title: 'Sonarr has nothing on the way', state: 'unknown', detail: (err as Error).message, action: { label: 'Settings → Services', to: '/settings/services' } });
    }
    try {
      const watched = (await api.titles()).filter((t) => t.monitored).length;
      steps.push({
        key: 'sonarr_off',
        title: 'Sonarr stops looking for episodes',
        state: watched === 0 ? 'done' : 'todo',
        detail:
          watched === 0
            ? 'Sonarr watches no shows, so it won’t download anything. Keep it running for a week or so in case you need to look something up, then you can remove it.'
            : `Sonarr still watches ${watched} ${watched === 1 ? 'show' : 'shows'}. In Sonarr: Series → Select Series → Select All → Edit → Monitored: Unmonitored → Apply Changes. Leave Sonarr running for now; Marquee only reads from it.`,
        action: null,
      });
    } catch (err) {
      steps.push({ key: 'sonarr_off', title: 'Sonarr stops looking for episodes', state: 'unknown', detail: (err as Error).message, action: null });
    }
  }

  const on = lookingForWantedTv(db);
  steps.push({
    key: 'take_over',
    title: 'Marquee looks for wanted episodes',
    state: on ? 'done' : 'todo',
    detail: on
      ? 'Every 30 minutes Marquee reads your Sources’ newest copies for new episodes. Every 6 hours it searches for episodes you’re missing (a whole season in one copy when most of it is missing), and once a day it checks finished seasons for a better copy. Specials are only searched when you ask.'
      : 'Turn this on when the steps above are done. Marquee then catches new episodes as they come out, searches for missing ones every 6 hours, and checks for better copies once a day.',
    action: null,
  });

  const before = steps.filter((s) => s.key !== 'take_over');
  return { kind: 'tv', steps, ready: before.every((s) => s.state === 'done'), lookingForWanted: on, runs: lastWantedTvRuns(db) };
}
