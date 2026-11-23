import { Hono } from 'hono';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ServerPerson, UserSummary } from '@marquee/shared';
import type { Db } from '../db/index.js';
import { users, type User } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { deleteUserSessions } from '../auth/sessions.js';
import { countAdmins, findUserById, uniqueUsername, findUserByUsername, insertUser, toSessionUser, updateUser } from '../auth/users.js';
import { HttpError, requireAdmin, type Ctx, type Env } from '../http.js';
import { MediaServerError, readMediaServer, type ServerKind } from '../library/mediaServers.js';
import { passwordSchema, usernameSchema } from './auth.js';

/** Admin-only user management: family members, kid profiles, roles. */
export const userRoutes = new Hono<Env>();

const roleSchema = z.enum(['admin', 'member', 'kid']);

function summary(u: User): UserSummary {
  return { ...toSessionUser(u), email: u.email, plexUsername: u.plexUsername, jellyfinUsername: u.jellyfinUsername, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt, skipApproval: u.skipApproval, weeklyLimit: u.weeklyLimit };
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
      skipApproval: z.boolean().optional(),
      weeklyLimit: z.number().int().min(0).max(100).optional(),
    })
    .parse(await c.req.json());

  if (input.role && input.role !== 'admin' && target.role === 'admin' && countAdmins(db) === 1) {
    throw new HttpError(400, 'last_admin', 'Marquee needs at least one admin.');
  }
  const updated = updateUser(db, target.id, {
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.role ? { role: input.role } : {}),
    ...(input.password ? { passwordHash: await hashPassword(input.password) } : {}),
    ...(input.unlinkPlex ? { plexId: null, plexUsername: null, plexToken: null } : {}),
    ...(input.skipApproval !== undefined ? { skipApproval: input.skipApproval } : {}),
    ...(input.weeklyLimit !== undefined ? { weeklyLimit: input.weeklyLimit } : {}),
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

// ---------- Pick people from Plex or Jellyfin ----------

function serverApi(c: Ctx, kind: ServerKind) {
  const { db, clients } = c.get('deps');
  const label = kind === 'plex' ? 'Plex' : 'Jellyfin';
  const saved = readMediaServer(db, kind);
  if (!saved.url || !saved.secret) throw new HttpError(400, 'not_set_up', `Connect ${label} under Settings → Services first.`);
  return { label, api: kind === 'plex' ? clients.plexServer(saved.url, saved.secret) : clients.jellyfin(saved.url, saved.secret) };
}

const serverSchema = z.enum(['plex', 'jellyfin']);

function linkedTo(db: Db, kind: ServerKind, id: string): User | undefined {
  return db.select().from(users).where(eq(kind === 'plex' ? users.plexId : users.jellyfinId, id)).get();
}

userRoutes.get('/server-people', async (c) => {
  requireAdmin(c);
  const kind = serverSchema.parse(c.req.query('server'));
  const { label, api } = serverApi(c, kind);
  try {
    const db = c.get('deps').db;
    const all = db.select().from(users).orderBy(asc(users.displayName)).all();
    // Accounts with no link to this server yet, which a person could be linked to instead of getting a new account.
    const open = all.filter((u) => !(kind === 'plex' ? u.plexId : u.jellyfinId));
    const same = (a: string | null | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();
    const people: ServerPerson[] = (await api.people()).map((p) => ({
      ...p,
      marqueeUser: linkedTo(db, kind, p.id)?.username ?? null,
      suggest: open.find((u) => [u.username, u.displayName, u.plexUsername, u.jellyfinUsername, u.email].some((x) => same(x, p.username) || same(x, p.name)))?.id ?? null,
    }));
    return c.json({ people, accounts: open.map((u) => ({ id: u.id, username: u.username, displayName: u.displayName })) });
  } catch (err) {
    if (err instanceof MediaServerError) throw new HttpError(502, 'server_unreachable', `${err.message} Check ${label} under Settings → Services.`);
    throw err;
  }
});

/** Makes Marquee accounts for the people picked from a server's list. They have no password; they sign in through that server. */
userRoutes.post('/from-server', async (c) => {
  requireAdmin(c);
  const db = c.get('deps').db;
  const input = z
    .object({ server: serverSchema, people: z.array(z.object({ id: z.string().min(1).max(100), role: roleSchema.default('member'), linkTo: z.number().int().optional() })).min(1).max(200) })
    .parse(await c.req.json());
  const { label, api } = serverApi(c, input.server);
  let listed;
  try {
    listed = await api.people();
  } catch (err) {
    if (err instanceof MediaServerError) throw new HttpError(502, 'server_unreachable', `${err.message} Check ${label} under Settings → Services.`);
    throw err;
  }
  const created: User[] = [];
  const linked: User[] = [];
  for (const pick of input.people) {
    const person = listed.find((p) => p.id === pick.id);
    if (!person || linkedTo(db, input.server, person.id)) continue;
    const link = input.server === 'plex' ? { plexId: person.id, plexUsername: person.username } : { jellyfinId: person.id, jellyfinUsername: person.username };
    if (pick.linkTo !== undefined) {
      // Link an account that's already here: it keeps its name, role and password.
      const target = findUserById(db, pick.linkTo);
      if (!target) throw new HttpError(404, 'not_found', 'That Marquee account isn’t there any more.');
      if (input.server === 'plex' ? target.plexId : target.jellyfinId) throw new HttpError(409, 'already_linked', `${target.displayName} is already linked to someone on ${label}.`);
      db.update(users).set(link).where(eq(users.id, target.id)).run();
      linked.push(findUserById(db, target.id)!);
      continue;
    }
    created.push(insertUser(db, { username: uniqueUsername(db, person.username), displayName: person.name, role: pick.role, passwordHash: null, ...link }));
  }
  return c.json({ users: created.map(summary), linked: linked.map(summary) }, 201);
});
