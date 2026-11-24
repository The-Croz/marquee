import { and, desc, eq, isNull } from 'drizzle-orm';
import type { WatchSyncPerson, WatchSyncPlan, WatchSyncRun, WatchSyncStatus } from '@marquee/shared';
import type { Db } from '../db/index.js';
import { getSetting, setSetting } from '../db/index.js';
import { users, watchSyncLog } from '../db/schema.js';
import type { Clients } from '../http.js';
import { MediaServerError, readMediaServer, type MediaServerApi, type ServerKind, type SyncItem } from '../library/mediaServers.js';

/**
 * Watched sync: keeps "watched" ticks the same on Plex and Jellyfin.
 *
 * The rule is simple on purpose: watched on either server means watched on
 * both. Marquee only ever adds ticks, never takes one away, so nothing you
 * watched can be lost. Every tick it adds is logged, and a whole run can be
 * undone.
 *
 * A person is a Marquee account linked to both servers (Settings → Users).
 * Titles are matched by TMDB, TVDB or IMDb id (episodes by the show's id,
 * season and episode), so names and file layouts don't matter.
 */

export interface SyncDeps {
  db: Db;
  clients: Partial<Pick<Clients, 'plexServer' | 'jellyfin'>>;
  now: () => number;
}

const NAME: Record<ServerKind, string> = { plex: 'Plex', jellyfin: 'Jellyfin' };
const ENABLED = 'watchsync.enabled';
const LAST = 'watchsync.last';

export const syncEnabled = (db: Db) => getSetting(db, ENABLED) === 'true';
export const setSyncEnabled = (db: Db, on: boolean) => setSetting(db, ENABLED, on ? 'true' : 'false');

function server(deps: SyncDeps, kind: ServerKind): MediaServerApi | null {
  const m = readMediaServer(deps.db, kind);
  const make = kind === 'plex' ? deps.clients.plexServer : deps.clients.jellyfin;
  return m.url && m.secret && make ? make(m.url, m.secret) : null;
}

interface Change {
  userId: number;
  person: string;
  to: ServerKind;
  serverUserId: string;
  ref: string;
  title: string;
  /** Set for a resume point: where to put them (ms). */
  position?: number;
}

const RESUME = 'watchsync.resume';
/** Resume points are synced too unless turned off. */
export const resumeEnabled = (db: Db) => getSetting(db, RESUME) !== 'false';
export const setResumeEnabled = (db: Db, on: boolean) => setSetting(db, RESUME, on ? 'true' : 'false');

/** Places closer than this count as the same. */
const SAME_PLACE = 60_000;

/**
 * Resume points (W1): for things neither server counts as watched, the
 * server played more recently passes its place to the other one.
 */
export function resumeChanges(a: SyncItem[], b: SyncItem[]): { from: SyncItem; to: SyncItem }[] {
  const byKey = new Map<string, SyncItem>();
  for (const i of b) for (const k of i.keys) byKey.set(k, i);
  const out: { from: SyncItem; to: SyncItem }[] = [];
  const seen = new Set<string>();
  for (const x of a) {
    const y = x.keys.map((k) => byKey.get(k)).find(Boolean);
    if (!y || x.watched || y.watched || seen.has(y.ref)) continue;
    seen.add(y.ref);
    const [newer, older] = (x.lastPlayed ?? 0) >= (y.lastPlayed ?? 0) ? [x, y] : [y, x];
    if (!newer.position || !newer.lastPlayed) continue;
    if (Math.abs((newer.position ?? 0) - (older.position ?? 0)) < SAME_PLACE) continue;
    out.push({ from: newer, to: older });
  }
  return out;
}

/** Which ticks are missing, per person. Reads both servers; changes nothing. */
export async function planSync(deps: SyncDeps): Promise<WatchSyncPlan & { changes: Change[] }> {
  const plex = server(deps, 'plex');
  const jf = server(deps, 'jellyfin');
  if (!plex || !jf) return { ready: false, problem: 'Connect both Plex and Jellyfin in Settings → Services first.', people: [], changes: [], total: 0 };
  if (!plex.watchedUsers || !jf.watchedUsers) return { ready: false, problem: 'One of the servers can’t do watched sync.', people: [], changes: [], total: 0 };

  let plexPeople, jfPeople;
  try {
    [plexPeople, jfPeople] = await Promise.all([plex.watchedUsers(), jf.watchedUsers!()]);
  } catch (err) {
    return { ready: false, problem: err instanceof MediaServerError ? `${err.message} Marquee tries again next time.` : 'Couldn’t read the people on Plex or Jellyfin.', people: [], changes: [], total: 0 };
  }
  const people: WatchSyncPerson[] = [];
  const changes: Change[] = [];
  for (const u of deps.db.select().from(users).all()) {
    const p = u.plexId ? plexPeople.find((x) => x.id === u.plexId) : undefined;
    const j = u.jellyfinId ? jfPeople.find((x) => x.id === u.jellyfinId) : undefined;
    if (!u.plexId && !u.jellyfinId) continue;
    if (!p || !j) {
      const missing = !u.plexId ? 'isn’t linked to Plex' : !u.jellyfinId ? 'isn’t linked to Jellyfin' : !p ? 'isn’t shared on this Plex server' : 'isn’t on this Jellyfin server';
      people.push({ userId: u.id, name: u.displayName, state: 'not_linked', note: `${u.displayName} ${missing}. Link both in Settings → Users to sync them.`, toPlex: 0, toJellyfin: 0 });
      continue;
    }
    try {
      const [a, b] = await Promise.all([plex.watchedLibrary!(p.id), jf.watchedLibrary!(j.id)]);
      const toJf = missingTicks(a, b);
      const toPlex = missingTicks(b, a);
      for (const i of toJf) changes.push({ userId: u.id, person: u.displayName, to: 'jellyfin', serverUserId: j.id, ref: i.ref, title: i.title });
      for (const i of toPlex) changes.push({ userId: u.id, person: u.displayName, to: 'plex', serverUserId: p.id, ref: i.ref, title: i.title });
      if (resumeEnabled(deps.db) && plex.setPosition && jf.setPosition) {
        const plexRefs = new Set(a.map((i) => i.ref));
        for (const r of resumeChanges(a, b)) {
          const to: ServerKind = plexRefs.has(r.to.ref) ? 'plex' : 'jellyfin';
          changes.push({ userId: u.id, person: u.displayName, to, serverUserId: to === 'plex' ? p.id : j.id, ref: r.to.ref, title: r.to.title, position: r.from.position! });
        }
      }
      people.push({ userId: u.id, name: u.displayName, state: 'linked', note: null, toPlex: toPlex.length, toJellyfin: toJf.length, examples: [...toJf, ...toPlex].slice(0, 5).map((i) => i.title) });
    } catch (err) {
      people.push({ userId: u.id, name: u.displayName, state: 'problem', note: err instanceof MediaServerError ? `${err.message} Marquee tries again next time.` : 'Couldn’t read their library.', toPlex: 0, toJellyfin: 0 });
    }
  }
  return { ready: true, problem: null, people, changes, total: changes.filter((c) => c.position === undefined).length };
}

