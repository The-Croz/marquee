import { and, desc, eq, lte } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { notificationChannels, notifications, userPrefs, users } from '../db/schema.js';
import { eventInfo } from './events.js';
import type { PushClient } from './push.js';

/**
 * Tells people things. Every message goes to an inbox (the bell in the web
 * app), and admin messages also go to the push channels (Pushover, ntfy)
 * that are switched on for that event. Never throws: a channel that fails
 * records what went wrong and the rest still get their message.
 */

export interface Message {
  title: string;
  body: string;
  /** A path in Marquee, e.g. "/requests". */
  link?: string | null;
}

export interface NotifyDeps {
  db: Db;
  push: PushClient;
  now: () => number;
  /** Marquee's public address, to make links people can open from a push. */
  baseUrl?: () => string | null;
}

const parse = <T>(s: string, fallback: T): T => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

const muted = (db: Db, userId: number, event: string) => {
  const row = db.select({ m: userPrefs.mutedEvents }).from(userPrefs).where(eq(userPrefs.userId, userId)).get();
  return row ? (parse<string[]>(row.m, [])).includes(event) : false;
};

function inbox(db: Db, now: number, userId: number, event: string, msg: Message): void {
  if (muted(db, userId, event)) return;
  db.insert(notifications).values({ userId, event, title: msg.title, body: msg.body, link: msg.link ?? null, createdAt: now }).run();
  // Keep the inbox small: the newest 200 per person.
  const old = db.select({ id: notifications.id }).from(notifications).where(eq(notifications.userId, userId)).orderBy(desc(notifications.id)).limit(1).offset(200).get();
  if (old) db.delete(notifications).where(and(eq(notifications.userId, userId), lte(notifications.id, old.id))).run();
}

/** Tells the person who asked (inbox only). */
export function notifyUser(deps: NotifyDeps, userId: number | null, event: string, msg: Message): void {
  if (userId === null || !eventInfo(event)) return;
  try {
    inbox(deps.db, deps.now(), userId, event, msg);
  } catch (err) {
    console.error('[notify] inbox failed:', (err as Error).message);
  }
}

/** Tells every admin (inbox) and sends it down the push channels that have the event on. */
export async function notifyAdmins(deps: NotifyDeps, event: string, msg: Message): Promise<void> {
  const { db, push, now } = deps;
  if (!eventInfo(event)) return;
  try {
    for (const a of db.select({ id: users.id }).from(users).where(eq(users.role, 'admin')).all()) inbox(db, now(), a.id, event, msg);
  } catch (err) {
    console.error('[notify] inbox failed:', (err as Error).message);
  }
  const base = deps.baseUrl?.() ?? null;
  const link = msg.link && base ? `${base}${msg.link}` : null;
  for (const ch of db.select().from(notificationChannels).where(and(eq(notificationChannels.enabled, true))).all()) {
    if (!parse<string[]>(ch.events, []).includes(event)) continue;
    try {
      await push.send({ kind: ch.kind, config: parse<Record<string, string>>(ch.config, {}) }, { title: msg.title, body: msg.body, link });
      db.update(notificationChannels).set({ lastOkAt: now(), lastError: null }).where(eq(notificationChannels.id, ch.id)).run();
    } catch (err) {
      db.update(notificationChannels).set({ lastError: (err as Error).message }).where(eq(notificationChannels.id, ch.id)).run();
    }
  }
}
