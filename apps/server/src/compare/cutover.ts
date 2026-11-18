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

/**
 * The movie switch-over checklist: what Marquee can check for itself before
 * it takes movies over from Radarr, then the steps to hand over. Read-only
 * towards Radarr: Marquee checks its queue and how many movies it still
 * watches, but you turn its watching off yourself, in Radarr.
 */

const DAY = 86_400_000;
/** Agreement needed over the last two weeks, from at least this many compared downloads. */
export const AGREE_PERCENT = 80;
export const AGREE_MIN = 10;

export async function cutoverChecklist(deps: { db: Db; config: Config; clients: Clients; now: () => number }): Promise<CutoverView> {
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

  // 2. qBittorrent works.
  const dl = readDownloader(db);
  const health = await checkDownloader(dl.url ? clients.qbittorrent(dl.url, dl.username, dl.password ?? '') : null, dl.category, now());
  steps.push({
    key: 'downloader',
    title: 'qBittorrent is connected',
    state: health.ok ? 'done' : 'todo',
    detail: health.ok ? `${health.label}${health.version ? ` · qBittorrent ${health.version}` : ''}.` : `${health.label}. ${health.fix ?? ''}`.trim(),
    action: { label: 'Settings → Downloader', to: '/settings/downloader' },
  });

  // 3. A download made it into the library.
  const imported = db.select().from(downloads).where(and(eq(downloads.kind, 'movie'), isNotNull(downloads.importedAt))).orderBy(desc(downloads.importedAt)).all();
  steps.push({
    key: 'import',
    title: 'A movie went all the way into your library',
    state: imported.length ? 'done' : 'todo',
    detail: imported.length
      ? `${imported.length} ${imported.length === 1 ? 'movie' : 'movies'} downloaded and put in your library; the last was ${imported[0]!.title}.`
      : 'Find a movie you don’t have yet and press Add to library. On its page press Find copies, then Download this, and wait until the Downloads page says “In your library”.',
    action: imported.length ? { label: 'Open Downloads', to: '/downloads' } : { label: 'Find a movie to add', to: '/search?kind=movie' },
  });

  // 4. Plex and Jellyfin are told.
  const servers = (['plex', 'jellyfin'] as const).filter((k) => {
    const s = readMediaServer(db, k);
    return s.url && s.secret;
  });
  const serverProblems: string[] = [];
  for (const k of servers) {
    const s = readMediaServer(db, k);
    const api = k === 'plex' ? clients.plexServer(s.url!, s.secret!) : clients.jellyfin(s.url!, s.secret!);
    await api.ping().catch((err: Error) => serverProblems.push(err.message));
  }
  const names = servers.map((k) => (k === 'plex' ? 'Plex' : 'Jellyfin'));
  steps.push({
    key: 'media',
    title: 'Plex and Jellyfin hear about new movies',
    state: !servers.length ? 'todo' : serverProblems.length ? 'warn' : 'done',
    detail: !servers.length
      ? 'Connect Plex or Jellyfin in Settings → Services so new movies show up straight away, not at the next scheduled scan.'
      : serverProblems.length
        ? serverProblems.join(' ')
        : `${names.join(' and ')} ${names.length === 1 ? 'is' : 'are'} connected and told to scan after each import.`,
    action: { label: 'Settings → Services', to: '/settings/services' },
  });

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
    steps,
    ready: before.every((s) => s.state === 'done'),
    lookingForWanted: on,
    runs: lastWantedRuns(db),
  };
}
