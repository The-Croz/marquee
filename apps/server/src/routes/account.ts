import { Hono } from 'hono';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { deleteUserSessions } from '../auth/sessions.js';
import { toSessionUser, updateUser } from '../auth/users.js';
import { HttpError, requireUser, signIn, type Env } from '../http.js';
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
    provider === 'plex' ? { plexId: null, plexUsername: null } : { oidcIssuer: null, oidcSubject: null },
  );
  return c.json({ user: toSessionUser(updated) });
});
