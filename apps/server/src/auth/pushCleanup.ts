import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { devices, liveActivities, notificationChannels } from '../db/schema.js';

/**
 * A phone that is signed out stops getting pushes and Lock Screen updates: nothing it was following is for whoever signs in next.
 * Which messages it was set to get is kept on the phone's row, for when it comes back on.
 */
export function forgetPushForDevice(db: Db, userId: number, deviceId: string): void {
  for (const ch of db.select().from(notificationChannels).where(and(eq(notificationChannels.userId, userId), eq(notificationChannels.kind, 'apns'))).all()) {
    if ((JSON.parse(ch.config) as { deviceId?: string }).deviceId !== deviceId) continue;
    db.update(devices).set({ pushEvents: ch.events }).where(eq(devices.id, deviceId)).run();
    db.delete(notificationChannels).where(eq(notificationChannels.id, ch.id)).run();
  }
  db.delete(liveActivities).where(eq(liveActivities.deviceId, deviceId)).run();
}

/** Call before sessions are deleted (signed out, password changed, expired). */
export function forgetPushForSessions(db: Db, sessionIds: string[]): void {
  if (sessionIds.length === 0) return;
  for (const d of db.select().from(devices).where(inArray(devices.sessionId, sessionIds)).all()) forgetPushForDevice(db, d.userId, d.id);
}
