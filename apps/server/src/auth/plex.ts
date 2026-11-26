import { randomUUID } from 'node:crypto';
import { getSetting, setSetting, type Db } from '../db/index.js';

/**
 * Plex sign-in uses Plex's PIN flow, the same one Overseerr and Tautulli use:
 * 1. We ask plex.tv for a PIN and send the browser to app.plex.tv to approve it.
 * 2. We poll the PIN until Plex attaches an auth token.
 * 3. We use that token to read the Plex account and, optionally, check that it
 *    can see your server.
 * The Plex token is used only during sign-in and is never stored.
 */

const PLEX_TV = 'https://plex.tv';
const PRODUCT = 'Marquee';

export interface PlexAccount {
  id: string;
  username: string;
  email: string | null;
  title: string;
  /** Where their Plex picture is. */
  avatar: string | null;
}

export class PlexClient {
  constructor(
    private readonly clientId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(token?: string): Record<string, string> {
    return {
      Accept: 'application/json',
      'X-Plex-Product': PRODUCT,
      'X-Plex-Client-Identifier': this.clientId,
      ...(token ? { 'X-Plex-Token': token } : {}),
    };
  }

  private async json<T>(url: string, init: RequestInit = {}, token?: string): Promise<T> {
    const res = await this.fetchImpl(url, { ...init, headers: { ...this.headers(token), ...(init.headers as Record<string, string>) } });
    if (!res.ok) throw new Error(`plex.tv ${res.status} for ${new URL(url).pathname}`);
    return (await res.json()) as T;
  }

  async createPin(): Promise<{ id: number; code: string }> {
    const pin = await this.json<{ id: number; code: string }>(`${PLEX_TV}/api/v2/pins?strong=true`, { method: 'POST' });
    return { id: pin.id, code: pin.code };
  }

  authUrl(code: string, forwardUrl?: string): string {
    const params = new URLSearchParams({ clientID: this.clientId, code, 'context[device][product]': PRODUCT });
    if (forwardUrl) params.set('forwardUrl', forwardUrl);
    return `https://app.plex.tv/auth#?${params.toString()}`;
  }

  /** Returns the auth token once the user has approved the PIN, else null. */
  async checkPin(id: number): Promise<string | null> {
    const pin = await this.json<{ authToken: string | null }>(`${PLEX_TV}/api/v2/pins/${id}`);
    return pin.authToken || null;
  }

  async account(token: string): Promise<PlexAccount> {
    const u = await this.json<{ id: number; username: string; email?: string; title?: string; thumb?: string }>(`${PLEX_TV}/api/v2/user`, {}, token);
    return { id: String(u.id), username: u.username, email: u.email ?? null, title: u.title || u.username, avatar: u.thumb ?? null };
  }

  /** True if this Plex account owns or has been shared the server with `serverId`. */
  async canAccessServer(token: string, serverId: string): Promise<boolean> {
    const resources = await this.json<{ clientIdentifier: string; provides: string }[]>(
      `${PLEX_TV}/api/v2/resources?includeHttps=1&includeRelay=0`,
      {},
      token,
    );
    return resources.some((r) => r.clientIdentifier === serverId && r.provides.split(',').includes('server'));
  }
}

/** Plex wants a stable identifier per app install. */
export function plexClientId(db: Db): string {
  let id = getSetting(db, 'plex_client_id');
  if (!id) {
    id = `marquee-${randomUUID()}`;
    setSetting(db, 'plex_client_id', id);
  }
  return id;
}
