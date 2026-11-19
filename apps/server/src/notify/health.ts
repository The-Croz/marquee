import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { getSetting, setSetting } from '../db/index.js';
import { episodes, series, sources } from '../db/schema.js';
import type { Clients } from '../http.js';
import { readMediaServer } from '../library/mediaServers.js';
import { checkDownloader, readDownloader, DOWNLOADER_TEXT } from '../downloads/service.js';
import { STATE_TEXT } from '../sources/service.js';
import { notifyAdmins, type NotifyDeps } from './service.js';

/**
 * Watches for things worth telling an admin about, and tells them once.
 * A problem is announced when it starts, not every check; it is forgotten
 * when it clears, so a later one is announced again. Runs every few minutes.
 */

const FAILS_BEFORE_TELLING = 3;
const key = (k: string) => `health.${k}`;

/** Remembers what we last said about `k`. Returns true when `now` is new and should be announced. */
function changed(db: Db, k: string, now: string | null): boolean {
  const before = getSetting(db, key(k)) || null;
  if (before === now) return false;
  setSetting(db, key(k), now ?? '');
  return now !== null;
}

export async function checkHealth(deps: NotifyDeps & { clients: Pick<Clients, 'qbittorrent'> & Partial<Pick<Clients, 'plexServer' | 'jellyfin'>> }): Promise<void> {
  const { db, clients, now } = deps;

  for (const s of db.select().from(sources).where(eq(sources.enabled, true)).all()) {
    const bad = !['unchecked', 'working', 'slowed_down'].includes(s.state) && s.failures >= FAILS_BEFORE_TELLING;
    if (changed(db, `source.${s.id}`, bad ? s.state : null)) {
      const t = STATE_TEXT[s.state];
      await notifyAdmins(deps, 'source_problem', { vars: { source: s.name, problem: t.label, fix: t.fix ?? null }, link: '/settings/sources' });
    }
  }

  const dl = readDownloader(db);
  if (dl.url) {
    const h = await checkDownloader(clients.qbittorrent(dl.url, dl.username, dl.password ?? ''), dl.category, now());
    const bad = !['working', 'firewalled', 'not_set_up'].includes(h.state);
    if (changed(db, 'downloader', bad ? h.state : null)) {
      await notifyAdmins(deps, 'downloader_problem', { vars: { problem: h.label, fix: DOWNLOADER_TEXT[h.state].fix ?? null }, link: '/settings/downloader' });
    }
  }

  // Plex and Jellyfin: told once when one stops answering.
  for (const kind of ['plex', 'jellyfin'] as const) {
    const m = readMediaServer(db, kind);
    const make = kind === 'plex' ? deps.clients.plexServer : deps.clients.jellyfin;
    if (!m.url || !m.secret || !make) continue;
    let down: string | null = null;
    try {
      await make(m.url, m.secret).ping();
    } catch (err) {
      down = (err as Error).message;
    }
    if (changed(db, `server.${kind}`, down ? 'down' : null)) {
      const name = kind === 'plex' ? 'Plex' : 'Jellyfin';
      await notifyAdmins(deps, 'media_server_problem', { vars: { server: name, error: down }, link: '/settings/services' });
    }
  }

  // Wanted episodes that aired today: one message a day, listing them.
  const today = new Date(now()).toISOString().slice(0, 10);
  if ((getSetting(db, key('aired')) || '') !== today) {
    const aired = db
      .select({ show: series.title, season: episodes.season, episode: episodes.episode })
      .from(episodes)
      .innerJoin(series, eq(series.id, episodes.seriesId))
      .where(and(eq(episodes.airDate, today), eq(episodes.monitored, true), eq(series.monitored, true)))
      .all();
    setSetting(db, key('aired'), today);
    if (aired.length) {
      const line = (a: (typeof aired)[number]) => `${a.show} S${String(a.season).padStart(2, '0')}E${String(a.episode).padStart(2, '0')}`;
      await notifyAdmins(deps, 'episode_aired', {
        vars: {
          summary: aired.length === 1 ? `New episode: ${line(aired[0]!)}` : `${aired.length} wanted episodes came out today`,
          episodes: aired.slice(0, 8).map(line).join(', ') + (aired.length > 8 ? ', …' : ''),
          count: aired.length,
        },
        link: '/calendar',
      });
    }
  }
}
