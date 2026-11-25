import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AppSignIn, AuthStatus, PlexPinCheck, PlexPinStart, SignInWall } from '@marquee/shared';
import { readServices } from '../library/services.js';
import type { Db } from '../db/index.js';
import { users, type User } from '../db/schema.js';
import { MediaServerError, readMediaServer } from '../library/mediaServers.js';
import { hashPassword, verifyPassword, burnPasswordCheck } from '../auth/password.js';
import { deleteSession, hashToken } from '../auth/sessions.js';
import { appDeviceSchema, signInDevice, signOutDevice, type AppDevice } from '../auth/devices.js';
import { describeError } from '../auth/oidc.js';
import { VERSION } from '../version.js';
import { createFlow, deleteFlow, readFlow } from '../auth/flows.js';
import { USERNAME_RE, countUsers, findLikelySamePerson, findUserByUsername, insertUser, toSessionUser, uniqueUsername, updateUser } from '../auth/users.js';
import { HttpError, clearSessionCookie, clientIp, isSecure, publicOrigin, sessionToken, signIn, type Env } from '../http.js';

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(USERNAME_RE, 'Usernames are 2–32 characters: letters, numbers, dots, dashes or underscores.');
export const passwordSchema = z.string().min(10, 'Passwords need at least 10 characters.').max(200);

const OIDC_COOKIE = 'marquee_oidc';
const FLOW_TTL = 10 * 60 * 1000;

interface OidcFlow {
  state: string;
  verifier: string;
  nonce: string;
  redirectUri: string;
  linkUserId: number | null;
  /** The iPhone app started this: finish at marquee:// instead of the web page. */
  app?: boolean;
}
interface PlexFlow {
  pinId: number;
  linkUserId: number | null;
  device?: AppDevice;
}

/** How long the one-time code between the browser sign-in and the app lasts. */
const APP_CODE_TTL = 60 * 1000;

/**
 * Finishes a sign-in. Browsers get the cookie; the app (which says which
 * phone it is) gets the token in the answer and no cookie.
 */
function finishSignIn(c: Parameters<typeof signIn>[0], user: User, device?: AppDevice): AppSignIn | { user: ReturnType<typeof toSessionUser> } {
  if (!device) {
    signIn(c, user);
    return { user: toSessionUser(user) };
  }
  const { db, now } = c.get('deps');
  return { token: signInDevice(db, user, device, c.req.header('user-agent'), now()), user: toSessionUser(user) };
}

export const authRoutes = new Hono<Env>();

authRoutes.get('/status', (c) => {
  const { db, config, oidc } = c.get('deps');
  const user = c.get('user');
  const body: AuthStatus = {
    setupRequired: countUsers(db) === 0,
    providers: {
      password: true,
      oidc: { enabled: oidc !== null, name: config.oidc?.name ?? '' },
      plex: { enabled: config.plex.enabled },
      jellyfin: { enabled: jellyfinReady(db) },
    },
    user: user ? toSessionUser(user) : null,
    version: VERSION,
  };
  return c.json(body);
});

// ---------- Sign-in poster wall ----------

/**
 * Popular movies and shows from TMDB for the sign-in screen. Anyone can see
 * this page, so it never shows what's in the library. Kept for six hours;
 * empty when there's no TMDB key or TMDB can't be reached.
 */
let wall: { at: number; key: string; posters: string[] } | null = null;
const WALL_FOR = 6 * 60 * 60 * 1000;

authRoutes.get('/wall', async (c) => {
  const { db, config, clients, now } = c.get('deps');
  const key = readServices(db, config).tmdbApiKey;
  if (!key) return c.json({ posters: [] } satisfies SignInWall);
  if (!wall || wall.key !== key || now() - wall.at > WALL_FOR) {
    try {
      const tmdb = clients.tmdb(key);
      const [m, s] = await Promise.all([tmdb.list('movie', 'popular'), tmdb.list('series', 'popular')]);
      const mixed = m.flatMap((x, i) => [x, s[i]]).filter((x): x is NonNullable<typeof x> => !!x?.posterPath);
      wall = { at: now(), key, posters: mixed.slice(0, 30).map((x) => x.posterPath!) };
    } catch {
      return c.json({ posters: wall?.posters ?? [] } satisfies SignInWall);
    }
  }
  return c.json({ posters: wall.posters } satisfies SignInWall);
});

