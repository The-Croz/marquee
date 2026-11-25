import { randomBytes } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { loginFlows } from '../db/schema.js';

type Kind = 'oidc' | 'plex' | 'app';

export function createFlow<T>(db: Db, kind: Kind, data: T, ttlMs: number, now = Date.now()): string {
  db.delete(loginFlows).where(lt(loginFlows.expiresAt, now)).run();
  const id = randomBytes(24).toString('base64url');
  db.insert(loginFlows).values({ id, kind, data: JSON.stringify(data), expiresAt: now + ttlMs }).run();
  return id;
}

export function readFlow<T>(db: Db, kind: Kind, id: string | undefined, now = Date.now()): T | null {
  if (!id) return null;
  const row = db.select().from(loginFlows).where(and(eq(loginFlows.id, id), eq(loginFlows.kind, kind))).get();
  if (!row || row.expiresAt <= now) return null;
  return JSON.parse(row.data) as T;
}

export function deleteFlow(db: Db, id: string): void {
  db.delete(loginFlows).where(eq(loginFlows.id, id)).run();
}
