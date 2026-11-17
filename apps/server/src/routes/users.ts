import { Hono } from 'hono';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { UserSummary } from '@marquee/shared';
import { users, type User } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { deleteUserSessions } from '../auth/sessions.js';
import { countAdmins, findUserById, findUserByUsername, insertUser, toSessionUser, updateUser } from '../auth/users.js';
import { HttpError, requireAdmin, type Ctx, type Env } from '../http.js';
import { passwordSchema, usernameSchema } from './auth.js';

/** Admin-only user management: family members, kid profiles, roles. */
export const userRoutes = new Hono<Env>();

const roleSchema = z.enum(['admin', 'member', 'kid']);

function summary(u: User): UserSummary {
  return { ...toSessionUser(u), email: u.email, plexUsername: u.plexUsername, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt };
}

function load(c: Ctx): User {
  const id = Number(c.req.param('id'));
  const user = Number.isInteger(id) ? findUserById(c.get('deps').db, id) : undefined;
  if (!user) throw new HttpError(404, 'not_found', 'No such user.');
  return user;
}

userRoutes.get('/', (c) => {
  requireAdmin(c);
  const rows = c.get('deps').db.select().from(users).orderBy(asc(users.createdAt)).all();
  return c.json({ users: rows.map(summary) });
});

userRoutes.post('/', async (c) => {
  requireAdmin(c);
  const { db } = c.get('deps');
  const input = z
    .object({
      username: usernameSchema,
      displayName: z.string().trim().min(1).max(60),
      role: roleSchema,
      password: passwordSchema.optional(),
    })
    .parse(await c.req.json());
  if (findUserByUsername(db, input.username)) throw new HttpError(409, 'username_taken', 'That username is taken.');
  const user = insertUser(db, {
    username: input.username,
    displayName: input.displayName,
    role: input.role,
    passwordHash: input.password ? await hashPassword(input.password) : null,
  });
  return c.json({ user: summary(user) }, 201);
});

userRoutes.patch('/:id{[0-9]+}', async (c) => {
  const admin = requireAdmin(c);
  const { db } = c.get('deps');
  const target = load(c);
  const input = z
    .object({
      displayName: z.string().trim().min(1).max(60).optional(),
      role: roleSchema.optional(),
      password: passwordSchema.optional(),
      unlinkPlex: z.boolean().optional(),
      unlinkOidc: z.boolean().optional(),
    })
    .parse(await c.req.json());

  if (input.role && input.role !== 'admin' && target.role === 'admin' && countAdmins(db) === 1) {
    throw new HttpError(400, 'last_admin', 'Marquee needs at least one admin.');
  }
  const updated = updateUser(db, target.id, {
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.role ? { role: input.role } : {}),
    ...(input.password ? { passwordHash: await hashPassword(input.password) } : {}),
    ...(input.unlinkPlex ? { plexId: null, plexUsername: null } : {}),
    ...(input.unlinkOidc ? { oidcIssuer: null, oidcSubject: null } : {}),
  });
  // A reset password or role change signs that person out everywhere.
  if ((input.password || input.role) && target.id !== admin.id) deleteUserSessions(db, target.id);
  return c.json({ user: summary(updated) });
});

userRoutes.delete('/:id{[0-9]+}', (c) => {
  const admin = requireAdmin(c);
  const target = load(c);
  if (target.id === admin.id) throw new HttpError(400, 'self_delete', "You can't delete your own account.");
  c.get('deps').db.delete(users).where(eq(users.id, target.id)).run();
  return c.json({ ok: true });
});