/** Tests start from an empty wall. */
export const forgetWall = () => {
  wall = null;
};

// ---------- First run ----------

authRoutes.post('/setup', async (c) => {
  const { db } = c.get('deps');
  const input = z
    .object({ username: usernameSchema, password: passwordSchema, displayName: z.string().trim().min(1).max(60).optional() })
    .parse(await c.req.json());
  if (countUsers(db) > 0) throw new HttpError(409, 'already_setup', 'Marquee is already set up. Sign in instead.');
  const user = insertUser(db, {
    username: input.username,
    displayName: input.displayName || input.username,
    passwordHash: await hashPassword(input.password),
    role: 'admin',
  });
  signIn(c, user);
  return c.json({ user: toSessionUser(user) }, 201);
});

// ---------- Username and password ----------

authRoutes.post('/login', async (c) => {
  const { db, loginLimiter } = c.get('deps');
  const input = z.object({ username: z.string().trim().toLowerCase().max(64), password: z.string().max(200), device: appDeviceSchema.optional() }).parse(await c.req.json());
  const key = `${clientIp(c)}|${input.username}`;
  const wait = loginLimiter.hit(key);
  if (wait > 0) throw new HttpError(429, 'rate_limited', `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.`);

  const user = findUserByUsername(db, input.username);
  const ok = user?.passwordHash ? await verifyPassword(input.password, user.passwordHash) : (await burnPasswordCheck(input.password), false);
  if (!user || !ok) throw new HttpError(401, 'bad_credentials', 'Wrong username or password.');

  loginLimiter.reset(key);
  return c.json(finishSignIn(c, user, input.device));
});

