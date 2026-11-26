import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { users, type User } from '../db/schema.js';
import type { Clients } from '../http.js';
import { readMediaServer } from '../library/mediaServers.js';

/**
 * Profile pictures: the person's Plex picture first, then the one from single
 * sign-on (Pocket ID). Marquee fetches it and serves it itself, so browsers and
 * phones never talk to Plex or the sign-in provider for it.
 */

export interface Picture {
  type: string;
  body: Buffer;
}

const DAY = 86_400_000;
const MAX_BYTES = 2 * 1024 * 1024;

/** The address screens use, or null when there's no picture. It changes when the picture's source does. */
export function avatarPath(u: Pick<User, 'id' | 'plexAvatar' | 'oidcAvatar'>): string | null {
  if (!u.plexAvatar && !u.oidcAvatar) return null;
  const version = createHash('sha256').update(`${u.plexAvatar ?? ''}|${u.oidcAvatar ?? ''}`).digest('hex').slice(0, 10);
  return `/api/avatars/${u.id}?v=${version}`;
}

/** Only Plex's own addresses and your sign-in provider's are ever fetched. */
export function allowedAvatar(address: string, issuer: string | null): boolean {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  if (url.protocol === 'https:' && (url.hostname === 'plex.tv' || url.hostname.endsWith('.plex.tv'))) return true;
  return !!issuer && (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === new URL(issuer).origin;
}

/** Fetches a picture, or null when it isn't one (or is too big to be a face). */
export async function fetchPicture(address: string, fetchImpl: typeof fetch = fetch): Promise<Picture | null> {
  const res = await fetchImpl(address, { signal: AbortSignal.timeout(10_000) });
  const type = res.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
  // SVG can carry script, so only ordinary pictures are passed on.
  if (!res.ok || !/^image\/(png|jpe?g|gif|webp|avif)$/.test(type)) return null;
  const body = Buffer.from(await res.arrayBuffer());
  return body.length > 0 && body.length <= MAX_BYTES ? { type, body } : null;
}

const cache = new WeakMap<Db, Map<string, { at: number; picture: Picture }>>();

export async function avatarFor(deps: { db: Db; clients: Pick<Clients, 'image'>; now: () => number }, u: User, issuer: string | null): Promise<Picture | null> {
  const kept = cache.get(deps.db) ?? new Map<string, { at: number; picture: Picture }>();
  cache.set(deps.db, kept);
  for (const address of [u.plexAvatar, u.oidcAvatar]) {
    if (!address || !allowedAvatar(address, issuer)) continue;
    const known = kept.get(address);
    if (known && deps.now() - known.at < DAY) return known.picture;
    const picture = await (deps.clients.image ?? fetchPicture)(address).catch(() => null);
    if (picture) {
      if (kept.size > 200) kept.clear();
      kept.set(address, { at: deps.now(), picture });
      return picture;
    }
    // An old copy beats nothing while the other end is down.
    if (known) return known.picture;
  }
  return null;
}

/**
 * Copies pictures from the people on your Plex server to their Marquee
 * accounts, matched by the linked Plex account or the same user name. Returns
 * how many accounts changed.
 */
export async function refreshPlexAvatars({ db, clients }: { db: Db; clients: Pick<Clients, 'plexServer'> }): Promise<number> {
  const s = readMediaServer(db, 'plex');
  if (!s.url || !s.secret) return 0;
  const people = await clients.plexServer(s.url, s.secret).people();
  let changed = 0;
  for (const u of db.select().from(users).all()) {
    const names = [u.plexUsername, u.username].filter(Boolean).map((n) => n!.toLowerCase());
    const person = people.find((p) => u.plexId === p.id) ?? (u.plexId ? undefined : people.find((p) => names.includes(p.username.toLowerCase())));
    if (!person?.avatar || person.avatar === u.plexAvatar) continue;
    db.update(users).set({ plexAvatar: person.avatar }).where(eq(users.id, u.id)).run();
    changed++;
  }
  return changed;
}
