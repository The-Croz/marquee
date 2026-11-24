import { Hono } from 'hono';
import { z } from 'zod';
import type { WatchSyncPlan, WatchSyncRun, WatchSyncStatus } from '@marquee/shared';
import { HttpError, requireAdmin, type Ctx, type Env } from '../http.js';
import { planSync, runSync, setResumeEnabled, setSyncEnabled, syncStatus, undoRun, type SyncDeps } from '../watchsync/sync.js';

/** `/api/watch-sync`: keep watched ticks the same on Plex and Jellyfin. Admin only. */
export const watchSyncRoutes = new Hono<Env>();

const deps = (c: Ctx): SyncDeps => {
  const { db, clients, now } = c.get('deps');
  return { db, clients, now };
};

let busy = false;
/** One sync at a time, whether from the page or the timer. */
export async function once<T>(f: () => Promise<T>): Promise<T> {
  if (busy) throw new HttpError(409, 'busy', 'A sync is already going. Try again in a minute.');
  busy = true;
  try {
    return await f();
  } finally {
    busy = false;
  }
}

watchSyncRoutes.get('/', (c) => {
  requireAdmin(c);
  return c.json<WatchSyncStatus>(syncStatus(c.get('deps').db));
});

/** What a sync would do now. Reads both servers, changes nothing. */
watchSyncRoutes.get('/plan', async (c) => {
  requireAdmin(c);
  const { changes: _, ...plan } = await planSync(deps(c));
  return c.json<WatchSyncPlan>(plan);
});

watchSyncRoutes.post('/run', async (c) => {
  requireAdmin(c);
  return c.json<WatchSyncRun>(await once(() => runSync(deps(c))));
});

watchSyncRoutes.put('/enabled', async (c) => {
  requireAdmin(c);
  const { enabled, resume } = z.object({ enabled: z.boolean().optional(), resume: z.boolean().optional() }).parse(await c.req.json());
  if (enabled !== undefined) setSyncEnabled(c.get('deps').db, enabled);
  if (resume !== undefined) setResumeEnabled(c.get('deps').db, resume);
  return c.json<WatchSyncStatus>(syncStatus(c.get('deps').db));
});

/** Takes back every tick one run added. */
watchSyncRoutes.post('/undo', async (c) => {
  requireAdmin(c);
  const { at } = z.object({ at: z.number().int() }).parse(await c.req.json());
  return c.json(await once(() => undoRun(deps(c), at)));
});