authRoutes.post('/logout', (c) => {
  const token = sessionToken(c);
  if (token) signOutDevice(c.get('deps').db, hashToken(token));
  deleteSession(c.get('deps').db, token);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

// ---------- OIDC (Pocket ID etc.) ----------

authRoutes.get('/oidc/start', async (c) => {
  const { db, oidc } = c.get('deps');
  if (!oidc) throw new HttpError(404, 'oidc_disabled', 'Single sign-on is not configured.');
  const linking = c.req.query('link') === '1';
  const current = c.get('user');
  if (linking && !current) throw new HttpError(401, 'unauthenticated', 'Sign in before linking an account.');
  const app = c.req.query('app') === '1';
  if (app && linking) throw new HttpError(400, 'bad_request', "The app can't link an account. Do that on the web, under Settings → Account.");

  const redirectUri = `${publicOrigin(c)}/api/auth/oidc/callback`;
  let started;
  try {
    started = await oidc.start(redirectUri);
  } catch (err) {
    console.warn(`[auth] couldn't start OIDC sign-in: ${describeError(err)}`);
    return c.redirect(app ? 'marquee://signed-in?error=oidc_unreachable' : linking ? '/settings/account?error=oidc_unreachable' : '/login?error=oidc_unreachable', 302);
  }
  const { url, state, verifier, nonce } = started;
  const flowId = createFlow<OidcFlow>(db, 'oidc', { state, verifier, nonce, redirectUri, linkUserId: linking ? current!.id : null, ...(app ? { app: true } : {}) }, FLOW_TTL);
  setCookie(c, OIDC_COOKIE, flowId, { httpOnly: true, sameSite: 'Lax', secure: isSecure(c), path: '/api/auth/oidc', maxAge: FLOW_TTL / 1000 });
  return c.redirect(url, 302);
});

authRoutes.get('/oidc/callback', async (c) => {
  const { db, oidc, config } = c.get('deps');
  if (!oidc || !config.oidc) throw new HttpError(404, 'oidc_disabled', 'Single sign-on is not configured.');
  const flowId = getCookie(c, OIDC_COOKIE);
  const flow = readFlow<OidcFlow>(db, 'oidc', flowId);
  deleteCookie(c, OIDC_COOKIE, { path: '/api/auth/oidc' });
  if (!flow || !flowId) return c.redirect('/login?error=oidc_expired', 302);
  deleteFlow(db, flowId);

  const back = (error: string) => c.redirect(flow.app ? `marquee://signed-in?error=${error}` : flow.linkUserId ? `/settings/account?error=${error}` : `/login?error=${error}`, 302);

  let identity;
  try {
    const callbackUrl = new URL(flow.redirectUri);
    callbackUrl.search = new URL(c.req.url).search;
    identity = await oidc.finish(callbackUrl, flow);
  } catch (err) {
    console.warn(`[auth] OIDC sign-in failed: ${describeError(err)}`);
    return back('oidc_failed');
  }

  const existing = db
    .select()
    .from(users)
    .where(and(eq(users.oidcIssuer, oidc.issuer), eq(users.oidcSubject, identity.subject)))
    .get();

  if (flow.linkUserId) {
    if (existing && existing.id !== flow.linkUserId) return back('oidc_in_use');
    updateUser(db, flow.linkUserId, { oidcIssuer: oidc.issuer, oidcSubject: identity.subject, email: identity.email ?? undefined });
    return c.redirect('/settings/account?linked=oidc', 302);
  }

  let user: User | undefined = existing;
  if (!user) {
    if (!config.oidc.autoCreate || countUsers(db) === 0) return back('oidc_no_account');
    if (findLikelySamePerson(db, identity)) return back('oidc_account_exists');
    user = insertUser(db, {
      username: uniqueUsername(db, identity.username ?? identity.email?.split('@')[0] ?? identity.name ?? 'user'),
      displayName: identity.name ?? identity.username ?? 'New user',
      email: identity.email,
      role: 'member',
      oidcIssuer: oidc.issuer,
      oidcSubject: identity.subject,
    });
  }
  if (flow.app) {
    const code = createFlow<{ userId: number }>(db, 'app', { userId: user.id }, APP_CODE_TTL, c.get('deps').now());
    return c.redirect(`marquee://signed-in?code=${code}`, 302);
  }
  signIn(c, user);
  return c.redirect('/', 302);
});

/** The app trades the one-time code from a browser sign-in for its token. */
authRoutes.post('/app-token', async (c) => {
  const { db, now } = c.get('deps');
  const { code, device } = z.object({ code: z.string().min(10).max(100), device: appDeviceSchema }).parse(await c.req.json());
  const flow = readFlow<{ userId: number }>(db, 'app', code, now());
  if (!flow) throw new HttpError(400, 'code_expired', 'That sign-in took too long. Try again.');
  deleteFlow(db, code);
  const user = db.select().from(users).where(eq(users.id, flow.userId)).get();
  if (!user) throw new HttpError(400, 'code_expired', 'That sign-in took too long. Try again.');
  return c.json(finishSignIn(c, user, device));
});

// ---------- Jellyfin ----------

function jellyfinReady(db: Db): boolean {
  const j = readMediaServer(db, 'jellyfin');
  return Boolean(j.url && j.secret);
}

/**
 * Jellyfin sign-in: Jellyfin checks the password, and the person must already
 * have a Marquee account linked to that Jellyfin user (pick them under
 * Settings → Users). Nobody is created here.
 */
authRoutes.post('/jellyfin', async (c) => {
  const { db, clients, loginLimiter } = c.get('deps');
  const input = z.object({ username: z.string().trim().max(64).min(1), password: z.string().max(200), device: appDeviceSchema.optional() }).parse(await c.req.json());
  const saved = readMediaServer(db, 'jellyfin');
  if (!saved.url || !saved.secret) throw new HttpError(404, 'jellyfin_disabled', 'Jellyfin sign-in is not set up.');
  const key = `${clientIp(c)}|jf|${input.username.toLowerCase()}`;
  const wait = loginLimiter.hit(key);
  if (wait > 0) throw new HttpError(429, 'rate_limited', `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.`);

  let who;
  try {
    who = await clients.jellyfinLogin(saved.url, input.username, input.password);
  } catch (err) {
    if (err instanceof MediaServerError) throw new HttpError(502, 'jellyfin_unreachable', "Marquee couldn't reach Jellyfin. Try your Marquee password, or ask an admin.");
    throw err;
  }
  if (!who) throw new HttpError(401, 'bad_credentials', 'Jellyfin says that username or password is wrong.');
  const user = db.select().from(users).where(eq(users.jellyfinId, who.id)).get();
  if (!user) throw new HttpError(403, 'not_linked', "That Jellyfin account isn't set up in Marquee yet. Ask an admin to add you under Settings → Users.");
  loginLimiter.reset(key);
  return c.json(finishSignIn(c, user, input.device));
});

// ---------- Plex ----------

authRoutes.post('/plex/start', async (c) => {
  const { db, config, plex } = c.get('deps');
  if (!config.plex.enabled) throw new HttpError(404, 'plex_disabled', 'Plex sign-in is turned off.');
  const body = z.object({ link: z.boolean().optional(), device: appDeviceSchema.optional() }).parse(await c.req.json().catch(() => ({})));
  const current = c.get('user');
  if (body.link && !current) throw new HttpError(401, 'unauthenticated', 'Sign in before linking an account.');

  const client = plex();
  let pin;
  try {
    pin = await client.createPin();
  } catch (err) {
    throw new HttpError(502, 'plex_unreachable', `Couldn't reach plex.tv (${(err as Error).message}).`);
  }
  const flowId = createFlow<PlexFlow>(db, 'plex', { pinId: pin.id, linkUserId: body.link ? current!.id : null, ...(body.device ? { device: body.device } : {}) }, FLOW_TTL);
  const result: PlexPinStart = { flowId, authUrl: client.authUrl(pin.code) };
  return c.json(result);
});

authRoutes.post('/plex/check', async (c) => {
  const { db, config, plex } = c.get('deps');
  if (!config.plex.enabled) throw new HttpError(404, 'plex_disabled', 'Plex sign-in is turned off.');
  const { flowId } = z.object({ flowId: z.string().min(10).max(100) }).parse(await c.req.json());
  const flow = readFlow<PlexFlow>(db, 'plex', flowId);
  if (!flow) return c.json<PlexPinCheck>({ status: 'expired' });

  const client = plex();
  let token: string | null;
  try {
    token = await client.checkPin(flow.pinId);
  } catch (err) {
    throw new HttpError(502, 'plex_unreachable', `Couldn't reach plex.tv (${(err as Error).message}).`);
  }
  if (!token) return c.json<PlexPinCheck>({ status: 'pending' });
  deleteFlow(db, flowId);

  const account = await client.account(token);
  const existing = db.select().from(users).where(eq(users.plexId, account.id)).get();

  if (flow.linkUserId) {
    if (existing && existing.id !== flow.linkUserId) {
      return c.json<PlexPinCheck>({ status: 'denied', message: 'That Plex account is already linked to another Marquee user.' });
    }
    // Their token is kept (never shown) so Marquee can read their Plex watchlist.
    const user = updateUser(db, flow.linkUserId, { plexId: account.id, plexUsername: account.username, plexToken: token });
    return c.json<PlexPinCheck>({ status: 'ok', user: toSessionUser(user) });
  }

  let user: User | undefined = existing;
  if (user) {
    user = updateUser(db, user.id, { plexUsername: account.username, plexToken: token });
  } else {
    const { autoCreate, serverId } = config.plex;
    const allowed = autoCreate && serverId !== null && countUsers(db) > 0 && (await client.canAccessServer(token, serverId));
    if (!allowed) {
      return c.json<PlexPinCheck>({
        status: 'denied',
        message: autoCreate
          ? "This Plex account doesn't have access to the Plex server, so it can't sign in."
          : "This Plex account isn't linked to a Marquee user yet. Ask an admin to link it, or sign in another way and link it under Settings → Account.",
      });
    }
    if (findLikelySamePerson(db, account)) {
      return c.json<PlexPinCheck>({
        status: 'denied',
        message: 'You already have a Marquee account. Sign in with your password, then link Plex under Settings → Account.',
      });
    }
    user = insertUser(db, {
      username: uniqueUsername(db, account.username),
      displayName: account.title,
      email: account.email,
      role: 'member',
      plexId: account.id,
      plexUsername: account.username,
      plexToken: token,
    });
  }
  const done = finishSignIn(c, user, flow.device);
  return c.json<PlexPinCheck>({ status: 'ok', user: done.user, ...('token' in done ? { token: done.token } : {}) });
});
