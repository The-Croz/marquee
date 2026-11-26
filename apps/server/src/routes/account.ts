import { Hono } from 'hono';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { deleteUserSessions, hashToken } from '../auth/sessions.js';
import { dropPush, listDevices, pushEvents, registerPush, removeDevice } from '../auth/devices.js';
import { toSessionUser, updateUser } from '../auth/users.js';
import { HttpError, requireUser, sessionToken, signIn, type Env } from '../http.js';
import type { User } from '../db/schema.js';
import { passwordSchema } from './auth.js';

/** The signed-in user's own account: name, password and linked sign-ins. */
export const accountRoutes = new Hono<Env>();

accountRoutes.get('/', (c) => c.json({ user: toSessionUser(requireUser(c)) }));

accountRoutes.patch('/', async (c) => {
  const user = requireUser(c);
  const input = z.object({ displayName: z.string().trim().min(1).max(60) }).parse(await c.req.json());
  const updated = updateUser(c.get('deps').db, user.id, { displayName: input.displayName });
  return c.json({ user: toSessionUser(updated) });
});

accountRoutes.post('/password', async (c) => {
  const user = requireUser(c);
  const { db } = c.get('deps');
  const input = z.object({ current: z.string().max(200).optional(), next: passwordSchema }).parse(await c.req.json());
  if (user.passwordHash) {
    if (!input.current || !(await verifyPassword(input.current, user.passwordHash))) {
      throw new HttpError(400, 'bad_password', 'Your current password is wrong.');
    }
  }
  const updated = updateUser(db, user.id, { passwordHash: await hashPassword(input.next) });
  // Sign out everywhere else, then keep this browser signed in.
  deleteUserSessions(db, user.id);
  signIn(c, updated);
  return c.json({ user: toSessionUser(updated) });
});

function signInMethods(u: User): number {
  return Number(u.passwordHash !== null) + Number(u.plexId !== null) + Number(u.oidcSubject !== null);
}

accountRoutes.delete('/links/:provider{plex|oidc}', (c) => {
  const user = requireUser(c);
  const provider = c.req.param('provider');
  const linked = provider === 'plex' ? user.plexId !== null : user.oidcSubject !== null;
  if (!linked) return c.json({ user: toSessionUser(user) });
  if (signInMethods(user) < 2) {
    throw new HttpError(400, 'last_method', 'Set a password or link another sign-in first, so you can still get in.');
  }
  const updated = updateUser(
    c.get('deps').db,
    user.id,
    provider === 'plex' ? { plexId: null, plexUsername: null, plexToken: null } : { oidcIssuer: null, oidcSubject: null },
  );
  return c.json({ user: toSessionUser(updated) });
});

// ---------- Your phones ----------

accountRoutes.get('/devices', (c) => {
  const user = requireUser(c);
  const token = sessionToken(c);
  return c.json({ devices: listDevices(c.get('deps').db, user.id, token ? hashToken(token) : undefined) });
});

accountRoutes.delete('/devices/:id', (c) => {
  const user = requireUser(c);
  if (!removeDevice(c.get('deps').db, user.id, c.req.param('id'))) throw new HttpError(404, 'not_found', "That phone isn't signed in to your account.");
  return c.json({ ok: true });
});

const pushBody = z.object({ token: z.string().regex(/^[0-9a-fA-F]{32,200}$/, 'That isn’t a push token.'), environment: z.enum(['production', 'sandbox']).default('production') });

/** The app, after the person allows notifications: this phone now gets push. */
accountRoutes.post('/devices/:id/push', async (c) => {
  const user = requireUser(c);
  const { db, now } = c.get('deps');
  const body = pushBody.parse(await c.req.json());
  if (!registerPush(db, user, c.req.param('id'), body.token.toLowerCase(), body.environment, now())) throw new HttpError(404, 'not_found', "That phone isn't signed in to your account.");
  return c.json({ ok: true });
});

function deviceEvents(answer: ReturnType<typeof pushEvents>) {
  if (answer === 'unknown') throw new HttpError(404, 'not_found', "That phone isn't signed in to your account.");
  if (answer === 'off') throw new HttpError(409, 'push_off', 'Notifications are off for this iPhone. Turn them on first.');
  return answer;
}

/** The app's own list of switches: which messages this phone gets. */
accountRoutes.get('/devices/:id/push/events', (c) => {
  const user = requireUser(c);
  return c.json(deviceEvents(pushEvents(c.get('deps').db, user, c.req.param('id'))));
});

accountRoutes.put('/devices/:id/push/events', async (c) => {
  const user = requireUser(c);
  const body = z.object({ events: z.array(z.string().max(40)).max(60), on: z.boolean() }).parse(await c.req.json());
  return c.json(deviceEvents(pushEvents(c.get('deps').db, user, c.req.param('id'), body)));
});

accountRoutes.delete('/devices/:id/push', (c) => {
  const user = requireUser(c);
  dropPush(c.get('deps').db, user.id, c.req.param('id'));
  return c.json({ ok: true });
});
