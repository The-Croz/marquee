import { Hono } from 'hono';
import { and, desc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { ApnsSettingsView, NotificationChannelView, NotificationEventInfo, NotificationInboxItem, NotificationPreview, NotificationPriority, NotificationTemplateView } from '@marquee/shared';
import type { Db } from '../db/index.js';
import { notificationChannels, notificationPriorities, notifications, notificationTemplates, userPrefs, type NotificationChannel, type User } from '../db/schema.js';
import { HttpError, requireAdmin, requireUser, type Ctx, type Env } from '../http.js';
import { COMMON_VARS, DEFAULT_ADMIN_EVENTS, EVENTS, defaultEventsFor, eventInfo, eventsFor, PRIORITIES } from '../notify/events.js';
import { compose, priorityFor, templateFor, type NotifyDeps } from '../notify/service.js';
import { unknownNames } from '../notify/template.js';
import { apnsView, writeApns } from '../notify/apnsSettings.js';

/**
 * Notifications:
 *   /api/notifications            each person's bell, what they mute, and their own push channels (/channels)
 *   /api/settings/notifications   admins: the shared push channels, and the wording of every message (/templates)
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
  const items: NotificationInboxItem[] = rows.map((n) => ({ id: n.id, event: n.event, title: n.title, body: n.body, link: n.link, image: n.image, createdAt: n.createdAt, read: n.readAt !== null }));
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

/** Which events this person can get, and which they turned off (for their bell and their own channels). */
notificationRoutes.get('/events', (c) => {
  const user = requireUser(c);
  const row = c.get('deps').db.select({ m: userPrefs.mutedEvents }).from(userPrefs).where(eq(userPrefs.userId, user.id)).get();
  return c.json<{ events: NotificationEventInfo[]; muted: string[] }>({ events: eventsFor(user.role), muted: row ? (JSON.parse(row.m) as string[]) : [] });
});

notificationRoutes.put('/muted', async (c) => {
  const user = requireUser(c);
  const { muted } = z.object({ muted: z.array(z.string().max(40)).max(60) }).parse(await c.req.json());
  const known = muted.filter((k) => EVENTS.some((e) => e.key === k));
  const json = JSON.stringify(known);
  c.get('deps').db.insert(userPrefs).values({ userId: user.id, mutedEvents: json }).onConflictDoUpdate({ target: userPrefs.userId, set: { mutedEvents: json } }).run();
  return c.json({ muted: known });
});

// ---------------- Push channels ----------------

const cfg = (ch: NotificationChannel) => JSON.parse(ch.config) as Record<string, string>;

function channelView(ch: NotificationChannel): NotificationChannelView {
  const c = cfg(ch);
  return {
    id: ch.id,
    kind: ch.kind,
    name: ch.name,
    enabled: ch.enabled,
    events: JSON.parse(ch.events) as string[],
    detail: ch.kind === 'ntfy' ? `${(c.server || 'https://ntfy.sh').replace(/\/+$/, '')}/${c.topic ?? ''}` : ch.kind === 'webhook' ? (c.url ?? '').replace(/^(https?:\/\/[^/]+).*$/, '$1/…') : ch.kind === 'apns' ? 'iPhone app' : 'Pushover',
    lastOkAt: ch.lastOkAt,
    lastError: ch.lastError,
  };
}

/**
 * The same channel routes for two owners: the shared admin channels (admin
 * events only), and each person's own (the events that person can get).
 */
interface Scope {
  /** Checks who may use these routes; returns the signed-in person. */
  who(c: Ctx): User;
  /** Which channels are theirs. */
  where(u: User): SQL;
  owner(u: User): number | null;
  /** Events these channels may carry. */
  allowed(u: User): string[];
  /** What a new channel starts with. */
  defaults(u: User): string[];
}

const SHARED: Scope = {
  who: requireAdmin,
  where: () => isNull(notificationChannels.userId),
  owner: () => null,
  allowed: () => EVENTS.filter((e) => e.audience === 'admins').map((e) => e.key),
  defaults: () => [...DEFAULT_ADMIN_EVENTS],
};

const MINE: Scope = {
  who: requireUser,
  where: (u) => eq(notificationChannels.userId, u.id),
  owner: (u) => u.id,
  allowed: (u) => eventsFor(u.role).map((e) => e.key),
  defaults: (u) => defaultEventsFor(u),
};

const eventList = z.array(z.string().max(40)).max(60);
const secret = z.string().max(300).optional();
const createBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pushover'), name: z.string().trim().min(1).max(60), appToken: z.string().trim().min(1).max(300), userKey: z.string().trim().min(1).max(300), events: eventList.optional() }),
  z.object({ kind: z.literal('ntfy'), name: z.string().trim().min(1).max(60), server: z.string().trim().max(300).default(''), topic: z.string().trim().min(1).max(200), token: secret, events: eventList.optional() }),
  z.object({ kind: z.literal('webhook'), name: z.string().trim().min(1).max(60), url: z.string().trim().regex(/^https?:\/\//i, 'The webhook address should start with http:// or https://').max(500), secret, events: eventList.optional() }),
]);
const patchBody = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  enabled: z.boolean().optional(),
  events: eventList.optional(),
  appToken: secret,
  userKey: secret,
  server: z.string().trim().max(300).optional(),
  topic: z.string().trim().max(200).optional(),
  token: secret,
  url: z.string().trim().regex(/^https?:\/\//i, 'The webhook address should start with http:// or https://').max(500).optional(),
  secret,
});

function channelRoutesFor(scope: Scope): Hono<Env> {
  const r = new Hono<Env>();
  const find = (c: Ctx, u: User) => {
    const ch = c.get('deps').db.select().from(notificationChannels).where(and(eq(notificationChannels.id, Number(c.req.param('id'))), scope.where(u))).get();
    if (!ch) throw new HttpError(404, 'not_found', 'That channel isn’t there any more.');
    return ch;
  };
  const only = (u: User, list: string[]) => list.filter((k) => scope.allowed(u).includes(k));

  r.get('/', (c) => {
    const u = scope.who(c);
    const { db } = c.get('deps');
    const allowed = scope.allowed(u);
    return c.json<{ items: NotificationChannelView[]; events: NotificationEventInfo[] }>({
      items: db.select().from(notificationChannels).where(scope.where(u)).orderBy(notificationChannels.id).all().map(channelView),
      events: EVENTS.filter((e) => allowed.includes(e.key)),
    });
  });

  r.post('/', async (c) => {
    const u = scope.who(c);
    const { db, now } = c.get('deps');
    const b = createBody.parse(await c.req.json());
    if (b.kind === 'ntfy' && b.server && !/^https?:\/\//i.test(b.server)) throw new HttpError(400, 'invalid_input', 'The ntfy address should start with http:// or https://');
    const config =
      b.kind === 'pushover'
        ? { appToken: b.appToken, userKey: b.userKey }
        : b.kind === 'webhook'
          ? { url: b.url, ...(b.secret ? { secret: b.secret } : {}) }
          : { server: b.server, topic: b.topic, ...(b.token ? { token: b.token } : {}) };
    const events = b.events ? only(u, b.events) : scope.defaults(u);
    const row = db.insert(notificationChannels).values({ kind: b.kind, name: b.name, userId: scope.owner(u), config: JSON.stringify(config), events: JSON.stringify(events), createdAt: now() }).returning().get();
    return c.json(channelView(row), 201);
  });

  /** Change a channel. Secrets left blank are kept. */
  r.patch('/:id{[0-9]+}', async (c) => {
    const u = scope.who(c);
    const { db } = c.get('deps');
    const ch = find(c, u);
    const b = patchBody.parse(await c.req.json());
    const config = cfg(ch);
    for (const k of ['appToken', 'userKey', 'token', 'secret', 'url'] as const) if (b[k]) config[k] = b[k]!;
    if (b.server !== undefined) config.server = b.server;
    if (b.topic) config.topic = b.topic;
    const row = db
      .update(notificationChannels)
      .set({ ...(b.name ? { name: b.name } : {}), ...(b.enabled !== undefined ? { enabled: b.enabled } : {}), ...(b.events ? { events: JSON.stringify(only(u, b.events)) } : {}), config: JSON.stringify(config) })
      .where(eq(notificationChannels.id, ch.id))
      .returning()
      .get();
    return c.json(channelView(row));
  });

  r.delete('/:id{[0-9]+}', (c) => {
    const u = scope.who(c);
    const ch = find(c, u);
    c.get('deps').db.delete(notificationChannels).where(eq(notificationChannels.id, ch.id)).run();
    return c.json({ ok: true });
  });

  /** Sends one test message now and says how it went. */
  r.post('/:id{[0-9]+}/test', async (c) => {
    const u = scope.who(c);
    const { db, clients, now } = c.get('deps');
    const ch = find(c, u);
    try {
      await clients.push.send({ kind: ch.kind, config: cfg(ch) }, { title: 'Marquee test', body: 'If you can read this, Marquee can reach you here.', link: null, event: 'test' });
      db.update(notificationChannels).set({ lastOkAt: now(), lastError: null }).where(eq(notificationChannels.id, ch.id)).run();
      return c.json({ ok: true, message: 'Sent. Check your phone.' });
    } catch (err) {
      const message = (err as Error).message;
      db.update(notificationChannels).set({ lastError: message }).where(eq(notificationChannels.id, ch.id)).run();
      return c.json({ ok: false, message });
    }
  });
  return r;
}

notificationRoutes.route('/channels', channelRoutesFor(MINE));

// ---------------- Wording (admin) ----------------

const view = (db: Db, event: string): NotificationTemplateView => ({ event, ...templateFor(db, event), priority: priorityFor(db, event) });
const templateBody = z.object({ title: z.string().max(300), body: z.string().max(2000), image: z.string().max(500).default('') });
const known = (event: string) => [...eventInfo(event)!.vars.map((v) => v.key), ...COMMON_VARS.map((v) => v.key)];
const mustKnow = (event: string) => {
  if (!eventInfo(event)) throw new HttpError(404, 'not_found', 'Marquee doesn’t send a message called that.');
};

channelRoutes.get('/templates', (c) => {
  requireAdmin(c);
  const { db } = c.get('deps');
  const items: NotificationTemplateView[] = EVENTS.map((e) => view(db, e.key));
  return c.json({ items, events: EVENTS, common: COMMON_VARS });
});

/** What a wording looks like with the example facts. Nothing is saved or sent. */
channelRoutes.post('/templates/preview', async (c) => {
  requireAdmin(c);
  const { event, ...t } = templateBody.extend({ event: z.string().max(40) }).parse(await c.req.json());
  mustKnow(event);
  const deps = notifyDeps(c);
  const vars = Object.fromEntries(eventInfo(event)!.vars.map((v) => [v.key, v.example]));
  const m = compose(deps, event, { vars, link: '/requests' }, { ...t, custom: true });
  const unknown = [...new Set([t.title, t.body, t.image].flatMap((s) => unknownNames(s, known(event))))];
  return c.json<NotificationPreview>({ title: m.title, body: m.body, image: m.image, unknown });
});

channelRoutes.put('/templates/:event', async (c) => {
  requireAdmin(c);
  const event = c.req.param('event');
  mustKnow(event);
  const t = templateBody.parse(await c.req.json());
  if (!t.title.trim()) throw new HttpError(400, 'invalid_input', 'A message needs a title. Use “Put Marquee’s wording back” to start again.');
  const { db, now } = c.get('deps');
  db.insert(notificationTemplates).values({ event, ...t, updatedAt: now() }).onConflictDoUpdate({ target: notificationTemplates.event, set: { ...t, updatedAt: now() } }).run();
  return c.json<NotificationTemplateView>(view(db, event));
});

/** How a message arrives on phones. Picking Marquee's own choice forgets yours. */
channelRoutes.put('/templates/:event/priority', async (c) => {
  requireAdmin(c);
  const event = c.req.param('event');
  mustKnow(event);
  const { priority } = z.object({ priority: z.enum(PRIORITIES as [NotificationPriority, ...NotificationPriority[]]) }).parse(await c.req.json());
  const { db, now } = c.get('deps');
  if (priority === eventInfo(event)!.priority) db.delete(notificationPriorities).where(eq(notificationPriorities.event, event)).run();
  else db.insert(notificationPriorities).values({ event, priority, updatedAt: now() }).onConflictDoUpdate({ target: notificationPriorities.event, set: { priority, updatedAt: now() } }).run();
  return c.json<NotificationTemplateView>(view(db, event));
});

/** Back to Marquee's own wording. */
channelRoutes.delete('/templates/:event', (c) => {
  requireAdmin(c);
  const event = c.req.param('event');
  mustKnow(event);
  const { db } = c.get('deps');
  db.delete(notificationTemplates).where(eq(notificationTemplates.event, event)).run();
  return c.json<NotificationTemplateView>(view(db, event));
});


// ---------------- iPhone app (Apple push key, admin) ----------------

const apnsBody = z.object({
  key: z.string().max(5000).optional(),
  keyId: z.string().trim().regex(/^[A-Z0-9]{10}$/, 'A key id is 10 letters and numbers, like ABC123DEFG.'),
  teamId: z.string().trim().regex(/^[A-Z0-9]{10}$/, 'A team id is 10 letters and numbers, like ABC123DEFG.'),
  bundleId: z.string().trim().regex(/^[A-Za-z0-9.-]{3,100}$/, 'The app id looks like marquee.ios.app.'),
});

channelRoutes.get('/apns', (c) => {
  requireAdmin(c);
  return c.json<ApnsSettingsView>(apnsView(c.get('deps').db));
});

channelRoutes.put('/apns', async (c) => {
  requireAdmin(c);
  const { db } = c.get('deps');
  const body = apnsBody.parse(await c.req.json());
  if (!body.key?.trim() && !apnsView(db).keySet) throw new HttpError(400, 'invalid_input', 'Paste the Apple push key (the .p8 file’s text) to set this up.');
  writeApns(db, body);
  return c.json<ApnsSettingsView>(apnsView(db));
});

/** Sends a test to the admin's own iPhones. */
channelRoutes.post('/apns/test', async (c) => {
  const user = requireAdmin(c);
  const { db, clients, now } = c.get('deps');
  if (!apnsView(db).ready) return c.json({ ok: false, message: 'Fill in the Apple key, key id, team id and app id first.' });
  const mine = db.select().from(notificationChannels).where(and(eq(notificationChannels.userId, user.id), eq(notificationChannels.kind, 'apns'))).all();
  if (mine.length === 0) return c.json({ ok: false, message: 'None of your iPhones is signed in with notifications on. Open the Marquee app, then You → Notifications on this iPhone.' });
  let sent = 0;
  let problem: string | null = null;
  for (const ch of mine) {
    try {
      await clients.push.send({ kind: 'apns', config: cfg(ch) }, { title: 'Marquee test', body: 'If you can read this, Marquee can reach your iPhone.', link: null, event: 'test' });
      db.update(notificationChannels).set({ lastOkAt: now(), lastError: null }).where(eq(notificationChannels.id, ch.id)).run();
      sent++;
    } catch (err) {
      problem = (err as Error).message;
      db.update(notificationChannels).set({ lastError: problem }).where(eq(notificationChannels.id, ch.id)).run();
    }
  }
  return c.json({ ok: sent > 0, message: sent > 0 ? `Sent to ${sent} ${sent === 1 ? 'iPhone' : 'iPhones'}. Check your phone.` : (problem ?? 'It didn’t go through.') });
});

channelRoutes.route('/', channelRoutesFor(SHARED));
