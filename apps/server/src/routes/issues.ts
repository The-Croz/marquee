import { Hono } from 'hono';
import { z } from 'zod';
import type { IssueView } from '@marquee/shared';
import { requireAdmin, requireUser, type Env } from '../http.js';
import { getIssue, issueView, listIssues, reply, reportIssue, setFixed, titleIssues } from '../requests/issues.js';
import { notifyDeps } from './notifications.js';

/** "Something wrong?" reports. Everyone reports and sees their own; admins see and fix all. */
export const issueRoutes = new Hono<Env>();

const problem = z.enum(['picture', 'sound', 'subtitles', 'wrong_title', 'other']);
const num = (c: { req: { param: (k: string) => string } }) => Number(c.req.param('id'));

issueRoutes.get('/', (c) => {
  const u = requireUser(c);
  const status = z.enum(['open', 'fixed', 'all']).default('open').parse(c.req.query('status'));
  return c.json<{ items: IssueView[] }>({ items: listIssues(c.get('deps').db, u, status) });
});

issueRoutes.get('/title/:kind{movie|series}/:id{[0-9]+}', (c) => {
  const u = requireUser(c);
  return c.json<{ items: IssueView[] }>({ items: titleIssues(c.get('deps').db, u, c.req.param('kind') as 'movie' | 'series', num(c)) });
});

issueRoutes.post('/', async (c) => {
  const u = requireUser(c);
  const input = z
    .object({ kind: z.enum(['movie', 'series']), id: z.number().int().positive(), season: z.number().int().min(0).nullable().optional(), episode: z.number().int().positive().nullable().optional(), problem, message: z.string().max(1000).default('') })
    .parse(await c.req.json());
  const { db, now } = c.get('deps');
  return c.json<IssueView>(reportIssue(db, notifyDeps(c), u, input, now()), 201);
});

issueRoutes.get('/:id{[0-9]+}', (c) => {
  const u = requireUser(c);
  const { db } = c.get('deps');
  return c.json<IssueView>(issueView(db, getIssue(db, u, num(c)), true));
});

issueRoutes.post('/:id{[0-9]+}/replies', async (c) => {
  const u = requireUser(c);
  const { body } = z.object({ body: z.string().trim().min(1, 'Write something first.').max(1000) }).parse(await c.req.json());
  const { db, now } = c.get('deps');
  return c.json<IssueView>(reply(db, notifyDeps(c), u, num(c), body, now()));
});

issueRoutes.post('/:id{[0-9]+}/fixed', async (c) => {
  const admin = requireAdmin(c);
  const { fixed, message } = z.object({ fixed: z.boolean().default(true), message: z.string().max(1000).default('') }).parse(await c.req.json());
  const { db, now } = c.get('deps');
  return c.json<IssueView>(setFixed(db, notifyDeps(c), admin, num(c), fixed, message, now()));
});
