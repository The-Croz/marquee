import { Hono } from 'hono';
import { z } from 'zod';
import type { CalendarView } from '@marquee/shared';
import { calendar } from '../library/airing.js';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema.js';
import { toIcal } from '../library/ical.js';
import { HttpError, requireUser, type Env } from '../http.js';
import { KID_MOVIE_RATINGS, KID_TV_RATINGS } from './library.js';

/** The calendar: episodes of shows in your library and Wanted movies coming out, by day. Kids only see kids' titles. */
export const calendarRoutes = new Hono<Env>();

const DAY = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

calendarRoutes.get('/', (c) => {
  const user = requireUser(c);
  const { db, now } = c.get('deps');
  const q = z
    .object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Give the first day as YYYY-MM-DD.').optional(),
      days: z.coerce.number().int().min(1).max(62).default(28),
    })
    .parse(c.req.query());
  const start = q.from ? Date.parse(`${q.from}T00:00:00Z`) : now() - 7 * DAY;
  return c.json<CalendarView>(
    calendar(db, { from: isoDay(start), to: isoDay(start + (q.days - 1) * DAY), now: now(), kidRatings: user.role === 'kid' ? KID_TV_RATINGS : undefined, kidMovieRatings: user.role === 'kid' ? KID_MOVIE_RATINGS : undefined }),
  );
});

/** Your private calendar link (iCal), to subscribe in Apple Calendar or Google Calendar. */
calendarRoutes.get('/link', (c) => {
  const user = requireUser(c);
  const { db, config } = c.get('deps');
  const token = db.select({ t: users.calendarToken }).from(users).where(eq(users.id, user.id)).get()?.t ?? null;
  return c.json({ path: token ? `/api/calendar/ical/${token}.ics` : null, base: config.baseUrl ?? null });
});

/** Makes your link, or a new one (the old one stops working). */
calendarRoutes.post('/link', (c) => {
  const user = requireUser(c);
  const { db, config } = c.get('deps');
  const token = randomBytes(24).toString('base64url');
  db.update(users).set({ calendarToken: token }).where(eq(users.id, user.id)).run();
  return c.json({ path: `/api/calendar/ical/${token}.ics`, base: config.baseUrl ?? null });
});

calendarRoutes.delete('/link', (c) => {
  const user = requireUser(c);
  c.get('deps').db.update(users).set({ calendarToken: null }).where(eq(users.id, user.id)).run();
  return c.json({ path: null });
});

/** The feed itself. The secret in the address is the sign-in, so calendar apps can read it. Kids get kids' titles only. */
calendarRoutes.get('/ical/:file{[A-Za-z0-9_-]+\\.ics}', (c) => {
  const { db, now } = c.get('deps');
  const token = c.req.param('file').replace(/\.ics$/, '');
  const owner = db.select().from(users).where(eq(users.calendarToken, token)).get();
  if (!owner) throw new HttpError(404, 'not_found', 'That calendar link isn’t valid any more. Make a new one on the Calendar page.');
  const kid = owner.role === 'kid';
  const view = calendar(db, { from: isoDay(now() - 30 * DAY), to: isoDay(now() + 120 * DAY), now: now(), kidRatings: kid ? KID_TV_RATINGS : undefined, kidMovieRatings: kid ? KID_MOVIE_RATINGS : undefined });
  return c.body(toIcal(view.items, now(), 'Marquee'), 200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'private, max-age=600' });
});
