import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { leftOut } from '../db/schema.js';

/** Whether the scan should skip a folder or a matched title: you removed it with "don't add it back when scanning". */
export function isLeftOut(db: Db, kind: 'movie' | 'series', by: { path?: string; tmdbId?: number }): boolean {
  if (by.path && db.select({ id: leftOut.id }).from(leftOut).where(and(eq(leftOut.kind, kind), eq(leftOut.path, by.path))).get()) return true;
  if (by.tmdbId && db.select({ id: leftOut.id }).from(leftOut).where(and(eq(leftOut.kind, kind), eq(leftOut.tmdbId, by.tmdbId))).get()) return true;
  return false;
}
