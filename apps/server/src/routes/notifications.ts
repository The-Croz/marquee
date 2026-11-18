import { Hono } from 'hono';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { NotificationChannelView, NotificationEventInfo, NotificationInboxItem } from '@marquee/shared';
import { notificationChannels, notifications, userPrefs, type NotificationChannel } from '../db/schema.js';
import { HttpError, requireAdmin, requireUser, type Ctx, type Env } from '../http.js';
import { ADMIN_EVENTS, EVENTS } from '../notify/events.js';
import type { NotifyDeps } from '../notify/service.js';

/**
 * Notifications: each person's inbox (the bell) and which events they want,
 * and, for admins, the push channels (Pushover, ntfy) and what goes to each.
 */
export const notificationRoutes = new Hono<Env>();
export const channelRoutes = new Hono<Env>();

export const notifyDeps = (c: Ctx): NotifyDeps => {
  const { db, clients, now, config } = c.get('deps');
  return { db, push: clients.push, now, baseUrl: () => config.baseUrl ?? null };
};

// ---------------- Inbox ----------------

notificationRoutes.get('/', (c) => {
  const user = requireUser(c);
  const { db } = c.get('deps');
  const rows = db.select().from(notifications).where(eq(notifications.userId, user.id)).orderBy(desc(notifications.id)).limit(50).all();
  const unread = db.select({ id: notifications.id }).from(notifications).where(and(eq(notifications.userId, user.id), isNull(notifications.readAt))).all().length;
  const items: NotificationInboxItem[] = rows.map((n) => ({ id: n.id, event: n.event, title: n.title, body: n.body, link: n.link, createdAt: n.createdAt, read: n.readAt !== null }));
  return c.json({ items, unread });
});

notificationRoutes.post('/read', async (c) => {
  const user = requireUser(c);
  const { ids } = z.object({ ids: z.array(z.number().int()).max(200).optional() }).parse(await c.req.json());
  const { db, now } = c.get('deps');
  db.update(notifications)
    .set({ readAt: now() })
    .where(and(eq(notifications.userId, user.id), isNull(notifications.readAt), ids ? inArray(notifications.id, ids) : undefined))
    .run();
  return c.json({ ok: true });
});

/** Which events this person can get, and which they turned off. */
notificationRoutes.get('/events', (c) => {
  const user = requireUser(c);
  const row = c.get('deps').db.select({ m: userPrefs.mutedEvents }).from(userPrefs).where(eq(userPrefs.userId, user.id)).get();
  const mine: NotificationEventInfo[] = EVENTS.filter((e) => e.audience === 'requester' || user.role === 'admin');
  return c.json({ events: mine, muted: row ? (JSON.parse(row.m) as string[]) : [] });
});

notificationRoutes.put('/muted', async (c) => {
  const user = requireUser(c);
  const { muted } = z.object({ muted: z.array(z.string().max(40)).max(40) }).parse(await c.req.json());
  const known = muted.filter((k) => EVENTS.some((e) => e.key === k));
  const json = JSON.stringify(known);
  c.get('deps').db.insert(userPrefs).values({ userId: user.id, mutedEvents: json }).onConflictDoUpdate({ target: userPrefs.userId, set: { mutedEvents: json } }).run();
  return c.json({ muted: known });
});

// ---------------- Push channels (admin) ----------------

const cfg = (ch: NotificationChannel) => JSON.parse(ch.config) as Record<string, string>;

function channelView(ch: NotificationChannel): NotificationChannelView {
  const c = cfg(ch);
  return {
    id: ch.id,
    kind: ch.kind,
    name: ch.name,
    enabled: ch.enabled,
    events: JSON.parse(ch.events) as string[],
    detail: ch.kind === 'ntfy' ? `${(c.server || 'https://ntfy.sh').replace(/\/+$/, '')}/${c.topic ?? ''}` : 'Pushover',
    lastOkAt: ch.lastOkAt,
    lastError: ch.lastError,
  };
}

