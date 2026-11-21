import { Hono } from 'hono';
import { z } from 'zod';
import type { CalendarView } from '@marquee/shared';
import { calendar } from '../library/airing.js';
import { requireUser, type Env } from '../http.js';
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