/** What is watched in `from` but not in `to`, matched by id. Each item in `to` is listed once. */
export function missingTicks(from: SyncItem[], to: SyncItem[]): SyncItem[] {
  const watched = new Set(from.filter((i) => i.watched).flatMap((i) => i.keys));
  return to.filter((i) => !i.watched && i.ref && i.keys.some((k) => watched.has(k)));
}

/** Plans, then ticks what's missing, logging each one. A tick that fails is skipped and counted. */
export async function runSync(deps: SyncDeps): Promise<WatchSyncRun> {
  const plan = await planSync(deps);
  const at = deps.now();
  const result: WatchSyncRun = { at, ticked: 0, resumed: 0, failed: 0, problem: plan.problem };
  if (plan.ready) {
    const api = { plex: server(deps, 'plex')!, jellyfin: server(deps, 'jellyfin')! };
    for (const c of plan.changes) {
      try {
        if (c.position !== undefined) {
          await api[c.to].setPosition!(c.serverUserId, c.ref, c.position);
          result.resumed!++;
          continue;
        }
        await api[c.to].setWatched!(c.serverUserId, c.ref, true);
        deps.db.insert(watchSyncLog).values({ runAt: at, userId: c.userId, person: c.person, server: c.to, serverUserId: c.serverUserId, itemRef: c.ref, title: c.title }).run();
        result.ticked++;
      } catch {
        result.failed++;
      }
    }
    const trouble = plan.people.find((p) => p.state === 'problem');
    if (!result.problem && trouble) result.problem = trouble.note;
  }
  setSetting(deps.db, LAST, JSON.stringify(result));
  return result;
}

/** Takes back the ticks one run added. Ticks someone made since then on the server aren't touched by anything else. */
export async function undoRun(deps: SyncDeps, runAt: number): Promise<{ undone: number; failed: number }> {
  const rows = deps.db.select().from(watchSyncLog).where(and(eq(watchSyncLog.runAt, runAt), isNull(watchSyncLog.undoneAt))).all();
  let undone = 0;
  let failed = 0;
  for (const r of rows) {
    const api = server(deps, r.server);
    try {
      if (!api?.setWatched) throw new Error('not connected');
      await api.setWatched(r.serverUserId, r.itemRef, false);
      deps.db.update(watchSyncLog).set({ undoneAt: deps.now() }).where(eq(watchSyncLog.id, r.id)).run();
      undone++;
    } catch {
      failed++;
    }
  }
  return { undone, failed };
}

export function syncStatus(db: Db): WatchSyncStatus {
  const last = getSetting(db, LAST);
  const runs = new Map<number, WatchSyncStatus['runs'][number]>();
  for (const r of db.select().from(watchSyncLog).orderBy(desc(watchSyncLog.runAt)).limit(2000).all()) {
    let run = runs.get(r.runAt);
    if (!run) {
      if (runs.size >= 10) continue;
      runs.set(r.runAt, (run = { at: r.runAt, ticks: 0, undone: 0, items: [] }));
    }
    run.ticks++;
    if (r.undoneAt) run.undone++;
    if (run.items.length < 20) run.items.push({ person: r.person, title: r.title, server: NAME[r.server] });
  }
  return { enabled: syncEnabled(db), resume: resumeEnabled(db), last: last ? (JSON.parse(last) as WatchSyncRun) : null, runs: [...runs.values()] };
}

/**
 * W3: sync soon after someone stops watching, using the live line Activity
 * already keeps to Plex and Jellyfin (what WatchState's webhooks did). Plays
 * ending close together share one run.
 */
export function syncAfterPlays(run: () => Promise<unknown>, enabled: () => boolean, delayMs = 20_000): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (!enabled() || timer) return;
    timer = setTimeout(() => {
      timer = null;
      run().catch((err) => console.error('[watch-sync] after a play:', (err as Error).message));
    }, delayMs);
    timer.unref?.();
  };
}
