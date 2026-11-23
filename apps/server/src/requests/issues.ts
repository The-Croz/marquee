import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { IssueProblem, IssueView } from '@marquee/shared';
import type { Db } from '../db/index.js';
import { issueComments, issues, movies, series, users, type User } from '../db/schema.js';
import { HttpError } from '../http.js';
import { tell, type NotifyDeps } from '../notify/service.js';

/**
 * "Something wrong?" (Seerr's Issues): anyone can say a title, or one
 * episode, has a problem with its picture, sound or subtitles, is the wrong
 * title, or something else. Admins see every report with Find a better copy,
 * both sides can reply, and fixing it tells the person.
 */

export const PROBLEMS: Record<IssueProblem, string> = {
  picture: 'Picture problem',
  sound: 'Sound problem',
  subtitles: 'Subtitles problem',
  wrong_title: 'It’s the wrong title',
  other: 'Something else',
};

type Row = typeof issues.$inferSelect;

const canSee = (r: Row, u: User) => u.role === 'admin' || r.userId === u.id;

export function issueView(db: Db, r: Row, withComments = false): IssueView {
  const who = (id: number | null) => (id ? (db.select({ name: users.displayName }).from(users).where(eq(users.id, id)).get()?.name ?? 'Someone') : 'Someone');
  const where = r.season !== null ? ` · S${String(r.season).padStart(2, '0')}${r.episode !== null ? `E${String(r.episode).padStart(2, '0')}` : ''}` : '';
  return {
    id: r.id,
    kind: r.kind,
    titleId: (r.kind === 'movie' ? r.movieId : r.seriesId) ?? null,
    title: r.title,
    where: r.season !== null ? where.slice(3) : null,
    href: r.kind === 'movie' ? (r.movieId ? `/movies/${r.movieId}` : null) : r.seriesId ? `/shows/${r.seriesId}` : null,
    problem: r.problem,
    problemText: PROBLEMS[r.problem],
    message: r.message,
    status: r.status,
    by: who(r.userId),
    byId: r.userId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    fixedAt: r.fixedAt,
    comments: withComments
      ? db
          .select()
          .from(issueComments)
          .where(eq(issueComments.issueId, r.id))
          .orderBy(asc(issueComments.id))
          .all()
          .map((c) => ({ id: c.id, by: who(c.userId), byId: c.userId, body: c.body, createdAt: c.createdAt }))
      : [],
  };
}

export function listIssues(db: Db, u: User, status: 'open' | 'fixed' | 'all'): IssueView[] {
  const rows = db
    .select()
    .from(issues)
    .where(and(status === 'all' ? undefined : eq(issues.status, status), u.role === 'admin' ? undefined : eq(issues.userId, u.id)))
    .orderBy(desc(issues.updatedAt))
    .limit(300)
    .all();
  return rows.map((r) => issueView(db, r));
}

/** Open reports for one title, for its page. */
export function titleIssues(db: Db, u: User, kind: 'movie' | 'series', id: number): IssueView[] {
  return db
    .select()
    .from(issues)
    .where(and(eq(issues.kind, kind), eq(kind === 'movie' ? issues.movieId : issues.seriesId, id), inArray(issues.status, ['open'])))
    .orderBy(desc(issues.createdAt))
    .all()
    .filter((r) => canSee(r, u))
    .map((r) => issueView(db, r, true));
}

export function getIssue(db: Db, u: User, id: number): Row {
  const r = db.select().from(issues).where(eq(issues.id, id)).get();
  if (!r || !canSee(r, u)) throw new HttpError(404, 'not_found', 'That report isn’t there any more.');
  return r;
}

export interface NewIssue {
  kind: 'movie' | 'series';
  id: number;
  season?: number | null;
  episode?: number | null;
  problem: IssueProblem;
  message: string;
}

export function reportIssue(db: Db, notify: NotifyDeps, u: User, input: NewIssue, now: number): IssueView {
  const title =
    input.kind === 'movie'
      ? db.select({ t: movies.title, y: movies.year }).from(movies).where(eq(movies.id, input.id)).get()
      : db.select({ t: series.title, y: series.year }).from(series).where(eq(series.id, input.id)).get();
  if (!title) throw new HttpError(404, 'not_found', input.kind === 'movie' ? 'No such movie.' : 'No such show.');
  if (input.problem === 'other' && !input.message.trim()) throw new HttpError(400, 'invalid_input', 'Say what’s wrong, so whoever fixes it knows what to look for.');
  const name = title.y ? `${title.t} (${title.y})` : title.t;
  const row = db
    .insert(issues)
    .values({
      kind: input.kind,
      movieId: input.kind === 'movie' ? input.id : null,
      seriesId: input.kind === 'series' ? input.id : null,
      season: input.kind === 'series' ? (input.season ?? null) : null,
      episode: input.kind === 'series' && input.season != null ? (input.episode ?? null) : null,
      title: name,
      problem: input.problem,
      message: input.message.trim(),
      userId: u.id,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  const view = issueView(db, row);
  tell(notify, 'admins', 'issue_reported', { vars: { user: u.displayName, title: view.where ? `${name} ${view.where}` : name, problem: PROBLEMS[input.problem], message: row.message }, link: '/requests/problems' });
  return view;
}

export function reply(db: Db, notify: NotifyDeps, u: User, id: number, body: string, now: number): IssueView {
  const r = getIssue(db, u, id);
  db.insert(issueComments).values({ issueId: r.id, userId: u.id, body: body.trim(), createdAt: now }).run();
  db.update(issues).set({ updatedAt: now }).where(eq(issues.id, r.id)).run();
  if (u.id === r.userId) tell(notify, 'admins', 'issue_comment', { vars: { user: u.displayName, title: r.title, message: body.trim() }, link: '/requests/problems' });
  else tell(notify, r.userId, 'issue_reply', { vars: { by: u.displayName, title: r.title, message: body.trim() }, link: '/requests/problems' });
  return issueView(db, db.select().from(issues).where(eq(issues.id, r.id)).get()!, true);
}

export function setFixed(db: Db, notify: NotifyDeps, admin: User, id: number, fixed: boolean, message: string, now: number): IssueView {
  const r = getIssue(db, admin, id);
  if (message.trim()) db.insert(issueComments).values({ issueId: r.id, userId: admin.id, body: message.trim(), createdAt: now }).run();
  db.update(issues)
    .set(fixed ? { status: 'fixed', fixedAt: now, fixedBy: admin.id, updatedAt: now } : { status: 'open', fixedAt: null, fixedBy: null, updatedAt: now })
    .where(eq(issues.id, r.id))
    .run();
  if (fixed && r.userId !== admin.id) tell(notify, r.userId, 'issue_fixed', { vars: { by: admin.displayName, title: r.title, message: message.trim() }, link: '/requests/problems' });
  return issueView(db, db.select().from(issues).where(eq(issues.id, r.id)).get()!, true);
}
