import type { Db } from '../db/index.js';
import { getSetting, setSetting } from '../db/index.js';
import { notifyAdmins, type NotifyDeps } from './service.js';

const KEY = 'notify.version';

/**
 * Tells the admins once when Marquee starts on a different version from last
 * time. The very first start, and local "dev" builds, stay quiet.
 */
export async function announceVersion(deps: NotifyDeps & { db: Db }, version: string): Promise<boolean> {
  const before = getSetting(deps.db, KEY) || null;
  if (before === version) return false;
  setSetting(deps.db, KEY, version);
  if (!before || version === 'dev') return false;
  await notifyAdmins(deps, 'marquee_updated', { vars: { version, previous: before }, link: '/settings/about' });
  return true;
}
