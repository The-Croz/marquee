import { createHash, randomBytes } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { devices, sessions, users, type User } from '../db/schema.js';
import { forgetPushForSessions } from './pushCleanup.js';

export const SESSION_COOKIE = 'marquee_session';
const DAY = 24 * 60 * 60 * 1000;
export const SESSION_TTL = 30 * DAY;
/** The iPhone app stays signed in for 180 days of not using it. */
export const APP_SESSION_TTL = 180 * DAY;
/** Sessions slide forward when used, but we only write that at most this often. */
const TOUCH_EVERY = 60 * 60 * 1000;

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function createSession(db: Db, userId: number, userAgent: string | undefined, now = Date.now(), ttl?: number): string {
  const token = randomBytes(32).toString('base64url');
  db.insert(sessions)
    .values({ id: hashToken(token), userId, createdAt: now, expiresAt: now + (ttl ?? SESSION_TTL), lastSeenAt: now, userAgent: userAgent?.slice(0, 300), ttl: ttl ?? null })
    .run();
  db.update(users).set({ lastLoginAt: now }).where(eq(users.id, userId)).run();
  return token;
}

export function getSessionUser(db: Db, token: string | undefined, now = Date.now()): User | null {
  if (!token) return null;
  const id = hashToken(token);
  const row = db.select({ session: sessions, user: users }).from(sessions).innerJoin(users, eq(sessions.userId, users.id)).where(eq(sessions.id, id)).get();
  if (!row) return null;
  if (row.session.expiresAt <= now) {
    forgetPushForSessions(db, [id]);
    db.delete(sessions).where(eq(sessions.id, id)).run();
    return null;
  }
  if (now - row.session.lastSeenAt > TOUCH_EVERY) {
    db.update(sessions).set({ lastSeenAt: now, expiresAt: now + (row.session.ttl ?? SESSION_TTL) }).where(eq(sessions.id, id)).run();
    db.update(devices).set({ lastSeenAt: now }).where(eq(devices.sessionId, id)).run();
  }
  return row.user;
}

export function deleteSession(db: Db, token: string | undefined): void {
  if (!token) return;
  forgetPushForSessions(db, [hashToken(token)]);
  db.delete(sessions).where(eq(sessions.id, hashToken(token))).run();
}

export function deleteUserSessions(db: Db, userId: number): void {
  forgetPushForSessions(db, db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId)).all().map((x) => x.id));
  db.delete(sessions).where(eq(sessions.userId, userId)).run();
}

export function purgeExpiredSessions(db: Db, now = Date.now()): void {
  forgetPushForSessions(db, db.select({ id: sessions.id }).from(sessions).where(lt(sessions.expiresAt, now)).all().map((x) => x.id));
  db.delete(sessions).where(lt(sessions.expiresAt, now)).run();
}
