import path from 'node:path';

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string | undefined;
  /** Label on the login button, e.g. "Pocket ID". */
  name: string;
  /** Create a member account the first time someone signs in through OIDC. */
  autoCreate: boolean;
}

export interface PlexConfig {
  enabled: boolean;
  /** Machine identifier of your Plex server. Required for automatic sign-up. */
  serverId: string | null;
  /** Create a member account for anyone who has access to `serverId`. */
  autoCreate: boolean;
}

export interface Config {
  port: number;
  dataDir: string;
  /** Public URL Marquee is reached at, e.g. https://marquee.example.com. */
  baseUrl: string | null;
  /** Built web app to serve. Null in development (Vite serves it). */
  webDir: string | null;
  oidc: OidcConfig | null;
  plex: PlexConfig;
  /** TMDB API key (v3 key or v4 read token). Used from Milestone 1. */
  tmdbApiKey: string | null;
}

type Env = Record<string, string | undefined>;

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function loadConfig(env: Env = process.env): Config {
  const baseUrl = env.MARQUEE_BASE_URL?.replace(/\/+$/, '') || null;

  const oidc: OidcConfig | null =
    env.OIDC_ISSUER && env.OIDC_CLIENT_ID
      ? {
          issuer: env.OIDC_ISSUER,
          clientId: env.OIDC_CLIENT_ID,
          clientSecret: env.OIDC_CLIENT_SECRET || undefined,
          name: env.OIDC_NAME || 'Single sign-on',
          autoCreate: bool(env.OIDC_AUTO_CREATE, true),
        }
      : null;

  const plexServerId = env.PLEX_SERVER_ID || null;

  return {
    port: Number(env.MARQUEE_PORT || env.PORT || 9797),
    dataDir: path.resolve(env.MARQUEE_DATA_DIR || './data'),
    baseUrl,
    webDir: env.MARQUEE_WEB_DIR ? path.resolve(env.MARQUEE_WEB_DIR) : null,
    oidc,
    plex: {
      enabled: bool(env.PLEX_LOGIN, false),
      serverId: plexServerId,
      autoCreate: bool(env.PLEX_AUTO_CREATE, false) && plexServerId !== null,
    },
    tmdbApiKey: env.TMDB_API_KEY?.trim() || null,
  };
}
