import { and, desc, eq, isNull, lte } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { notificationChannels, notifications, notificationTemplates, userPrefs, users, type NotificationChannel } from '../db/schema.js';
import { eventInfo } from './events.js';
import type { PushClient } from './push.js';
import { render, type Vars } from './template.js';

/**
 * Tells people things. Every message goes to an inbox (the bell in the web
 * app) and down the push channels (Pushover, ntfy) that want that event:
 * the shared admin channels for admin events, and each person's own
 * channels for what they get. Never throws: a channel that fails records
 * what went wrong and the rest still get their message.
 *
 * Callers hand over the facts (variables); the wording comes from the
 * event's template, Marquee's own or the admin's (Settings → Notifications).
 */

export interface Message {
  /** The facts this message carries; see each event's `vars`. */
  vars: Vars;
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

export interface Composed {
  title: string;
  body: string;
  image: string | null;
  /** The path in Marquee. */
  link: string | null;
  /** A full address, when Marquee knows its own. */
  url: string | null;
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
  return row ? parse<string[]>(row.m, []).includes(event) : false;
};

const when = (t: number) => new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** The wording for an event: the admin's, or Marquee's. */
export function templateFor(db: Db, event: string): { title: string; body: string; image: string; custom: boolean } {
  const info = eventInfo(event)!;
  const row = db.select().from(notificationTemplates).where(eq(notificationTemplates.event, event)).get();
  return row ? { title: row.title, body: row.body, image: row.image, custom: true } : { title: info.title, body: info.body, image: info.image, custom: false };
}

/** Fills an event's wording with the facts. A blank title falls back to Marquee's, so a message is never empty. */
export function compose(deps: Pick<NotifyDeps, 'db' | 'now' | 'baseUrl'>, event: string, msg: Message, tpl = templateFor(deps.db, event)): Composed {
  const info = eventInfo(event)!;
  const base = deps.baseUrl?.() ?? null;
  const url = msg.link && base ? `${base.replace(/\/+$/, '')}${msg.link}` : null;
  const vars: Vars = { ...msg.vars, link: url ?? msg.link ?? '', time: when(deps.now()), event: info.label };
  const title = render(tpl.title, vars) || render(info.title, vars) || info.label;
  const body = render(tpl.body, vars);
  const image = render(tpl.image, vars);
  return { title, body, image: /^https?:\/\//i.test(image) ? image : null, link: msg.link ?? null, url };
}

function inbox(db: Db, now: number, userId: number, event: string, m: Composed): void {
  db.insert(notifications).values({ userId, event, title: m.title, body: m.body, link: m.link, image: m.image, createdAt: now }).run();
  // Keep the inbox small: the newest 200 per person.
  const old = db.select({ id: notifications.id }).from(notifications).where(eq(notifications.userId, userId)).orderBy(desc(notifications.id)).limit(1).offset(200).get();
  if (old) db.delete(notifications).where(and(eq(notifications.userId, userId), lte(notifications.id, old.id))).run();
}

async function sendTo(deps: NotifyDeps, channels: NotificationChannel[], event: string, m: Composed, vars: Record<string, unknown> = {}): Promise<void> {
  const { db, push, now } = deps;
  for (const ch of channels) {
    if (!ch.enabled || !parse<string[]>(ch.events, []).includes(event)) continue;
    try {
      await push.send({ kind: ch.kind, config: parse<Record<string, string>>(ch.config, {}) }, { title: m.title, body: m.body, link: m.url, image: m.image, event, vars });
      db.update(notificationChannels).set({ lastOkAt: now(), lastError: null }).where(eq(notificationChannels.id, ch.id)).run();
    } catch (err) {
      db.update(notificationChannels).set({ lastError: (err as Error).message }).where(eq(notificationChannels.id, ch.id)).run();
    }
  }
}

const ownChannels = (db: Db, userId: number) => db.select().from(notificationChannels).where(eq(notificationChannels.userId, userId)).all();

/** Tells one person: their bell, and their own push channels. Muted events go nowhere. */
export async function notifyUser(deps: NotifyDeps, userId: number | null, event: string, msg: Message): Promise<void> {
  if (userId === null || !eventInfo(event)) return;
  const { db, now } = deps;
  let m: Composed;
  try {
    if (muted(db, userId, event)) return;
    m = compose(deps, event, msg);
    inbox(db, now(), userId, event, m);
  } catch (err) {
    console.error('[notify] inbox failed:', (err as Error).message);
    return;
  }
  await sendTo(deps, ownChannels(db, userId), event, m, msg.vars);
}

/** Tells every admin (bell and their own channels) and sends it down the shared channels that have the event on. */
export async function notifyAdmins(deps: NotifyDeps, event: string, msg: Message): Promise<void> {
  const { db, now } = deps;
  if (!eventInfo(event)) return;
  let m: Composed;
  const listening: number[] = [];
  try {
    m = compose(deps, event, msg);
    for (const a of db.select({ id: users.id }).from(users).where(eq(users.role, 'admin')).all()) {
      if (muted(db, a.id, event)) continue;
      listening.push(a.id);
      inbox(db, now(), a.id, event, m);
    }
  } catch (err) {
    console.error('[notify] inbox failed:', (err as Error).message);
    return;
  }
  await sendTo(deps, db.select().from(notificationChannels).where(isNull(notificationChannels.userId)).all(), event, m, msg.vars);
  for (const id of listening) await sendTo(deps, ownChannels(db, id), event, m, msg.vars);
}

/** Fire and forget, for code that mustn't wait on a push. */
export function tell(deps: NotifyDeps | null | undefined, to: 'admins' | number | null, event: string, msg: Message): void {
  if (!deps) return;
  const p = to === 'admins' ? notifyAdmins(deps, event, msg) : notifyUser(deps, to, event, msg);
  p.catch((e) => console.error('[notify] failed:', (e as Error).message));
}
