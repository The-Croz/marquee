// Types shared by the server and the web app. Keep this file free of runtime
// dependencies so both sides can import it.

export type Role = 'admin' | 'member' | 'kid';

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  linked: { plex: boolean; oidc: boolean; password: boolean };
}

export interface AuthStatus {
  /** True until the first admin account exists. */
  setupRequired: boolean;
  providers: {
    password: true;
    oidc: { enabled: boolean; name: string };
    plex: { enabled: boolean };
  };
  user: SessionUser | null;
}

export interface ApiError {
  error: string;
  message: string;
}

export interface PlexPinStart {
  /** Opaque id for polling /api/auth/plex/check. */
  flowId: string;
  authUrl: string;
}

export type PlexPinCheck =
  | { status: 'pending' }
  | { status: 'ok'; user: SessionUser }
  | { status: 'denied'; message: string }
  | { status: 'expired' };

export interface UserSummary extends SessionUser {
  email: string | null;
  plexUsername: string | null;
  createdAt: number;
  lastLoginAt: number | null;
}

// ---- Home screen (sample data until Milestones 1-6 land) ----

export interface HomeData {
  sample: boolean;
  nowDownloading: {
    title: string;
    requestedBy: string;
    quality: string;
    profile: string;
    size: string;
    percent: number;
    speed: string;
    eta: string;
  } | null;
  stats: { label: string; value: string; note: string }[];
  approvals: { id: number; title: string; who: string; plan: string; color: string }[];
  watching: { title: string; who: string; mode: string; percent: number }[];
  recent: { title: string; sub: string; color: string }[];
  upcoming: { day: string; title: string; note: string }[];
}
