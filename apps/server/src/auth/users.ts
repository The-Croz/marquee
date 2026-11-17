import { count, eq, sql } from 'drizzle-orm';
import type { Role, SessionUser } from '@marquee/shared';
import type { Db } from '../db/index.js';
import { users, type NewUser, type User } from '../db/schema.js';

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

export function toSessionUser(u: User): SessionUser {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role as Role,
    linked: { plex: u.plexId !== null, oidc: u.oidcSubject !== null, password: u.passwordHash !== null },
  };
}

export function countUsers(db: Db): number {
  return db.select({ n: count() }).from(users).get()?.n ?? 0;
}

export function countAdmins(db: Db): number {
  return db.select({ n: count() }).from(users).where(eq(users.role, 'admin')).get()?.n ?? 0;
}

export function findUserByUsername(db: Db, username: string): User | undefined {
  return db.select().from(users).where(sql`lower(${users.username}) = ${username.toLowerCase()}`).get();
}

export function findUserById(db: Db, id: number): User | undefined {
  return db.select().from(users).where(eq(users.id, id)).get();
}

/** Turns a display name or remote username into a free, valid local username. */
export function uniqueUsername(db: Db, wanted: string): string {
  let base = wanted
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9._-]+/g, '.')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 28);
  if (base.length < 2) base = 'user';
  let candidate = base;
  for (let i = 2; findUserByUsername(db, candidate); i++) candidate = `${base}${i}`;
  return candidate;
}

export function insertUser(db: Db, values: Omit<NewUser, 'createdAt'>, now = Date.now()): User {
  return db.insert(users).values({ ...values, createdAt: now }).returning().get();
}

export function updateUser(db: Db, id: number, values: Partial<Omit<NewUser, 'id' | 'createdAt'>>): User {
  return db.update(users).set(values).where(eq(users.id, id)).returning().get();
}
