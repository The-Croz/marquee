import type { ConnectionView, HealthView } from '@marquee/shared';
import { sources } from '../db/schema.js';
import type { Deps } from '../http.js';
import { STATE_TEXT } from '../sources/service.js';
import { solverView } from '../sources/sites/solver.js';
import { checkDownloader, readDownloader, DOWNLOADER_TEXT } from '../downloads/service.js';
import { readMediaServer } from '../library/mediaServers.js';
import { readServices } from '../library/services.js';
import { diskViews, readDiskSettings, realDiskProbe } from './disk.js';

/**
 * The Health page: every connection Marquee depends on, each with a plain
 * state and what to do about it, plus free space and every background job.
 * Uses the same words as the Sources and Downloader pages.
 */

const CHECK_MS = 8000;

function withTimeout<T>(p: Promise<T>, ms = CHECK_MS): Promise<T> {
  return Promise.race([p, new Promise<T>((_, no) => setTimeout(() => no(new Error('It didn’t answer in time.')), ms).unref())]);
}

const tone = (ok: boolean): ConnectionView['tone'] => (ok ? 'ok' : 'problem');

function sourceRows(deps: Pick<Deps, 'db'>): ConnectionView[] {
  const all = deps.db.select().from(sources).all();
  if (!all.length) {
    return [{ key: 'sources', group: 'Sources', name: 'Sources', tone: 'problem', state: 'None yet', fix: 'Add a Source, or link Prowlarr, so Marquee has somewhere to look for copies.', detail: null, to: '/settings/sources' }];
  }
  return all.map((s): ConnectionView => {
    if (!s.enabled) return { key: `source.${s.id}`, group: 'Sources', name: s.name, tone: 'off', state: STATE_TEXT.paused.label, fix: STATE_TEXT.paused.fix, detail: null, to: '/settings/sources' };
    const t = STATE_TEXT[s.state];
    const state: ConnectionView['tone'] = s.state === 'working' ? 'ok' : s.state === 'unchecked' || s.state === 'slowed_down' ? 'attention' : 'problem';
    return { key: `source.${s.id}`, group: 'Sources', name: s.name, tone: state, state: t.label, fix: t.fix, detail: s.state === 'working' ? null : s.stateMessage, to: '/settings/sources' };
  });
}

async function downloaderRow(deps: Pick<Deps, 'db' | 'clients' | 'now'>): Promise<ConnectionView> {
  const base = { key: 'downloader', group: 'Downloader' as const, name: 'qBittorrent', to: '/settings/downloader' };
  const dl = readDownloader(deps.db);
  if (!dl.url) return { ...base, tone: 'problem', state: DOWNLOADER_TEXT.not_set_up.label, fix: DOWNLOADER_TEXT.not_set_up.fix, detail: null };
  const h = await withTimeout(checkDownloader(deps.clients.qbittorrent(dl.url, dl.username, dl.password ?? ''), dl.category, deps.now())).catch(() => null);
  if (!h) return { ...base, tone: 'problem', state: DOWNLOADER_TEXT.unreachable.label, fix: DOWNLOADER_TEXT.unreachable.fix, detail: 'It didn’t answer in time.' };
  return { ...base, tone: h.state === 'firewalled' ? 'attention' : tone(h.ok), state: h.label, fix: h.fix, detail: h.detail };
}

async function mediaServerRows(deps: Pick<Deps, 'db' | 'clients'>): Promise<ConnectionView[]> {
  return Promise.all(
    (['plex', 'jellyfin'] as const).map(async (kind): Promise<ConnectionView> => {
      const name = kind === 'plex' ? 'Plex' : 'Jellyfin';
      const base = { key: `server.${kind}`, group: 'Media servers' as const, name, to: '/settings/services' };
      const m = readMediaServer(deps.db, kind);
      if (!m.url || !m.secret) return { ...base, tone: 'off', state: 'Not set up', fix: `Optional. Add ${name} in Settings → Services to see what’s playing and scan after imports.`, detail: null };
      try {
        const make = kind === 'plex' ? deps.clients.plexServer : deps.clients.jellyfin;
        await withTimeout(make(m.url, m.secret).ping());
        return { ...base, tone: 'ok', state: 'Working', fix: null, detail: null };
      } catch (err) {
        return { ...base, tone: 'problem', state: 'Not answering', fix: `Check ${name} is running and its address and ${kind === 'plex' ? 'token' : 'API key'} in Settings → Services. Marquee tries again by itself.`, detail: (err as Error).message };
      }
    }),
  );
}

async function tmdbRow(deps: Pick<Deps, 'db' | 'config' | 'clients'>): Promise<ConnectionView> {
  const base = { key: 'tmdb', group: 'Services' as const, name: 'TMDB', to: '/settings/services' };
  const key = readServices(deps.db, deps.config).tmdbApiKey;
  if (!key) return { ...base, tone: 'problem', state: 'No key yet', fix: 'Add your TMDB API key in Settings → Services. Marquee needs it to know what each title is.', detail: null };
  try {
    await withTimeout(deps.clients.tmdb(key).ping());
    return { ...base, tone: 'ok', state: 'Working', fix: null, detail: null };
  } catch (err) {
    return { ...base, tone: 'problem', state: 'Not answering', fix: 'Check the key in Settings → Services, and that Marquee can reach the internet. Titles already in your library keep working.', detail: (err as Error).message };
  }
}

function solverRow(deps: Pick<Deps, 'db' | 'sources'>): ConnectionView {
  const v = solverView(deps.db, deps.sources.bundledSolver);
  const base = { key: 'solver', group: 'Services' as const, name: 'Bot-check solver', to: '/settings/sources', detail: null };
  if (v.state === 'off') return { ...base, tone: 'off', state: 'Off', fix: 'Only needed for sites behind a bot check. Turn it on in Settings → Sources.' };
  if (v.state === 'ready') return { ...base, tone: 'ok', state: 'Ready', fix: null };
  if (v.state === 'starting') return { ...base, tone: 'attention', state: 'Starting', fix: null };
  return { ...base, tone: 'problem', state: v.state === 'missing' ? 'Not in this install' : 'Didn’t start', fix: v.message };
}

export async function healthView(deps: Deps): Promise<HealthView> {
  const [downloader, servers, tmdb, disks] = await Promise.all([downloaderRow(deps), mediaServerRows(deps), tmdbRow(deps), diskViews(deps.db, deps.clients.disk ?? realDiskProbe)]);
  const connections = [...sourceRows(deps), downloader, ...servers, tmdb, solverRow(deps)];
  const jobs = deps.jobs.list();
  const problems = connections.filter((c) => c.tone === 'problem').length + disks.filter((d) => d.tone === 'problem').length + jobs.filter((j) => j.tone === 'problem').length;
  return { checkedAt: deps.now(), problems, connections, disks, disk: readDiskSettings(deps.db), jobs };
}
