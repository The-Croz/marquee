import { Hono } from 'hono';
import { z } from 'zod';
import type { CleanupDownloadsView, CleanupResult, CopyGroup, SetAsideView, UntrackedFile } from '@marquee/shared';
import { requireAdmin, type Deps, type Env } from '../http.js';
import { copyGroups, deleteForGood, putBack, setAsideByHand, setAsideView, unusedDownloads, untrackedFiles, type CleanupDeps } from '../library/cleanup.js';
import { tellMediaServers } from '../library/mediaServers.js';
import { readDownloader } from '../downloads/service.js';
import { size } from '../system/disk.js';
import { scanSourcesFor } from './library.js';

/** Library → Clean up (admins only): find leftovers, set them aside, and the recycle bin. */

export const cleanupRoutes = new Hono<Env>();

function cleanupDeps(d: Deps): CleanupDeps {
  return {
    db: d.db,
    now: d.now,
    qbit: () => {
      const s = readDownloader(d.db);
      return s.url ? d.clients.qbittorrent(s.url, s.username, s.password ?? '') : null;
    },
  };
}

const paths = z.object({ paths: z.array(z.string().min(1).max(4096)).min(1, 'Pick something first.').max(5000) });

cleanupRoutes.get('/copies', async (c) => {
  requireAdmin(c);
  return c.json<{ groups: CopyGroup[] }>({ groups: await copyGroups(cleanupDeps(c.get('deps'))) });
});

cleanupRoutes.get('/set-aside', async (c) => {
  requireAdmin(c);
  return c.json<SetAsideView>(await setAsideView(c.get('deps').db));
});

cleanupRoutes.get('/downloads', async (c) => {
  requireAdmin(c);
  return c.json<CleanupDownloadsView>(await unusedDownloads(cleanupDeps(c.get('deps'))));
});

cleanupRoutes.get('/untracked', async (c) => {
  requireAdmin(c);
  return c.json<{ files: UntrackedFile[] }>({ files: await untrackedFiles(c.get('deps').db) });
});

/** Moves what you picked into the recycle bin (the set-aside folders). Never deletes. */
cleanupRoutes.post('/set-aside', async (c) => {
  const user = requireAdmin(c);
  const input = paths.parse(await c.req.json());
  const d = c.get('deps');
  const r = await setAsideByHand(cleanupDeps(d), input.paths, user.id);
  for (const kind of ['movie', 'tv'] as const) {
    const folders = r.folders.filter((f) => f.kind === kind).map((f) => f.folder);
    if (folders.length) await tellMediaServers(d.db, d.clients, kind, folders).catch(() => null);
  }
  console.info(`[cleanup] ${user.displayName} set aside ${r.done} ${r.done === 1 ? 'thing' : 'things'}`);
  return c.json<CleanupResult>({ done: r.done, problems: r.problems, message: r.message });
});

/** Puts things in the recycle bin back where they were, then scans so the library counts them again. */
cleanupRoutes.post('/put-back', async (c) => {
  const user = requireAdmin(c);
  const input = paths.parse(await c.req.json());
  const d = c.get('deps');
  const r = await putBack(d.db, input.paths, d.now(), user.id);
  if (r.library.length) void d.scanner.start(scanSourcesFor(d)).catch(() => null);
  return c.json<CleanupResult>({ done: r.done, problems: r.problems, message: r.message });
});

/** Deletes things in the recycle bin for good. Only by hand, behind a confirm. */
cleanupRoutes.post('/delete', async (c) => {
  const user = requireAdmin(c);
  const input = paths.extend({ confirm: z.literal(true, { message: 'Confirm first: this deletes these files for good.' }) }).parse(await c.req.json());
  const d = c.get('deps');
  const r = await deleteForGood(d.db, input.paths, d.now(), user.id);
  console.info(`[cleanup] ${user.displayName} deleted ${r.done} set-aside ${r.done === 1 ? 'file' : 'files'} (${size(r.bytes)})`);
  return c.json<CleanupResult>({ done: r.done, problems: r.problems, message: r.done ? `${r.message.replace(/\.$/, '')}, giving back ${size(r.bytes)}.` : r.message });
});
