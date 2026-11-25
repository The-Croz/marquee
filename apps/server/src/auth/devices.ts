import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { DeviceView } from '@marquee/shared';
import type { Db } from '../db/index.js';
import { devices, sessions, type User } from '../db/schema.js';
import { APP_SESSION_TTL, createSession, hashToken } from './sessions.js';

export const appDeviceSchema = z.object({
  id: z.string().trim().min(8).max(100),
  name: z.string().trim().min(1).max(80),
  kind: z.literal('ios'),
});
export type AppDevice = z.infer<typeof appDeviceSchema>;

/**
 * Signs a phone in: its old sign-in (if any) stops working, and it gets a
 * 180-day one. The same phone keeps one row however often it signs in, so
 * anything attached to it later (its alerts) is never duplicated.
 */
export function signInDevice(db: Db, user: User, input: AppDevice, userAgent: string | undefined, now: number): string {
  // One row per person per phone: someone else signing in on a shared phone never signs this person out.
  const device = { ...input, id: `${user.id}.${input.id}` };
  const existing = db.select().from(devices).where(eq(devices.id, device.id)).get();
  if (existing?.sessionId) db.delete(sessions).where(eq(sessions.id, existing.sessionId)).run();
  const token = createSession(db, user.id, userAgent, now, APP_SESSION_TTL);
  const sessionId = hashToken(token);
  if (existing) {
    db.update(devices).set({ userId: user.id, name: device.name, kind: device.kind, sessionId, lastSeenAt: now }).where(eq(devices.id, device.id)).run();
  } else {
    db.insert(devices).values({ id: device.id, userId: user.id, name: device.name, kind: device.kind, sessionId, createdAt: now, lastSeenAt: now }).run();
  }
  return token;
}

export function listDevices(db: Db, userId: number, currentSessionId?: string): DeviceView[] {
  const rows = db.select().from(devices).where(eq(devices.userId, userId)).orderBy(desc(devices.lastSeenAt)).all();
  const ids = rows.flatMap((d) => (d.sessionId ? [d.sessionId] : []));
  const alive = new Set(ids.length ? db.select({ id: sessions.id }).from(sessions).where(inArray(sessions.id, ids)).all().map((s) => s.id) : []);
  return rows.map((d) => ({
    id: d.id,
    name: d.name,
    kind: d.kind,
    lastSeenAt: d.lastSeenAt,
    signedIn: d.sessionId !== null && alive.has(d.sessionId),
    current: d.sessionId !== null && d.sessionId === currentSessionId,
  }));
}

/** Signs the phone out and forgets it. False when it isn't theirs. */
export function removeDevice(db: Db, userId: number, deviceId: string): boolean {
  const row = db.select().from(devices).where(and(eq(devices.id, deviceId), eq(devices.userId, userId))).get();
  if (!row) return false;
  if (row.sessionId) db.delete(sessions).where(eq(sessions.id, row.sessionId)).run();
  db.delete(devices).where(eq(devices.id, deviceId)).run();
  return true;
}

/** Called when a phone signs itself out: the row stays, signed out. */
export function signOutDevice(db: Db, sessionId: string): void {
  db.update(devices).set({ sessionId: null }).where(eq(devices.sessionId, sessionId)).run();
}
