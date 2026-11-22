import fs from 'node:fs';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { z } from 'zod';
import type { BackupView, BackupsView, DiskSettingsView, HealthView, JobView, LogsView, RestoreResult } from '@marquee/shared';
import { HttpError, requireAdmin, type Env } from '../http.js';
import { healthView } from '../system/health.js';
import { readDiskSettings, writeDiskSettings } from '../system/disk.js';
import { backUp, backupPath, backupsView, restoreBackup } from '../system/backups.js';
import { KEEP_LINES } from '../system/logs.js';

/** `/api/system`: the Health page (connections, free space, jobs), backups and logs. Admin only. */
export const systemRoutes = new Hono<Env>();

// ---------------- Health ----------------

systemRoutes.get('/health', async (c) => {
  requireAdmin(c);
  return c.json<HealthView>(await healthView(c.get('deps')));
});

/** Runs a background job now. Answers within a couple of seconds; a longer run carries on and shows as running. */
systemRoutes.post('/jobs/:id/run', async (c) => {
  requireAdmin(c);
  const { jobs } = c.get('deps');
  const id = c.req.param('id');
  if (!jobs.has(id)) throw new HttpError(404, 'no_such_job', 'There’s no job with that name.');
  const off = jobs.offReason(id);
  if (off) throw new HttpError(409, 'job_off', `This job is off. ${off}`);
  const run = jobs.run(id);
  await Promise.race([run, new Promise((r) => setTimeout(r, 1500).unref())]);
  const job = jobs.list().find((j) => j.id === id)!;
  return c.json<{ job: JobView }>({ job });
});

const diskUpdate = z.object({
  downloadsFolder: z
    .string()
    .trim()
    .refine((v) => v === '' || v.startsWith('/'), 'Folders are full paths, like /data/torrents.')
    .nullable()
    .optional(),
  minFreeGb: z.number().min(0, 'The minimum can’t be below 0.').max(10_000, 'That’s more than any disk holds.').nullable().optional(),
});

systemRoutes.put('/disk', async (c) => {
  requireAdmin(c);
  const { db } = c.get('deps');
  writeDiskSettings(db, diskUpdate.parse(await c.req.json()));
  return c.json<DiskSettingsView>(readDiskSettings(db));
});

// ---------------- Backups ----------------

systemRoutes.get('/backups', (c) => {
  requireAdmin(c);
  const { config, now } = c.get('deps');
  return c.json<BackupsView>(backupsView(config.dataDir, now()));
});

/** Back up now. */
systemRoutes.post('/backups', async (c) => {
  requireAdmin(c);
  const { db, config, now } = c.get('deps');
  return c.json<BackupView>(await backUp(db, config.dataDir, 'by_hand', now()), 201);
});

/** Downloads one backup file. */
systemRoutes.get('/backups/:name', (c) => {
  requireAdmin(c);
  const name = c.req.param('name');
  const file = backupPath(c.get('deps').config.dataDir, name);
  const body = Readable.toWeb(fs.createReadStream(file)) as ReadableStream;
  return c.body(body, 200, {
    'Content-Type': 'application/vnd.sqlite3',
    'Content-Disposition': `attachment; filename="${name}"`,
    'Content-Length': String(fs.statSync(file).size),
    'Cache-Control': 'no-store',
  });
});

/** Puts a backup in place of everything now. Needs `{ "confirm": true }`; a backup of how things are is taken first. */
systemRoutes.post('/backups/:name/restore', async (c) => {
  requireAdmin(c);
  const { confirm } = z.object({ confirm: z.boolean().optional() }).parse(await c.req.json());
  if (confirm !== true) throw new HttpError(400, 'needs_confirm', 'Restoring replaces everything in Marquee with this backup. Send confirm to go ahead.');
  const { db, config, now } = c.get('deps');
  const r = await restoreBackup(db, config.dataDir, c.req.param('name'), now());
  console.log(`[backups] restored ${r.restored.name}; how things were is kept as ${r.safety.name}`);
  return c.json<RestoreResult>({
    ...r,
    message: `Restored that backup. How things were just before is kept as a backup too, so you can restore that to undo this. You may need to sign in again.`,
  });
});

// ---------------- Logs ----------------

const logQuery = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(KEEP_LINES).optional(),
});

systemRoutes.get('/logs', (c) => {
  requireAdmin(c);
  const { logs } = c.get('deps');
  const q = logQuery.parse(c.req.query());
  return c.json<LogsView>({ lines: logs.read({ ...q, limit: q.limit ?? 1000 }), kept: logs.size, keepMax: KEEP_LINES });
});

/** The kept lines as a text file, for a bug report. Secrets were taken out when each line was kept. */
systemRoutes.get('/logs/download', (c) => {
  requireAdmin(c);
  const { logs, now } = c.get('deps');
  const q = logQuery.parse(c.req.query());
  const day = new Date(now()).toISOString().slice(0, 10);
  return c.body(logs.text(q) + '\n', 200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': `attachment; filename="marquee-log-${day}.txt"`,
    'Cache-Control': 'no-store',
  });
});
