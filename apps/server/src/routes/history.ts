import { Hono } from 'hono';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import type { HistoryView, NeverPickItem, NeverPickView } from '@marquee/shared';
import { neverPick } from '../db/schema.js';
import { HttpError, requireAdmin, type Env } from '../http.js';
import { HISTORY_EVENTS, historyView, recordAllowedAgain, titleName } from '../downloads/history.js';
import type { HistoryEvent } from '@marquee/shared';

/** The History page: everything that happened to downloads, filterable. Admin only. */
export const historyRoutes = new Hono<Env>();

const day = /^\d{4}-\d{2}-\d{2}$/;

historyRoutes.get('/', (c) => {
  requireAdmin(c);
  const q = z
    .object({
      /** One or more of the events, comma-separated. */
      event: z.string().max(200).optional(),
      q: z.string().max(200).optional(),
      /** Days, as YYYY-MM-DD (in UTC), both inclusive. */
      from: z.string().regex(day, 'Dates look like 2026-11-22.').optional(),
      to: z.string().regex(day, 'Dates look like 2026-11-22.').optional(),
      movieId: z.coerce.number().int().positive().optional(),
      seriesId: z.coerce.number().int().positive().optional(),
      before: z.string().max(40).optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    })
    .parse(c.req.query());
  const events = q.event ? q.event.split(',').filter(Boolean) : [];
  const unknown = events.find((e) => !HISTORY_EVENTS.includes(e as HistoryEvent));
  if (unknown) throw new HttpError(400, 'invalid_input', `“${unknown}” isn’t something the History records. Use ${HISTORY_EVENTS.join(', ')}.`);
  return c.json<HistoryView>(
    historyView(c.get('deps').db, {
      events: events as HistoryEvent[],
      q: q.q,
      from: q.from ? Date.parse(`${q.from}T00:00:00Z`) : undefined,
      to: q.to ? Date.parse(`${q.to}T23:59:59.999Z`) : undefined,
      movieId: q.movieId,
      seriesId: q.seriesId,
      before: q.before,
      limit: q.limit,
    }),
  );
});

/** Never pick: copies turned down for a title, which searches skip. Admin only. */
export const neverPickRoutes = new Hono<Env>();

neverPickRoutes.get('/', (c) => {
  requireAdmin(c);
  const q = z.object({ movieId: z.coerce.number().int().positive().optional(), seriesId: z.coerce.number().int().positive().optional() }).parse(c.req.query());
  const { db } = c.get('deps');
  const rows = db
    .select()
    .from(neverPick)
    .where(q.movieId ? eq(neverPick.movieId, q.movieId) : q.seriesId ? eq(neverPick.seriesId, q.seriesId) : undefined)
    .orderBy(desc(neverPick.at), desc(neverPick.id))
    .all();
  const items = rows.map(
    (r): NeverPickItem => ({
      id: r.id,
      at: r.at,
      kind: r.kind,
      titleName: titleName(db, { ...r, season: null, episodes: null }, r.kind === 'movie' ? 'A movie no longer in your library' : 'A show no longer in your library'),
      titleLink: r.movieId ? `/movies/${r.movieId}` : r.seriesId ? `/shows/${r.seriesId}` : null,
      copy: r.title,
      reason: r.reason,
    }),
  );
  return c.json<NeverPickView>({ items });
});

/** Remove from list: searches can pick this copy again. */
neverPickRoutes.delete('/:id{[0-9]+}', (c) => {
  const user = requireAdmin(c);
  const { db, now } = c.get('deps');
  const row = db.select().from(neverPick).where(eq(neverPick.id, Number(c.req.param('id')))).get();
  if (!row) throw new HttpError(404, 'not_found', 'That copy isn’t on the Never pick list any more.');
  db.delete(neverPick).where(eq(neverPick.id, row.id)).run();
  recordAllowedAgain(db, { kind: row.kind, movieId: row.movieId, seriesId: row.seriesId, copy: row.title, reason: row.reason }, now(), user.id);
  return c.json({ message: `Taken off Never pick. Searches can pick ${row.title} again.` });
});