const events = z.array(z.string().max(40)).max(40).transform((list) => list.filter((k) => ADMIN_EVENTS.includes(k)));
const secret = z.string().max(300).optional();
const createBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pushover'), name: z.string().trim().min(1).max(60), appToken: z.string().trim().min(1).max(300), userKey: z.string().trim().min(1).max(300), events: events.default([...ADMIN_EVENTS]) }),
  z.object({ kind: z.literal('ntfy'), name: z.string().trim().min(1).max(60), server: z.string().trim().max(300).default(''), topic: z.string().trim().min(1).max(200), token: secret, events: events.default([...ADMIN_EVENTS]) }),
]);

channelRoutes.get('/', (c) => {
  requireAdmin(c);
  const { db } = c.get('deps');
  return c.json({ items: db.select().from(notificationChannels).orderBy(notificationChannels.id).all().map(channelView), events: EVENTS.filter((e) => e.audience === 'admins') });
});

channelRoutes.post('/', async (c) => {
  requireAdmin(c);
  const { db, now } = c.get('deps');
  const b = createBody.parse(await c.req.json());
  if (b.kind === 'ntfy' && b.server && !/^https?:\/\//i.test(b.server)) throw new HttpError(400, 'invalid_input', 'The ntfy address should start with http:// or https://');
  const config = b.kind === 'pushover' ? { appToken: b.appToken, userKey: b.userKey } : { server: b.server, topic: b.topic, ...(b.token ? { token: b.token } : {}) };
  const row = db.insert(notificationChannels).values({ kind: b.kind, name: b.name, config: JSON.stringify(config), events: JSON.stringify(b.events), createdAt: now() }).returning().get();
  return c.json(channelView(row), 201);
});

/** Change a channel. Secrets left blank are kept. */
channelRoutes.patch('/:id{[0-9]+}', async (c) => {
  requireAdmin(c);
  const { db } = c.get('deps');
  const id = Number(c.req.param('id'));
  const ch = db.select().from(notificationChannels).where(eq(notificationChannels.id, id)).get();
  if (!ch) throw new HttpError(404, 'not_found', 'That channel isn’t there any more.');
  const b = z
    .object({ name: z.string().trim().min(1).max(60).optional(), enabled: z.boolean().optional(), events: events.optional(), appToken: secret, userKey: secret, server: z.string().trim().max(300).optional(), topic: z.string().trim().max(200).optional(), token: secret })
    .parse(await c.req.json());
  const config = cfg(ch);
  for (const k of ['appToken', 'userKey', 'token'] as const) if (b[k]) config[k] = b[k]!;
  if (b.server !== undefined) config.server = b.server;
  if (b.topic) config.topic = b.topic;
  const row = db
    .update(notificationChannels)
    .set({ ...(b.name ? { name: b.name } : {}), ...(b.enabled !== undefined ? { enabled: b.enabled } : {}), ...(b.events ? { events: JSON.stringify(b.events) } : {}), config: JSON.stringify(config) })
    .where(eq(notificationChannels.id, id))
    .returning()
    .get();
  return c.json(channelView(row));
});

channelRoutes.delete('/:id{[0-9]+}', (c) => {
  requireAdmin(c);
  c.get('deps').db.delete(notificationChannels).where(eq(notificationChannels.id, Number(c.req.param('id')))).run();
  return c.json({ ok: true });
});

/** Sends one test message now and says how it went. */
channelRoutes.post('/:id{[0-9]+}/test', async (c) => {
  requireAdmin(c);
  const { db, clients, now } = c.get('deps');
  const id = Number(c.req.param('id'));
  const ch = db.select().from(notificationChannels).where(eq(notificationChannels.id, id)).get();
  if (!ch) throw new HttpError(404, 'not_found', 'That channel isn’t there any more.');
  try {
    await clients.push.send({ kind: ch.kind, config: cfg(ch) }, { title: 'Marquee test', body: 'If you can read this, Marquee can reach you here.', link: null });
    db.update(notificationChannels).set({ lastOkAt: now(), lastError: null }).where(eq(notificationChannels.id, id)).run();
    return c.json({ ok: true, message: 'Sent. Check your phone.' });
  } catch (err) {
    const message = (err as Error).message;
    db.update(notificationChannels).set({ lastError: message }).where(eq(notificationChannels.id, id)).run();
    return c.json({ ok: false, message });
  }
});
